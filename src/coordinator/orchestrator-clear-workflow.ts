import type { Logger } from "pino";
import type { Binding } from "../domain/binding.js";
import type { OrchestratorClearOperation, SessionRotationRequest } from "../domain/orchestrator-clear.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { OrchestratorClearStore } from "../domain/ports/orchestrator-clear.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import { sameNativeTraexSession } from "../domain/traex-session-identity.js";
import { safeLogError } from "../runtime/safe-error.js";

export interface OrchestratorClearRequest {
  id: string;
  idempotencyKey: string;
  bindingId: string;
  actorOpenId: string;
  sourceMessageId: string;
  confirmationId: string;
}

interface Options {
  store: OrchestratorClearStore;
  herdr: Pick<HerdrPort, "listWorkspaces" | "observeRuntime" | "supportsSessionRotation" | "rotateSession">;
  launchFor(binding: Binding): SessionRotationRequest["launch"];
  presentation?: Pick<ApplicationPresentation, "orchestratorClearResult">;
  wakeOutbound?(): void;
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

export class OrchestratorClearWorkflow {
  private readonly lanes = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(private readonly options: Options) {}

  async request(input: OrchestratorClearRequest): Promise<OrchestratorClearOperation> {
    const existing = this.options.store.get(input.id);
    if (existing) {
      if (existing.idempotencyKey !== input.idempotencyKey || existing.bindingId !== input.bindingId
        || existing.actorOpenId !== input.actorOpenId || existing.sourceMessageId !== input.sourceMessageId
        || existing.confirmationId !== input.confirmationId) throw new Error("Orchestrator clear operation ID belongs to a different request");
      await this.drain(existing.bindingId);
      this.publishTerminalResults();
      return this.options.store.get(existing.id) ?? existing;
    }
    if (!this.options.herdr.supportsSessionRotation || !this.options.herdr.rotateSession
      || !await this.options.herdr.supportsSessionRotation()) throw new Error("Herdr Core does not support managed same-Pane session rotation");
    const binding = this.requireEligibleBinding(input.bindingId);
    if (this.options.store.hasActiveIdentityMigration(binding.id)) throw new Error("Orchestrator identity migration is in progress");
    await this.requireFixedIdentity(binding);
    if (this.options.store.hasNonterminalPrompt(binding.id)) throw new Error("Orchestrator context can only be cleared while its prompt queue is quiescent");
    const observation = await this.options.herdr.observeRuntime(binding.paneId!);
    const pane = observation.pane;
    if (!pane || pane.workspaceId !== binding.workspaceId || pane.paneId !== binding.paneId
      || pane.terminalId !== binding.traexSessionId || !pane.agentSession || !sameBindingSession(binding, pane.agentSession)) {
      throw new Error("Orchestrator runtime identity changed before context clear acceptance");
    }
    if (pane.agentState !== "idle" || !observation.composerReady || pane.activeTurnId !== null) {
      throw new Error("Orchestrator must be idle and composer-ready before clearing context");
    }
    if (pane.stateChangeSeq === null || pane.stateChangeSeq === undefined) throw new Error("Herdr runtime does not expose the state sequence required for context clear");
    const accepted = this.options.store.accept({
      id: input.id, idempotencyKey: input.idempotencyKey, actorOpenId: input.actorOpenId,
      sourceMessageId: input.sourceMessageId, confirmationId: input.confirmationId,
      bindingId: binding.id, bindingGeneration: binding.generation, oldSessionEpoch: binding.sessionEpoch,
      expectedWorkspaceId: binding.workspaceId, expectedPaneId: binding.paneId!, expectedTerminalId: binding.traexSessionId!,
      expectedSession: pane.agentSession, expectedStateChangeSeq: pane.stateChangeSeq
    });
    await this.drain(binding.id);
    this.publishTerminalResults();
    return this.options.store.get(accepted.operation.id) ?? accepted.operation;
  }

