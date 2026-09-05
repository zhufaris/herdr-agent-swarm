import type { ControlActor } from "../domain/commands.js";
import type { InterruptReceipt, SteerReceipt } from "../domain/agent-runtime.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { TurnControlStore } from "../domain/ports/turn-control.js";
import type { Binding, HerdrAgentSession, HerdrPane } from "../domain/types.js";
import type { TurnControlOperation, TurnTarget } from "../domain/turn-control.js";
import { safeLogError } from "../runtime/safe-error.js";
import { renderTurnControlResultCard } from "../cards/turn-control-card.js";

type Store = TurnControlStore & Pick<InstanceStore, "getBinding" | "getActiveOrdinaryPrompt" | "getAgentInstance" | "getActiveInstanceTurn">;
type SteerOutcome = { operation: TurnControlOperation; duplicate: boolean };

interface Options { store: Store; herdr: Pick<HerdrPort, "getPane" | "steerAgent" | "interruptAgent">; idFactory: () => string; wakeOutbound?: () => void }
interface SteerCommand { owner: { kind: "binding" | "instance"; id: string }; actor: ControlActor; text: string; idempotencyKey: string; sourceMessageId?: string | null; sourceCardId?: string | null; resultTargetMessageId?: string | null }
interface InterruptCommand { owner: SteerCommand["owner"]; actor: ControlActor; idempotencyKey: string; sourceMessageId?: string | null; sourceCardId?: string | null; resultTargetMessageId?: string | null }

export class TurnControlWorkflow {
  private readonly lanes = new Map<string, Promise<SteerOutcome>>();
  constructor(private readonly options: Options) {}

  async steer(input: SteerCommand): Promise<SteerOutcome> {
    return this.inLane(input.owner, () => this.control("steer", input));
  }

  async interrupt(input: InterruptCommand): Promise<SteerOutcome> {
    return this.inLane(input.owner, () => this.control("interrupt", input));
  }

  private async inLane(owner: SteerCommand["owner"], operation: () => Promise<SteerOutcome>): Promise<SteerOutcome> {
    const key = `${owner.kind}:${owner.id}`;
    const previous = this.lanes.get(key);
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
    this.lanes.set(key, current);
    try { return await current; }
    finally { if (this.lanes.get(key) === current) this.lanes.delete(key); }
  }

