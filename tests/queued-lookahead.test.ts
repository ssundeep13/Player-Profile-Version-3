// Balanced queued look-ahead (Task #65).
//
// Covers the 5 user-supplied scenarios for `pickLineupWithLookahead`
// and `partitionWaitersAcrossCourts`:
//   1. 4 weak waiters / 2 courts → both queued rows mix waiting+active for
//      balance (includesActivePlayers=true on both).
//   2. 4 mixed-skill waiters that produce a balanced 2v2 → pure waiting
//      lineup, includesActivePlayers=false.
//   3. 5 waiters / 2 courts → all 5 names appear across the 2 queued rows
//      (round-robin partition, longest-waiter first via FIFO order).
//   4. Player who just won 2 in a row sits at the back of the queue → the
//      partitioner picks the longer-waiting players first (rest-state
//      proxy via FIFO queue position; no new "just-won" penalty needed).
//   5. Regression: a balanced 4-waiting pool on 1 court still produces a
//      pure-waiting queued row (includesActivePlayers=false).

import { describe, it, expect } from 'vitest';
import {
  pickLineupWithLookahead,
  partitionWaitersAcrossCourts,
  computeLineupSkillGap,
} from '../server/auto-matchmaking';
import type { Player } from '@shared/schema';

function mkPlayer(id: string, name: string, score: number): Player {
  return {
    id,
    name,
    skillScore: score,
    level: 'lower_intermediate',
    gender: 'male',
  } as unknown as Player;
}

