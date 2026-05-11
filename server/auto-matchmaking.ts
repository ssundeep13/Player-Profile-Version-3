// Player-driven auto-matchmaking orchestrator.
//
// Triggered fire-and-forget from the marketplace check-in handler and from
// the marketplace score-submit handler. Replaces the old single-court
// runP3BackgroundMatchmaking helper.
//
// Threshold rules:
//   - First match of the session (zero completed games AND zero in-flight
//     suggestions) → 6 waiting players required.
//   - Every subsequent match → 4 waiting players required.
//
// Brain selection:
//   - The very first iteration of the very first match attempt asks
//     Claude AI for the best 2v2 split. On any failure (timeout, error,
//     unknown player name, missing key) we silently fall back to the
//     standard generateBracketedLineups for that iteration.
//   - Every subsequent iteration in the same loop, and every later call,
//     uses generateBracketedLineups directly. Claude is never called more
//     than once per session.
//
// Concurrency:
//   - Wrapped in a Postgres advisory lock keyed off the session id, so two
//     near-simultaneous check-ins (or a check-in racing a score submit)
//     collapse to a single matchmaking pass — the loser logs and exits.

import { db } from './db';
import { sql, and, eq, inArray } from 'drizzle-orm';
import { storage } from './storage';
import { appendFileSync } from 'node:fs';
import {
  generateBracketedLineups,
  findBalancedTeams,
  buildRestStatesFromHistory,
  buildPartnerHistoryFromHistory,
  loadRestStatesFromDb,
  getPlayerRestState,
  getSittingOutPlayers,
  computeRecentPartnersAndOpponents,
} from './matchmaking';
import type { Player } from '@shared/schema';
import {
  matchSuggestions,
  matchSuggestionPlayers,
  gameResults,
} from '@shared/schema';
import {
  requestClaudeMatchmaking,
  requestPlayerFlowMatchmaking,
  type ClaudeSessionState,
  type PlayerFlowPlayerProfile,
  type PlayerFlowCourtRequest,
} from './claude-matchmaking';

const PENDING_WINDOW_MS = 90_000;
const FIRST_MATCH_THRESHOLD = 6;
const SUBSEQUENT_MATCH_THRESHOLD = 4;

// Structured event side-channel. The on-disk workflow log is a
// platform-managed snapshot (not live-tailed), so the E2E test cannot rely
// on it for path/timing verification. Instead, every meaningful matchmaking
// event is also appended as a single JSON line to this file. The file is
// best-effort: any append failure is swallowed so production traffic is
// never blocked by a debug write.
const EVENT_LOG_PATH = process.env.AUTO_MATCHMAKING_EVENT_LOG ?? '/tmp/shuttleiq-am-events.jsonl';

type AutoMatchmakingEvent =
  | { type: 'claude_used'; sessionId: string; elapsedMs: number; ts: number }
  | { type: 'fallback'; sessionId: string; elapsedMs: number; reason: string; ts: number }
  | { type: 'suggestion_created'; sessionId: string; courtId: string; iteration: number; firstMatch: boolean; ts: number }
  | { type: 'skipped'; sessionId: string; reason: string; ts: number }
  | { type: 'done'; sessionId: string; created: number; firstMatch: boolean; ts: number };

function emitEvent(ev: AutoMatchmakingEvent): void {
  try {
    appendFileSync(EVENT_LOG_PATH, JSON.stringify(ev) + '\n');
  } catch {
    // Side channel only — never break production on a debug write failure.
  }
}

// drizzle's neon driver returns either `{ rows: [...] }` (current versions)
// or a bare array (older paths). This helper normalises both into a
// single-row generic so call sites stay strongly typed.
function firstRow<T>(result: unknown): T | undefined {
  if (result && typeof result === 'object') {
    const withRows = result as { rows?: unknown };
    if (Array.isArray(withRows.rows) && withRows.rows.length > 0) {
      return withRows.rows[0] as T;
    }
    if (Array.isArray(result) && result.length > 0) {
      return result[0] as T;
    }
  }
  return undefined;
}

