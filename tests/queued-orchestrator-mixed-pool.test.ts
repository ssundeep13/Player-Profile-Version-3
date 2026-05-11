// Mixed-pool queued lineup generator (Case 2/3 of the queued orchestrator).
//
// Scenario covered: 1 court is in 'playing' status with 4 active players,
// 2 sitters are waiting in the queue (pool size = 2 < 4). The queued
// orchestrator falls back to the mixed-pool path and asks
// pickLineupWithMustInclude to build a lineup that:
//   • forces both sitters in,
//   • fills the remaining 2 slots from the court's currently-playing
//     roster (the only legal source when pool < 4),
//   • returns 2 vs 2 with no duplicates.
//
// This test exercises the *brain* of Case 2/3 directly — the function
// is pure (no I/O, no Postgres) and covers the math that the orchestrator
// hands off to. The orchestrator's surrounding side effects
// (createMatchSuggestion call, includesActivePlayers=true tagging) are
// already validated by the player-flow E2E (`scripts/test-e2e-self-service-loop.mjs`).

import { describe, it, expect } from 'vitest';
import {
  pickLineupWithMustInclude,
  isCourtInPlay,
} from '../server/auto-matchmaking';
import type { Player } from '@shared/schema';

function mkPlayer(id: string, name: string, score: number): Player {
  // Cast through unknown — Player has many DB-only fields the brain
  // never reads (createdAt, status, photoUrl, gender, …). The matchmaking
  // helpers only consult: id, name, skillScore, level, gender.
  return {
    id,
    name,
    skillScore: score,
    level: 'lower_intermediate',
    gender: 'male',
  } as unknown as Player;
}

describe('pickLineupWithMustInclude (mixed-pool Case 2/3)', () => {
  it('builds a 2v2 lineup with both sitters when pool=2 / court=4', () => {
    const sitters = [mkPlayer('s1', 'Sitter One', 95), mkPlayer('s2', 'Sitter Two', 90)];
    const active = [
      mkPlayer('a1', 'Active One', 92),
      mkPlayer('a2', 'Active Two', 88),
      mkPlayer('a3', 'Active Three', 96),
      mkPlayer('a4', 'Active Four', 85),
    ];
    const allPlayers = [...sitters, ...active];

    const lineup = pickLineupWithMustInclude(
      'session-mixed-test',
      sitters.map(p => p.id),
      active.map(p => p.id),
      allPlayers,
    );

    expect(lineup).not.toBeNull();
    const all4 = new Set([...lineup!.team1Ids, ...lineup!.team2Ids]);
    expect(lineup!.team1Ids).toHaveLength(2);
    expect(lineup!.team2Ids).toHaveLength(2);
    expect(all4.size).toBe(4); // no duplicate player across teams

    // Both sitters MUST be in the final lineup — that's the contract.
    expect(all4.has('s1')).toBe(true);
    expect(all4.has('s2')).toBe(true);

    // The other 2 slots MUST come from the active court roster (no
    // ghost-id contamination from elsewhere).
    const fillerIds = [...all4].filter(id => id !== 's1' && id !== 's2');
    expect(fillerIds).toHaveLength(2);
    fillerIds.forEach(id => {
      expect(['a1', 'a2', 'a3', 'a4']).toContain(id);
    });
  });

  it('returns null when there are not enough fill candidates', () => {
    const sitters = [mkPlayer('s1', 'Sitter One', 90)];
    const active = [mkPlayer('a1', 'Active One', 90), mkPlayer('a2', 'Active Two', 90)];
    // Need 3 fills (4 - 1 must-include) but only 2 fill candidates.
    const lineup = pickLineupWithMustInclude(
      'session-x',
      sitters.map(p => p.id),
      active.map(p => p.id),
      [...sitters, ...active],
    );
    expect(lineup).toBeNull();
  });

  it('returns null when an unknown must-include id is passed', () => {
    const active = Array.from({ length: 4 }, (_, i) =>
      mkPlayer(`a${i}`, `Active ${i}`, 90),
    );
    const lineup = pickLineupWithMustInclude(
      'session-x',
      ['ghost-id'],
      active.map(p => p.id),
      active,
    );
    expect(lineup).toBeNull();
  });

  // Regression guard for task #64: the orchestrator's in-play filter
  // must accept BOTH 'occupied' (the canonical court-in-play status set
  // by every admin assign and by the player-driven start path in
  // storage.startApprovedSuggestion) AND 'playing' (defensive). The
  // courts.status enum in shared/schema.ts is documented as
  // ('available' | 'occupied') only — filtering on === 'playing' alone
  // is dead code that previously caused the queued orchestrator to
  // silently early-return, so no queued lineup ever got built and
  // /marketplace/play had to fall back to the read-only projection
  // card.
  //
  // We import the EXACT predicate the orchestrator uses
  // (isCourtInPlay from server/auto-matchmaking.ts) rather than
  // re-declaring it here, so any drift in the orchestrator's filter
  // is caught by this test. If a refactor inlines the check or
  // narrows it again (the original bug), the import or the
  // assertions break.
  it("treats both 'occupied' and 'playing' courts as in-play (task #64 regression guard)", () => {
    expect(isCourtInPlay({ status: 'occupied' })).toBe(true);
    expect(isCourtInPlay({ status: 'playing' })).toBe(true);
    expect(isCourtInPlay({ status: 'available' })).toBe(false);
    expect(isCourtInPlay({ status: 'ended' })).toBe(false);
    expect(isCourtInPlay({ status: '' })).toBe(false);
  });

  it('handles a single sitter (pool=1, fill=3) — still includes the sitter', () => {
    const sitter = mkPlayer('s1', 'Solo Sitter', 95);
    const active = Array.from({ length: 4 }, (_, i) =>
      mkPlayer(`a${i}`, `Active ${i}`, 88 + i),
    );
    const lineup = pickLineupWithMustInclude(
      'session-x',
      ['s1'],
      active.map(p => p.id),
      [sitter, ...active],
    );
    expect(lineup).not.toBeNull();
    const all4 = new Set([...lineup!.team1Ids, ...lineup!.team2Ids]);
    expect(all4.size).toBe(4);
    expect(all4.has('s1')).toBe(true);
    // 3 fills should all come from the active roster.
    const fillerIds = [...all4].filter(id => id !== 's1');
    expect(fillerIds).toHaveLength(3);
    fillerIds.forEach(id => {
      expect(['a0', 'a1', 'a2', 'a3']).toContain(id);
    });
  });
});
