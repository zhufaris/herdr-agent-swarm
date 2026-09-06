import type { ControlActor } from "../domain/commands.js";
import type { InterruptReceipt, SteerReceipt } from "../domain/agent-runtime.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { PromptAcceptanceStore } from "../domain/ports/prompt.js";
import type { PrimaryPresentation, WorkerPresentation } from "../domain/ports/presentation.js";
import type { TurnControlStore } from "../domain/ports/turn-control.js";
import type { Binding, HerdrAgentSession, HerdrPane } from "../domain/types.js";
import type { TurnControlOperation, TurnTarget } from "../domain/turn-control.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import { createQueuedWorkerTurnCard } from "../domain/worker-turn-card-view.js";
import { safeLogError } from "../runtime/safe-error.js";

type Store = TurnControlStore & Pick<InstanceStore, "getBinding" | "getActiveOrdinaryPrompt" | "getAgentInstance" | "getActiveInstanceTurn" | "acceptInstanceTurn" | "acceptInstanceTurnWithCard" | "countPendingInstanceTurns"> & Pick<PromptAcceptanceStore, "acceptPrompt" | "countPendingPrompts">;
export type SteerOutcome =
  | { mode: "native"; operation: TurnControlOperation; duplicate: boolean }
  | { mode: "priority"; logicalTurnId: string; duplicate: boolean };

