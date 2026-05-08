import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageTitle } from '@/hooks/usePageTitle';

interface CurrentSuggestionPlayer {
  playerId: string;
  playerName: string;
  team: number;
}

interface CurrentSuggestion {
  id: string;
  status: 'pending' | 'approved' | 'playing' | 'completed' | 'dismissed';
  courtId: string;
  courtName: string;
  pendingUntil: string;
  selfTeam: 1 | 2 | null;
  players: CurrentSuggestionPlayer[];
}

interface CurrentSuggestionResponse {
  suggestion: CurrentSuggestion | null;
}

const NAVY = '#003E8C';
const TEAL = '#006B5F';

export default function PlayingScreen() {
  usePageTitle('Playing');
  const [, setLocation] = useLocation();

  // Reuse the same endpoint P6 already polls. TanStack Query handles teardown
  // of the 5 s interval automatically when this component unmounts.
  const suggestionQuery = useQuery<CurrentSuggestionResponse>({
    queryKey: ['/api/marketplace/players/me/current-suggestion'],
    refetchInterval: 5000,
    staleTime: 0,
  });

  const suggestion = suggestionQuery.data?.suggestion ?? null;

  // Tracks whether we ever observed a 'playing' status during this mount.
  // The current-suggestion endpoint only surfaces pending|approved|playing —
  // when the Court Captain marks the game as completed the suggestion drops
  // out of the response and we see `null`. We distinguish "the game just
  // finished" from "the player landed here without a live game" by checking
  // whether 'playing' was seen at any earlier poll on this mount.
  const sawPlayingRef = useRef(false);

  useEffect(() => {
    if (suggestionQuery.isPending) {
      // Initial load — don't redirect while we're still finding out.
      return;
    }

    const status = suggestion?.status ?? null;

    if (status === 'playing') {
      sawPlayingRef.current = true;
      return;
    }

    if (status === 'pending' || status === 'approved') {
      // Player landed here too early. Send them back to the waiting screen.
      setLocation('/marketplace/play');
      return;
    }

    if (status === 'dismissed') {
      // Admin cancelled the game (Court Captain pressed Cancel Game).
      // The /current-suggestion endpoint surfaces 'dismissed' rows for a
      // 10-minute window so we can detect this transition. Route the
      // player back to the waiting screen — score entry is reserved for
      // games that actually completed with a winner.
      setLocation('/marketplace/play');
      return;
    }

    // status is null or 'completed'.
    if (sawPlayingRef.current) {
      // The game we were watching just finished — proceed to score entry (P8).
      setLocation('/marketplace/play/score');
    } else {
      // Stale/never-started: there's no game in progress for this player.
      setLocation('/marketplace/play');
    }
  }, [suggestion?.status, suggestionQuery.isPending, setLocation]);

  // Cosmetic count-up timer. Lives in its own effect so it never tangles with
  // the polling query. The interval is cleared on unmount via the cleanup
  // function — verified by manual code review for memory-leak safety.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-6 sm:py-10" data-testid="page-playing">
      {suggestionQuery.isPending ? (
        <InitialSkeleton />
      ) : suggestion?.status === 'playing' ? (
        <PlayingContent suggestion={suggestion} elapsedSeconds={elapsedSeconds} />
      ) : (
        // We're about to redirect (handled by the effect above). Render a
        // small skeleton so the screen doesn't flash empty during the
        // single render between data arriving and navigation taking effect.
        <InitialSkeleton />
      )}
    </div>
  );
}

function InitialSkeleton() {
  return (
    <div className="space-y-4" data-testid="state-playing-loading">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-4 w-56 mx-auto" />
    </div>
  );
}

function PlayingContent({
  suggestion,
  elapsedSeconds,
}: {
  suggestion: CurrentSuggestion;
  elapsedSeconds: number;
}) {
  const [, setLocation] = useLocation();
  // Render from the requesting player's perspective. selfTeam is set by the
  // backend based on the linkedPlayerId; fall back to team 1 defensively so
  // the UI never crashes if the data is somehow incomplete.
  const selfTeamNum = suggestion.selfTeam ?? 1;
  const oppTeamNum = selfTeamNum === 1 ? 2 : 1;
  const yourTeam = suggestion.players.filter((p) => p.team === selfTeamNum);
  const opponents = suggestion.players.filter((p) => p.team === oppTeamNum);

  return (
    <div className="space-y-6" data-testid="state-playing">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wider" style={{ color: TEAL }}>
          In progress
        </p>
        <h1 className="text-2xl font-semibold" style={{ color: NAVY }} data-testid="text-playing-heading">
          Game on.
        </h1>
      </div>

      <Card data-testid="card-playing">
        <CardContent className="py-6 space-y-6">
          <div className="text-center space-y-1">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Court
            </p>
            <p
              className="text-3xl font-semibold"
              style={{ color: NAVY }}
              data-testid="text-court-name"
            >
              {suggestion.courtName?.trim() || '—'}
            </p>
          </div>

          <div className="space-y-3">
            <TeamRow
              label="Your team"
              players={yourTeam}
              accent={TEAL}
              testId="team-self"
            />
            <div className="text-center text-xs uppercase tracking-wider text-muted-foreground">
              vs
            </div>
            <TeamRow
              label="Opponents"
              players={opponents}
              accent={NAVY}
              testId="team-opponents"
            />
          </div>

          <div className="text-center space-y-1 pt-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Time
            </p>
            <p
              className="text-4xl font-semibold tabular-nums"
              style={{ color: NAVY }}
              data-testid="text-game-timer"
            >
              {formatTimer(elapsedSeconds)}
            </p>
          </div>
        </CardContent>
      </Card>

      <Button
        size="lg"
        className="w-full text-base h-14"
        onClick={() => setLocation('/marketplace/play/score')}
        data-testid="button-end-game"
      >
        End game and enter score
      </Button>

      <p
        className="text-xs text-center text-muted-foreground"
        data-testid="text-playing-caption"
      >
        Tap when your match is over. Any player on the court can enter the score.
      </p>
    </div>
  );
}

function TeamRow({
  label,
  players,
  accent,
  testId,
}: {
  label: string;
  players: CurrentSuggestionPlayer[];
  accent: string;
  testId: string;
}) {
  return (
    <div data-testid={`row-${testId}`}>
      <p className="text-xs uppercase tracking-wider mb-1" style={{ color: accent }}>
        {label}
      </p>
      <div className="space-y-1">
        {players.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          players.map((p) => (
            <p
              key={p.playerId}
              className="text-base font-medium"
              data-testid={`text-player-${p.playerId}`}
            >
              {p.playerName}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function formatTimer(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
