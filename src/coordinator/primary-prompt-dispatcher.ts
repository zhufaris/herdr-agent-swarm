import type { Logger } from "pino";
import type { HerdrPort } from "../domain/ports/external.js";
import type { ClaimedPrompt } from "../domain/ports/prompt-acceptance.js";
import type { PromptDispatchStore, PromptRecoveryStore, PromptSessionStore } from "../domain/ports/prompt-run.js";
import type { Binding } from "../domain/types.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { requireMatchingRuntimeIdentity } from "./pane-runtime-identity.js";
import type { PromptRunRegistry } from "./prompt-run-registry.js";
import type { PromptTurnExecutor } from "./prompt-turn-executor.js";

export interface PrimaryPromptDispatcherPort { drain(bindingId: string): Promise<void>; }

interface Options {
  stores: { dispatch: Pick<PromptDispatchStore, "claimNextDispatchablePrompt">; recovery: Pick<PromptRecoveryStore, "releaseUndispatchedPromptClaim">; session: Pick<PromptSessionStore, "getBinding"> };
  herdr: Pick<HerdrPort, "getPane">;
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

  async drain(bindingId: string): Promise<void> {
    while (!this.options.isStopping()) {
      if (this.options.handoffExternalTurns) await this.options.handoffExternalTurns(bindingId);
      const claimed = this.options.stores.dispatch.claimNextDispatchablePrompt(bindingId);
      if (!claimed) return;
      const { binding, prompt, model } = claimed;
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
          else if (livePane.agentState === "working" || livePane.agentState === "blocked") unavailableReason = "runtime_busy";
          else if (livePane.agentState === "unknown") unavailableReason = "runtime_unknown";
        } catch { unavailableReason = "runtime_identity_changed"; }
      }
      if (unavailableReason) {
        const released = this.release(claimed);
        this.options.logger.warn({ event: "prompt-pre-dispatch-runtime-unavailable", bindingId, promptId: prompt.id, paneId: binding.paneId, reason: unavailableReason, agentState: livePane?.agentState ?? "unknown", outcome: released ? "requeued_before_dispatch" : "stale_claim" }, "deferred prompt dispatch because the live Herdr pane was not dispatchable");
        if (released && unavailableReason === "runtime_busy" && this.options.handoffExternalTurns) await this.options.handoffExternalTurns(bindingId);
        return;
      }
      if (model) await this.options.convergeMainCard(bindingId);
      const controller = this.options.registry.attachTurn(bindingId, prompt.id, binding.paneId!);
      let observerDetached = false;
      let dispatchDeferred = false;
      try {
        const execution = await this.options.executor.execute(claimed, controller);
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