describe('Task #65 — Balanced queued look-ahead', () => {
  // ── Scenario 1 ────────────────────────────────────────────────────────
  it('S1: 4 weak waiters / 2 courts → each court borrows from active for balance', () => {
    // 12 players: 4 weak waiters (W1..W4 ~60), 8 stronger active split
    // across two courts (A1..A4 on court A ~95, B1..B4 on court B ~95).
    const waiters = [
      mkPlayer('w1', 'W1', 58),
      mkPlayer('w2', 'W2', 60),
      mkPlayer('w3', 'W3', 62),
      mkPlayer('w4', 'W4', 64),
    ];
    const courtAActive = [
      mkPlayer('a1', 'A1', 110),
      mkPlayer('a2', 'A2', 105),
      mkPlayer('a3', 'A3', 100),
      mkPlayer('a4', 'A4', 95),
    ];
    const courtBActive = [
      mkPlayer('b1', 'B1', 108),
      mkPlayer('b2', 'B2', 103),
      mkPlayer('b3', 'B3', 98),
      mkPlayer('b4', 'B4', 93),
    ];
    const allPlayers = [...waiters, ...courtAActive, ...courtBActive];

    // Round-robin partition assigns W1,W3 → court A and W2,W4 → court B
    // (queue order = waiter index).
    const partition = partitionWaitersAcrossCourts(
      waiters.map(w => w.id),
      ['courtA', 'courtB'],
    );
    expect(partition.get('courtA')).toEqual(['w1', 'w3']);
    expect(partition.get('courtB')).toEqual(['w2', 'w4']);

    // Court A: must=[w1,w3], optional=[], active=courtAActive.
    // Pure plan A is null (need 2 fillers, optional empty), so plan B
    // must produce a borrowed lineup.
    const resultA = pickLineupWithLookahead(
      'session-s1',
      partition.get('courtA')!,
      [],
      courtAActive.map(p => p.id),
      allPlayers,
    );
    expect(resultA).not.toBeNull();
    expect(resultA!.includesActive).toBe(true);
    const lineupA = new Set([...resultA!.lineup.team1Ids, ...resultA!.lineup.team2Ids]);
    expect(lineupA.has('w1')).toBe(true);
    expect(lineupA.has('w3')).toBe(true);
    // Two of the four court-A active players were borrowed.
    const borrowedA = [...lineupA].filter(id => id.startsWith('a'));
    expect(borrowedA).toHaveLength(2);
    // Skill gap should be small — well below the 5.0 threshold for an
    // optimised mix-in lineup.
    expect(resultA!.skillGap).toBeLessThan(5);

    // Court B: same shape, must=[w2,w4], borrows from court B's active.
    const resultB = pickLineupWithLookahead(
      'session-s1',
      partition.get('courtB')!,
      [],
      courtBActive.map(p => p.id),
      allPlayers,
    );
    expect(resultB).not.toBeNull();
    expect(resultB!.includesActive).toBe(true);
    const lineupB = new Set([...resultB!.lineup.team1Ids, ...resultB!.lineup.team2Ids]);
    expect(lineupB.has('w2')).toBe(true);
    expect(lineupB.has('w4')).toBe(true);
    const borrowedB = [...lineupB].filter(id => id.startsWith('b'));
    expect(borrowedB).toHaveLength(2);
    expect(resultB!.skillGap).toBeLessThan(5);
  });

  // ── Scenario 2 ────────────────────────────────────────────────────────
  it('S2: 4 mixed-skill waiters on a single court → pure waiting wins (includesActive=false)', () => {
    // A perfectly-balanceable 2v2 from the waiting pool: (110+60) vs
    // (105+65) → gap 0 vs gap 0 (after pairing). findBalancedTeams will
    // pick the gap-0 split.
    const waiters = [
      mkPlayer('w1', 'W1', 110),
      mkPlayer('w2', 'W2', 105),
      mkPlayer('w3', 'W3', 65),
      mkPlayer('w4', 'W4', 60),
    ];
    const active = [
      mkPlayer('a1', 'A1', 95),
      mkPlayer('a2', 'A2', 95),
      mkPlayer('a3', 'A3', 95),
      mkPlayer('a4', 'A4', 95),
    ];
    const allPlayers = [...waiters, ...active];

    const result = pickLineupWithLookahead(
      'session-s2',
      waiters.map(p => p.id),
      [],
      active.map(p => p.id),
      allPlayers,
    );
    expect(result).not.toBeNull();
    expect(result!.includesActive).toBe(false);
    expect(result!.skillGap).toBeLessThan(5);

    const lineup = new Set([...result!.lineup.team1Ids, ...result!.lineup.team2Ids]);
    expect(lineup.size).toBe(4);
    // All 4 lineup slots are waiters — no active player ended up in.
    for (const id of lineup) {
      expect(id.startsWith('w')).toBe(true);
    }
  });

  // ── Scenario 3 ────────────────────────────────────────────────────────
  it('S3: 5 waiters / 2 courts → all 5 waiters appear across the 2 queued rows', () => {
    const pool = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const partition = partitionWaitersAcrossCourts(pool, ['courtA', 'courtB']);

    // Round-robin: A gets [0,2,4]=w1,w3,w5; B gets [1,3]=w2,w4.
    expect(partition.get('courtA')).toEqual(['w1', 'w3', 'w5']);
    expect(partition.get('courtB')).toEqual(['w2', 'w4']);

    // Union of both partitions must equal the full waiter set.
    const seen = new Set<string>([
      ...partition.get('courtA')!,
      ...partition.get('courtB')!,
    ]);
    expect(seen).toEqual(new Set(pool));
  });

  // ── Scenario 4 ────────────────────────────────────────────────────────
  it('S4: player who just won (back of queue) is NOT picked over longer-waiting candidates', () => {
    // FIFO queue order is the rest-state proxy: a player who just won
    // gets re-added at the BACK of the queue (high index = short wait =
    // high gamesThisSession), so the partition's round-robin picks
    // longest-waiters first. No new "just-won" penalty in the look-ahead
    // — the existing FIFO ordering carries the signal.
    //
    // Setup: 5 waiters in queue order. w5 is the recent winner (at the
    // back). 1 court → only the first 4 are partitioned in.
    const pool = ['w1', 'w2', 'w3', 'w4', 'w5_recent_winner'];
    const partition = partitionWaitersAcrossCourts(pool, ['courtA']);

    expect(partition.get('courtA')).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(partition.get('courtA')).not.toContain('w5_recent_winner');
  });

  // ── Scenario 5 ────────────────────────────────────────────────────────
  it('S5 (regression): single court with 4 balanced waiters still produces pure-waiting queued row', () => {
    const waiters = [
      mkPlayer('w1', 'W1', 90),
      mkPlayer('w2', 'W2', 92),
      mkPlayer('w3', 'W3', 88),
      mkPlayer('w4', 'W4', 91),
    ];
    const active = [
      mkPlayer('a1', 'A1', 100),
      mkPlayer('a2', 'A2', 100),
      mkPlayer('a3', 'A3', 100),
      mkPlayer('a4', 'A4', 100),
    ];
    const allPlayers = [...waiters, ...active];

    const result = pickLineupWithLookahead(
      'session-s5',
      waiters.map(p => p.id),
      [],
      active.map(p => p.id),
      allPlayers,
    );
    expect(result).not.toBeNull();
    expect(result!.includesActive).toBe(false);
    expect(result!.skillGap).toBeLessThan(5);

    const lineup = new Set([...result!.lineup.team1Ids, ...result!.lineup.team2Ids]);
    expect(lineup).toEqual(new Set(['w1', 'w2', 'w3', 'w4']));
  });

  // ── Helper sanity checks ──────────────────────────────────────────────
  it('computeLineupSkillGap returns absolute average difference', () => {
    const allPlayers = [
      mkPlayer('p1', 'P1', 100),
      mkPlayer('p2', 'P2', 80),
      mkPlayer('p3', 'P3', 60),
      mkPlayer('p4', 'P4', 40),
    ];
    // (100+40)/2 = 70 vs (80+60)/2 = 70 → gap 0
    expect(
      computeLineupSkillGap(
        { team1Ids: ['p1', 'p4'], team2Ids: ['p2', 'p3'] },
        allPlayers,
      ),
    ).toBe(0);
    // (100+80)/2 = 90 vs (60+40)/2 = 50 → gap 40
    expect(
      computeLineupSkillGap(
        { team1Ids: ['p1', 'p2'], team2Ids: ['p3', 'p4'] },
        allPlayers,
      ),
    ).toBe(40);
  });

  it('partitionWaitersAcrossCourts caps each court at 4 mustIncludes', () => {
    const pool = Array.from({ length: 12 }, (_, i) => `w${i + 1}`);
    const partition = partitionWaitersAcrossCourts(pool, ['cA', 'cB']);
    expect(partition.get('cA')!.length).toBe(4);
    expect(partition.get('cB')!.length).toBe(4);
    // 4 leftover (w9..w12) stay in pool for next pass — they don't
    // appear in the partition.
    const used = new Set([...partition.get('cA')!, ...partition.get('cB')!]);
    expect(used.size).toBe(8);
  });
});
