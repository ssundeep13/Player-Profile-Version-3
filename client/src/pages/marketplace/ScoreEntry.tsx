import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { apiRequest, getMarketplaceAccessToken } from '@/lib/queryClient';
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

interface SubmitScoreResponse {
  success: true;
  gameResultId: string;
  alreadySubmitted: boolean;
}

interface FlagResponse {
  success: true;
  disputeId: string;
  alreadyFlagged: boolean;
}

const NAVY = '#003E8C';
const TEAL = '#006B5F';

function isNonNegativeInteger(raw: string): boolean {
  if (raw.trim() === '') return false;
  if (!/^\d+$/.test(raw.trim())) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0;
}

export default function ScoreEntry() {
  usePageTitle('Score');
  const [, setLocation] = useLocation();

  // The score-entry screen opts in to the 'completed' fallback via
  // ?for=score-entry. Other consumers (waiting screen, playing screen)
  // intentionally do not pass this and therefore never receive a stale
  // completed suggestion.
  const suggestionQuery = useQuery<CurrentSuggestionResponse>({
    queryKey: ['/api/marketplace/players/me/current-suggestion', { for: 'score-entry' }],
    queryFn: async () => {
      const res = await fetch(
        '/api/marketplace/players/me/current-suggestion?for=score-entry',
        {
          credentials: 'include',
          headers: {
            Authorization: `Bearer ${getMarketplaceAccessToken() ?? ''}`,
          },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const suggestion = suggestionQuery.data?.suggestion ?? null;
  // Pin the lineup shown in the form so a background refetch cannot swap
  // in the next-round pending suggestion (empty 0-0 form for wrong match).
  const latchedSuggestionRef = useRef<CurrentSuggestion | null>(null);

  // Latch the initial decision (form vs. already-submitted view) the FIRST
  // time the query resolves and never recompute it from later refetches.
  // This is critical: once Player A submits inside ScoreEntryContent, the
  // server flips the suggestion to 'completed'. If a background refetch
  // (e.g. after a mobile network reconnect) lands while ScoreEntryContent
  // is showing the post-submit confirmation, naively branching on the
  // live status would yank Player A's confirmation out from under them
  // and replace it with the late-submitter view. The latch keeps the
  // top-level branch stable for the lifetime of this screen; concurrent
  // submissions are still handled inside ScoreEntryContent via the
  // alreadySubmitted=true response from the submit-score endpoint.
  const initialBranchRef = useRef<'form' | 'already-submitted' | 'redirect' | null>(null);
  if (initialBranchRef.current === null && !suggestionQuery.isPending) {
    const status = suggestion?.status ?? null;
    if (status === 'playing') {
      initialBranchRef.current = 'form';
      if (suggestion) {
        latchedSuggestionRef.current = suggestion;
      }
    } else if (status === 'completed') {
      initialBranchRef.current = 'already-submitted';
    } else {
      initialBranchRef.current = 'redirect';
    }
  }
  const initialBranch = initialBranchRef.current;

  // If the player landed here without a live or recently-completed game,
  // send them back to the waiting screen.
  useEffect(() => {
    if (initialBranch === 'redirect') {
      setLocation('/marketplace/play');
    }
  }, [initialBranch, setLocation]);

  return (
    <div
      className="mx-auto w-full max-w-md px-4 py-6 sm:py-10"
      data-testid="page-score-entry"
    >
      {initialBranch === null ? (
        <InitialSkeleton />
      ) : initialBranch === 'form' && latchedSuggestionRef.current ? (
        <ScoreEntryContent suggestion={latchedSuggestionRef.current} />
      ) : initialBranch === 'already-submitted' ? (
        // Late-submitter path: by the time this player landed on the score
        // screen, another player on the court had already submitted the
        // score (the suggestion is already completed). Skip the form
        // entirely — there's nothing for them to record — and show a
        // brief confirmation before routing them to the same destination
        // late submitters reach today.
        <AlreadySubmittedView />
      ) : (
        <InitialSkeleton />
      )}
    </div>
  );
}

function AlreadySubmittedView() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    const id = window.setTimeout(() => {
      setLocation('/marketplace/play');
    }, 2000);
    return () => {
      window.clearTimeout(id);
    };
  }, [setLocation]);

  return (
    <div className="space-y-6" data-testid="state-already-submitted">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wider" style={{ color: TEAL }}>
          Game ended
        </p>
        <h1
          className="text-2xl font-semibold"
          style={{ color: NAVY }}
          data-testid="text-already-submitted-heading"
        >
          Score already submitted.
        </h1>
      </div>

      <Card data-testid="card-already-submitted">
        <CardContent className="py-8 text-center space-y-2">
          <p className="text-sm" data-testid="text-already-submitted-body">
            Another player on your court entered the score. Taking you back to
            the session…
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function InitialSkeleton() {
  return (
    <div className="space-y-4" data-testid="state-score-loading">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

function ScoreEntryContent({ suggestion }: { suggestion: CurrentSuggestion }) {
  const [, setLocation] = useLocation();

  // Render from the requesting player's perspective. selfTeam comes from the
  // backend; fall back to team 1 defensively so the UI never crashes.
  const selfTeamNum: 1 | 2 = suggestion.selfTeam ?? 1;
  const oppTeamNum: 1 | 2 = selfTeamNum === 1 ? 2 : 1;
  const yourTeamPlayers = suggestion.players.filter((p) => p.team === selfTeamNum);
  const opponentPlayers = suggestion.players.filter((p) => p.team === oppTeamNum);

  // Local form state. The two inputs are labelled from the player's
  // perspective ("Your team" / "Opponents"); the API expects team1Score /
  // team2Score, so we map at submission time.
  const [yourScoreRaw, setYourScoreRaw] = useState('');
  const [oppScoreRaw, setOppScoreRaw] = useState('');
  const [selectedWinner, setSelectedWinner] = useState<'self' | 'opponents' | null>(null);

  // Post-submit state. Once we have a gameResultId, we render the flag
  // button; we never re-show the form.
  const [submittedGameResultId, setSubmittedGameResultId] = useState<string | null>(null);
  const [submittedAlreadyRecorded, setSubmittedAlreadyRecorded] = useState(false);
  const [flagResolved, setFlagResolved] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);

  // Holds the post-submit auto-redirect timer so the "Flag this score"
  // tap can cancel it. Cleared on unmount to avoid late navigation.
  const redirectTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (redirectTimerRef.current !== null) {
        window.clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }
    };
  }, []);

  const cancelAutoRedirect = () => {
    if (redirectTimerRef.current !== null) {
      window.clearTimeout(redirectTimerRef.current);
      redirectTimerRef.current = null;
    }
  };

  const yourScoreValid = isNonNegativeInteger(yourScoreRaw);
  const oppScoreValid = isNonNegativeInteger(oppScoreRaw);
  const bothScoresValid = yourScoreValid && oppScoreValid;

  // Derived validation. We only show inline messages once both inputs are
  // valid integers — partial input shouldn't yell at the player.
  const isTied = bothScoresValid && Number(yourScoreRaw) === Number(oppScoreRaw);
  const winnerMismatch = useMemo(() => {
    if (!bothScoresValid || isTied || !selectedWinner) return false;
    const yourWon = Number(yourScoreRaw) > Number(oppScoreRaw);
    return selectedWinner === 'self' ? !yourWon : yourWon;
  }, [bothScoresValid, isTied, selectedWinner, yourScoreRaw, oppScoreRaw]);

  const submitMutation = useMutation<
    SubmitScoreResponse,
    { error?: string; status?: number },
    { team1Score: number; team2Score: number; winningTeam: 1 | 2 }
  >({
    mutationFn: (payload) =>
      apiRequest<SubmitScoreResponse>(
        'POST',
        `/api/marketplace/games/${suggestion.id}/submit-score`,
        payload,
      ),
    onSuccess: (data) => {
      setSubmittedGameResultId(data.gameResultId);
      setSubmittedAlreadyRecorded(data.alreadySubmitted);
      setSubmitError(null);
      // Auto-navigate after the confirmation has had a moment to land.
      //   - First submitter (alreadySubmitted=false) → 1.5s → P9 done
      //     screen at /marketplace/play/done. P9 hasn't shipped yet, so
      //     wouter falls through to NotFound — accepted per the plan.
      //   - Late submitter (alreadySubmitted=true) → 2s → session hub
      //     at /marketplace/play (today's "session summary" surface).
      // The handle is stored in a ref so tapping "Flag this score"
      // can cancel the timer — flagging is the rare-but-important
      // path and must not get raced away by the redirect.
      const destination = data.alreadySubmitted
        ? '/marketplace/play'
        : '/marketplace/play/done';
      const delayMs = data.alreadySubmitted ? 2000 : 1500;
      redirectTimerRef.current = window.setTimeout(() => {
        setLocation(destination);
      }, delayMs);
    },
    onError: (err) => {
      setSubmitError(
        err?.error ??
          'Could not submit the score. Please try again or ask the Court Captain for help.',
      );
    },
  });

  const flagMutation = useMutation<
    FlagResponse,
    { error?: string; status?: number },
    void
  >({
    mutationFn: () =>
      apiRequest<FlagResponse>(
        'POST',
        `/api/marketplace/games/${submittedGameResultId}/flag`,
        {},
      ),
    onSuccess: () => {
      setFlagResolved(true);
      setFlagError(null);
    },
    onError: (err) => {
      setFlagError(
        err?.error ??
          'Could not flag the score. Please ask the Court Captain to look into it.',
      );
    },
  });

  const canSubmit =
    !submitMutation.isPending &&
    submittedGameResultId === null &&
    bothScoresValid &&
    !isTied &&
    selectedWinner !== null &&
    !winnerMismatch;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const yourNum = Number(yourScoreRaw);
    const oppNum = Number(oppScoreRaw);
    // Map the player-perspective scores back to team1/team2 the API expects.
    const team1Score = selfTeamNum === 1 ? yourNum : oppNum;
    const team2Score = selfTeamNum === 1 ? oppNum : yourNum;
    const winningTeamNum: 1 | 2 =
      selectedWinner === 'self' ? selfTeamNum : oppTeamNum;
    submitMutation.mutate({
      team1Score,
      team2Score,
      winningTeam: winningTeamNum,
    });
  };

  // Allow only digits as the user types, but keep the value as a string so
  // we can show the empty state cleanly. Strip leading zeros except for "0".
  const handleScoreChange =
    (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const digits = e.target.value.replace(/[^0-9]/g, '');
      const normalized = digits.length > 1 ? digits.replace(/^0+/, '') || '0' : digits;
      setter(normalized);
    };

  const submitted = submittedGameResultId !== null;

  return (
    <div className="space-y-6" data-testid="state-score-entry">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wider" style={{ color: TEAL }}>
          Game over
        </p>
        <h1
          className="text-2xl font-semibold"
          style={{ color: NAVY }}
          data-testid="text-score-heading"
        >
          What was the score?
        </h1>
      </div>

      <Card data-testid="card-score-entry">
        <CardContent className="py-6 space-y-6">
          <div className="text-center space-y-1">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Court
            </p>
            <p
              className="text-2xl font-semibold"
              style={{ color: NAVY }}
              data-testid="text-court-name"
            >
              {suggestion.courtName}
            </p>
          </div>

          <div className="space-y-3">
            <TeamRow
              label="Your team"
              players={yourTeamPlayers}
              accent={TEAL}
              testId="team-self"
            />
            <div className="text-center text-xs uppercase tracking-wider text-muted-foreground">
              vs
            </div>
            <TeamRow
              label="Opponents"
              players={opponentPlayers}
              accent={NAVY}
              testId="team-opponents"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 pt-2">
            <ScoreInput
              label="Your team"
              accent={TEAL}
              value={yourScoreRaw}
              onChange={handleScoreChange(setYourScoreRaw)}
              disabled={submitted || submitMutation.isPending}
              testId="input-score-self"
            />
            <ScoreInput
              label="Opponents"
              accent={NAVY}
              value={oppScoreRaw}
              onChange={handleScoreChange(setOppScoreRaw)}
              disabled={submitted || submitMutation.isPending}
              testId="input-score-opponents"
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Who won?
            </p>
            <div className="grid grid-cols-2 gap-3">
              <WinnerCard
                label="Your team"
                players={yourTeamPlayers}
                accent={TEAL}
                selected={selectedWinner === 'self'}
                disabled={submitted || submitMutation.isPending}
                onClick={() => setSelectedWinner('self')}
                testId="button-winner-self"
              />
              <WinnerCard
                label="Opponents"
                players={opponentPlayers}
                accent={NAVY}
                selected={selectedWinner === 'opponents'}
                disabled={submitted || submitMutation.isPending}
                onClick={() => setSelectedWinner('opponents')}
                testId="button-winner-opponents"
              />
            </div>
          </div>

          {isTied ? (
            <p
              className="text-sm text-destructive text-center"
              data-testid="text-error-tied"
            >
              Scores cannot be tied — badminton always has a winner
            </p>
          ) : winnerMismatch ? (
            <p
              className="text-sm text-destructive text-center"
              data-testid="text-error-mismatch"
            >
              The winner you picked has the lower score. Adjust the scores or
              the winner before submitting.
            </p>
          ) : null}

          {submitError ? (
            <p
              className="text-sm text-destructive text-center"
              data-testid="text-error-submit"
            >
              {submitError}
            </p>
          ) : null}

          {!submitted ? (
            <Button
              size="lg"
              className="w-full"
              style={{ backgroundColor: NAVY, color: 'white' }}
              disabled={!canSubmit}
              onClick={handleSubmit}
              data-testid="button-submit-score"
            >
              {submitMutation.isPending ? 'Submitting…' : 'Submit score'}
            </Button>
          ) : (
            <div className="space-y-3">
              <p
                className="text-sm font-medium text-center"
                style={{ color: TEAL }}
                data-testid="text-submit-confirmation"
              >
                {submittedAlreadyRecorded
                  ? 'Score already recorded'
                  : 'Score submitted'}
              </p>

              {flagResolved ? (
                <p
                  className="text-xs text-center text-muted-foreground"
                  data-testid="text-flag-confirmation"
                >
                  Flagged for review
                </p>
              ) : (
                <>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={flagMutation.isPending}
                    onClick={() => {
                      cancelAutoRedirect();
                      flagMutation.mutate();
                    }}
                    data-testid="button-flag-score"
                  >
                    {flagMutation.isPending ? 'Flagging…' : 'Flag this score'}
                  </Button>
                  {flagError ? (
                    <p
                      className="text-xs text-destructive text-center"
                      data-testid="text-error-flag"
                    >
                      {flagError}
                    </p>
                  ) : null}
                </>
              )}

              {/*
                Explicit "Done" button — fallback escape hatch. The auto-
                redirect handles the common case; this lets a player who
                cancelled it (by tapping "Flag this score") still leave
                the screen on their own terms.
              */}
              <Button
                size="lg"
                className="w-full"
                style={{ backgroundColor: NAVY, color: 'white' }}
                onClick={() => {
                  cancelAutoRedirect();
                  setLocation(
                    submittedAlreadyRecorded
                      ? '/marketplace/play'
                      : '/marketplace/play/done',
                  );
                }}
                data-testid="button-done"
              >
                Done
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ScoreInput({
  label,
  accent,
  value,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  accent: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-wider" style={{ color: accent }}>
        {label}
      </span>
      <Input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder="0"
        className="h-14 text-center text-3xl font-semibold tabular-nums"
        data-testid={testId}
      />
    </label>
  );
}

function WinnerCard({
  label,
  players,
  accent,
  selected,
  disabled,
  onClick,
  testId,
}: {
  label: string;
  players: CurrentSuggestionPlayer[];
  accent: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border p-3 text-left hover-elevate active-elevate-2 disabled:opacity-60 disabled:cursor-not-allowed ${
        selected ? 'border-2' : ''
      }`}
      style={{
        borderColor: selected ? TEAL : undefined,
        backgroundColor: selected ? `${TEAL}10` : undefined,
      }}
      data-testid={testId}
    >
      <p className="text-xs uppercase tracking-wider mb-1" style={{ color: accent }}>
        {label}
      </p>
      <div className="space-y-0.5">
        {players.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          players.map((p) => (
            <p key={p.playerId} className="text-sm font-medium leading-tight">
              {p.playerName}
            </p>
          ))
        )}
      </div>
    </button>
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
