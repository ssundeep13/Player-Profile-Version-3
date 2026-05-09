import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
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
import { MapPin, Clock, Calendar as CalendarIcon, Loader2, Users, ListOrdered, Trophy, ExternalLink } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useToast } from '@/hooks/use-toast';
import type { BookingWithDetails } from '@shared/schema';

interface ActiveSessionResponse {
  activeSessionId: string | null;
}

interface CurrentSuggestionPlayer {
  playerId: string;
  playerName: string;
  team: number;
  photoUrl: string | null;
  tierName: string;
}

interface CurrentSuggestion {
  id: string;
  status: 'pending' | 'approved' | 'playing' | 'dismissed' | 'queued';
  courtId: string;
  courtName: string;
  startedAt: string | null;
  pendingUntil: string | null;
  includesActivePlayers: boolean;
  selfTeam: 1 | 2 | null;
  players: CurrentSuggestionPlayer[];
}

interface CourtInPlay {
  id: string;
  name: string;
  startedAt: string | null;
}

interface LastGameSummary {
  gameId: string;
  won: boolean;
  myScore: number;
  theirScore: number;
  partnerName: string | null;
  opponentNames: string[];
}

interface TodayStatsResponse {
  gamesPlayed: number;
  wins: number;
  skillScore: number;
  tierName: string;
  queuePosition: number | null;
  courtsInPlay: CourtInPlay[];
  lastGame: LastGameSummary | null;
}

interface CurrentSuggestionResponse {
  suggestion: CurrentSuggestion | null;
}

interface CheckedInResponse {
  players: Array<{ id: string; name: string; photoUrl: string | null }>;
}

const NAVY = '#003E8C';
const TEAL = '#006B5F';

