// Task #69 regression: incremental check-ins must not lock out later
// waiters from getting a queued ("Up next") lineup.
//
// Bug history: when 4 female waiters checked in one-by-one to a session
// with 2 already-occupied courts, the queued orchestrator built greedy
// borrowed rows on the first 2 check-ins (court A = [F1 + 3 borrowed
// actives], court B = [F2 + 3 borrowed]), then SKIPPED entirely on the
// 3rd and 4th check-ins because both courts already had a queued row.
// F3 and F4 were left with only the read-only ProjectionCard
// ("You're #4 in the queue"), never the OnDeckCard with team names.
//
// Fix (replace-in-place): each orchestrator run snapshots existing
// borrowed queued rows, returns their players to the rebuild pool,
// and only DISMISSES each old borrowed row AFTER the per-court
// replacement is successfully created. If a per-court rebuild
// returns null or throws, that court's prior borrowed row stays in
// place — players never regress from OnDeckCard back to the
// read-only ProjectionCard.
//
// Three scopes:
//   1. snapshotQueuedRows classifies borrowed vs pure-waiting rows
//      and returns the borrowed-player pool.
//   2. Post-snapshot partition + look-ahead chain produces queued
//      lineups that name ALL 4 waiters.
//   3. End-to-end orchestrator run with a stateful mock store:
//      a. Pre-seed 2 borrowed queued rows + queue=[F1..F4] →
//         orchestrator dismisses them AND creates 2 new queued
//         rows naming all 4 waiters.
//      b. Force a per-court create failure → that court's old
//         borrowed row stays in place; the other court still
//         gets its replacement.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Stateful mock store (shared between db + storage mocks) ──────────
type MockSuggestion = {
  id: string;
  sessionId: string;
  courtId: string;
  status: string;
  includesActivePlayers: boolean;
  players: { playerId: string; team: number }[];
};

type MockCourt = { id: string; name: string; status: string };

const mockState = {
  suggestions: [] as MockSuggestion[],
  courts: [] as MockCourt[],
  courtPlayers: new Map<string, string[]>(),
  queue: [] as string[],
  nextId: 1,
};

const mockDismissCalls: string[] = [];
const mockCreateCalls: Array<{
  sessionId: string;
  courtId: string;
  status: string;
  includesActivePlayers: boolean;
  players: { playerId: string; team: number }[];
}> = [];

function resetMockState() {
  mockState.suggestions.length = 0;
  mockState.courts.length = 0;
  mockState.courtPlayers.clear();
  mockState.queue.length = 0;
  mockState.nextId = 1;
  mockDismissCalls.length = 0;
  mockCreateCalls.length = 0;
}

// ── db mock: dispatches by inspecting the projected columns ─────────
// The orchestrator hits these db.select() shapes:
//   snapshotQueuedRows step 1 → cols includes `includesActivePlayers`
//                               (selects id, courtId, includesActivePlayers)
//   snapshotQueuedRows step 2 → cols only has `playerId` from
//                               matchSuggestionPlayers (no join)
//   getPlayersOnAnyOpenSuggestion → cols has `playerId` (joined query)
// Both `playerId` queries use the same dispatcher branch but return
// different things based on whether innerJoin was called.
vi.mock('../server/db', () => {
  return {
    db: {
      select: (cols: Record<string, unknown>) => {
        const keys = Object.keys(cols ?? {});
        let joined = false;
        const chain = {
          from: (_table: unknown) => chain,
          innerJoin: (_table: unknown, _cond: unknown) => {
            joined = true;
            return chain;
          },
          where: (_cond: unknown) => {
            if (keys.includes('includesActivePlayers')) {
              return mockState.suggestions
                .filter(s => s.status === 'queued')
                .map(s => ({
                  id: s.id,
                  courtId: s.courtId,
                  includesActivePlayers: s.includesActivePlayers,
                }));
            }
            if (keys.includes('playerId')) {
              if (joined) {
                // getPlayersOnAnyOpenSuggestion: pending|approved|playing|queued.
                const open = new Set(['pending', 'approved', 'playing', 'queued']);
                return mockState.suggestions
                  .filter(s => open.has(s.status))
                  .flatMap(s => s.players.map(p => ({ playerId: p.playerId })));
              }
              // snapshotQueuedRows step 2: borrowed-queued players only.
              // The orchestrator passes inArray(suggestionId, borrowedIds);
              // since the dispatcher can't introspect the WHERE, return
              // every player from every borrowed-queued row.
              return mockState.suggestions
                .filter(s => s.status === 'queued' && s.includesActivePlayers)
                .flatMap(s => s.players.map(p => ({ playerId: p.playerId })));
            }
            return [];
          },
        };
        return chain;
      },
    },
  };
});