  private async control(kind: "steer" | "interrupt", input: SteerCommand | InterruptCommand): Promise<SteerOutcome> {
    const previous = this.options.store.getTurnControlOperationByIdempotencyKey(input.idempotencyKey);
    if (previous) {
      if (!sameControlRequest(previous, kind, input)) throw new Error("Idempotency key belongs to a different turn control operation");
      this.options.wakeOutbound?.();
      return { operation: previous, duplicate: true };
    }
    const target = await this.resolveTarget(input.owner, kind);
    const payload = kind === "steer" ? (input as SteerCommand).text : null;
    const pending: TurnControlOperation = { id: this.options.idFactory(), idempotencyKey: input.idempotencyKey, kind, target, actor: input.actor, payload, sourceMessageId: input.sourceMessageId ?? null, sourceCardId: input.sourceCardId ?? null, state: "accepted", result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const accepted = this.options.store.acceptTurnControlOperation({
      id: pending.id, idempotencyKey: input.idempotencyKey, kind, target, actor: input.actor, payload,
      ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
      ...(input.sourceCardId !== undefined ? { sourceCardId: input.sourceCardId } : {}),
      ...(input.resultTargetMessageId ? { result: { targetMessageId: input.resultTargetMessageId, bindingId: target.owner.kind === "binding" ? target.owner.id : null, card: renderTurnControlResultCard(pending) } } : {})
    });
    if (!accepted.inserted) { this.options.wakeOutbound?.(); return { operation: accepted.operation, duplicate: true }; }
    this.options.wakeOutbound?.();
    const operation = await this.dispatch(accepted.operation);
    this.options.wakeOutbound?.();
    return { operation, duplicate: false };
  }

  async recover(): Promise<{ resumed: TurnControlOperation[]; uncertain: TurnControlOperation[] }> {
    const recovered = this.options.store.recoverTurnControlOperations(renderTurnControlResultCard);
    if (recovered.uncertain.length > 0) this.options.wakeOutbound?.();
    const resumed: TurnControlOperation[] = [];
    for (const operation of recovered.accepted) { resumed.push(await this.dispatch(operation)); this.options.wakeOutbound?.(); }
    return { resumed, uncertain: recovered.uncertain };
  }

  private async resolveTarget(owner: SteerCommand["owner"], kind: "steer" | "interrupt"): Promise<TurnTarget> {
    if (owner.kind === "binding") {
      const binding = this.options.store.getBinding(owner.id);
      if (!binding?.projectId || !binding.paneId) throw new Error("Primary binding has no active runtime");
      const turn = this.options.store.getActiveOrdinaryPrompt(binding.id, binding.generation);
      if (!turn?.transcriptTurnId) throw new Error("Primary binding has no exact active runtime turn");
      const session = bindingSession(binding);
      if (!session) throw new Error("Primary binding has no native Agent session");
      const pane = await this.requireControllablePane(binding.paneId, session, turn.transcriptTurnId, kind);
      return { owner, projectId: binding.projectId, paneId: binding.paneId, generation: binding.generation, agentSession: pane.agentSession!, logicalTurnId: turn.id, runtimeTurnId: turn.transcriptTurnId };
    }
    const instance = this.options.store.getAgentInstance(owner.id);
    if (!instance?.runtimeRef) throw new Error("Agent instance has no active runtime");
    const turn = this.options.store.getActiveInstanceTurn(instance.id, instance.generation);
    if (!turn?.runtimeTurnId) throw new Error("Agent instance has no exact active runtime turn");
    const pane = await this.requireControllablePane(instance.runtimeRef.paneId, null, turn.runtimeTurnId, kind);
    if (!pane.agentSession || (instance.runtimeRef.nativeSessionId && pane.agentSession.value !== instance.runtimeRef.nativeSessionId)) throw new Error("Agent session identity changed");
    return { owner, projectId: instance.projectId, paneId: instance.runtimeRef.paneId, generation: instance.generation, agentSession: pane.agentSession, logicalTurnId: turn.id, runtimeTurnId: turn.runtimeTurnId };
  }

  private async dispatch(operation: TurnControlOperation): Promise<TurnControlOperation> {
    const rejection = await this.revalidate(operation.target, operation.kind);
    if (rejection) {
      const rejected = { ...operation, state: "rejected" as const, result: { status: "rejected", reason: rejection } };
      return this.options.store.rejectAcceptedTurnControlOperation({ id: operation.id, result: rejected.result, card: renderTurnControlResultCard(rejected) }) ?? this.requireOperation(operation.id);
    }
    const claimed = this.options.store.claimTurnControlOperation(operation.id);
    if (!claimed) {
      const rejected = { ...operation, state: "rejected" as const, result: { status: "rejected", reason: "Exact turn target changed before dispatch" } };
      return this.options.store.rejectAcceptedTurnControlOperation({ id: operation.id, result: rejected.result, card: renderTurnControlResultCard(rejected) }) ?? this.requireOperation(operation.id);
    }
    try {
      if (claimed.kind === "interrupt") {
        if (!this.options.herdr.interruptAgent) return this.finish(claimed.id, { status: "unsupported", reason: "Herdr native interruption is unavailable" });
        return this.finish(claimed.id, await this.options.herdr.interruptAgent({ paneId: claimed.target.paneId, agentSession: claimed.target.agentSession, runtimeTurnId: claimed.target.runtimeTurnId, idempotencyKey: claimed.id }));
      }
      if (!this.options.herdr.steerAgent) return this.finish(claimed.id, { status: "unsupported", reason: "Herdr native steering is unavailable" });
      return this.finish(claimed.id, await this.options.herdr.steerAgent({ paneId: claimed.target.paneId, agentSession: claimed.target.agentSession, runtimeTurnId: claimed.target.runtimeTurnId, text: claimed.payload!, idempotencyKey: claimed.id }));
    } catch (error) {
      const result = { status: "delivery-uncertain", reason: safeLogError(error).message };
      return this.options.store.finishTurnControlOperation({ id: claimed.id, state: "uncertain", result, card: renderTurnControlResultCard({ ...claimed, state: "uncertain", result }) }) ?? this.requireOperation(claimed.id);
    }
  }

  private finish(id: string, receipt: SteerReceipt | InterruptReceipt): TurnControlOperation {
    const state = receipt.status === "delivered" || receipt.status === "interrupted" ? "delivered" : receipt.status === "delivery-uncertain" || receipt.status === "failed" ? "uncertain" : "rejected";
    const operation = this.requireOperation(id);
    return this.options.store.finishTurnControlOperation({ id, state, result: receipt, card: renderTurnControlResultCard({ ...operation, state, result: receipt }) }) ?? this.requireOperation(id);
  }

  private async revalidate(target: TurnTarget, kind: "steer" | "interrupt"): Promise<string | null> {
    try { await this.requireControllablePane(target.paneId, target.agentSession, target.runtimeTurnId, kind); return null; }
    catch (error) { return safeLogError(error).message; }
  }

  private async requireControllablePane(paneId: string, expectedSession: HerdrAgentSession | null, runtimeTurnId: string, kind: "steer" | "interrupt"): Promise<HerdrPane> {
    const pane = await this.options.herdr.getPane(paneId);
    if (!pane) throw new Error("Herdr pane is no longer active");
    if (!pane.agentSession) throw new Error("Herdr pane has no native Agent session");
    if (expectedSession && !sameSession(expectedSession, pane.agentSession)) throw new Error("Agent session identity changed");
    if (kind === "steer" && pane.steeringCapability !== "native") throw new Error("Native steering is unsupported for this pane");
    if (pane.agentState === "blocked") throw new Error("Agent is blocked on a local approval or question");
    if (pane.agentState !== "working") throw new Error("Agent turn is not active");
    if (pane.activeTurnId !== null && pane.activeTurnId !== undefined && pane.activeTurnId !== runtimeTurnId) throw new Error("Runtime turn identity changed");
    return pane;
  }

  private requireOperation(id: string): TurnControlOperation {
    const operation = this.options.store.getTurnControlOperation(id);
    if (!operation) throw new Error(`Turn control operation disappeared: ${id}`);
    return operation;
  }
}

function bindingSession(binding: Binding): HerdrAgentSession | null {
  return binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } : null;
}
function sameSession(left: HerdrAgentSession, right: HerdrAgentSession): boolean {
  return left.source === right.source && left.agent === right.agent && left.kind === right.kind && left.value === right.value;
}
function sameControlRequest(operation: TurnControlOperation, kind: "steer" | "interrupt", input: SteerCommand | InterruptCommand): boolean {
  const payload = kind === "steer" ? (input as SteerCommand).text : null;
  return operation.kind === kind && operation.target.owner.kind === input.owner.kind && operation.target.owner.id === input.owner.id
    && operation.payload === payload && operation.sourceMessageId === (input.sourceMessageId ?? null) && operation.sourceCardId === (input.sourceCardId ?? null);
}
