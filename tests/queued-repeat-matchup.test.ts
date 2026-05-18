// Queued suggestions must not repeat the same four-player matchup within
// a session (including borrowing the court's active roster mid-game).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/db', () => {
  return {
    db: {
      select: () => {
        const chain = {
          from: (_table: unknown) => chain,
          innerJoin: (_table: unknown, _cond: unknown) => chain,
          where: (_cond: unknown) => [] as unknown[],
        };
        return chain;
      },
      transaction: async (fn: (tx: { execute: () => Promise<{ rows: unknown[] }> }) => unknown) =>
        fn({ execute: async () => ({ rows: [{ locked: true }] }) }),
    },
  };
});

import {
  pickLineupWithLookahead,
  pickLineupWithMustInclude,
} from '../server/auto-matchmaking';
import {
  buildFourPlayerHistoryFromHistory,
  hasPlayedFourPlayerSet,
  updateFourPlayerHistory,
  clearSessionRestStates,
} from '../server/matchmaking';
import type { Player } from '@shared/schema';

function mkPlayer(id: string, score: number): Player {
  return {
    id,
    name: id,
    skillScore: score,
    level: 'lower_intermediate',
    gender: 'male',
  } as unknown as Player;
}

const SESSION = 's-repeat';

describe('queued repeat-matchup guard', () => {
  beforeEach(() => {
    clearSessionRestStates(SESSION);
  });

  it('pickLineupWithMustInclude blocks the exact on-court quartet mid-game', () => {
    const players = ['p1', 'p2', 'p3', 'p4'].map((id, i) => mkPlayer(id, 90 + i));
    const lineup = pickLineupWithMustInclude(
      SESSION,
      ['p1', 'p2', 'p3', 'p4'],
      [],
      players,
      { rejectActiveRosterIds: ['p1', 'p2', 'p3', 'p4'] },
    );
    expect(lineup).toBeNull();
  });

  it('pickLineupWithMustInclude returns null when only quartet already played', () => {
    const players = ['p1', 'p2', 'p3', 'p4'].map((id, i) => mkPlayer(id, 90 + i));
    updateFourPlayerHistory(SESSION, ['p1', 'p2', 'p3', 'p4']);
    const lineup = pickLineupWithMustInclude(SESSION, ['p1', 'p2', 'p3', 'p4'], [], players);
    expect(lineup).toBeNull();
  });

  it('pickLineupWithMustInclude prefers a non-repeat quartet when history exists', () => {
    const players = [
      mkPlayer('p1', 90),
      mkPlayer('p2', 92),
      mkPlayer('p3', 94),
      mkPlayer('p4', 96),
      mkPlayer('p5', 70),
    ];
    updateFourPlayerHistory(SESSION, ['p1', 'p2', 'p3', 'p4']);

    const lineup = pickLineupWithMustInclude(
      SESSION,
      ['p5'],
      ['p1', 'p2', 'p3', 'p4'],
      players,
    );

    expect(lineup).not.toBeNull();
    const ids = [...lineup!.team1Ids, ...lineup!.team2Ids];
    expect(ids).toContain('p5');
    expect(hasPlayedFourPlayerSet(SESSION, ids)).toBe(false);
  });

  it('buildFourPlayerHistoryFromHistory marks a completed game quartet', () => {
    const participants = [
      { gameId: 'g1', playerId: 'a', team: 1, createdAt: new Date() },
      { gameId: 'g1', playerId: 'b', team: 1, createdAt: new Date() },
      { gameId: 'g1', playerId: 'c', team: 2, createdAt: new Date() },
      { gameId: 'g1', playerId: 'd', team: 2, createdAt: new Date() },
    ] as Parameters<typeof buildFourPlayerHistoryFromHistory>[1];

    buildFourPlayerHistoryFromHistory(SESSION, participants);
    expect(hasPlayedFourPlayerSet(SESSION, ['a', 'b', 'c', 'd'])).toBe(true);
    expect(hasPlayedFourPlayerSet(SESSION, ['a', 'b', 'c', 'e'])).toBe(false);
  });
});
