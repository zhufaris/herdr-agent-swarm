import type { Logger } from "pino";
import type { HerdrPort, NativePromptSubmissionResult } from "../domain/ports/external.js";
import type { ClaimedPrompt } from "../domain/ports/prompt-acceptance.js";
import type { PromptDispatchStore, PromptRecoveryStore, PromptSessionStore } from "../domain/ports/prompt-run.js";
import type { Binding } from "../domain/types.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { classifyPromptSubmissionFailure } from "../domain/prompt-submission.js";
import { hasNativeAgentSession, requireMatchingRuntimeIdentity } from "./pane-runtime-identity.js";
import type { PromptRunRegistry } from "./prompt-run-registry.js";
import type { PromptTurnExecutor } from "./prompt-turn-executor.js";

export interface PrimaryPromptDispatcherPort { drain(bindingId: string, options?: { nativeInputBatchOnly?: boolean }): Promise<void>; }

interface Options {
  stores: { dispatch: Pick<PromptDispatchStore, "claimNextDispatchablePrompt" | "fencePromptNativeSubmission" | "markPromptNativeQueued" | "applyPromptNativeSubmissionReceipt" | "releaseRejectedNativeSubmission">; recovery: Pick<PromptRecoveryStore, "releaseUndispatchedPromptClaim" | "markPromptObservationDetached">; session: Pick<PromptSessionStore, "getBinding"> };
  herdr: Pick<HerdrPort, "getPane" | "supportsPromptQueue" | "queuePrompt" | "supportsModelPrompt" | "queueModelPrompt">;
  executor: Pick<PromptTurnExecutor, "execute">;
  registry: Pick<PromptRunRegistry, "attachTurn" | "detachTurn">;
  scheduler: Pick<PromptWorkScheduler, "wake">;
  logger: Pick<Logger, "warn">;
  isStopping(): boolean;
  handoffExternalTurns?(bindingId: string): Promise<void>;
  convergeMainCard(bindingId: string): Promise<void>;
  archiveDrainedBinding(binding: Binding): Promise<void>;
}

export class PrimaryPromptDispatcher implements PrimaryPromptDispatcherPort {
  constructor(private readonly options: Options) {}