vi.mock('../server/storage', () => {
  return {
    storage: {
      getCourtsBySession: async (_sessionId: string) => mockState.courts.slice(),
      getCourtPlayers: async (courtId: string) => (mockState.courtPlayers.get(courtId) ?? []).slice(),
      getQueue: async (_sessionId: string) => mockState.queue.slice(),
      dismissQueuedSuggestion: async (id: string) => {
        mockDismissCalls.push(id);
        const row = mockState.suggestions.find(s => s.id === id && s.status === 'queued');
        if (!row) return undefined;
        row.status = 'dismissed';
        return { ...row };
      },
      createMatchSuggestion: async (input: {
        sessionId: string;
        courtId: string;
        pendingUntil: Date | null;
        status: string;
        includesActivePlayers: boolean;
        players: { playerId: string; team: number }[];
      }) => {
        mockCreateCalls.push({
          sessionId: input.sessionId,
          courtId: input.courtId,
          status: input.status,
          includesActivePlayers: input.includesActivePlayers,
          players: input.players.slice(),
        });
        const row: MockSuggestion = {
          id: `sug-new-${mockState.nextId++}`,
          sessionId: input.sessionId,
          courtId: input.courtId,
          status: input.status,
          includesActivePlayers: input.includesActivePlayers,
          players: input.players.slice(),
        };
        mockState.suggestions.push(row);
        return row;
      },
    },
  };
});

vi.mock('../server/matchmaking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/matchmaking')>();
  return {
    ...actual,
    getSittingOutPlayers: (_sessionId: string) => [] as string[],
  };
});

import {
  snapshotQueuedRows,
  pickLineupWithLookahead,
  partitionWaitersAcrossCourts,
  runQueuedOrchestrator,
} from '../server/auto-matchmaking';
import type { Player } from '@shared/schema';
import { storage } from '../server/storage';

// Builds a Player satisfying the shape the orchestrator passes through
// to the lineup generator. The full Drizzle row has many more columns
// (timestamps, marketplace fields, etc.) — we cast the literal once
// at the constructor boundary so individual call sites stay clean.
function mkPlayer(id: string, name: string, score: number): Player {
  const partial = {
    id,
    name,
    skillScore: score,
    level: 'lower_intermediate',
    gender: 'male',
    isActive: true,
    createdAt: new Date(),
  };
  return partial as unknown as Player;
}

function mkAllPlayers(): Player[] {
  return [
    mkPlayer('f1', 'Female 1', 60),
    mkPlayer('f2', 'Female 2', 62),
    mkPlayer('f3', 'Female 3', 58),
    mkPlayer('f4', 'Female 4', 65),
    mkPlayer('a1', 'A1', 95),
    mkPlayer('a2', 'A2', 100),
    mkPlayer('a3', 'A3', 90),
    mkPlayer('a4', 'A4', 88),
    mkPlayer('b1', 'B1', 98),
    mkPlayer('b2', 'B2', 92),
    mkPlayer('b3', 'B3', 105),
    mkPlayer('b4', 'B4', 87),
  ];
}

