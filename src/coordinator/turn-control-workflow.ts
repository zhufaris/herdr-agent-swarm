import type { ControlActor } from "../domain/commands.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { AgentInputWorkflowPort } from "../domain/ports/agent-input.js";
import type { PrimaryPresentation, WorkerPresentation } from "../domain/ports/presentation.js";
import { TurnControlRequestError, type InterruptCommand, type SteerCommand, type SteerOutcome, type TurnControlPort, type TurnControlWorkflowStore } from "../domain/ports/turn-control.js";
import type { Binding, HerdrAgentSession, HerdrPane } from "../domain/types.js";
import { sameNativeTraexSession } from "../domain/traex-session-identity.js";
import type { TurnControlOperation, TurnTarget } from "../domain/turn-control.js";
import { createQueuedWorkerTurnCard } from "../domain/worker-turn-card-view.js";
import type { ProjectConfig } from "../domain/types.js";

interface Options { store: TurnControlWorkflowStore; herdr: Pick<HerdrPort, "getPane"> & Partial<Pick<HerdrPort, "getActiveTurn">>; projects: readonly ProjectConfig[]; idFactory: () => string; presentation: Pick<PrimaryPresentation, "answerCard"> & Pick<WorkerPresentation, "workerTurn" | "turnControlResult">; agentInput: AgentInputWorkflowPort; wakeOutbound?: () => void; wakePrimary?: (bindingId: string) => void; wakeInstance?: (instanceId: string) => void; wakeTurnControl?: (owner: SteerCommand["owner"]) => void; maxQueueDepth?: number }