export default function Play() {
  usePageTitle('Play');
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const bookingsQuery = useQuery<BookingWithDetails[]>({
    queryKey: ['/api/marketplace/bookings/mine'],
    staleTime: 0,
    refetchOnMount: true,
  });

  const activeSessionQuery = useQuery<ActiveSessionResponse>({
    queryKey: ['/api/marketplace/active-session'],
    staleTime: 0,
  });

  const todaysBooking = useMemo<BookingWithDetails | null>(() => {
    const activeId = activeSessionQuery.data?.activeSessionId;
    const bookings = bookingsQuery.data;
    if (!activeId || !bookings) return null;
    return (
      bookings.find(
        (b) =>
          !b.isGuestBooking &&
          b.session?.linkedSessionId === activeId &&
          (b.status === 'confirmed' || b.status === 'attended'),
      ) ?? null
    );
  }, [bookingsQuery.data, activeSessionQuery.data]);

  const isCheckedIn = !!todaysBooking?.attendedAt || todaysBooking?.status === 'attended';
  const initialLoading = bookingsQuery.isPending || activeSessionQuery.isPending;

  if (initialLoading) {
    return <PageShell><InitialSkeleton /></PageShell>;
  }

  if (!todaysBooking) {
    return <PageShell><NoSessionToday onBook={() => setLocation('/marketplace/book')} /></PageShell>;
  }

  if (!isCheckedIn) {
    return (
      <PageShell>
        <CheckInScreen
          booking={todaysBooking}
          onCheckedIn={() => {
            queryClient.invalidateQueries({ queryKey: ['/api/marketplace/bookings/mine'] });
          }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <WaitingScreen onDone={() => setLocation('/marketplace')} />
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-6 sm:py-10 pb-36" data-testid="page-play">
      {children}
    </div>
  );
}

function InitialSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

function NoSessionToday({ onBook }: { onBook: () => void }) {
  return (
    <Card data-testid="card-no-session">
      <CardContent className="py-10 text-center space-y-3">
        <h1 className="text-xl font-semibold" style={{ color: NAVY }} data-testid="text-no-session-heading">
          No session today.
        </h1>
        <p className="text-sm text-muted-foreground" data-testid="text-no-session-body">
          Check the schedule for upcoming sessions.
        </p>
        <div className="pt-2">
          <Button onClick={onBook} data-testid="button-view-schedule">
            View schedule
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CheckInScreen({
  booking,
  onCheckedIn,
}: {
  booking: BookingWithDetails;
  onCheckedIn: () => void;
}) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const checkInMutation = useMutation({
    mutationFn: async () => {
      return apiRequest('POST', `/api/marketplace/sessions/${booking.session.id}/checkin`);
    },
    onSuccess: () => {
      setErrorMessage(null);
      onCheckedIn();
    },
    onError: (err: unknown) => {
      const fallback = "Couldn't check you in — please ask the Court Captain for help.";
      const maybeApi = err as { error?: string } | null | undefined;
      const fromMessage = err instanceof Error ? err.message : undefined;
      setErrorMessage(maybeApi?.error || fromMessage || fallback);
    },
  });

  const checkedInQuery = useQuery<CheckedInResponse>({
    queryKey: ['/api/marketplace/sessions', booking.session.id, 'checked-in'],
    queryFn: async () => {
      return await apiRequest<CheckedInResponse>(
        'GET',
        `/api/marketplace/sessions/${booking.session.id}/checked-in`,
      );
    },
    refetchInterval: 15_000,
    staleTime: 0,
  });

  const sessionDate = booking.session.date ? new Date(booking.session.date) : null;
  const dateLabel = sessionDate ? format(sessionDate, 'EEEE, MMMM d') : '';
  const venueName = booking.session.venueName;
  const mapHref = booking.session.venueMapUrl
    ? booking.session.venueMapUrl
    : venueName
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venueName)}`
      : null;

  const checkedInPlayers = checkedInQuery.data?.players ?? [];

  return (
    <div className="space-y-6" data-testid="state-checkin">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wider" style={{ color: TEAL }}>
          Today
        </p>
        <h1 className="text-2xl font-semibold" style={{ color: NAVY }} data-testid="text-checkin-heading">
          Ready to check in?
        </h1>
      </div>

      <Card data-testid="card-session-details">
        <CardContent className="py-5 space-y-3">
          <div className="flex items-start gap-3">
            <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
            <div className="text-sm flex-1 min-w-0">
              {mapHref ? (
                <a
                  href={mapHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:underline inline-flex items-center gap-1"
                  data-testid="link-venue-map"
                >
                  <span data-testid="text-venue-name">{venueName}</span>
                  <ExternalLink className="w-3 h-3 text-muted-foreground" />
                </a>
              ) : (
                <p className="font-medium" data-testid="text-venue-name">{venueName}</p>
              )}
              {booking.session.title ? (
                <p className="text-muted-foreground text-xs mt-0.5" data-testid="text-session-title">
                  {booking.session.title}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <CalendarIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
            <span data-testid="text-session-date">{dateLabel}</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Clock className="w-4 h-4 shrink-0 text-muted-foreground" />
            <span data-testid="text-session-time">{booking.session.startTime}</span>
          </div>
        </CardContent>
      </Card>

      {checkedInPlayers.length > 0 ? (
        <div className="space-y-2" data-testid="row-checked-in-rail">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Already here ({checkedInPlayers.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {checkedInPlayers.slice(0, 12).map((p) => (
              <div key={p.id} className="flex items-center" data-testid={`avatar-checked-in-${p.id}`}>
                <Avatar className="h-9 w-9 border">
                  {p.photoUrl ? <AvatarImage src={p.photoUrl} alt={p.name} /> : null}
                  <AvatarFallback className="text-xs">{getInitials(p.name)}</AvatarFallback>
                </Avatar>
              </div>
            ))}
            {checkedInPlayers.length > 12 ? (
              <span className="text-xs text-muted-foreground self-center">
                +{checkedInPlayers.length - 12} more
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          data-testid="text-checkin-error"
        >
          {errorMessage}
        </div>
      ) : null}

      <StickyCta>
        <Button
          size="lg"
          className="w-full text-base h-14"
          onClick={() => checkInMutation.mutate()}
          disabled={checkInMutation.isPending}
          data-testid="button-checkin"
        >
          {checkInMutation.isPending ? (
            <>
              <Loader2 className="mr-2 w-4 h-4 animate-spin" />
              Checking you in…
            </>
          ) : (
            'Check in'
          )}
        </Button>
      </StickyCta>
    </div>
  );
}

function WaitingScreen({ onDone }: { onDone: () => void }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const suggestionQuery = useQuery<CurrentSuggestionResponse>({
    queryKey: ['/api/marketplace/players/me/current-suggestion'],
    refetchInterval: 5000,
    staleTime: 0,
  });

  const todayStatsQuery = useQuery<TodayStatsResponse>({
    queryKey: ['/api/marketplace/players/me/today-stats'],
    refetchInterval: 10_000,
    staleTime: 0,
  });

  const suggestion = suggestionQuery.data?.suggestion ?? null;

  // Court-ready alert: chime + vibrate + title rewrite on pending → approved.
  // Tracked across renders via ref so we only fire once per transition.
  const lastStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const status = suggestion?.status ?? null;
    const prev = lastStatusRef.current;
    // Update the ref AFTER the transition check, otherwise prev === status
    // on the very render that flipped the status, and the alert never fires.
    if (prev !== 'approved' && status === 'approved') {
      lastStatusRef.current = status;
      try { playChime(); } catch {}
      try { navigator.vibrate?.([200, 100, 200]); } catch {}
      const courtName = suggestion?.courtName || 'your court';
      const originalTitle = document.title;
      document.title = `Court ready — ${courtName}`;
      const restore = window.setTimeout(() => {
        document.title = originalTitle;
      }, 30_000);
      return () => window.clearTimeout(restore);
    }
    lastStatusRef.current = status;
  }, [suggestion?.status, suggestion?.courtName]);

  useEffect(() => {
    if (suggestion?.status === 'playing') {
      setLocation('/marketplace/play/playing');
    }
  }, [suggestion?.status, setLocation]);

  const doneMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest<{ success: boolean }>(
        'POST',
        '/api/marketplace/players/me/done',
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/marketplace/players/me/current-suggestion'] });
      queryClient.invalidateQueries({ queryKey: ['/api/marketplace/players/me/today-stats'] });
      onDone();
    },
    onError: () => {
      toast({
        title: "Couldn't sign you out cleanly",
        description: "Please let the Court Captain know — heading back to the marketplace.",
        variant: 'destructive',
      });
      onDone();
    },
  });

  if (suggestionQuery.isPending) {
    return (
      <div className="space-y-6" data-testid="state-waiting-loading">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const stats = todayStatsQuery.data;

  return (
    <div className="space-y-6" data-testid="state-waiting">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wider" style={{ color: TEAL }}>
          Status
        </p>
        <h1 className="text-2xl font-semibold" style={{ color: NAVY }} data-testid="text-waiting-heading">
          You're checked in
        </h1>
      </div>

      <WaitingChips stats={stats} />

      <CourtsInPlayStrip courts={stats?.courtsInPlay ?? []} />

      {!suggestion || suggestion.status === 'dismissed' ? (
        <FindingNextGameCard />
      ) : suggestion.status === 'queued' ? (
        <OnDeckCard suggestion={suggestion} />
      ) : (
        <NextGameCard suggestion={suggestion} />
      )}

      {stats?.lastGame ? <LastGameCard last={stats.lastGame} /> : null}

      <div className="pt-4 flex justify-center">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="default"
              disabled={doneMutation.isPending}
              data-testid="button-done-for-today"
            >
              {doneMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing you out…
                </>
              ) : (
                "I'm done for today"
              )}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent data-testid="dialog-confirm-done">
            <AlertDialogHeader>
              <AlertDialogTitle>Done for today?</AlertDialogTitle>
              <AlertDialogDescription>
                We'll take you out of the queue and skip you for the next round.
                You can always check back in if you change your mind.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-confirm-done-cancel">Stay in queue</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => doneMutation.mutate()}
                data-testid="button-confirm-done-confirm"
              >
                Yes, I'm done
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

function WaitingChips({ stats }: { stats: TodayStatsResponse | undefined }) {
  // Useful at-a-glance info: queue position, courts currently in play, and
  // games already played today. Replaces the duplicated games/wins/tier
  // chips that overlap with the stats already on /marketplace/dashboard.
  const queueLabel =
    stats?.queuePosition == null ? '—' : `#${stats.queuePosition}`;
  const courtsBusy = stats?.courtsInPlay.length ?? 0;
  const courtsTotal = courtsBusy; // we only know the busy count from this endpoint
  const items: Array<{ icon: typeof ListOrdered; label: string; value: string; testId: string }> = [
    { icon: ListOrdered, label: 'Queue', value: queueLabel, testId: 'stat-queue-position' },
    { icon: Users, label: 'Courts in play', value: courtsTotal === 0 ? '0' : String(courtsBusy), testId: 'stat-courts-in-play' },
    { icon: Trophy, label: 'Games today', value: String(stats?.gamesPlayed ?? '—'), testId: 'stat-games-today' },
  ];
  return (
    <div className="grid grid-cols-3 gap-2" data-testid="row-stat-chips">
      {items.map(item => {
        const Icon = item.icon;
        return (
          <div
            key={item.testId}
            className="flex flex-col items-center gap-1 rounded-md border bg-card px-2 py-3"
            data-testid={item.testId}
          >
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="text-lg font-semibold" style={{ color: NAVY }}>
              {item.value}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground text-center">
              {item.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CourtsInPlayStrip({ courts }: { courts: CourtInPlay[] }) {
  // Live elapsed-time strip per occupied court, anchored on each court's
  // server `startedAt`. We keep our own seconds counter so the labels tick
  // forward smoothly between the 10s polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (courts.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="row-courts-in-play">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        Courts in play
      </p>
      <div className="flex flex-wrap gap-2">
        {courts.map(c => {
          const elapsed = c.startedAt
            ? Math.max(0, Math.floor((now - new Date(c.startedAt).getTime()) / 1000))
            : null;
          return (
            <Badge
              key={c.id}
              variant="secondary"
              className="font-medium"
              data-testid={`chip-court-${c.id}`}
            >
              <span className="font-semibold" style={{ color: NAVY }}>
                {c.name}
              </span>
              <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                {elapsed == null ? 'in play' : formatElapsed(elapsed)}
              </span>
            </Badge>
          );
        })}
      </div>
    </div>
  );
}

function LastGameCard({ last }: { last: LastGameSummary }) {
  const opponents = last.opponentNames.length
    ? last.opponentNames.join(' & ')
    : 'opponents';
  const partner = last.partnerName ? ` with ${last.partnerName}` : '';
  return (
    <Card data-testid="card-last-game">
      <CardContent className="py-3 px-4 flex items-center justify-between gap-3">
        <div className="text-sm flex-1 min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Last game
          </p>
          <p className="truncate" data-testid="text-last-game-summary">
            <span className="font-semibold" style={{ color: last.won ? TEAL : NAVY }}>
              {last.won ? 'Won' : 'Lost'} {last.myScore}–{last.theirScore}
            </span>{' '}
            <span className="text-muted-foreground">vs {opponents}{partner}</span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function OnDeckCard({ suggestion }: { suggestion: CurrentSuggestion }) {
  const selfTeamNum = suggestion.selfTeam ?? 1;
  const oppTeamNum = selfTeamNum === 1 ? 2 : 1;
  const yourTeam = suggestion.players.filter(p => p.team === selfTeamNum);
  const opponents = suggestion.players.filter(p => p.team === oppTeamNum);

  return (
    <Card data-testid="card-on-deck">
      <CardContent className="py-6 space-y-5">
        <div className="text-center space-y-1">
          <p className="text-xs uppercase tracking-wider" style={{ color: TEAL }}>
            On deck
          </p>
          <h2 className="text-xl font-semibold" style={{ color: NAVY }} data-testid="text-on-deck-heading">
            {suggestion.courtName ? (
              <>
                You're up next on{' '}
                <span style={{ color: TEAL }} data-testid="text-on-deck-court-name">
                  Court {suggestion.courtName}
                </span>
              </>
            ) : (
              <>You're up next</>
            )}
          </h2>
          <p className="text-xs text-muted-foreground" data-testid="text-on-deck-helper">
            We'll move you to the court the moment the current game ends.
          </p>
          {suggestion.includesActivePlayers && (
            <p
              className="text-xs italic text-muted-foreground"
              data-testid="text-on-deck-may-adjust"
            >
              Lineup may adjust when the current game ends.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <TeamRow label="Your team" players={yourTeam} accent={TEAL} testId="team-self" />
          <div className="text-center text-xs uppercase tracking-wider text-muted-foreground">vs</div>
          <TeamRow label="Opponents" players={opponents} accent={NAVY} testId="team-opponents" />
        </div>
      </CardContent>
    </Card>
  );
}

function FindingNextGameCard() {
  return (
    <Card data-testid="card-finding-game">
      <CardContent className="py-10 text-center space-y-3">
        <div className="mx-auto h-2 w-32 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full w-1/3 rounded-full animate-pulse"
            style={{ backgroundColor: TEAL }}
          />
        </div>
        <p className="text-sm font-medium" style={{ color: NAVY }} data-testid="text-finding-game">
          Finding your next game…
        </p>
        <p className="text-xs text-muted-foreground">
          The Court Captain is sorting out the next round.
        </p>
      </CardContent>
    </Card>
  );
}

function NextGameCard({ suggestion }: { suggestion: CurrentSuggestion }) {
  const selfTeamNum = suggestion.selfTeam ?? 1;
  const oppTeamNum = selfTeamNum === 1 ? 2 : 1;
  const yourTeam = suggestion.players.filter((p) => p.team === selfTeamNum);
  const opponents = suggestion.players.filter((p) => p.team === oppTeamNum);
  const isApproved = suggestion.status === 'approved';

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const startGameMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest<{ success: boolean; alreadyStarted: boolean }>(
        'POST',
        `/api/marketplace/games/${suggestion.id}/start-game`,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['/api/marketplace/players/me/current-suggestion'],
      });
    },
    onError: (err: unknown) => {
      const isMatchGone =
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        ((err as { status: number }).status === 404 ||
          (err as { status: number }).status === 409);
      toast({
        title: "Couldn't start the game",
        description: isMatchGone
          ? "This match is no longer available. Looking for your next game…"
          : "Please try again or ask the Court Captain.",
        variant: 'destructive',
      });
      queryClient.invalidateQueries({
        queryKey: ['/api/marketplace/players/me/current-suggestion'],
      });
    },
  });

  return (
    <>
      <Card data-testid="card-next-game">
        <CardContent className="py-6 space-y-5">
          {isApproved ? (
            <div className="flex items-center gap-4">
              <CourtBadge name={suggestion.courtName} />
              <div className="flex-1 min-w-0">
                <p className="text-xs uppercase tracking-wider" style={{ color: TEAL }}>
                  Court ready
                </p>
                <h2 className="text-lg font-semibold leading-tight" data-testid="text-game-heading">
                  Head to{' '}
                  <span style={{ color: TEAL }} data-testid="text-court-name-approved">
                    Court {suggestion.courtName}
                  </span>{' '}
                  now
                </h2>
              </div>
            </div>
          ) : (
            <div className="text-center space-y-1">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Up next
              </p>
              <h2 className="text-xl font-semibold" style={{ color: NAVY }} data-testid="text-game-heading">
                Your next game
              </h2>
              <p className="text-sm text-muted-foreground" data-testid="text-court-name-pending">
                Court {suggestion.courtName}
              </p>
            </div>
          )}

          {!isApproved && suggestion.pendingUntil ? (
            <PendingCountdown pendingUntil={suggestion.pendingUntil} />
          ) : null}

          <div className="space-y-3">
            <TeamRow label="Your team" players={yourTeam} accent={TEAL} testId="team-self" />
            <div className="text-center text-xs uppercase tracking-wider text-muted-foreground">vs</div>
            <TeamRow label="Opponents" players={opponents} accent={NAVY} testId="team-opponents" />
          </div>
        </CardContent>
      </Card>

      {isApproved && (
        <StickyCta>
          <Button
            size="lg"
            className="w-full text-base h-14"
            onClick={() => startGameMutation.mutate()}
            disabled={startGameMutation.isPending}
            data-testid="button-start-game"
          >
            {startGameMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              "We're at the court – start game"
            )}
          </Button>
        </StickyCta>
      )}
    </>
  );
}

function CourtBadge({ name }: { name: string }) {
  return (
    <div
      className="h-16 w-16 shrink-0 rounded-md border-2 flex flex-col items-center justify-center"
      style={{ borderColor: TEAL, backgroundColor: '#F5EFE0' }}
      data-testid="badge-court-number"
    >
      <span className="text-[9px] uppercase tracking-wider" style={{ color: TEAL }}>
        Court
      </span>
      <span className="text-2xl font-bold leading-none" style={{ color: NAVY }}>
        {name?.trim() || '—'}
      </span>
    </div>
  );
}

function PendingCountdown({ pendingUntil }: { pendingUntil: string }) {
  // Server-anchored countdown: we recompute remaining time from the
  // pendingUntil timestamp every second. Window is assumed to be 90s
  // (matches the backend pendingUntil = now+90s on insert/flip).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const targetMs = new Date(pendingUntil).getTime();
  const remainingMs = Math.max(0, targetMs - now);
  const totalMs = 90_000;
  const fraction = Math.max(0, Math.min(1, remainingMs / totalMs));
  const seconds = Math.ceil(remainingMs / 1000);
  return (
    <div className="space-y-1" data-testid="row-pending-countdown">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full transition-[width] duration-300 ease-linear"
          style={{ width: `${fraction * 100}%`, backgroundColor: TEAL }}
        />
      </div>
      <p className="text-xs text-center text-muted-foreground tabular-nums">
        Lineup confirms in {seconds}s
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
                  <p className="text-xs text-muted-foreground leading-tight" data-testid={`text-player-tier-${p.playerId}`}>
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
  // Pinned to the bottom of the viewport on mobile so primary CTAs are
  // always thumb-reachable. On desktop we stop pinning at the `sm`
  // breakpoint and let the button flow inline.
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

function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Soft court-ready chime built with Web Audio so we don't ship an audio asset.
// Two short sine tones — quiet enough to be a notification, not a startle.
function playChime(): void {
  const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const note = (freq: number, start: number, duration: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime + start);
    gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + duration + 0.05);
  };
  note(880, 0, 0.18);
  note(1175, 0.18, 0.22);
  window.setTimeout(() => ctx.close().catch(() => {}), 800);
}