describe('Task #69 — incremental check-ins absorb all waiters', () => {
  beforeEach(() => {
    resetMockState();
  });

  // ── Half 1: snapshot helper in isolation ─────────────────────────
  describe('snapshotQueuedRows', () => {
    it('classifies borrowed vs pure-waiting rows and collects borrowed-player IDs', async () => {
      mockState.suggestions.push(
        {
          id: 'sug-borrowed-A',
          sessionId: 's1',
          courtId: 'cA',
          status: 'queued',
          includesActivePlayers: true,
          players: [
            { playerId: 'f1', team: 1 },
            { playerId: 'a1', team: 1 },
            { playerId: 'a2', team: 2 },
            { playerId: 'a3', team: 2 },
          ],
        },
        {
          id: 'sug-pure-B',
          sessionId: 's1',
          courtId: 'cB',
          status: 'queued',
          includesActivePlayers: false,
          players: [
            { playerId: 'f2', team: 1 },
            { playerId: 'f3', team: 1 },
            { playerId: 'f4', team: 2 },
            { playerId: 'f5', team: 2 },
          ],
        },
      );

      const snap = await snapshotQueuedRows('s1');

      expect(snap.borrowedSuggestionByCourtId.get('cA')).toBe('sug-borrowed-A');
      expect(snap.borrowedSuggestionByCourtId.has('cB')).toBe(false);
      expect(snap.courtsWithPureQueued.has('cB')).toBe(true);
      expect(snap.courtsWithPureQueued.has('cA')).toBe(false);
      // Borrowed-player set covers all 4 players from the borrowed row.
      expect([...snap.borrowedPlayerIds].sort()).toEqual(['a1', 'a2', 'a3', 'f1']);
    });

    it('returns empty maps when no queued rows exist', async () => {
      const snap = await snapshotQueuedRows('s-empty');
      expect(snap.borrowedSuggestionByCourtId.size).toBe(0);
      expect(snap.courtsWithPureQueued.size).toBe(0);
      expect(snap.borrowedPlayerIds.size).toBe(0);
    });
  });

  // ── Half 2: post-snapshot partition + look-ahead chain ───────────
  describe('partition + look-ahead rebuild covers all 4 waiters', () => {
    it('with 2 occupied courts + 4 waiters, both queued lineups name all 4 waiters', () => {
      const allPlayers = mkAllPlayers();
      const courtAActive = ['a1', 'a2', 'a3', 'a4'];
      const courtBActive = ['b1', 'b2', 'b3', 'b4'];
      const waiterPool = ['f1', 'f2', 'f3', 'f4'];

      const partition = partitionWaitersAcrossCourts(waiterPool, ['courtA', 'courtB']);
      expect(partition.get('courtA')).toEqual(['f1', 'f3']);
      expect(partition.get('courtB')).toEqual(['f2', 'f4']);

      const resultA = pickLineupWithLookahead('s1', partition.get('courtA')!, [], courtAActive, allPlayers);
      const resultB = pickLineupWithLookahead('s1', partition.get('courtB')!, [], courtBActive, allPlayers);

      expect(resultA).not.toBeNull();
      expect(resultB).not.toBeNull();

      const lineupA = new Set([...resultA!.lineup.team1Ids, ...resultA!.lineup.team2Ids]);
      const lineupB = new Set([...resultB!.lineup.team1Ids, ...resultB!.lineup.team2Ids]);

      expect(lineupA.has('f1')).toBe(true);
      expect(lineupA.has('f3')).toBe(true);
      expect(lineupB.has('f2')).toBe(true);
      expect(lineupB.has('f4')).toBe(true);

      expect(resultA!.includesActive).toBe(true);
      expect(resultB!.includesActive).toBe(true);
    });
  });

  // ── Half 3: full orchestrator integration ────────────────────────
  describe('runQueuedOrchestrator end-to-end', () => {
    function seedTwoOccupiedCourts() {
      mockState.courts.push(
        { id: 'courtA', name: 'Court A', status: 'occupied' },
        { id: 'courtB', name: 'Court B', status: 'occupied' },
      );
      mockState.courtPlayers.set('courtA', ['a1', 'a2', 'a3', 'a4']);
      mockState.courtPlayers.set('courtB', ['b1', 'b2', 'b3', 'b4']);
      mockState.queue.push('f1', 'f2', 'f3', 'f4');
    }

    function seedStaleBorrowedRows() {
      mockState.suggestions.push(
        {
          id: 'sug-stale-A',
          sessionId: 's-test',
          courtId: 'courtA',
          status: 'queued',
          includesActivePlayers: true,
          players: [
            { playerId: 'f1', team: 1 },
            { playerId: 'a1', team: 1 },
            { playerId: 'a2', team: 2 },
            { playerId: 'a3', team: 2 },
          ],
        },
        {
          id: 'sug-stale-B',
          sessionId: 's-test',
          courtId: 'courtB',
          status: 'queued',
          includesActivePlayers: true,
          players: [
            { playerId: 'f2', team: 1 },
            { playerId: 'b1', team: 1 },
            { playerId: 'b2', team: 2 },
            { playerId: 'b3', team: 2 },
          ],
        },
      );
    }

    it('replaces both stale borrowed rows; new queued rows name all 4 waiters', async () => {
      seedTwoOccupiedCourts();
      seedStaleBorrowedRows();

      await runQueuedOrchestrator('s-test', mkAllPlayers());

      // Both stale borrowed rows dismissed (replaced after create).
      expect(mockDismissCalls.sort()).toEqual(['sug-stale-A', 'sug-stale-B']);
      const stillQueuedFromStale = mockState.suggestions
        .filter(s => ['sug-stale-A', 'sug-stale-B'].includes(s.id))
        .filter(s => s.status === 'queued');
      expect(stillQueuedFromStale).toEqual([]);

      // Two new queued rows, one per court, all 4 waiters covered.
      const queuedCreates = mockCreateCalls.filter(c => c.status === 'queued');
      expect(queuedCreates).toHaveLength(2);
      expect(new Set(queuedCreates.map(c => c.courtId))).toEqual(new Set(['courtA', 'courtB']));

      const allCreatedPlayerIds = new Set(
        queuedCreates.flatMap(c => c.players.map(p => p.playerId)),
      );
      for (const fid of ['f1', 'f2', 'f3', 'f4']) {
        expect(allCreatedPlayerIds.has(fid)).toBe(true);
      }

      // Each new row is a complete 4-player 2v2 lineup.
      for (const c of queuedCreates) {
        expect(c.players).toHaveLength(4);
        expect(c.players.filter(p => p.team === 1)).toHaveLength(2);
        expect(c.players.filter(p => p.team === 2)).toHaveLength(2);
      }

      // No cross-court borrowing (each row's borrowed actives stay
      // within their own court's roster).
      const rowA = queuedCreates.find(c => c.courtId === 'courtA')!;
      const rowB = queuedCreates.find(c => c.courtId === 'courtB')!;
      for (const id of rowA.players.map(p => p.playerId)) {
        expect(['b1', 'b2', 'b3', 'b4']).not.toContain(id);
      }
      for (const id of rowB.players.map(p => p.playerId)) {
        expect(['a1', 'a2', 'a3', 'a4']).not.toContain(id);
      }
    });

    it('preserves a court\'s prior borrowed row when its rebuild fails (partial-failure safety)', async () => {
      // Seeds the same 2-court / 4-waiter / 2-stale-row state, then
      // forces createMatchSuggestion to throw the FIRST time it's
      // called (court A's rebuild). Court B's rebuild still
      // succeeds, so its stale borrowed row gets replaced; court A's
      // stale row must be left in place so its players keep seeing
      // their existing OnDeckCard.
      seedTwoOccupiedCourts();
      seedStaleBorrowedRows();

      const realCreate = storage.createMatchSuggestion.bind(storage);
      const createSpy = vi.spyOn(storage, 'createMatchSuggestion')
        .mockImplementationOnce(async () => {
          throw new Error('simulated DB failure for court A');
        })
        .mockImplementation(realCreate);

      await runQueuedOrchestrator('s-test', mkAllPlayers());

      createSpy.mockRestore();

      // Court A's stale row must STILL be queued — partial-failure
      // safety means the orchestrator never strands a court without
      // any queued lineup.
      const staleA = mockState.suggestions.find(s => s.id === 'sug-stale-A');
      expect(staleA?.status).toBe('queued');
      expect(mockDismissCalls).not.toContain('sug-stale-A');

      // Court B's stale row was successfully replaced.
      expect(mockDismissCalls).toContain('sug-stale-B');
      const staleB = mockState.suggestions.find(s => s.id === 'sug-stale-B');
      expect(staleB?.status).toBe('dismissed');

      // Court A's create threw before reaching the recorder; court B's
      // create persisted normally. Net result: exactly one new queued
      // row in storage, on court B.
      const persistedQueued = mockState.suggestions.filter(
        s => s.status === 'queued' && !['sug-stale-A', 'sug-stale-B'].includes(s.id),
      );
      expect(persistedQueued).toHaveLength(1);
      expect(persistedQueued[0].courtId).toBe('courtB');
      // The create attempt counter (only the success path records) reflects 1.
      expect(mockCreateCalls.filter(c => c.status === 'queued')).toHaveLength(1);
    });
  });
});