// Stable advisory-lock keyed off the session UUID. Two near-simultaneous
// check-ins or a check-in racing a score submit collapse to a single
// matchmaking pass — the loser logs and exits.
//
// IMPORTANT: We use `pg_try_advisory_xact_lock` *inside a transaction* so
// the lock is bound to the transaction's backend connection and is
// auto-released at COMMIT/ROLLBACK on that same connection. Using
// session-level `pg_try_advisory_lock` over a connection Pool is unsafe
// because the unlock call can land on a different backend connection,
// silently leaking the lock and breaking subsequent runs.
async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return await db.transaction(async (tx) => {
    const result = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${sessionId})) AS locked`,
    );
    const row = firstRow<{ locked: boolean }>(result);
    if (!row?.locked) {
      console.log(`[auto-matchmaking] session=${sessionId} skipped — another worker holds the lock`);
      return undefined;
    }
    return await fn();
  });
}

// Counts completed games + in-flight (pending/approved/playing) suggestions.
// Both must be zero for the very first match condition.
async function isFirstMatchOfSession(sessionId: string): Promise<boolean> {
  const completedRows = await db
    .select({ id: gameResults.id })
    .from(gameResults)
    .where(eq(gameResults.sessionId, sessionId))
    .limit(1);
  if (completedRows.length > 0) return false;

  const inFlightRows = await db
    .select({ id: matchSuggestions.id })
    .from(matchSuggestions)
    .where(and(
      eq(matchSuggestions.sessionId, sessionId),
      inArray(matchSuggestions.status, ['pending', 'approved', 'playing']),
    ))
    .limit(1);
  return inFlightRows.length === 0;
}

// All player IDs already locked into ANY non-terminal suggestion for this
// session (pending|approved|playing|queued) — they MUST NOT be reassigned
// to a new court by the pending-creation pass. 'queued' is included so a
// player named on a pre-built next-round lineup can never end up
// double-booked into a fresh pending row.
async function getPlayersOnInFlightSuggestions(sessionId: string): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: matchSuggestionPlayers.playerId })
    .from(matchSuggestionPlayers)
    .innerJoin(matchSuggestions, eq(matchSuggestions.id, matchSuggestionPlayers.suggestionId))
    .where(and(
      eq(matchSuggestions.sessionId, sessionId),
      inArray(matchSuggestions.status, ['pending', 'approved', 'playing', 'queued']),
    ));
  return new Set(rows.map(r => r.playerId));
}

// Court IDs that already have a pending/approved/playing/queued suggestion
// — they MUST NOT receive a second pending row. 'queued' is included so
// the orchestrator can never overwrite a pre-built next-round lineup.
async function getCourtsWithInFlightSuggestions(sessionId: string): Promise<Set<string>> {
  const rows = await db
    .select({ courtId: matchSuggestions.courtId })
    .from(matchSuggestions)
    .where(and(
      eq(matchSuggestions.sessionId, sessionId),
      inArray(matchSuggestions.status, ['pending', 'approved', 'playing', 'queued']),
    ));
  return new Set(rows.map(r => r.courtId));
}

// Player IDs already locked into ANY non-terminal suggestion (including
// 'queued' next-round lineups). Used by the queued orchestrator's pool
// computation so a player who is named in one court's queued lineup can't
// be double-assigned to another court's queued lineup in the same pass.
async function getPlayersOnAnyOpenSuggestion(sessionId: string): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: matchSuggestionPlayers.playerId })
    .from(matchSuggestionPlayers)
    .innerJoin(matchSuggestions, eq(matchSuggestions.id, matchSuggestionPlayers.suggestionId))
    .where(and(
      eq(matchSuggestions.sessionId, sessionId),
      inArray(matchSuggestions.status, ['pending', 'approved', 'playing', 'queued']),
    ));
  return new Set(rows.map(r => r.playerId));
}

// Court IDs that already have a 'queued' next-round suggestion — used by
// the queued orchestrator so we don't stack two queued rows on one court.
async function getCourtsWithQueuedSuggestions(sessionId: string): Promise<Set<string>> {
  const rows = await db
    .select({ courtId: matchSuggestions.courtId })
    .from(matchSuggestions)
    .where(and(
      eq(matchSuggestions.sessionId, sessionId),
      eq(matchSuggestions.status, 'queued'),
    ));
  return new Set(rows.map(r => r.courtId));
}

interface Lineup {
  team1Ids: string[];
  team2Ids: string[];
}

// Try Claude exactly once for the first match. Returns null on any failure
// (the caller falls back to the standard algorithm). All failures are logged
// here, so the caller doesn't need to.
async function tryClaudeFirstMatch(
  sessionId: string,
  poolPlayerIds: string[],
  allPlayers: Awaited<ReturnType<typeof storage.getAllPlayers>>,
): Promise<Lineup | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    const reason = 'ANTHROPIC_API_KEY not set';
    console.log(`[auto-matchmaking] fell back to standard algorithm session=${sessionId} elapsedMs=0 reason="${reason}"`);
    emitEvent({ type: 'fallback', sessionId, elapsedMs: 0, reason, ts: Date.now() });
    return null;
  }

  const poolIdSet = new Set(poolPlayerIds);
  const poolPlayers = allPlayers.filter(p => poolIdSet.has(p.id));
  if (poolPlayers.length < 4) {
    const reason = `pool size ${poolPlayers.length} < 4 after resolving ids`;
    console.log(`[auto-matchmaking] fell back to standard algorithm session=${sessionId} elapsedMs=0 reason="${reason}"`);
    emitEvent({ type: 'fallback', sessionId, elapsedMs: 0, reason, ts: Date.now() });
    return null;
  }

  const restStates = poolPlayers.map(p => getPlayerRestState(sessionId, p.id));
  const totalGames = restStates.reduce((sum, rs) => sum + (rs.gamesThisSession || 0), 0);
  const avgGames = poolPlayers.length > 0 ? totalGames / poolPlayers.length : 0;

  const sessionState: ClaudeSessionState = {
    availableCourts: 1, // we only need ONE lineup from Claude
    avgGames: Math.round(avgGames * 10) / 10,
    players: poolPlayers.map(p => {
      const rs = getPlayerRestState(sessionId, p.id);
      return {
        name: p.name,
        score: p.skillScore || 90,
        tier: p.level || 'lower_intermediate',
        gender: p.gender || 'male',
        gamesThisSession: rs.gamesThisSession || 0,
        gamesWaited: rs.gamesWaited || 0,
      };
    }),
  };

  const startedAt = Date.now();
  try {
    const parsed = await requestClaudeMatchmaking(sessionState, { timeoutMs: 5000 });
    const first = parsed.suggestions[0];
    if (!first || !Array.isArray(first.team1) || !Array.isArray(first.team2)) {
      throw new Error('AI response missing first suggestion');
    }

    const playersByNameLower = new Map(allPlayers.map(p => [p.name.toLowerCase(), p]));
    const resolveTeam = (team: { name: string }[]): string[] =>
      team.map(raw => {
        const found = playersByNameLower.get(raw.name.toLowerCase());
        if (!found) throw new Error(`Unknown player name from AI: "${raw.name}"`);
        if (!poolIdSet.has(found.id)) {
          throw new Error(`AI picked player not in waiting pool: "${raw.name}"`);
        }
        return found.id;
      });

    const team1Ids = resolveTeam(first.team1);
    const team2Ids = resolveTeam(first.team2);
    if (team1Ids.length !== 2 || team2Ids.length !== 2) {
      throw new Error(`AI returned malformed lineup (${team1Ids.length}v${team2Ids.length})`);
    }
    const allIds = new Set([...team1Ids, ...team2Ids]);
    if (allIds.size !== 4) {
      throw new Error('AI returned duplicate player ids across teams');
    }

    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[auto-matchmaking] used Claude AI session=${sessionId} elapsedMs=${elapsedMs} ` +
      `lineup=[${team1Ids.join(',')}]vs[${team2Ids.join(',')}] reasoning="${first.reasoning ?? ''}"`,
    );
    emitEvent({ type: 'claude_used', sessionId, elapsedMs, ts: Date.now() });
    return { team1Ids, team2Ids };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const reason = err instanceof Error ? err.message : String(err);
    console.log(
      `[auto-matchmaking] fell back to standard algorithm session=${sessionId} ` +
      `elapsedMs=${elapsedMs} reason="${reason}"`,
    );
    emitEvent({ type: 'fallback', sessionId, elapsedMs, reason, ts: Date.now() });
    return null;
  }
}

