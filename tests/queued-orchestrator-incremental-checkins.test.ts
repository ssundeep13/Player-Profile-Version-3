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
// This test exercises the two halves of the fix in isolation:
//   1. `dismissBorrowedQueuedRows` actually dismisses borrowed rows
//      (and only borrowed rows) — using mocked storage + db.
//   2. After the tear-down, the partition + look-ahead chain
//      produces queued lineups that name ALL 4 waiters across the 2
//      courts (no waiter silently dropped).
//
// The full integration with createMatchSuggestion + queue/sittingOut
// reads is covered by `scripts/test-e2e-self-service-loop.mjs`.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock storage + db BEFORE importing the SUT ─────────────────────────
// vi.mock factories must be self-contained (hoisted), so we record the
// mock call args via vars exposed in the factory closure.
type MockRow = { id: string; includesActivePlayers: boolean };
const mockDbRows: MockRow[] = [];
const mockDismissCalls: string[] = [];
const mockDismissReturns = new Map<string, MockRow | undefined>();

vi.mock('../server/db', () => {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => mockDbRows.slice(),
        }),
      }),
    },
  };
});

vi.mock('../server/storage', () => {
  return {
    storage: {
      dismissQueuedSuggestion: async (id: string) => {
        mockDismissCalls.push(id);
        return mockDismissReturns.get(id);
      },
      // The other storage methods aren't used by the helper under test.
    },
  };
});

import {
  dismissBorrowedQueuedRows,
  pickLineupWithLookahead,
  partitionWaitersAcrossCourts,
} from '../server/auto-matchmaking';
import type { Player } from '@shared/schema';

function mkPlayer(id: string, name: string, score: number, level = 'lower_intermediate'): Player {
  return { id, name, skillScore: score, level, gender: 'male' } as unknown as Player;
}

describe('Task #69 — incremental check-ins absorb all waiters', () => {
  beforeEach(() => {
    mockDbRows.length = 0;
    mockDismissCalls.length = 0;
    mockDismissReturns.clear();
  });

  // ── Half 1: tear-down helper ─────────────────────────────────────────
  describe('dismissBorrowedQueuedRows', () => {
    it('dismisses every borrowed (includesActivePlayers=true) row', async () => {
      mockDbRows.push(
        { id: 'sug-borrowed-A', includesActivePlayers: true },
        { id: 'sug-borrowed-B', includesActivePlayers: true },
      );
      mockDismissReturns.set('sug-borrowed-A', { id: 'sug-borrowed-A', includesActivePlayers: true });
      mockDismissReturns.set('sug-borrowed-B', { id: 'sug-borrowed-B', includesActivePlayers: true });

      const dismissed = await dismissBorrowedQueuedRows('session-1');

      expect(dismissed).toBe(2);
      expect(mockDismissCalls).toEqual(['sug-borrowed-A', 'sug-borrowed-B']);
    });

    it('leaves pure-waiting (includesActivePlayers=false) rows alone', async () => {
      mockDbRows.push(
        { id: 'sug-pure', includesActivePlayers: false },
        { id: 'sug-borrowed', includesActivePlayers: true },
      );
      mockDismissReturns.set('sug-borrowed', { id: 'sug-borrowed', includesActivePlayers: true });

      const dismissed = await dismissBorrowedQueuedRows('session-1');

      expect(dismissed).toBe(1);
      // Only the borrowed row was dismissed — the pure-waiting one
      // never appears in the call list.
      expect(mockDismissCalls).toEqual(['sug-borrowed']);
    });

    it('returns 0 (and makes no calls) when there are no queued rows', async () => {
      const dismissed = await dismissBorrowedQueuedRows('session-empty');
      expect(dismissed).toBe(0);
      expect(mockDismissCalls).toEqual([]);
    });

    it('counts CAS losers (undefined return) as not-dismissed', async () => {
      // Simulates: row was borrowed at SELECT time, but flipped to
      // pending|dismissed by another path between the SELECT and the
      // CAS UPDATE inside dismissQueuedSuggestion. The orchestrator
      // must keep going (don't crash, don't double-count).
      mockDbRows.push(
        { id: 'sug-cas-loser', includesActivePlayers: true },
        { id: 'sug-cas-winner', includesActivePlayers: true },
      );
      mockDismissReturns.set('sug-cas-loser', undefined);
      mockDismissReturns.set('sug-cas-winner', { id: 'sug-cas-winner', includesActivePlayers: true });

      const dismissed = await dismissBorrowedQueuedRows('session-race');

      expect(dismissed).toBe(1);
      // Both rows were attempted — only one came back populated.
      expect(mockDismissCalls).toEqual(['sug-cas-loser', 'sug-cas-winner']);
    });
  });

  // ── Half 2: post-tear-down partition + look-ahead ────────────────────
  describe('post-tear-down rebuild covers all 4 waiters', () => {
    it('with 2 occupied courts + 4 waiters, both queued rows name all 4 waiters', () => {
      // The exact shape of the user's reported repro: 4 female waiters
      // (low skill, all Beginner) + 2 courts of 4 mid-tier active
      // males each. After tear-down, the orchestrator's pool = all 4
      // waiters (no longer locked into stale borrowed rows).
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

      // Round-robin partition: A = [f1, f3], B = [f2, f4].
      const partition = partitionWaitersAcrossCourts(waiterPool, ['courtA', 'courtB']);
      expect(partition.get('courtA')).toEqual(['f1', 'f3']);
      expect(partition.get('courtB')).toEqual(['f2', 'f4']);

      // Each court runs look-ahead with its 2 partitioned waiters.
      const resultA = pickLineupWithLookahead(
        'session-1',
        partition.get('courtA')!,
        [],
        courtAActive,
        allPlayers,
      );
      const resultB = pickLineupWithLookahead(
        'session-1',
        partition.get('courtB')!,
        [],
        courtBActive,
        allPlayers,
      );

      expect(resultA).not.toBeNull();
      expect(resultB).not.toBeNull();

      const lineupA = new Set([...resultA!.lineup.team1Ids, ...resultA!.lineup.team2Ids]);
      const lineupB = new Set([...resultB!.lineup.team1Ids, ...resultB!.lineup.team2Ids]);

      // Every waiter ends up in a queued lineup — F3/F4 are no
      // longer locked out (the bug the fix resolves).
      expect(lineupA.has('f1')).toBe(true);
      expect(lineupA.has('f3')).toBe(true);
      expect(lineupB.has('f2')).toBe(true);
      expect(lineupB.has('f4')).toBe(true);

      // Sanity: 2 weak waiters + active borrows means borrowing was
      // necessary to balance — the rows should be tagged with
      // includesActivePlayers=true so the game-end transition's
      // re-verify step (tryFlipQueuedToPendingForCourt) double-checks
      // the borrowed actives are still eligible before flipping.
      expect(resultA!.includesActive).toBe(true);
      expect(resultB!.includesActive).toBe(true);

      // Borrows from each court must come from THAT court's active
      // roster only — never from the other court's. Cross-court
      // borrowing is the orchestrator's responsibility to forbid; the
      // look-ahead helper only sees one court's roster at a time, so
      // this also documents that contract.
      const borrowsA = [...lineupA].filter(id => id.startsWith('a'));
      const borrowsB = [...lineupB].filter(id => id.startsWith('b'));
      expect(borrowsA.length).toBe(2);
      expect(borrowsB.length).toBe(2);
    });
  });
});