  async drain(bindingId: string, options: { nativeInputBatchOnly?: boolean } = {}): Promise<void> {
    while (!this.options.isStopping()) {
      const nativeQueueAvailable = typeof this.options.herdr.queuePrompt === "function"
        && typeof this.options.herdr.supportsPromptQueue === "function"
        && await this.options.herdr.supportsPromptQueue();
      if (!nativeQueueAvailable && this.options.handoffExternalTurns) await this.options.handoffExternalTurns(bindingId);
      const claimed = options.nativeInputBatchOnly
        ? this.options.stores.dispatch.claimNextDispatchablePrompt(bindingId, options)
        : this.options.stores.dispatch.claimNextDispatchablePrompt(bindingId);
      if (!claimed) return;
      const { binding, prompt, executionBody, model } = claimed;
      const modelQueueAvailable = model === null || (
        typeof this.options.herdr.queueModelPrompt === "function"
        && typeof this.options.herdr.supportsModelPrompt === "function"
        && await this.options.herdr.supportsModelPrompt()
      );
      if (model && !modelQueueAvailable) {
        const released = this.release(claimed);
        this.options.logger.warn({ event: "prompt-model-queue-unavailable", bindingId, promptId: prompt.id, paneId: binding.paneId, outcome: released ? "requeued_before_dispatch" : "stale_claim" }, "deferred model prompt because Herdr Core does not advertise the fail-closed model prompt contract");
        return;
      }
      let livePane;
      try { livePane = await this.options.herdr.getPane(binding.paneId!); }
      catch (error) {
        const released = this.release(claimed);
        this.options.logger.warn({ event: "prompt-pre-dispatch-observation-failed", err: safeLogError(error), bindingId, promptId: prompt.id, paneId: binding.paneId, outcome: released ? "requeued_before_dispatch" : "stale_claim" }, "could not verify the pane was settled before prompt dispatch");
        return;
      }
      let unavailableReason: string | null = null;
      if (!livePane) unavailableReason = "pane_missing";
      else {
        try {
          requireMatchingRuntimeIdentity(binding, livePane);
          if (livePane.workspaceId !== binding.workspaceId) unavailableReason = "workspace_changed";
          else if (livePane.agentState === "blocked" || livePane.agentState === "working") unavailableReason = "runtime_busy";
          else if (livePane.agentState === "unknown") unavailableReason = "runtime_unknown";
        } catch { unavailableReason = "runtime_identity_changed"; }
      }
      if (unavailableReason) {
        const released = this.release(claimed);
        this.options.logger.warn({ event: "prompt-pre-dispatch-runtime-unavailable", bindingId, promptId: prompt.id, paneId: binding.paneId, reason: unavailableReason, agentState: livePane?.agentState ?? "unknown", outcome: released ? "requeued_before_dispatch" : "stale_claim" }, "deferred prompt dispatch because the live Herdr pane was not dispatchable");
        if (released && unavailableReason === "runtime_busy" && this.options.handoffExternalTurns) await this.options.handoffExternalTurns(bindingId);
        return;
      }
      const expectedSessionId = livePane?.agentSession?.kind === "id"
        ? livePane.agentSession.value
        : null;
      const sessionlessNativeInputBatchBootstrap = claimed.nativeInputBatch === true
        && !expectedSessionId
        && !hasNativeAgentSession(binding);
      if (nativeQueueAvailable) {
        if (!expectedSessionId && (model || livePane?.agentState === "working" || livePane?.agentState === "blocked")) {
          const released = this.release(claimed);
          this.options.logger.warn({ event: "prompt-native-queue-identity-unavailable", bindingId, promptId: prompt.id, paneId: binding.paneId, outcome: released ? "requeued_before_dispatch" : "stale_claim" }, "deferred native prompt submission because the exact Agent session identity was unavailable");
          return;
        }
        if (!expectedSessionId) {
          this.options.logger.warn({ event: "prompt-native-session-bootstrap", bindingId, promptId: prompt.id, paneId: binding.paneId, outcome: "observed_submission" }, "submitting the first prompt through the observed turn path because the Agent session identity does not exist yet");
        } else {
          const dispatchedAt = new Date().toISOString();
          const fenced = this.options.stores.dispatch.fencePromptNativeSubmission({
            promptId: prompt.id, bindingId, submissionId: prompt.id, dispatchedAt
          });
          if (!fenced) {
            this.options.logger.warn({ event: "prompt-native-queue-fence-stale", bindingId, promptId: prompt.id, paneId: binding.paneId, outcome: "stale_claim" }, "did not invoke native prompt submission because its durable attempt fence changed");
            return;
          }
          let receipt: NativePromptSubmissionResult;
          try {
            receipt = model
              ? await this.options.herdr.queueModelPrompt!(binding.paneId!, executionBody, { model: model.name, submissionId: prompt.id, expectedSessionId })
              : await this.options.herdr.queuePrompt!(binding.paneId!, executionBody, { submissionId: prompt.id, expectedSessionId });
          } catch (error) {
            const failure = classifyPromptSubmissionFailure(error);
            if (failure?.kind === "not_started" || failure?.kind === "rejected") {
              const released = this.options.stores.dispatch.releaseRejectedNativeSubmission({
                promptId: prompt.id, bindingId, submissionId: prompt.id, dispatchedAt
              });
              this.options.logger.warn({ event: "prompt-native-queue-rejected", err: safeLogError(error), bindingId, promptId: prompt.id, paneId: binding.paneId, outcome: released ? "requeued_before_dispatch" : "stale_claim" }, "Herdr rejected the native prompt submission before acceptance");
              return;
            }
            const reason = safeLogError(error).message;
            const persisted = this.options.stores.dispatch.markPromptNativeQueued({
              promptId: prompt.id, bindingId, submissionId: prompt.id, dispatchedAt, uncertainReason: reason
            });
            if (persisted) this.options.stores.recovery.markPromptObservationDetached?.(prompt.id, reason);
            if (persisted && claimed.nativeInputBatch) await this.options.convergeMainCard(bindingId);
            this.options.logger.warn({ event: "prompt-native-queue-uncertain", err: safeLogError(error), bindingId, promptId: prompt.id, paneId: binding.paneId, outcome: persisted ? "detached_without_replay" : "stale_claim" }, "native prompt submission may have been accepted; it will not be replayed");
            return;
          }
          const receiptMismatch = nativeReceiptMismatch(receipt, {
            submissionId: prompt.id,
            sessionId: expectedSessionId,
            agentKind: binding.agentKind ?? binding.agentSessionAgent ?? "traex",
            terminalId: livePane?.terminalId ?? null
          });
          const receiptState = receiptMismatch ? "uncertain" : receipt.receipt?.state;
          if (receiptState === "rejected") {
            const released = this.options.stores.dispatch.releaseRejectedNativeSubmission({
              promptId: prompt.id, bindingId, submissionId: prompt.id, dispatchedAt
            });
            this.options.logger.warn({ event: "prompt-native-queue-rejected", bindingId, promptId: prompt.id, paneId: binding.paneId, outcome: released ? "requeued_before_dispatch" : "stale_claim" }, "Core receipt proved the native prompt did not cross the submission boundary");
            return;
          }
          const uncertainReason = receiptMismatch
            ?? (receiptState === "uncertain" ? "Core reported an uncertain native submission; it will not be replayed"
              : receiptState === "prepared" ? "Core prepared the native submission but its PTY outcome is not yet known; it will not be replayed"
                : undefined);
          const receiptNotice = receiptState === "accepted"
            ? "Core confirmed the native submission; observing execution without replay"
            : uncertainReason;
          const persisted = receiptState
            ? this.options.stores.dispatch.applyPromptNativeSubmissionReceipt({
              promptId: prompt.id, bindingId, submissionId: prompt.id, dispatchedAt,
              state: receiptState === "accepted" ? "accepted" : "uncertain",
              notice: receiptNotice ?? "Core did not confirm the native submission outcome; it will not be replayed"
            })
            : this.options.stores.dispatch.markPromptNativeQueued({
              promptId: prompt.id, bindingId, submissionId: prompt.id, dispatchedAt
            });
          if (!persisted) {
            this.options.logger.warn({ event: "prompt-native-queue-receipt-stale", bindingId, promptId: prompt.id, paneId: binding.paneId, outcome: "detached_without_replay" }, "native prompt submission was accepted but its durable receipt fence changed");
            return;
          }
          if (!receiptState) this.options.stores.recovery.markPromptObservationDetached?.(
            prompt.id, "Native submission returned without a durable Core receipt; observing without replay"
          );
          if (claimed.nativeInputBatch) await this.options.convergeMainCard(bindingId);
          if (receipt.submissionId !== prompt.id) {
            this.options.logger.warn({ event: "prompt-native-queue-receipt-identity-mismatch", bindingId, promptId: prompt.id, paneId: binding.paneId, outcome: "detached_without_replay" }, "native prompt submission returned a mismatched receipt identity; preserving Prompt ID without replay");
            return;
          }
          if (model && !claimed.nativeInputBatch) await this.options.convergeMainCard(bindingId);
          return;
        }
      }
      if (model) await this.options.convergeMainCard(bindingId);
      const controller = this.options.registry.attachTurn(bindingId, prompt.id, binding.paneId!);
      let observerDetached = false;
      let dispatchDeferred = false;
      try {
        const execution = sessionlessNativeInputBatchBootstrap
          ? await this.options.executor.execute(claimed, controller, { transcriptAcquisition: "sessionless-bootstrap" })
          : await this.options.executor.execute(claimed, controller);
        observerDetached = execution.observerDetached;
        dispatchDeferred = execution.dispatchDeferred ?? false;
      } finally {
        this.options.registry.detachTurn(bindingId, prompt.id);
        this.options.scheduler.wake({ kind: "control-ready", bindingId });
        const latestBinding = this.options.stores.session.getBinding(bindingId);
        if (!observerDetached && latestBinding?.lifecycle === "draining") await this.options.archiveDrainedBinding(latestBinding);
      }
      if (dispatchDeferred) {
        if (this.options.handoffExternalTurns) await this.options.handoffExternalTurns(bindingId);
        return;
      }
    }
  }

  private release({ binding, prompt }: ClaimedPrompt): boolean {
    return this.options.stores.recovery.releaseUndispatchedPromptClaim({ promptId: prompt.id, bindingId: binding.id, updatedAt: prompt.updatedAt, bindingGeneration: binding.generation, paneId: binding.paneId! });
  }
}

function nativeReceiptMismatch(
  result: Awaited<ReturnType<NonNullable<HerdrPort["queuePrompt"]>>>,
  expected: { submissionId: string; sessionId: string; agentKind: string; terminalId: string | null }
): string | null {
  if (result.submissionId !== expected.submissionId) return "Native submission receipt identity mismatch";
  const receipt = result.receipt;
  if (!receipt) return null;
  if (receipt.submissionId !== expected.submissionId) return "Native submission receipt identity mismatch";
  if (receipt.sessionId !== expected.sessionId) return "Native submission receipt session mismatch";
  if (receipt.agentKind !== expected.agentKind) return "Native submission receipt Agent kind mismatch";
  if (expected.terminalId && receipt.terminalId !== expected.terminalId) return "Native submission receipt terminal mismatch";
  return null;
}