// Build a 2v2 lineup from the pool using the existing bracketed generator.
// Returns null if the generator can't produce a viable combo.
function pickStandardLineup(
  sessionId: string,
  poolPlayerIds: string[],
  allPlayers: Awaited<ReturnType<typeof storage.getAllPlayers>>,
): Lineup | null {
  const { brackets } = generateBracketedLineups(sessionId, poolPlayerIds, allPlayers, 1);
  const top = brackets[0];
  if (!top || !top.combination) return null;
  const combo = top.combination;
  const team1Ids = combo.team1.map(p => p.id);
  const team2Ids = combo.team2.map(p => p.id);
  if (team1Ids.length !== 2 || team2Ids.length !== 2) return null;
  return { team1Ids, team2Ids };
}

// Build a 2v2 lineup that MUST contain every id in `mustIncludeIds`,
// padding the rest from `fillFromIds`. Used by the queued-orchestrator's
// Case 2/3 path: when only 1-3 players are waiting, the missing slots are
// filled with the court's currently-playing roster. We try every
// C(fillFromIds, 4 - mustIncludeIds.length) subset, evaluate the 3 team
// permutations of each resulting 4-player set via findBalancedTeams, and
// keep the best (skillGap → splitPenalty → variance — same key as the
// standard generator).
export function pickLineupWithMustInclude(
  sessionId: string,
  mustIncludeIds: string[],
  fillFromIds: string[],
  allPlayers: Awaited<ReturnType<typeof storage.getAllPlayers>>,
): Lineup | null {
  const need = 4 - mustIncludeIds.length;
  if (need <= 0 || need > fillFromIds.length) return null;

  const playersById = new Map(allPlayers.map(p => [p.id, p]));
  const mustInclude: Player[] = [];
  for (const id of mustIncludeIds) {
    const p = playersById.get(id);
    if (!p) return null;
    mustInclude.push(p);
  }
  const fillCandidates: Player[] = [];
  for (const id of fillFromIds) {
    const p = playersById.get(id);
    if (p) fillCandidates.push(p);
  }
  if (fillCandidates.length < need) return null;

  // Enumerate C(fillCandidates, need) subsets.
  const combos: Player[][] = [];
  const pick = (start: number, chosen: Player[]) => {
    if (chosen.length === need) {
      combos.push(chosen.slice());
      return;
    }
    for (let i = start; i < fillCandidates.length; i++) {
      chosen.push(fillCandidates[i]);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);

  let best: { team1Ids: string[]; team2Ids: string[]; skillGap: number; splitPenalty: number; variance: number } | null = null;
  for (const fillCombo of combos) {
    const four = [...mustInclude, ...fillCombo];
    const ranked = findBalancedTeams(four, 1, false, sessionId);
    const top = ranked[0];
    if (!top) continue;
    const candidate = {
      team1Ids: top.team1.map(p => p.id),
      team2Ids: top.team2.map(p => p.id),
      skillGap: top.skillGap,
      splitPenalty: top.splitPenalty,
      variance: top.variance,
    };
    if (!best) {
      best = candidate;
      continue;
    }
    const beats =
      candidate.skillGap < best.skillGap - 0.01 ||
      (Math.abs(candidate.skillGap - best.skillGap) < 0.01 && candidate.splitPenalty < best.splitPenalty) ||
      (Math.abs(candidate.skillGap - best.skillGap) < 0.01 && candidate.splitPenalty === best.splitPenalty && candidate.variance < best.variance);
    if (beats) best = candidate;
  }

  if (!best) return null;
  return { team1Ids: best.team1Ids, team2Ids: best.team2Ids };
}

export async function tryAutoMatchmaking(sessionId: string): Promise<void> {
  try {
    await withSessionLock(sessionId, async () => {
      const session = await storage.getSession(sessionId);
      if (!session || session.status !== 'active') {
        console.log(`[auto-matchmaking] session=${sessionId} skipped — session missing or not active`);
        return;
      }

      const firstMatch = await isFirstMatchOfSession(sessionId);
      const threshold = firstMatch ? FIRST_MATCH_THRESHOLD : SUBSEQUENT_MATCH_THRESHOLD;

      // Hydrate rest states + partner history from completed games so the
      // standard generator and the Claude prompt both see the right
      // gamesThisSession / gamesWaited / partner history. Always loaded
      // here so BOTH passes (pending + queued) have the same view.
      await loadRestStatesFromDb(sessionId);
      const history = await storage.getSessionGameParticipants(sessionId);
      const queue = await storage.getQueue(sessionId);
      buildRestStatesFromHistory(sessionId, history, queue);
      buildPartnerHistoryFromHistory(sessionId, history);

      const allPlayers = await storage.getAllPlayers();

      // ── First pass: pending lineups for available courts ───────────────
      // May skip (pool below threshold, no available courts) — that's
      // fine. The queued pass below STILL runs in those cases so a
      // player who checked in mid-game (every court already playing)
      // still gets a queued lineup built for them eagerly, and
      // courts-in-play get next-round lineups even before any game ends.
      let suggestionsCreated = 0;
      let pendingSkipReason: string | null = null;

      const sittingOut = new Set(getSittingOutPlayers(sessionId));
      const onInFlight = await getPlayersOnInFlightSuggestions(sessionId);
      let pool = queue.filter(id => !sittingOut.has(id) && !onInFlight.has(id));

      const courts = await storage.getCourtsBySession(sessionId);
      const courtsWithInFlight = await getCourtsWithInFlightSuggestions(sessionId);
      const availableCourts = courts.filter(
        c => c.status === 'available' && !courtsWithInFlight.has(c.id),
      );

      if (pool.length < threshold) {
        pendingSkipReason = `pool=${pool.length} < threshold=${threshold} (firstMatch=${firstMatch})`;
      } else if (availableCourts.length === 0) {
        pendingSkipReason = 'no available courts';
      }

      if (pendingSkipReason) {
        console.log(`[auto-matchmaking] session=${sessionId} pending pass skipped — ${pendingSkipReason}`);
        emitEvent({ type: 'skipped', sessionId, reason: pendingSkipReason, ts: Date.now() });
      }

      let iterationIndex = 0;
      while (!pendingSkipReason && pool.length >= 4 && availableCourts.length > 0) {
        const isVeryFirstIteration = iterationIndex === 0 && firstMatch;
        const court = availableCourts.shift()!;

        let lineup: Lineup | null = null;
        if (isVeryFirstIteration) {
          lineup = await tryClaudeFirstMatch(sessionId, pool, allPlayers);
        }
        if (!lineup) {
          // Either Claude declined / failed, or this is not the first
          // iteration — use the standard algorithm.
          lineup = pickStandardLineup(sessionId, pool, allPlayers);
          if (!lineup) {
            console.log(
              `[auto-matchmaking] session=${sessionId} court=${court.id} ` +
              `iteration=${iterationIndex} skipped — bracket generator returned no viable lineup`,
            );
            iterationIndex++;
            continue;
          }
        }

        try {
          await storage.createMatchSuggestion({
            sessionId,
            courtId: court.id,
            pendingUntil: new Date(Date.now() + PENDING_WINDOW_MS),
            players: [
              ...lineup.team1Ids.map(id => ({ playerId: id, team: 1 as const })),
              ...lineup.team2Ids.map(id => ({ playerId: id, team: 2 as const })),
            ],
          });
          suggestionsCreated++;
          console.log(
            `[auto-matchmaking] session=${sessionId} court=${court.id} ` +
            `iteration=${iterationIndex} suggestion created`,
          );
          emitEvent({
            type: 'suggestion_created',
            sessionId,
            courtId: court.id,
            iteration: iterationIndex,
            firstMatch,
            ts: Date.now(),
          });
        } catch (createErr) {
          console.error(
            `[auto-matchmaking] session=${sessionId} court=${court.id} ` +
            `iteration=${iterationIndex} createMatchSuggestion failed:`,
            createErr,
          );
          iterationIndex++;
          continue;
        }

        const usedIds = new Set([...lineup.team1Ids, ...lineup.team2Ids]);
        pool = pool.filter(id => !usedIds.has(id));
        iterationIndex++;
      }

      if (!pendingSkipReason) {
        console.log(
          `[auto-matchmaking] session=${sessionId} pending pass done — ` +
          `created=${suggestionsCreated} firstMatch=${firstMatch}`,
        );
        emitEvent({ type: 'done', sessionId, created: suggestionsCreated, firstMatch, ts: Date.now() });
      }

      // Second pass: queued orchestrator. For every court currently in
      // 'playing' status that does not already have a 'queued' next-round
      // lineup, build one so the Court Captain panel can show "Up next"
      // and the next-round transition is instantaneous when the score is
      // submitted. ALWAYS runs (even when the pending pass above was
      // skipped) — that's the whole point of eager queued generation
      // for players who checked in while every court is busy.
      //
      // Handles Case 1 (pool >= 4 → pure waiting players) and Case 2/3
      // (pool 1-3 → mix in this court's currently-playing roster). When
      // Case 2/3 is used the row is created with includesActivePlayers
      // = true so the game-end transition re-verifies availability
      // before flipping queued → pending; on failure it dismisses the
      // queued row and the regular pending path via tryAutoMatchmaking
      // takes over.
      try {
        await runQueuedOrchestrator(sessionId, allPlayers);
      } catch (orchErr) {
        // Best-effort. The pending lineups are already created above; a
        // failure here just means the next round won't pre-build, which
        // is the same behaviour as before this orchestrator existed.
        console.error(`[queued-orchestrator] session=${sessionId} failed:`, orchErr);
      }
    });
  } catch (err) {
    console.error(`[auto-matchmaking] session=${sessionId} unhandled:`, err);
  }
}

// ─── Queued (next-round) orchestrator ───────────────────────────────────────
// Builds 'queued' suggestions for any in-play court that doesn't already
// have one. Uses the standard bracket generator for a single court, and the
// player-flow Claude prompt (batched, single API call) when 2+ courts need
// queued at the same time.

/**
 * Shared predicate for "this court is currently in play". Accepts BOTH
 * 'occupied' (canonical — set by every admin assign and by the
 * player-driven start path in storage.startApprovedSuggestion) AND
 * 'playing' (defensive — no current write site sets this on the
 * courts table, but if a future path does we still want to build a
 * queued lineup for it). Filtering on 'playing' alone is dead code
 * per the schema enum at shared/schema.ts:147 and was the root cause
 * of task-64 (queued lineups never got built; players only ever saw
 * the read-only projection card). Exported so the regression test
 * exercises the exact predicate the orchestrator uses.
 */
export function isCourtInPlay(court: { status: string }): boolean {
  return court.status === 'occupied' || court.status === 'playing';
}

async function runQueuedOrchestrator(
  sessionId: string,
  allPlayers: Awaited<ReturnType<typeof storage.getAllPlayers>>,
): Promise<void> {
  const allCourts = await storage.getCourtsBySession(sessionId);
  const playingCourts = allCourts.filter(isCourtInPlay);
  if (playingCourts.length === 0) return;

  const courtsWithQueued = await getCourtsWithQueuedSuggestions(sessionId);
  const courtsNeedingQueued = playingCourts.filter(c => !courtsWithQueued.has(c.id));
  if (courtsNeedingQueued.length === 0) return;

  // Pool: queue minus sitting-out minus anyone already on a non-terminal
  // suggestion (pending|approved|playing|queued). May be < 4 — Case 2/3
  // below handles 1-3 by mixing in the court's currently-playing roster.
  const onAnyOpen = await getPlayersOnAnyOpenSuggestion(sessionId);
  const sittingOut = new Set(getSittingOutPlayers(sessionId));
  const queue = await storage.getQueue(sessionId);
  let pool = queue.filter(id => !sittingOut.has(id) && !onAnyOpen.has(id));

  if (pool.length === 0) {
    console.log(`[queued-orchestrator] session=${sessionId} skipped — pool=0 (no waiting players for any case)`);
    return;
  }

  // Tracks which courts have a queued lineup created this run, so each
  // subsequent pass (Claude → standard pure-pool → mixed pool) only
  // touches courts still missing one.
  const filledCourtIds = new Set<string>();

  // ── Case 1 (pure waiting pool) ──────────────────────────────────────────
  // Multi-court Claude path. Only used when 2+ courts need queued AND we
  // have enough players to fill at least 2 lineups (8 players).
  const useClaude = courtsNeedingQueued.length >= 2 && pool.length >= 8 && !!process.env.ANTHROPIC_API_KEY;

  let createdClaude = 0;
  if (useClaude) {
    const result = await tryClaudeQueuedBatch(sessionId, courtsNeedingQueued, pool, allPlayers);
    createdClaude = result.created;
    result.filledCourtIds.forEach(id => filledCourtIds.add(id));
    if (result.usedPlayerIds.size > 0) {
      pool = pool.filter(id => !result.usedPlayerIds.has(id));
    }
    if (createdClaude > 0) {
      console.log(`[queued-orchestrator] session=${sessionId} created ${createdClaude}/${courtsNeedingQueued.length} queued lineup(s) via Claude`);
    }
  }

  // Standard pure-pool generator: covers single-court runs, Claude-skipped
  // runs, AND any courts Claude couldn't fill in a partial response.
  let createdStd = 0;
  for (const court of courtsNeedingQueued) {
    if (filledCourtIds.has(court.id)) continue;
    if (pool.length < 4) break;
    const lineup = pickStandardLineup(sessionId, pool, allPlayers);
    if (!lineup) break;
    try {
      await storage.createMatchSuggestion({
        sessionId,
        courtId: court.id,
        pendingUntil: null,
        status: 'queued',
        includesActivePlayers: false,
        players: [
          ...lineup.team1Ids.map(id => ({ playerId: id, team: 1 as const })),
          ...lineup.team2Ids.map(id => ({ playerId: id, team: 2 as const })),
        ],
      });
      createdStd++;
      filledCourtIds.add(court.id);
      const usedIds = new Set([...lineup.team1Ids, ...lineup.team2Ids]);
      pool = pool.filter(id => !usedIds.has(id));
    } catch (createErr) {
      console.error(`[queued-orchestrator] session=${sessionId} court=${court.id} create failed:`, createErr);
    }
  }
  if (createdStd > 0) {
    console.log(`[queued-orchestrator] session=${sessionId} created ${createdStd} queued lineup(s) via standard generator`);
  }

  // ── Case 2/3 (waiting pool 1-3 → mix in this court's active players) ───
  // For each remaining court, force-include every still-waiting player
  // and fill the remaining slots from THAT court's currently-playing
  // roster. The waiting pool is shared across courts so we drain it as
  // we go; active rosters are per-court so they aren't tracked across
  // iterations. includesActivePlayers=true so the game-end transition
  // re-verifies eligibility before flipping queued→pending.
  let createdMixed = 0;
  for (const court of courtsNeedingQueued) {
    if (filledCourtIds.has(court.id)) continue;
    if (pool.length === 0 || pool.length >= 4) continue;

    const courtPlayerIds = await storage.getCourtPlayers(court.id);
    if (courtPlayerIds.length < 4 - pool.length) continue;

    const lineup = pickLineupWithMustInclude(sessionId, pool, courtPlayerIds, allPlayers);
    if (!lineup) continue;

    try {
      await storage.createMatchSuggestion({
        sessionId,
        courtId: court.id,
        pendingUntil: null,
        status: 'queued',
        includesActivePlayers: true,
        players: [
          ...lineup.team1Ids.map(id => ({ playerId: id, team: 1 as const })),
          ...lineup.team2Ids.map(id => ({ playerId: id, team: 2 as const })),
        ],
      });
      createdMixed++;
      filledCourtIds.add(court.id);
      // Drain ONLY the waiting players from the shared pool. The active
      // court players we mixed in are not in the pool to begin with.
      const waitingSet = new Set(pool);
      const lineupIds = [...lineup.team1Ids, ...lineup.team2Ids];
      const consumedWaiting = new Set(lineupIds.filter(id => waitingSet.has(id)));
      pool = pool.filter(id => !consumedWaiting.has(id));
    } catch (createErr) {
      console.error(`[queued-orchestrator] session=${sessionId} court=${court.id} mixed-pool create failed:`, createErr);
    }
  }
  if (createdMixed > 0) {
    console.log(`[queued-orchestrator] session=${sessionId} created ${createdMixed} queued lineup(s) via mixed-pool generator (Case 2/3, includesActivePlayers=true)`);
  }
}

async function tryClaudeQueuedBatch(
  sessionId: string,
  courtsNeedingQueued: Awaited<ReturnType<typeof storage.getCourtsBySession>>,
  pool: string[],
  allPlayers: Awaited<ReturnType<typeof storage.getAllPlayers>>,
): Promise<{ created: number; filledCourtIds: Set<string>; usedPlayerIds: Set<string> }> {
  const poolIdSet = new Set(pool);
  const poolPlayers = allPlayers.filter(p => poolIdSet.has(p.id));
  const playersById = new Map(poolPlayers.map(p => [p.id, p]));

  // Recent partners/opponents for richer prompts.
  const history = await storage.getSessionGameParticipants(sessionId);
  const recentMap = computeRecentPartnersAndOpponents(history, 3);
  const nameById = new Map(allPlayers.map(p => [p.id, p.name]));
  const playerIdByLowerName = new Map(allPlayers.map(p => [p.name.toLowerCase(), p.id]));

  const profiles: PlayerFlowPlayerProfile[] = poolPlayers.map(p => {
    const rs = getPlayerRestState(sessionId, p.id);
    const recent = recentMap.get(p.id) ?? { partners: [], opponents: [] };
    return {
      name: p.name,
      score: p.skillScore || 90,
      tier: p.level || 'lower_intermediate',
      gender: p.gender || 'male',
      gamesThisSession: rs.gamesThisSession || 0,
      gamesWaited: rs.gamesWaited || 0,
      recentPartners: recent.partners.map(id => nameById.get(id) ?? '').filter(Boolean),
      recentOpponents: recent.opponents.map(id => nameById.get(id) ?? '').filter(Boolean),
    };
  });

  const courtRequests: PlayerFlowCourtRequest[] = courtsNeedingQueued.map((c, idx) => ({
    courtNumber: idx + 1,
    availablePlayerNames: poolPlayers.map(p => p.name),
    mustIncludeNames: [],
  }));

  const startedAt = Date.now();
  let parsed: Awaited<ReturnType<typeof requestPlayerFlowMatchmaking>>;
  try {
    parsed = await requestPlayerFlowMatchmaking(profiles, courtRequests, { timeoutMs: 5000 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`[queued-orchestrator] session=${sessionId} Claude failed elapsedMs=${Date.now() - startedAt} reason="${reason}" — falling back`);
    return { created: 0, filledCourtIds: new Set(), usedPlayerIds: new Set() };
  }

  const usedIds = new Set<string>();
  const filledCourtIds = new Set<string>();
  let created = 0;
  for (let i = 0; i < courtsNeedingQueued.length && i < parsed.suggestions.length; i++) {
    const court = courtsNeedingQueued[i];
    const sug = parsed.suggestions[i];
    if (!sug || !Array.isArray(sug.team1) || !Array.isArray(sug.team2)) continue;

    const resolveTeam = (team: { name: string }[]): string[] | null => {
      const ids: string[] = [];
      for (const raw of team) {
        const id = playerIdByLowerName.get(raw.name.toLowerCase());
        if (!id || !playersById.has(id) || usedIds.has(id)) return null;
        ids.push(id);
      }
      return ids;
    };

    const t1 = resolveTeam(sug.team1);
    const t2 = resolveTeam(sug.team2);
    if (!t1 || !t2 || t1.length !== 2 || t2.length !== 2) continue;
    const all4 = new Set([...t1, ...t2]);
    if (all4.size !== 4) continue;

    try {
      await storage.createMatchSuggestion({
        sessionId,
        courtId: court.id,
        pendingUntil: null,
        status: 'queued',
        includesActivePlayers: false,
        players: [
          ...t1.map(id => ({ playerId: id, team: 1 as const })),
          ...t2.map(id => ({ playerId: id, team: 2 as const })),
        ],
      });
      created++;
      filledCourtIds.add(court.id);
      all4.forEach(id => usedIds.add(id));
    } catch (createErr) {
      console.error(`[queued-orchestrator] session=${sessionId} court=${court.id} Claude-row create failed:`, createErr);
    }
  }
  return { created, filledCourtIds, usedPlayerIds: usedIds };
}

// ─── Game-end queued→pending transition ─────────────────────────────────────
// Called from BOTH score-submit paths (player-driven + admin end-game) AFTER
// the court has been freed and BEFORE tryAutoMatchmaking fires. If there is
// a queued lineup waiting for this court and all four named players are
// still eligible (in queue, not on another in-flight suggestion, not sitting
// out), we flip queued→pending with a fresh 90s pendingUntil. Otherwise we
// dismiss the queued row so tryAutoMatchmaking is free to assign the court
// from scratch.
//
// Returns the suggestion id of the row that was flipped to pending, or null
// if nothing actionable happened. Callers fire-and-forget tryAutoMatchmaking
// regardless — when we flip, the orchestrator's "court has in-flight"
// filter will skip this court (correct), and when we dismiss it, the
// orchestrator will pick it up (also correct).
export async function tryFlipQueuedToPendingForCourt(
  sessionId: string,
  courtId: string,
): Promise<{ flippedId: string | null; dismissedId: string | null }> {
  const queued = await storage.getQueuedSuggestionForCourt(courtId);
  if (!queued) return { flippedId: null, dismissedId: null };

  const namedIds = queued.players.map(p => p.playerId);

  // Branch on includesActivePlayers (per spec):
  //  • false (Case 1 — pure waiting pool): the named players were
  //    explicitly chosen from the queue at orchestrator time and were
  //    excluded from any other in-flight suggestion. Flip directly with
  //    a CAS on status='queued' — no extra eligibility round-trips.
  //  • true (Case 2/3 — mixes in 1+ active court players): we must
  //    re-verify the active players are now actually available (the
  //    score-submit path that called us frees the court immediately
  //    before, so they should be — but a racing /done or admin cancel
  //    can have removed them). Failure → dismiss.
  if (queued.includesActivePlayers) {
    const queue = await storage.getQueue(sessionId);
    const queueSet = new Set(queue);
    const sittingOut = new Set(getSittingOutPlayers(sessionId));

    const otherOpenRows = await db
      .select({ playerId: matchSuggestionPlayers.playerId })
      .from(matchSuggestionPlayers)
      .innerJoin(matchSuggestions, eq(matchSuggestions.id, matchSuggestionPlayers.suggestionId))
      .where(and(
        eq(matchSuggestions.sessionId, sessionId),
        inArray(matchSuggestions.status, ['pending', 'approved', 'playing', 'queued']),
        sql`${matchSuggestions.id} <> ${queued.id}`,
        inArray(matchSuggestionPlayers.playerId, namedIds),
      ));
    const onOtherOpen = new Set(otherOpenRows.map(r => r.playerId));

    const eligible = namedIds.every(id =>
      queueSet.has(id) && !sittingOut.has(id) && !onOtherOpen.has(id),
    );

    if (!eligible) {
      await storage.dismissQueuedSuggestion(queued.id);
      console.log(`[queued-transition] session=${sessionId} court=${courtId} queued=${queued.id} dismissed — Case 2/3 eligibility failed`);
      return { flippedId: null, dismissedId: queued.id };
    }
  }

  const pendingUntil = new Date(Date.now() + PENDING_WINDOW_MS);
  const flipped = await storage.flipQueuedSuggestionToPending(queued.id, pendingUntil);
  if (!flipped) {
    // Race: another worker (admin replace, end-session sweep) just changed
    // the row out from under us. Treat as no-op.
    console.log(`[queued-transition] session=${sessionId} court=${courtId} queued=${queued.id} race lost`);
    return { flippedId: null, dismissedId: null };
  }
  console.log(`[queued-transition] session=${sessionId} court=${courtId} queued=${queued.id} flipped to pending (includesActivePlayers=${queued.includesActivePlayers})`);
  return { flippedId: flipped.id, dismissedId: null };
}

