import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { usePageTitle } from '@/hooks/usePageTitle';

interface CurrentSuggestionPlayer {
  playerId: string;
  playerName: string;
  team: number;
  photoUrl: string | null;
  tierName: string;
}

interface CurrentSuggestion {
  id: string;
  status: 'pending' | 'approved' | 'playing' | 'completed' | 'dismissed';
  courtId: string;
  courtName: string;
  startedAt: string | null;
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

  const suggestionQuery = useQuery<CurrentSuggestionResponse>({
    queryKey: ['/api/marketplace/players/me/current-suggestion'],
    refetchInterval: 5000,
    staleTime: 0,
  });

  const suggestion = suggestionQuery.data?.suggestion ?? null;
  const sawPlayingRef = useRef(false);

  useEffect(() => {
    if (suggestionQuery.isPending) return;
    const status = suggestion?.status ?? null;
    if (status === 'playing') {
      sawPlayingRef.current = true;
      return;
    }
    if (status === 'pending' || status === 'approved') {
      setLocation('/marketplace/play');
      return;
    }
    if (status === 'dismissed') {
      setLocation('/marketplace/play');
      return;
    }
    if (sawPlayingRef.current) {
      setLocation('/marketplace/play/score');
    } else {
      setLocation('/marketplace/play');
    }
  }, [suggestion?.status, suggestionQuery.isPending, setLocation]);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-6 sm:py-10 pb-36" data-testid="page-playing">
      {suggestionQuery.isPending ? (
        <InitialSkeleton />
      ) : suggestion?.status === 'playing' ? (
        <PlayingContent suggestion={suggestion} />
      ) : (
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

function PlayingContent({ suggestion }: { suggestion: CurrentSuggestion }) {
  const [, setLocation] = useLocation();
  const selfTeamNum = suggestion.selfTeam ?? 1;
  const oppTeamNum = selfTeamNum === 1 ? 2 : 1;
  const yourTeam = suggestion.players.filter((p) => p.team === selfTeamNum);
  const opponents = suggestion.players.filter((p) => p.team === oppTeamNum);

  // Server-anchored count-up. We compute elapsed seconds from the court's
  // startedAt every tick — refresh / re-mount / navigate-and-back all
  // recover the real elapsed time instead of restarting at 00:00. If the
  // server didn't send startedAt for some reason, we fall back to a
  // mount-anchored counter so the screen still renders something useful.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const startedAtMs = suggestion.startedAt ? new Date(suggestion.startedAt).getTime() : null;
  const mountAnchorRef = useRef<number>(Date.now());
  const elapsedSeconds = startedAtMs
    ? Math.max(0, Math.floor((now - startedAtMs) / 1000))
    : Math.max(0, Math.floor((now - mountAnchorRef.current) / 1000));

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
          <div className="flex items-center justify-center gap-4">
            <CourtBadge name={suggestion.courtName} />
            <div className="text-center">
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
        </CardContent>
      </Card>

      <p
        className="text-xs text-center text-muted-foreground"
        data-testid="text-playing-caption"
      >
        Tap when your match is over. Any player on the court can enter the score.
      </p>

      <StickyCta>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="lg"
              className="w-full text-base h-14"
              data-testid="button-end-game"
            >
              End game and enter score
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent data-testid="dialog-confirm-end-game">
            <AlertDialogHeader>
              <AlertDialogTitle>End the game?</AlertDialogTitle>
              <AlertDialogDescription>
                Match over? You'll go straight to the score entry screen, and
                this can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-confirm-end-cancel">
                Keep playing
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => setLocation('/marketplace/play/score')}
                data-testid="button-confirm-end-confirm"
              >
                End game
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </StickyCta>
    </div>
  );
}

function CourtBadge({ name }: { name: string }) {
  return (
    <div
      className="h-20 w-20 shrink-0 rounded-md border-2 flex flex-col items-center justify-center"
      style={{ borderColor: TEAL, backgroundColor: '#F5EFE0' }}
      data-testid="badge-court-number"
    >
      <span className="text-[9px] uppercase tracking-wider" style={{ color: TEAL }}>
        Court
      </span>
      <span className="text-3xl font-bold leading-none" style={{ color: NAVY }} data-testid="text-court-name">
        {name?.trim() || '—'}
      </span>
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
      <p className="text-xs uppercase tracking-wider mb-2" style={{ color: accent }}>
        {label}
      </p>
      <div className="space-y-2">
        {players.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          players.map((p) => (
            <div
              key={p.playerId}
              className="flex items-center gap-3"
              data-testid={`text-player-${p.playerId}`}
            >
              <Avatar className="h-9 w-9 border">
                {p.photoUrl ? <AvatarImage src={p.photoUrl} alt={p.playerName} /> : null}
                <AvatarFallback className="text-xs">{getInitials(p.playerName)}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-base font-medium leading-tight truncate">{p.playerName}</p>
                {p.tierName ? (
                  <p className="text-xs text-muted-foreground leading-tight">
                    {p.tierName}
                  </p>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function StickyCta({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="sm:static fixed inset-x-0 bottom-0 z-40 px-4 sm:px-0 sm:py-0"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)', paddingTop: '0.75rem' }}
    >
      <div
        className="sm:bg-transparent sm:border-0 sm:shadow-none bg-background/95 backdrop-blur border-t shadow-lg sm:p-0 -mx-4 sm:mx-0 px-4 sm:px-0 py-3 sm:py-0"
      >
        <div className="mx-auto w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}

function getInitials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatTimer(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