  start(intervalMs: number): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => { void this.recover().catch((error) => this.logFailure(error)); }, intervalMs);
    this.timer.unref?.();
  }

  async recover(): Promise<void> {
    const bindingIds = new Set(this.options.store.listRecoverable().map((operation) => operation.bindingId));
    await Promise.all([...bindingIds].map((bindingId) => this.drain(bindingId)));
    this.publishTerminalResults();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.lanes.values()]);
  }

  private drain(bindingId: string): Promise<void> {
    const current = this.lanes.get(bindingId);
    if (current) return current;
    const work = this.drainLane(bindingId).finally(() => {
      if (this.lanes.get(bindingId) === work) this.lanes.delete(bindingId);
    });
    this.lanes.set(bindingId, work);
    return work;
  }

  private async drainLane(bindingId: string): Promise<void> {
    while (!this.stopping) {
      const operation = this.options.store.listRecoverable().find((candidate) => candidate.bindingId === bindingId);
      if (!operation || operation.state === "context-cleared" || operation.state === "withdrawing") return;
      if (operation.state === "accepted") {
        const rejection = await this.revalidateAccepted(operation);
        if (this.stopping) return;
        if (rejection) { this.options.store.finish(operation.id, "rejected", rejection); return; }
        const claimed = this.options.store.claimNext(bindingId);
        if (!claimed) return;
        await this.dispatch(claimed);
        return;
      }
      if (operation.state === "rotating" || operation.state === "rotation-uncertain") {
        await this.dispatch(operation);
        return;
      }
      return;
    }
  }

  private async dispatch(operation: OrchestratorClearOperation): Promise<void> {
    const binding = this.options.store.getBinding(operation.bindingId);
    if (!binding) { this.options.store.finish(operation.id, "rejected", "Orchestrator Binding no longer exists"); return; }
    if (!this.options.herdr.rotateSession || !this.options.herdr.supportsSessionRotation
      || !await this.options.herdr.supportsSessionRotation()) {
      this.options.store.finish(operation.id, "rejected", "Herdr Core does not support managed same-Pane session rotation");
      return;
    }
    try {
      const result = await this.options.herdr.rotateSession({
        operationId: operation.id, paneId: operation.expectedPaneId, expectedTerminalId: operation.expectedTerminalId,
        expectedSession: operation.expectedSession, expectedStateChangeSeq: operation.expectedStateChangeSeq,
        launch: this.options.launchFor(binding)
      });
      if (result.outcome === "rotated" || result.outcome === "already-applied") {
        const applied = this.options.store.applyRotationReceipt({ operationId: operation.id, receipt: result.receipt });
        if (!applied) this.options.store.finish(operation.id, "rejected", "Binding identity changed before the rotation receipt was committed");
        else this.options.logger?.info({ event: "orchestrator-context-cleared", operationId: operation.id, bindingId: operation.bindingId, sessionEpoch: applied.binding.sessionEpoch, outcome: result.outcome }, "Orchestrator context was cleared in the existing Pane");
        return;
      }
      if (result.outcome === "rotating" || result.outcome === "uncertain" || result.outcome === "malformed-response") {
        this.options.store.markRotationUncertain(operation.id, result.outcome === "rotating" ? "Herdr Core is still rotating the managed Agent session" : result.reason);
        return;
      }
      const reason = result.reason;
      this.options.store.finish(operation.id, result.outcome === "definitely-not-started" ? "failed" : "rejected", reason);
    } catch (error) {
      const detail = safeLogError(error).message;
      this.options.store.markRotationUncertain(operation.id, detail);
      this.logFailure(error, operation);
    }
  }

  private requireEligibleBinding(bindingId: string): Binding {
    const binding = this.options.store.getBinding(bindingId);
    if (!binding || binding.kind !== "orchestrator" || binding.state !== "active" || binding.lifecycle !== "active"
      || binding.attachment !== "attached" || !binding.paneId || !binding.traexSessionId
      || !binding.agentSessionSource || !binding.agentSessionAgent || !binding.agentSessionKind || !binding.agentSessionValue) {
      throw new Error("Context clear requires an active attached managed Orchestrator Binding");
    }
    return binding;
  }

  private async revalidateAccepted(operation: OrchestratorClearOperation): Promise<string | null> {
    const binding = this.options.store.getBinding(operation.bindingId);
    if (!binding || binding.kind !== "orchestrator" || binding.generation !== operation.bindingGeneration
      || binding.sessionEpoch !== operation.oldSessionEpoch || binding.workspaceId !== operation.expectedWorkspaceId
      || binding.paneId !== operation.expectedPaneId || binding.traexSessionId !== operation.expectedTerminalId
      || binding.paneToken !== "orch" || !sameBindingSession(binding, operation.expectedSession)) return "Orchestrator Binding fence changed before rotation";
    if (this.options.store.hasNonterminalPrompt(binding.id)) return "Orchestrator acquired nonterminal Prompt work before rotation";
    try {
      await this.requireFixedIdentity(binding);
      const observation = await this.options.herdr.observeRuntime(operation.expectedPaneId);
      const pane = observation.pane;
      if (!pane || pane.workspaceId !== operation.expectedWorkspaceId || pane.paneId !== operation.expectedPaneId
        || pane.terminalId !== operation.expectedTerminalId || !pane.agentSession || !sameNativeTraexSession(pane.agentSession, operation.expectedSession)
        || pane.stateChangeSeq !== operation.expectedStateChangeSeq) return "Herdr runtime fence changed before rotation";
      if (pane.agentState !== "idle" || !observation.composerReady || pane.activeTurnId !== null) return "Orchestrator is no longer idle and composer-ready";
      return null;
    } catch (error) { return safeLogError(error).message; }
  }

  private async requireFixedIdentity(binding: Binding): Promise<void> {
    if (binding.paneToken !== "orch" || !this.options.herdr.listWorkspaces) {
      throw new Error("Orchestrator context clear requires the fixed Herdr identity");
    }
    const matches = (await this.options.herdr.listWorkspaces()).filter((workspace) => workspace.label === "herdr");
    if (matches.length !== 1 || matches[0]!.workspaceId !== binding.workspaceId) {
      throw new Error("Orchestrator context clear requires the fixed Herdr identity in the unique Space labeled 'herdr'");
    }
  }

  private logFailure(error: unknown, operation?: OrchestratorClearOperation): void {
    this.options.logger?.error({ event: "orchestrator-clear-reconcile-failed", err: safeLogError(error), operationId: operation?.id, bindingId: operation?.bindingId, outcome: "rotation-uncertain" }, "Orchestrator clear recovery remains pending");
  }

  private publishTerminalResults(): void {
    if (!this.options.presentation) return;
    let reserved = false;
    for (const operation of this.options.store.listTerminalWithoutResult()) {
      reserved = this.options.store.reserveResult(operation.id, this.options.presentation.orchestratorClearResult(operation)) || reserved;
    }
    if (reserved) this.options.wakeOutbound?.();
  }
}

function sameBindingSession(binding: Binding, session: { source: string; agent: string; kind: string; value: string }): boolean {
  return binding.agentSessionSource === session.source && binding.agentSessionAgent === session.agent
    && binding.agentSessionKind === session.kind && binding.agentSessionValue === session.value;
}
