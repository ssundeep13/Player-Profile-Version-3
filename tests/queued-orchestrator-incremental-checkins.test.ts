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
// Fix: at the top of every orchestrator run, dismiss any existing
// borrowed (`includesActivePlayers=true`) queued row so the rebuild
// can absorb the larger waiter pool. Pure-waiting queued rows are
// left alone (they're already optimal — no churn on score-submit).
//
// This file exercises three scopes:
//   1. The pure tear-down helper `dismissBorrowedQueuedRows` (mocks
//      storage + db only).
//   2. The post-tear-down partition + look-ahead chain produces
//      queued lineups that name ALL 4 waiters.
//   3. End-to-end orchestrator run with a stateful mock store: pre-
//      seed 2 borrowed queued rows + queue=[F1..F4], invoke
//      `runQueuedOrchestrator`, assert the 2 borrowed rows are
//      dismissed and 2 new queued rows are created naming all 4
//      waiters across the 2 courts.

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
// runQueuedOrchestrator hits these db.select() shapes (in order):
//   #1 tear-down            → cols includes `includesActivePlayers`
//   #2 courts-with-queued   → cols only has `courtId`
//   #3 players-on-any-open  → cols includes `playerId` (joined query)
// Other table reads go through the mocked `storage` API below.
vi.mock('../server/db', () => {
  return {
    db: {
      select: (cols: Record<string, unknown>) => {
        const keys = Object.keys(cols ?? {});
        const chain = {
          from: (_table: unknown) => chain,
          innerJoin: (_table: unknown, _cond: unknown) => chain,
          where: (_cond: unknown) => {
            if (keys.includes('includesActivePlayers')) {
              return mockState.suggestions
                .filter(s => s.status === 'queued')
                .map(s => ({ id: s.id, includesActivePlayers: s.includesActivePlayers }));
            }
            if (keys.includes('playerId')) {
              const openStatuses = new Set(['pending', 'approved', 'playing', 'queued']);
              return mockState.suggestions
                .filter(s => openStatuses.has(s.status))
                .flatMap(s => s.players.map(p => ({ playerId: p.playerId })));
            }
            if (keys.includes('courtId')) {
              return mockState.suggestions
                .filter(s => s.status === 'queued')
                .map(s => ({ courtId: s.courtId }));
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

// matchmaking exports getSittingOutPlayers (in-memory). The orchestrator
// reads it to filter the pool. Default empty for these tests.
vi.mock('../server/matchmaking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/matchmaking')>();
  return {
    ...actual,
    getSittingOutPlayers: (_sessionId: string) => [] as string[],
  };
});

// SUT imports MUST come AFTER vi.mock calls (which are hoisted, but
// imports are still evaluated lazily here).
import {
  dismissBorrowedQueuedRows,
  pickLineupWithLookahead,
  partitionWaitersAcrossCourts,
  runQueuedOrchestrator,
} from '../server/auto-matchmaking';
import type { Player } from '@shared/schema';

function mkPlayer(id: string, name: string, score: number, level = 'lower_intermediate'): Player {
  return { id, name, skillScore: score, level, gender: 'male' } as unknown as Player;
}

describe('Task #69 — incremental check-ins absorb all waiters', () => {
  beforeEach(() => {
    resetMockState();
  });

  // ── Half 1: tear-down helper in isolation ────────────────────────
  describe('dismissBorrowedQueuedRows', () => {
    it('dismisses every borrowed (includesActivePlayers=true) row', async () => {
      mockState.suggestions.push(
        { id: 'sug-borrowed-A', sessionId: 's1', courtId: 'cA', status: 'queued', includesActivePlayers: true, players: [] },
        { id: 'sug-borrowed-B', sessionId: 's1', courtId: 'cB', status: 'queued', includesActivePlayers: true, players: [] },
      );

      const dismissed = await dismissBorrowedQueuedRows('s1');

      expect(dismissed).toBe(2);
      expect(mockDismissCalls).toEqual(['sug-borrowed-A', 'sug-borrowed-B']);
    });

    it('leaves pure-waiting (includesActivePlayers=false) rows alone', async () => {
      mockState.suggestions.push(
        { id: 'sug-pure', sessionId: 's1', courtId: 'cA', status: 'queued', includesActivePlayers: false, players: [] },
        { id: 'sug-borrowed', sessionId: 's1', courtId: 'cB', status: 'queued', includesActivePlayers: true, players: [] },
      );

      const dismissed = await dismissBorrowedQueuedRows('s1');

      expect(dismissed).toBe(1);
      expect(mockDismissCalls).toEqual(['sug-borrowed']);
    });

    it('returns 0 (and makes no calls) when there are no queued rows', async () => {
      const dismissed = await dismissBorrowedQueuedRows('s-empty');
      expect(dismissed).toBe(0);
      expect(mockDismissCalls).toEqual([]);
    });

    it('counts CAS losers (suggestion already flipped) as not-dismissed', async () => {
      mockState.suggestions.push(
        // CAS loser: already not 'queued' by the time dismiss runs.
        { id: 'sug-cas-loser', sessionId: 's1', courtId: 'cA', status: 'queued', includesActivePlayers: true, players: [] },
        { id: 'sug-cas-winner', sessionId: 's1', courtId: 'cB', status: 'queued', includesActivePlayers: true, players: [] },
      );
      // Race: simulate the CAS loser by pre-flipping its status before
      // the helper runs. The mock storage.dismissQueuedSuggestion only
      // returns a row when its status is still 'queued'.
      const cas = mockState.suggestions.find(s => s.id === 'sug-cas-loser')!;
      // Override: set up so the SELECT still returns the row (we want
      // to test the dismiss call's behaviour), then flip status to
      // simulate a concurrent transition between SELECT and UPDATE.
      const originalDismiss = mockState.suggestions;
      // Trick: flip the status AFTER the SELECT. We do that by spying
      // on db's where call: easier — flip status immediately AFTER the
      // initial SELECT but BEFORE the dismiss loop. Use a setTimeout
      // pattern via microtask: pre-flip is simplest because the helper
      // SELECTs first then iterates. So flip BEFORE calling helper —
      // SELECT will see 'queued' (in our mock the SELECT runs against
      // current state at call time; we need a CAS-loser flow). The
      // simplest fix: the mock db SELECT captures a snapshot, so we
      // mutate after. But our mock returns a fresh filter each call,
      // so we need to flip between SELECT and dismiss. Use a Proxy on
      // dismissQueuedSuggestion? Simpler: let the helper's SELECT
      // include the row (status='queued'), then arrange that dismiss
      // returns undefined for that id. Replace mock impl for this
      // test by overriding once.
      const realDismiss = (await import('../server/storage')).storage.dismissQueuedSuggestion;
      const spy = vi.spyOn((await import('../server/storage')).storage, 'dismissQueuedSuggestion')
        .mockImplementationOnce(async (id: string) => {
          mockDismissCalls.push(id);
          // CAS loser → undefined return, no state mutation.
          return undefined;
        });

      const dismissed = await dismissBorrowedQueuedRows('s1');

      expect(dismissed).toBe(1); // only sug-cas-winner counted
      expect(mockDismissCalls).toEqual(['sug-cas-loser', 'sug-cas-winner']);

      spy.mockRestore();
      // touch unused refs to satisfy lint
      void originalDismiss;
      void realDismiss;
      void cas;
    });
  });

  // ── Half 2: post-tear-down partition + look-ahead chain ──────────
  describe('post-tear-down rebuild covers all 4 waiters', () => {
    it('with 2 occupied courts + 4 waiters, both queued rows name all 4 waiters', () => {
      const allPlayers = [
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

      const borrowsA = [...lineupA].filter(id => id.startsWith('a'));
      const borrowsB = [...lineupB].filter(id => id.startsWith('b'));
      expect(borrowsA.length).toBe(2);
      expect(borrowsB.length).toBe(2);
    });
  });

  // ── Half 3: full orchestrator integration with mocked storage ────
  describe('runQueuedOrchestrator end-to-end (incremental-checkin scenario)', () => {
    it('dismisses pre-existing borrowed rows AND creates 2 new queued rows naming all 4 waiters', async () => {
      // Session shape: 2 courts in play, each with 4 mid-tier active
      // males. Queue contains all 4 female waiters (the user's
      // task #69 repro state right after F4 checks in).
      mockState.courts.push(
        { id: 'courtA', name: 'Court A', status: 'occupied' },
        { id: 'courtB', name: 'Court B', status: 'occupied' },
      );
      mockState.courtPlayers.set('courtA', ['a1', 'a2', 'a3', 'a4']);
      mockState.courtPlayers.set('courtB', ['b1', 'b2', 'b3', 'b4']);
      mockState.queue.push('f1', 'f2', 'f3', 'f4');

      // Pre-seed the bug state: 2 borrowed queued rows (the leftovers
      // from F1's and F2's earlier solo check-ins). Without the
      // task #69 fix, the orchestrator would see "both courts already
      // have a queued row" and skip — F3/F4 stay on ProjectionCard.
      mockState.suggestions.push({
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
      });
      mockState.suggestions.push({
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
      });

      const allPlayers = [
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

      await runQueuedOrchestrator('s-test', allPlayers as any);

      // ── Tear-down assertion: both stale borrowed rows dismissed.
      expect(mockDismissCalls.sort()).toEqual(['sug-stale-A', 'sug-stale-B']);
      const stillQueuedFromStale = mockState.suggestions
        .filter(s => ['sug-stale-A', 'sug-stale-B'].includes(s.id))
        .filter(s => s.status === 'queued');
      expect(stillQueuedFromStale).toEqual([]);

      // ── Rebuild assertion: 2 new createMatchSuggestion calls,
      // both with status='queued', covering all 4 waiters.
      const queuedCreates = mockCreateCalls.filter(c => c.status === 'queued');
      expect(queuedCreates).toHaveLength(2);

      const courtsCovered = new Set(queuedCreates.map(c => c.courtId));
      expect(courtsCovered).toEqual(new Set(['courtA', 'courtB']));

      const allCreatedPlayerIds = new Set(
        queuedCreates.flatMap(c => c.players.map(p => p.playerId)),
      );
      expect(allCreatedPlayerIds.has('f1')).toBe(true);
      expect(allCreatedPlayerIds.has('f2')).toBe(true);
      expect(allCreatedPlayerIds.has('f3')).toBe(true);
      expect(allCreatedPlayerIds.has('f4')).toBe(true);

      // Sanity: each new row is a complete 4-player lineup with 2 vs 2.
      for (const c of queuedCreates) {
        expect(c.players).toHaveLength(4);
        expect(c.players.filter(p => p.team === 1)).toHaveLength(2);
        expect(c.players.filter(p => p.team === 2)).toHaveLength(2);
      }

      // Sanity: borrows stay within the same court (no cross-court
      // borrowing, which would break the 4-named-roster contract).
      const rowA = queuedCreates.find(c => c.courtId === 'courtA')!;
      const rowB = queuedCreates.find(c => c.courtId === 'courtB')!;
      const aPlayerIds = new Set(rowA.players.map(p => p.playerId));
      const bPlayerIds = new Set(rowB.players.map(p => p.playerId));
      // Court A row contains no court-B active players.
      for (const id of aPlayerIds) {
        expect(['b1', 'b2', 'b3', 'b4']).not.toContain(id);
      }
      for (const id of bPlayerIds) {
        expect(['a1', 'a2', 'a3', 'a4']).not.toContain(id);
      }
    });
  });
});
