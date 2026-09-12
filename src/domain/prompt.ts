export type PromptState = "queued" | "running" | "delivered" | "failed" | "cancelled";
export type TurnPriority = "normal" | "priority";
export type PromptObservationState = "not_started" | "attached" | "detached" | "completed";
export type PromptWorkHint =
  | { kind: "prompt-ready"; bindingId: string }
  | { kind: "control-ready"; bindingId: string }
  | { kind: "detached-observer-ready"; bindingId: string; promptId: string }
  | { kind: "binding-runtime-changed"; bindingId: string };
export interface DurablePromptWorkScan { cancelled: number; failedDetached: number; hints: PromptWorkHint[] }
export interface StalePromptClaim { promptId: string; bindingId: string; updatedAt: string }
export interface UndispatchedPromptClaimFence extends StalePromptClaim { bindingGeneration: number; paneId: string }
export interface PromptJob {
  id: string; bindingId: string; larkMessageId: string; actorOpenId: string; body: string; executionOrigin: "bridge" | "herdr";
  parentPromptId: string | null;
  priority: TurnPriority; wasDetached: boolean; dispatchedAt: string | null; transcriptTurnId: string | null; transcriptTurnStartedAt: string | null;
  modelName?: string | null; modelRevision?: number | null; observationState: PromptObservationState; state: PromptState; attemptCount: number;
  error: string | null; createdAt: string; updatedAt: string;
}
export interface ExternalTurnAdoption { outcome: "adopted_queued" | "created_external" | "already_owned" | "stale_binding" | "conflict"; prompt: PromptJob | null; supersededPromptIds: string[]; outboxReserved: boolean }
export interface ExternalTurnSupersessionFence { promptId: string; turnId: string; startedAt: string }
export type TranscriptTurnClaimOutcome =
  | { state: "claimed"; prompt: PromptJob }
  | { state: "matched"; prompt: PromptJob }
  | { state: "conflict"; prompt: PromptJob }
  | { state: "ineligible"; prompt: PromptJob | null };