export class TurnControlWorkflow implements TurnControlPort {
  private readonly lanes = new Map<string, Promise<SteerOutcome>>();
  private readonly acceptedPrioritySteers = new Map<string, { logicalTurnId: string; text: string }>();
  constructor(private readonly options: Options) { void options.projects; }

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
      if (previous.state === "accepted") this.options.wakeTurnControl?.(previous.target.owner);
      const priorityTurnId = previous.result?.status === "priority-accepted" && typeof previous.result.logicalTurnId === "string" ? previous.result.logicalTurnId : null;
      if (priorityTurnId) return { mode: "priority", logicalTurnId: priorityTurnId, duplicate: true };
      return { mode: "native", operation: previous, duplicate: true };
    }
    if (kind === "steer") {
      const priority = this.acceptedPrioritySteers.get(prioritySteerKey(input.owner, input.idempotencyKey)) ?? this.options.store.getPrioritySteer(input.owner, input.idempotencyKey);
      if (priority) {
        if (priority.text !== (input as SteerCommand).text) throw new Error("Idempotency key belongs to a different priority steer");
        return { mode: "priority", logicalTurnId: priority.logicalTurnId, duplicate: true };
      }
    }
    const resolved = await this.resolveTarget(input.owner, kind);
    if (resolved.kind !== "active") return await this.acceptPriorityTurn(resolved, input as SteerCommand);
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
    this.options.wakeTurnControl?.(target.owner);
    return { mode: "native", operation: accepted.operation, duplicate: false };
  }

  private async resolveTarget(owner: SteerCommand["owner"], kind: "steer" | "interrupt"): Promise<{ kind: "active"; target: TurnTarget } | { kind: "idle"; binding: Binding; pane: HerdrPane } | { kind: "local-busy"; binding: Binding; pane: HerdrPane } | { kind: "idle-instance"; instance: NonNullable<ReturnType<TurnControlWorkflowStore["getAgentInstance"]>> }> {
    if (owner.kind === "binding") {
      const binding = this.options.store.getBinding(owner.id);
      if (!binding?.projectId || !binding.paneId) throw new TurnControlRequestError("not-active", "Primary binding has no active runtime");
      const session = bindingSession(binding);
      if (!session) throw new TurnControlRequestError("not-active", "Primary binding has no native Agent session");
      const pane = await this.requireAvailablePane(binding.paneId, session);
      const activeTurnId = pane.activeTurnId ?? (await this.options.herdr.getActiveTurn?.(binding.paneId))?.turnId ?? null;
      if (!activeTurnId) {
        if (kind === "interrupt") throw new TurnControlRequestError("not-active", "Primary binding has no exact active runtime turn");
        if (pane.agentState === "blocked") throw new TurnControlRequestError("blocked", "Agent is blocked on a local approval or question");
        if (pane.agentState === "working") return { kind: "local-busy", binding, pane };
        if (pane.agentState !== "idle" && pane.agentState !== "done") throw new TurnControlRequestError("not-active", "Agent runtime state is not safely idle");
        return { kind: "idle", binding, pane };
      }
      await this.requireControllablePane(binding.paneId, session, activeTurnId);
      return { kind: "active", target: { owner, projectId: binding.projectId, paneId: binding.paneId, generation: binding.generation, agentSession: pane.agentSession!, logicalTurnId: activeTurnId, runtimeTurnId: activeTurnId } };
    }
    const instance = this.options.store.getAgentInstance(owner.id);
    if (!instance?.runtimeRef) throw new TurnControlRequestError("not-active", "Agent instance has no active runtime");
    const turn = this.options.store.getActiveInstanceTurn(instance.id, instance.generation);
    if (!turn) {
      if (kind === "interrupt") throw new TurnControlRequestError("not-active", "Agent instance has no exact active runtime turn");
      await this.requireIdlePane(instance.runtimeRef.paneId, null);
      return { kind: "idle-instance", instance };
    }
    if (!turn.runtimeTurnId) throw new TurnControlRequestError("not-active", "Agent active runtime turn identity is not established");
    const pane = await this.requireControllablePane(instance.runtimeRef.paneId, null, turn.runtimeTurnId);
    if (!pane.agentSession || (instance.runtimeRef.nativeSessionId && pane.agentSession.value !== instance.runtimeRef.nativeSessionId)) throw new TurnControlRequestError("not-active", "Agent session identity changed");
    return { kind: "active", target: { owner, projectId: instance.projectId, paneId: instance.runtimeRef.paneId, generation: instance.generation, agentSession: pane.agentSession, logicalTurnId: turn.id, runtimeTurnId: turn.runtimeTurnId } };
  }

  private async acceptPriorityTurn(target: { kind: "idle" | "local-busy"; binding: Binding; pane: HerdrPane } | { kind: "idle-instance"; instance: NonNullable<ReturnType<TurnControlWorkflowStore["getAgentInstance"]>> }, input: SteerCommand): Promise<SteerOutcome> {
    const id = this.options.idFactory();
    const occurredAt = new Date().toISOString();
    if (target.kind !== "idle-instance") {
      const binding = target.binding;
      const pane = target.pane;
      if (!binding.paneId || !pane.terminalId || (pane.agentKind !== "traex" && pane.agentKind !== "pi")) throw new Error("Primary binding has no Agent Input route");
      const receipt = await this.options.agentInput.submit({
        ingressSource: "swarm-control",
        sourceMessageKey: idleSteerSourceKey(input.idempotencyKey),
        actor: {
          kind: input.actor.kind === "human" ? "human" : "system", id: actorId(input.actor), gatewayId: binding.gatewayId,
          chatId: binding.chatId, topicId: binding.topicId, rootMessageId: input.resultTargetMessageId ?? binding.rootMessageId
        },
        text: input.text,
        owner: { kind: "primary", id: binding.id, generation: binding.generation },
        paneId: binding.paneId, terminalId: pane.terminalId, expectedAgentKind: pane.agentKind,
        expectedSessionId: pane.agentSession?.agent === pane.agentKind ? pane.agentSession.value : null
      });
      if (receipt.outcome === "conflict") throw new Error("Agent Input idempotency key conflicts with an existing submission");
      return { mode: "input", submissionId: receipt.submissionId, duplicate: receipt.outcome === "duplicate" };
    }
    const instance = target.instance;
    if (input.resultTargetMessageId) {
      const view = createQueuedWorkerTurnCard({ turnId: id, instanceId: instance.id, instanceGeneration: instance.generation, workerSessionGeneration: instance.workerSessionGeneration, workerName: instance.name, parentTurnId: null, rootMessageId: input.resultTargetMessageId, requestText: input.text, queuePosition: 0, occurredAt });
      const accepted = this.options.store.acceptInstanceTurnWithCard({ id, idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: instance.projectId, instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", priority: "priority", text: input.text, parentTurnId: null, sourceMessageId: input.sourceMessageId ?? input.idempotencyKey, view, render: this.options.presentation.workerTurn, maxQueueDepth: this.options.maxQueueDepth ?? 20, unifiedSegment: { segmentId: `worker-turn:${id}`, submissionId: id, producerKey: `worker:${instance.id}`, owner: { kind: "worker", id: instance.id, generation: instance.generation }, agentKind: instance.agentKind === "pi" ? "pi" : "traex", expectedSessionId: instance.runtimeRef?.nativeSessionId ?? null, rootMessageId: input.resultTargetMessageId, occurredAt } });
      if (accepted.inserted) this.options.wakeOutbound?.();
      this.options.wakeInstance?.(instance.id);
      return { mode: "priority", logicalTurnId: accepted.turn.id, duplicate: !accepted.inserted };
    }
    const accepted = this.options.store.acceptInstanceTurn({ id, idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: instance.projectId, instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", priority: "priority", text: input.text, maxQueueDepth: this.options.maxQueueDepth ?? 20 });
    this.options.wakeInstance?.(instance.id);
    return { mode: "priority", logicalTurnId: accepted.turn.id, duplicate: !accepted.inserted };
  }

  private async requireControllablePane(paneId: string, expectedSession: HerdrAgentSession | null, runtimeTurnId: string): Promise<HerdrPane> {
    const pane = await this.options.herdr.getPane(paneId);
    if (!pane) throw new TurnControlRequestError("not-active", "Herdr pane is no longer active");
    if (!pane.agentSession) throw new TurnControlRequestError("not-active", "Herdr pane has no native Agent session");
    if (expectedSession && !sameNativeTraexSession(expectedSession, pane.agentSession)) throw new TurnControlRequestError("not-active", "Agent session identity changed");
    if (pane.agentState === "blocked") throw new TurnControlRequestError("blocked", "Agent is blocked on a local approval or question");
    const activeTurnId = pane.activeTurnId ?? (await this.options.herdr.getActiveTurn?.(paneId))?.turnId ?? null;
    if (activeTurnId !== runtimeTurnId) throw new TurnControlRequestError("not-active", "Runtime turn identity changed");
    return pane;
  }

  private async requireIdlePane(paneId: string, expectedSession: HerdrAgentSession | null): Promise<HerdrPane> {
    const pane = await this.requireAvailablePane(paneId, expectedSession);
    if (pane.agentState === "blocked") throw new TurnControlRequestError("blocked", "Agent is blocked on a local approval or question");
    if (pane.agentState !== "idle" && pane.agentState !== "done") throw new TurnControlRequestError("not-active", "Agent runtime state is not safely idle");
    return pane;
  }

  private async requireAvailablePane(paneId: string, expectedSession: HerdrAgentSession | null): Promise<HerdrPane> {
    const pane = await this.options.herdr.getPane(paneId);
    if (!pane?.agentSession) throw new TurnControlRequestError("not-active", "Herdr pane has no native Agent session");
    if (expectedSession && !sameNativeTraexSession(expectedSession, pane.agentSession)) throw new TurnControlRequestError("not-active", "Agent session identity changed");
    return pane;
  }

}

function actorId(actor: ControlActor): string { return actor.kind === "human" ? actor.userId : `primary:${actor.bindingId}`; }
function prioritySteerKey(owner: SteerCommand["owner"], idempotencyKey: string): string { return `${owner.kind}:${owner.id}:${idempotencyKey}`; }
function idleSteerSourceKey(idempotencyKey: string): string { return `idle-steer:v1:${idempotencyKey}`; }

function bindingSession(binding: Binding): HerdrAgentSession | null {
  return binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } : null;
}
function sameControlRequest(operation: TurnControlOperation, kind: "steer" | "interrupt", input: SteerCommand | InterruptCommand): boolean {
  const payload = kind === "steer" ? (input as SteerCommand).text : null;
  return operation.kind === kind && operation.target.owner.kind === input.owner.kind && operation.target.owner.id === input.owner.id
    && operation.payload === payload && operation.sourceMessageId === (input.sourceMessageId ?? null) && operation.sourceCardId === (input.sourceCardId ?? null);
}
