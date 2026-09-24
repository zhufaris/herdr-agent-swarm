import type { InterruptReceipt, SteerReceipt } from "../domain/agent-runtime.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { TurnControlStore } from "../domain/ports/turn-control.js";
import { sameNativeTraexSession } from "../domain/traex-session-identity.js";
import type { TurnControlOperation, TurnControlOwner, TurnTarget } from "../domain/turn-control.js";
import { safeLogError } from "../runtime/safe-error.js";

interface Options { store: TurnControlStore; herdr: Pick<HerdrPort, "getPane" | "interruptAgent">; presentation: Pick<ApplicationPresentation, "turnControlResult">; wakeOutbound(): void; logger?: { error(value: object, message: string): void } }

/** Drains durable exact-turn control intents outside inbound request handlers. */
export class TurnControlDispatcher {
  private readonly lanes = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(private readonly options: Options) {}

  wake(owner: TurnControlOwner): void {
    if (this.stopping) return;
    const key = `${owner.kind}:${owner.id}`;
    if (this.lanes.has(key)) return;
    const work = this.drain(owner).catch((error) => {
      this.options.logger?.error({ event: "turn-control-dispatch-failed", err: safeLogError(error), ownerKind: owner.kind, ownerId: owner.id, outcome: "deferred" }, "durable turn control dispatch failed");
    }).finally(() => {
      if (this.lanes.get(key) === work) this.lanes.delete(key);
      if (!this.stopping && this.options.store.listAcceptedTurnControlOperations(owner).length > 0) this.wake(owner);
    });
    this.lanes.set(key, work);
  }

  async recover(): Promise<{ accepted: number; uncertain: number }> {
    const recovered = this.options.store.recoverTurnControlOperations(this.options.presentation.turnControlResult);
    if (recovered.uncertain.length > 0) this.options.wakeOutbound();
    const owners = new Map(recovered.accepted.map((operation) => [`${operation.target.owner.kind}:${operation.target.owner.id}`, operation.target.owner]));
    for (const owner of owners.values()) this.wake(owner);
    return { accepted: recovered.accepted.length, uncertain: recovered.uncertain.length };
  }

  async stop(): Promise<void> { this.stopping = true; await Promise.allSettled([...this.lanes.values()]); }

  private async drain(owner: TurnControlOwner): Promise<void> {
    while (!this.stopping) {
      const operation = this.options.store.listAcceptedTurnControlOperations(owner)[0];
      if (!operation) return;
      await this.dispatch(operation);
      this.options.wakeOutbound();
    }
  }

  private async dispatch(operation: TurnControlOperation): Promise<void> {
    const rejection = await this.revalidate(operation.target);
    if (rejection) { this.reject(operation, rejection); return; }
    const claimed = this.options.store.claimTurnControlOperation(operation.id);
    if (!claimed) { this.reject(operation, "Exact turn target changed before dispatch"); return; }
    try {
      if (claimed.kind === "steer") { this.finish(claimed, { status: "unsupported", reason: "Herdr native steering is unavailable" }); return; }
      const receipt = this.options.herdr.interruptAgent
        ? await this.options.herdr.interruptAgent({ paneId: claimed.target.paneId, agentSession: claimed.target.agentSession, runtimeTurnId: claimed.target.runtimeTurnId, idempotencyKey: claimed.id })
        : { status: "unsupported" as const, reason: "Herdr native interruption is unavailable" };
      this.finish(claimed, receipt);
    } catch (error) {
      const result = { status: "delivery-uncertain" as const, operationId: claimed.id, reason: safeLogError(error).message };
      this.options.store.finishTurnControlOperation({ id: claimed.id, state: "uncertain", result, card: this.options.presentation.turnControlResult({ ...claimed, state: "uncertain", result }) });
    }
  }

  private reject(operation: TurnControlOperation, reason: string): void {
    const result = { status: "rejected", reason };
    this.options.store.rejectAcceptedTurnControlOperation({ id: operation.id, result, card: this.options.presentation.turnControlResult({ ...operation, state: "rejected", result }) });
  }

  private finish(operation: TurnControlOperation, receipt: SteerReceipt | InterruptReceipt): void {
    const state = receipt.status === "delivered" || receipt.status === "interrupted" ? "delivered" : receipt.status === "delivery-uncertain" || receipt.status === "failed" ? "uncertain" : "rejected";
    this.options.store.finishTurnControlOperation({ id: operation.id, state, result: receipt, card: this.options.presentation.turnControlResult({ ...operation, state, result: receipt }) });
  }

  private async revalidate(target: TurnTarget): Promise<string | null> {
    try {
      const pane = await this.options.herdr.getPane(target.paneId);
      if (!pane?.agentSession) return "Herdr pane has no native Agent session";
      if (!sameNativeTraexSession(target.agentSession, pane.agentSession)) return "Agent session identity changed";
      if (pane.agentState === "blocked") return "Agent is blocked on a local approval or question";
      if (pane.activeTurnId !== target.runtimeTurnId) return "Runtime turn identity changed";
      return null;
    } catch (error) { return safeLogError(error).message; }
  }
}
