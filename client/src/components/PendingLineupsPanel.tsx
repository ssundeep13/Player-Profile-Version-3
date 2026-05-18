import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Clock, Check, X, Pencil, ArrowLeftRight } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const NAVY = "#003E8C";
const TEAL = "#006B5F";
const CREAM = "#F5EFE0";

type PendingSuggestion = {
  id: string;
  sessionId: string;
  courtId: string;
  courtName: string;
  pendingUntil: string | null;
  status: string;
  includesActivePlayers?: boolean;
  players: Array<{
    suggestionId: string;
    courtId: string;
    playerId: string;
    team: number;
    name: string;
  }>;
};

type SwapCandidatesResponse = {
  candidates: Array<{ playerId: string; name: string }>;
  playingPlayerIds: string[];
};

type DraftSwap = {
  removePlayerId: string;
  addPlayerId: string;
  team: number;
  displayName: string;
};

interface PendingLineupsPanelProps {
  sessionId: string;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "Expired";
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

function LineupSuggestionCard({
  sessionId,
  suggestion,
  variant,
  editing,
  onStartEdit,
  onCancelEdit,
  onApprove,
  onDismiss,
  isApproving,
  isDismissing,
  isSavingEdit,
  onSaveEdit,
}: {
  sessionId: string;
  suggestion: PendingSuggestion;
  variant: "pending" | "queued";
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onApprove?: () => void;
  onDismiss: () => void;
  isApproving?: boolean;
  isDismissing: boolean;
  isSavingEdit: boolean;
  onSaveEdit: (
    swaps: Array<{ removePlayerId: string; addPlayerId: string; team: number }>,
  ) => void;
}) {
  const [draftSwaps, setDraftSwaps] = useState<Record<string, DraftSwap>>({});
  const [swapTargetId, setSwapTargetId] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraftSwaps({});
      setSwapTargetId(null);
    }
  }, [editing]);

  const { data: swapData } = useQuery<SwapCandidatesResponse>({
    queryKey: ["/api/sessions", sessionId, "suggestions", suggestion.id, "swap-candidates"],
    queryFn: () =>
      apiRequest<SwapCandidatesResponse>(
        "GET",
        `/api/sessions/${sessionId}/suggestions/${suggestion.id}/swap-candidates`,
      ),
    enabled: editing && !!sessionId,
  });

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (variant !== "pending") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [variant]);

  const remainingMs = suggestion.pendingUntil
    ? new Date(suggestion.pendingUntil).getTime() - now
    : 0;
  const expired = variant === "pending" && remainingMs <= 0;

  const playingSet = useMemo(
    () => new Set(swapData?.playingPlayerIds ?? []),
    [swapData?.playingPlayerIds],
  );

  const displayPlayers = useMemo(() => {
    return suggestion.players.map((p) => {
      const draft = draftSwaps[p.playerId];
      if (draft) {
        return { ...p, playerId: draft.addPlayerId, name: draft.displayName };
      }
      return p;
    });
  }, [suggestion.players, draftSwaps]);

  const team1 = displayPlayers.filter((p) => p.team === 1);
  const team2 = displayPlayers.filter((p) => p.team === 2);

  const pendingSwaps = Object.values(draftSwaps);
  const hasDraftChanges = pendingSwaps.length > 0;

  const startEdit = () => {
    setDraftSwaps({});
    setSwapTargetId(null);
    onStartEdit();
  };

  const cancelEdit = () => {
    setDraftSwaps({});
    setSwapTargetId(null);
    onCancelEdit();
  };

  const applySwap = (removePlayer: PendingSuggestion["players"][0], addPlayerId: string) => {
    const candidate = swapData?.candidates.find((c) => c.playerId === addPlayerId);
    if (!candidate) return;
    setDraftSwaps((prev) => ({
      ...prev,
      [removePlayer.playerId]: {
        removePlayerId: removePlayer.playerId,
        addPlayerId: candidate.playerId,
        team: removePlayer.team,
        displayName: candidate.name,
      },
    }));
    setSwapTargetId(null);
  };

  const handleSave = () => {
    if (!hasDraftChanges) {
      cancelEdit();
      return;
    }
    onSaveEdit(
      pendingSwaps.map(({ removePlayerId, addPlayerId, team }) => ({
        removePlayerId,
        addPlayerId,
        team,
      })),
    );
  };

  const pickerCandidates = (swapData?.candidates ?? []).filter((c) => {
    const usedElsewhere = Object.values(draftSwaps).some(
      (d) => d.addPlayerId === c.playerId && d.removePlayerId !== swapTargetId,
    );
    return !usedElsewhere;
  });

  const rowTestId =
    variant === "pending"
      ? `row-pending-suggestion-${suggestion.id}`
      : `row-queued-suggestion-${suggestion.id}`;

  return (
    <div
      className={`flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-start sm:justify-between ${
        variant === "queued" ? "border-dashed" : ""
      } ${editing ? "ring-2 ring-[#006B5F]" : ""}`}
      style={editing ? { backgroundColor: CREAM, borderColor: TEAL } : undefined}
      data-testid={rowTestId}
    >
      <div className="flex flex-col gap-2 min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" data-testid={`badge-court-${suggestion.id}`}>
            Court {suggestion.courtName}
          </Badge>
          {variant === "pending" ? (
            <div
              className="inline-flex items-center gap-1 text-sm text-muted-foreground"
              data-testid={`text-countdown-${suggestion.id}`}
            >
              <Clock className="h-3.5 w-3.5" />
              <span>{expired ? "Approving…" : `Auto-approve in ${formatCountdown(remainingMs)}`}</span>
            </div>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">On deck</span>
              {suggestion.includesActivePlayers && (
                <span
                  className="text-xs italic text-muted-foreground"
                  data-testid={`text-queued-may-adjust-${suggestion.id}`}
                >
                  Lineup may adjust when the current game ends
                </span>
              )}
            </>
          )}
          {editing && (
            <span className="text-xs font-medium uppercase tracking-wider" style={{ color: TEAL }}>
              Editing lineup
            </span>
          )}
        </div>

        {editing ? (
          <div className="space-y-3" data-testid={`edit-lineup-${suggestion.id}`}>
            {suggestion.players.map((original) => {
              const draft = draftSwaps[original.playerId];
              const displayName = draft?.displayName ?? original.name;
              const isPlaying = playingSet.has(original.playerId);
              const showPicker = swapTargetId === original.playerId;

              return (
                <div
                  key={original.playerId}
                  className="flex flex-col gap-2 rounded-md border bg-white/80 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                  data-testid={`edit-player-row-${original.playerId}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: NAVY }}>
                      {displayName}
                      {draft && (
                        <span className="text-xs font-normal text-muted-foreground ml-2">
                          (replacing {original.name})
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">Team {original.team}</p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    {showPicker ? (
                      <Select
                        onValueChange={(value) => applySwap(original, value)}
                      >
                        <SelectTrigger
                          className="w-full sm:w-[220px]"
                          data-testid={`select-replacement-${original.playerId}`}
                        >
                          <SelectValue placeholder="Choose replacement" />
                        </SelectTrigger>
                        <SelectContent>
                          {pickerCandidates.map((c) => (
                            <SelectItem key={c.playerId} value={c.playerId}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isPlaying}
                        onClick={() => setSwapTargetId(original.playerId)}
                        data-testid={`button-swap-${original.playerId}`}
                        className="border-[#006B5F] text-[#006B5F] hover:bg-[#006B5F]/10"
                      >
                        <ArrowLeftRight className="h-3.5 w-3.5 mr-1" />
                        Swap
                      </Button>
                    )}
                    {showPicker && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setSwapTargetId(null)}
                      >
                        Cancel swap
                      </Button>
                    )}
                    {isPlaying && (
                      <span className="text-xs text-muted-foreground">On court now</span>
                    )}
                  </div>
                </div>
              );
            })}
            {(swapData?.candidates.length ?? 0) === 0 && (
              <p className="text-xs text-muted-foreground">
                No waiting players available to swap in. Add players to the queue first.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium" data-testid={`text-team1-${suggestion.id}`}>
              {team1.map((p) => p.name).join(" + ") || "—"}
            </span>
            <span className="text-muted-foreground">vs</span>
            <span className="font-medium" data-testid={`text-team2-${suggestion.id}`}>
              {team2.map((p) => p.name).join(" + ") || "—"}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        {editing ? (
          <>
            <Button
              size="sm"
              disabled={isSavingEdit}
              onClick={handleSave}
              data-testid={`button-save-edit-${suggestion.id}`}
              style={{ backgroundColor: NAVY, color: "white" }}
            >
              {isSavingEdit ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isSavingEdit}
              onClick={cancelEdit}
              data-testid={`button-cancel-edit-${suggestion.id}`}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={startEdit}
              disabled={isApproving || isDismissing}
              data-testid={`button-edit-${suggestion.id}`}
              className="border-[#003E8C] text-[#003E8C] hover:bg-[#003E8C]/10"
            >
              <Pencil className="h-4 w-4" />
              Edit
            </Button>
            {variant === "pending" && onApprove && (
              <Button
                size="sm"
                onClick={onApprove}
                disabled={isApproving || isDismissing}
                data-testid={`button-approve-${suggestion.id}`}
                style={{ backgroundColor: TEAL, color: "white" }}
              >
                <Check className="h-4 w-4" />
                Approve now
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={onDismiss}
              disabled={isApproving || isDismissing}
              data-testid={
                variant === "queued"
                  ? `button-dismiss-queued-${suggestion.id}`
                  : `button-dismiss-${suggestion.id}`
              }
            >
              <X className="h-4 w-4" />
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function PendingLineupsPanel({ sessionId }: PendingLineupsPanelProps) {
  const { toast } = useToast();
  const [editingSuggestionId, setEditingSuggestionId] = useState<string | null>(null);
  const [savingSuggestionId, setSavingSuggestionId] = useState<string | null>(null);

  const { data: suggestions = [] } = useQuery<PendingSuggestion[]>({
    queryKey: ["/api/sessions", sessionId, "pending-suggestions"],
    refetchInterval: 10_000,
    enabled: !!sessionId,
  });

  const approveMutation = useMutation({
    mutationFn: async (suggestionId: string) => {
      return apiRequest("POST", `/api/sessions/${sessionId}/suggestions/${suggestionId}/approve`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId, "pending-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/courts"], exact: false });
      toast({ title: "Lineup approved", description: "Players have been notified." });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't approve lineup", description: err.message, variant: "destructive" });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (suggestionId: string) => {
      return apiRequest("POST", `/api/sessions/${sessionId}/suggestions/${suggestionId}/dismiss`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId, "pending-suggestions"] });
      toast({ title: "Lineup dismissed" });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't dismiss lineup", description: err.message, variant: "destructive" });
    },
  });

  const swapMutation = useMutation({
    mutationFn: async ({
      suggestionId,
      swaps,
    }: {
      suggestionId: string;
      swaps: Array<{ removePlayerId: string; addPlayerId: string; team: number }>;
    }) => {
      return apiRequest<{ suggestion: PendingSuggestion }>(
        "PUT",
        `/api/sessions/${sessionId}/suggestions/${suggestionId}/players`,
        { swaps },
      );
    },
    onSuccess: () => {
      setEditingSuggestionId(null);
      setSavingSuggestionId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId, "pending-suggestions"] });
      toast({
        title: "Lineup updated",
        description: "Affected players have been notified to check the Play screen.",
      });
    },
    onError: (err: Error) => {
      setSavingSuggestionId(null);
      toast({ title: "Couldn't update lineup", description: err.message, variant: "destructive" });
    },
  });

  const pending = suggestions.filter((s) => s.status === "pending");
  const queued = suggestions.filter((s) => s.status === "queued");

  if (pending.length === 0 && queued.length === 0) return null;

  const activeMutationId =
    approveMutation.variables ??
    dismissMutation.variables ??
    swapMutation.variables?.suggestionId;

  return (
    <Card data-testid="panel-pending-lineups">
      <CardHeader>
        <CardTitle className="text-base" style={{ color: NAVY }}>
          Pending Lineups (Court Captain)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending.length > 0 && (
          <div className="space-y-3" data-testid="group-pending">
            {pending.map((s) => (
              <LineupSuggestionCard
                key={s.id}
                sessionId={sessionId}
                suggestion={s}
                variant="pending"
                editing={editingSuggestionId === s.id}
                onStartEdit={() => setEditingSuggestionId(s.id)}
                onCancelEdit={() => setEditingSuggestionId(null)}
                onApprove={() => approveMutation.mutate(s.id)}
                onDismiss={() => dismissMutation.mutate(s.id)}
                isApproving={approveMutation.isPending && activeMutationId === s.id}
                isDismissing={dismissMutation.isPending && activeMutationId === s.id}
                isSavingEdit={swapMutation.isPending && savingSuggestionId === s.id}
                onSaveEdit={(swaps) => {
                  setSavingSuggestionId(s.id);
                  swapMutation.mutate({ suggestionId: s.id, swaps });
                }}
              />
            ))}
          </div>
        )}
        {queued.length > 0 && (
          <div className="space-y-2" data-testid="group-queued">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Up next (auto-confirms when current game ends)
            </p>
            {queued.map((s) => (
              <LineupSuggestionCard
                key={s.id}
                sessionId={sessionId}
                suggestion={s}
                variant="queued"
                editing={editingSuggestionId === s.id}
                onStartEdit={() => setEditingSuggestionId(s.id)}
                onCancelEdit={() => setEditingSuggestionId(null)}
                onDismiss={() => dismissMutation.mutate(s.id)}
                isDismissing={dismissMutation.isPending && activeMutationId === s.id}
                isSavingEdit={swapMutation.isPending && savingSuggestionId === s.id}
                onSaveEdit={(swaps) => {
                  setSavingSuggestionId(s.id);
                  swapMutation.mutate({ suggestionId: s.id, swaps });
                }}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