interface Options { store: Store; herdr: Pick<HerdrPort, "getPane" | "steerAgent" | "interruptAgent">; idFactory: () => string; presentation: Pick<PrimaryPresentation, "answerCard"> & Pick<WorkerPresentation, "workerTurn" | "turnControlResult">; wakeOutbound?: () => void; wakePrimary?: (bindingId: string) => void; wakeInstance?: (instanceId: string) => void; maxQueueDepth?: number }
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
      const priorityTurnId = previous.result?.status === "priority-accepted" && typeof previous.result.logicalTurnId === "string" ? previous.result.logicalTurnId : null;
      if (priorityTurnId) return { mode: "priority", logicalTurnId: priorityTurnId, duplicate: true };
      return { mode: "native", operation: previous, duplicate: true };
    }
    if (kind === "steer") {
      const priority = this.options.store.getPrioritySteer(input.owner, input.idempotencyKey);
      if (priority) {
        if (priority.text !== (input as SteerCommand).text) throw new Error("Idempotency key belongs to a different priority steer");
        return { mode: "priority", logicalTurnId: priority.logicalTurnId, duplicate: true };
      }
    }
    const resolved = await this.resolveTarget(input.owner, kind);
    if (resolved.kind !== "active") return this.acceptPriorityTurn(resolved, input as SteerCommand);
    const target = resolved.target;
    const payload = kind === "steer" ? (input as SteerCommand).text : null;
    const pending: TurnControlOperation = { id: this.options.idFactory(), idempotencyKey: input.idempotencyKey, kind, target, actor: input.actor, payload, sourceMessageId: input.sourceMessageId ?? null, sourceCardId: input.sourceCardId ?? null, state: "accepted", result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const accepted = this.options.store.acceptTurnControlOperation({
      id: pending.id, idempotencyKey: input.idempotencyKey, kind, target, actor: input.actor, payload,
      ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
      ...(input.sourceCardId !== undefined ? { sourceCardId: input.sourceCardId } : {}),
      ...(input.resultTargetMessageId ? { result: { targetMessageId: input.resultTargetMessageId, bindingId: target.owner.kind === "binding" ? target.owner.id : null, card: this.options.presentation.turnControlResult(pending) } } : {})
    });
    if (!accepted.inserted) { this.options.wakeOutbound?.(); return { mode: "native", operation: accepted.operation, duplicate: true }; }
    this.options.wakeOutbound?.();
    const dispatched = await this.dispatch(accepted.operation, input as SteerCommand);
    this.options.wakeOutbound?.();
    return dispatched.mode === "priority" ? dispatched : { mode: "native", operation: dispatched.operation, duplicate: false };
  }

  async recover(): Promise<{ resumed: TurnControlOperation[]; uncertain: TurnControlOperation[] }> {
    const recovered = this.options.store.recoverTurnControlOperations(this.options.presentation.turnControlResult);
    if (recovered.uncertain.length > 0) this.options.wakeOutbound?.();
    const resumed: TurnControlOperation[] = [];
    for (const operation of recovered.accepted) {
      const outcome = await this.dispatch(operation, operation.kind === "steer" ? commandFromOperation(operation) : undefined);
      if (outcome.mode === "native") resumed.push(outcome.operation);
      this.options.wakeOutbound?.();
    }
    return { resumed, uncertain: recovered.uncertain };
  }

  private async resolveTarget(owner: SteerCommand["owner"], kind: "steer" | "interrupt"): Promise<{ kind: "active"; target: TurnTarget } | { kind: "idle"; binding: Binding } | { kind: "idle-instance"; instance: NonNullable<ReturnType<InstanceStore["getAgentInstance"]>> }> {
    if (owner.kind === "binding") {
      const binding = this.options.store.getBinding(owner.id);
      if (!binding?.projectId || !binding.paneId) throw new Error("Primary binding has no active runtime");
      const turn = this.options.store.getActiveOrdinaryPrompt(binding.id, binding.generation);
      const session = bindingSession(binding);
      if (!session) throw new Error("Primary binding has no native Agent session");
      if (!turn) {
        if (kind === "interrupt") throw new Error("Primary binding has no exact active runtime turn");
        const pane = await this.requireIdlePane(binding.paneId, session);
        if (pane.agentState === "blocked") throw new Error("Agent is blocked on a local approval or question");
        return { kind: "idle", binding };
      }
      if (!turn.transcriptTurnId) throw new Error("Primary active runtime turn identity is not established");
      const pane = await this.requireControllablePane(binding.paneId, session, turn.transcriptTurnId, kind);
      return { kind: "active", target: { owner, projectId: binding.projectId, paneId: binding.paneId, generation: binding.generation, agentSession: pane.agentSession!, logicalTurnId: turn.id, runtimeTurnId: turn.transcriptTurnId } };
    }
    const instance = this.options.store.getAgentInstance(owner.id);
    if (!instance?.runtimeRef) throw new Error("Agent instance has no active runtime");
    const turn = this.options.store.getActiveInstanceTurn(instance.id, instance.generation);
    if (!turn) {
      if (kind === "interrupt") throw new Error("Agent instance has no exact active runtime turn");
      await this.requireIdlePane(instance.runtimeRef.paneId, null);
      return { kind: "idle-instance", instance };
    }
    if (!turn.runtimeTurnId) throw new Error("Agent active runtime turn identity is not established");
    const pane = await this.requireControllablePane(instance.runtimeRef.paneId, null, turn.runtimeTurnId, kind);
    if (!pane.agentSession || (instance.runtimeRef.nativeSessionId && pane.agentSession.value !== instance.runtimeRef.nativeSessionId)) throw new Error("Agent session identity changed");
    return { kind: "active", target: { owner, projectId: instance.projectId, paneId: instance.runtimeRef.paneId, generation: instance.generation, agentSession: pane.agentSession, logicalTurnId: turn.id, runtimeTurnId: turn.runtimeTurnId } };
  }

  private acceptPriorityTurn(target: { kind: "idle"; binding: Binding } | { kind: "idle-instance"; instance: NonNullable<ReturnType<InstanceStore["getAgentInstance"]>> }, input: SteerCommand): SteerOutcome {
    const id = this.options.idFactory();
    const occurredAt = new Date().toISOString();
    if (target.kind === "idle") {
      const binding = target.binding;
      if (!binding.rootMessageId) throw new Error("Primary binding has no result thread");
      const view = createQueuedRunCard({ promptId: id, bindingId: binding.id, bindingGeneration: binding.generation, title: "Priority steer", sessionTitle: binding.title, workspaceId: binding.workspaceId, paneId: binding.paneId, requestText: input.text, queuePosition: 0, occurredAt });
      const accepted = this.options.store.acceptPrompt({ prompt: { id, bindingId: binding.id, larkMessageId: `priority-steer:${input.idempotencyKey}`, actorOpenId: actorId(input.actor), body: input.text, priority: "priority" }, view, rootMessageId: binding.rootMessageId, answerCard: this.options.presentation.answerCard(view), maxQueueDepth: this.options.maxQueueDepth ?? 20, expectedBindingGeneration: binding.generation });
      if (accepted.inserted) { this.options.wakeOutbound?.(); this.options.wakePrimary?.(binding.id); }
      return { mode: "priority", logicalTurnId: accepted.prompt.id, duplicate: !accepted.inserted };
    }
    const instance = target.instance;
    if (input.resultTargetMessageId) {
      const view = createQueuedWorkerTurnCard({ turnId: id, instanceId: instance.id, instanceGeneration: instance.generation, workerSessionGeneration: instance.workerSessionGeneration, workerName: instance.name, parentTurnId: null, rootMessageId: input.resultTargetMessageId, requestText: input.text, queuePosition: 0, occurredAt });
      const accepted = this.options.store.acceptInstanceTurnWithCard({ id, idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: instance.projectId, instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", priority: "priority", text: input.text, parentTurnId: null, sourceMessageId: input.sourceMessageId ?? input.idempotencyKey, view, render: this.options.presentation.workerTurn, maxQueueDepth: this.options.maxQueueDepth ?? 20 });
      if (accepted.inserted) this.options.wakeOutbound?.();
      this.options.wakeInstance?.(instance.id);
      return { mode: "priority", logicalTurnId: accepted.turn.id, duplicate: !accepted.inserted };
    }
    const accepted = this.options.store.acceptInstanceTurn({ id, idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: instance.projectId, instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", priority: "priority", text: input.text, maxQueueDepth: this.options.maxQueueDepth ?? 20 });
    this.options.wakeInstance?.(instance.id);
    return { mode: "priority", logicalTurnId: accepted.turn.id, duplicate: !accepted.inserted };
  }

  private async dispatch(operation: TurnControlOperation, steerInput?: SteerCommand): Promise<{ mode: "native"; operation: TurnControlOperation } | SteerOutcome> {
    const rejection = await this.revalidate(operation.target, operation.kind);
    if (rejection) {
      const rejected = { ...operation, state: "rejected" as const, result: { status: "rejected", reason: rejection } };
      return { mode: "native", operation: this.options.store.rejectAcceptedTurnControlOperation({ id: operation.id, result: rejected.result, card: this.options.presentation.turnControlResult(rejected) }) ?? this.requireOperation(operation.id) };
    }
    const claimed = this.options.store.claimTurnControlOperation(operation.id);
    if (!claimed) {
      const rejected = { ...operation, state: "rejected" as const, result: { status: "rejected", reason: "Exact turn target changed before dispatch" } };
      return { mode: "native", operation: this.options.store.rejectAcceptedTurnControlOperation({ id: operation.id, result: rejected.result, card: this.options.presentation.turnControlResult(rejected) }) ?? this.requireOperation(operation.id) };
    }
    try {
      if (claimed.kind === "interrupt") {
        if (!this.options.herdr.interruptAgent) return { mode: "native", operation: this.finish(claimed.id, { status: "unsupported", reason: "Herdr native interruption is unavailable" }) };
        return { mode: "native", operation: this.finish(claimed.id, await this.options.herdr.interruptAgent({ paneId: claimed.target.paneId, agentSession: claimed.target.agentSession, runtimeTurnId: claimed.target.runtimeTurnId, idempotencyKey: claimed.id })) };
      }
      if (!this.options.herdr.steerAgent) return { mode: "native", operation: this.finish(claimed.id, { status: "unsupported", reason: "Herdr native steering is unavailable" }) };
      const receipt = await this.options.herdr.steerAgent({ paneId: claimed.target.paneId, agentSession: claimed.target.agentSession, runtimeTurnId: claimed.target.runtimeTurnId, text: claimed.payload!, idempotencyKey: claimed.id });
      if (receipt.status === "not-active" && steerInput) {
        let converted: SteerOutcome | null;
        try { converted = await this.convertNotActiveToPriority(claimed, steerInput); }
        catch (error) {
          const result = { status: "rejected", reason: safeLogError(error).message };
          return { mode: "native", operation: this.options.store.finishTurnControlOperation({ id: claimed.id, state: "rejected", result, card: this.options.presentation.turnControlResult({ ...claimed, state: "rejected", result }) }) ?? this.requireOperation(claimed.id) };
        }
        if (converted) return converted;
      }
      return { mode: "native", operation: this.finish(claimed.id, receipt) };
    } catch (error) {
      const result = { status: "delivery-uncertain", reason: safeLogError(error).message };
      return { mode: "native", operation: this.options.store.finishTurnControlOperation({ id: claimed.id, state: "uncertain", result, card: this.options.presentation.turnControlResult({ ...claimed, state: "uncertain", result }) }) ?? this.requireOperation(claimed.id) };
    }
  }

  private async convertNotActiveToPriority(operation: TurnControlOperation, input: SteerCommand): Promise<SteerOutcome | null> {
    const pane = await this.options.herdr.getPane(operation.target.paneId);
    if (!pane?.agentSession || pane.agentState !== "idle" && pane.agentState !== "done" || pane.activeTurnId !== null && pane.activeTurnId !== undefined || !sameSession(operation.target.agentSession, pane.agentSession)) return null;
    const id = this.options.idFactory();
    const occurredAt = new Date().toISOString();
    const result = { status: "priority-accepted", logicalTurnId: id };
    if (operation.target.owner.kind === "binding") {
      const binding = this.options.store.getBinding(operation.target.owner.id);
      if (!binding?.rootMessageId || binding.generation !== operation.target.generation || binding.paneId !== operation.target.paneId || !bindingSession(binding) || !sameSession(bindingSession(binding)!, operation.target.agentSession)) return null;
      const view = createQueuedRunCard({ promptId: id, bindingId: binding.id, bindingGeneration: binding.generation, title: "Priority steer", sessionTitle: binding.title, workspaceId: binding.workspaceId, paneId: binding.paneId, requestText: input.text, queuePosition: 0, occurredAt });
      const converted = this.options.store.convertTurnControlToPrimaryPriority({ operationId: operation.id, prompt: { id, bindingId: binding.id, larkMessageId: `priority-steer:${input.idempotencyKey}`, actorOpenId: actorId(input.actor), body: input.text, priority: "priority" }, view, rootMessageId: binding.rootMessageId, answerCard: this.options.presentation.answerCard(view), maxQueueDepth: this.options.maxQueueDepth ?? 20, expectedBindingGeneration: binding.generation, result, card: this.options.presentation.turnControlResult({ ...operation, state: "delivered", result }) });
      if (!converted) return null;
      this.options.wakePrimary?.(binding.id); this.options.wakeOutbound?.();
      return { mode: "priority", logicalTurnId: converted.prompt.id, duplicate: false };
    }
    const instance = this.options.store.getAgentInstance(operation.target.owner.id);
    if (!instance?.runtimeRef || instance.generation !== operation.target.generation || instance.runtimeRef.paneId !== operation.target.paneId || instance.runtimeRef.nativeSessionId !== operation.target.agentSession.value) return null;
    const common = { id, idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: instance.projectId, instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn" as const, priority: "priority" as const, text: input.text, parentTurnId: null, sourceMessageId: input.sourceMessageId ?? input.idempotencyKey };
    const turn = input.resultTargetMessageId
      ? (() => { const view = createQueuedWorkerTurnCard({ turnId: id, instanceId: instance.id, instanceGeneration: instance.generation, workerSessionGeneration: instance.workerSessionGeneration, workerName: instance.name, parentTurnId: null, rootMessageId: input.resultTargetMessageId!, requestText: input.text, queuePosition: 0, occurredAt }); return { ...common, view, render: this.options.presentation.workerTurn }; })()
      : common;
    const converted = this.options.store.convertTurnControlToWorkerPriority({ operationId: operation.id, turn, maxQueueDepth: this.options.maxQueueDepth ?? 20, result, card: this.options.presentation.turnControlResult({ ...operation, state: "delivered", result }) });
    if (!converted) return null;
    this.options.wakeInstance?.(instance.id); this.options.wakeOutbound?.();
    return { mode: "priority", logicalTurnId: converted.logicalTurnId, duplicate: false };
  }

  private finish(id: string, receipt: SteerReceipt | InterruptReceipt): TurnControlOperation {
    const state = receipt.status === "delivered" || receipt.status === "interrupted" ? "delivered" : receipt.status === "delivery-uncertain" || receipt.status === "failed" ? "uncertain" : "rejected";
    const operation = this.requireOperation(id);
    return this.options.store.finishTurnControlOperation({ id, state, result: receipt, card: this.options.presentation.turnControlResult({ ...operation, state, result: receipt }) }) ?? this.requireOperation(id);
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
    if (pane.activeTurnId !== runtimeTurnId) throw new Error("Runtime turn identity changed");
    return pane;
  }

  private async requireIdlePane(paneId: string, expectedSession: HerdrAgentSession | null): Promise<HerdrPane> {
    const pane = await this.options.herdr.getPane(paneId);
    if (!pane?.agentSession) throw new Error("Herdr pane has no native Agent session");
    if (expectedSession && !sameSession(expectedSession, pane.agentSession)) throw new Error("Agent session identity changed");
    if (pane.agentState === "blocked") throw new Error("Agent is blocked on a local approval or question");
    if (pane.agentState !== "idle" && pane.agentState !== "done") throw new Error("Agent runtime state is not safely idle");
    return pane;
  }

  private requireOperation(id: string): TurnControlOperation {
    const operation = this.options.store.getTurnControlOperation(id);
    if (!operation) throw new Error(`Turn control operation disappeared: ${id}`);
    return operation;
  }
}

function actorId(actor: ControlActor): string { return actor.kind === "human" ? actor.userId : `primary:${actor.bindingId}`; }

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

function commandFromOperation(operation: TurnControlOperation): SteerCommand {
  if (operation.kind !== "steer" || operation.payload === null) throw new Error("Cannot reconstruct a non-steer control operation");
  return { owner: operation.target.owner, actor: operation.actor, text: operation.payload, idempotencyKey: operation.idempotencyKey, sourceMessageId: operation.sourceMessageId, sourceCardId: operation.sourceCardId };
}
