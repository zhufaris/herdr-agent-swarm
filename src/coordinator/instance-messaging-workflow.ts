import type { AgentInstance } from "../domain/agent-instance.js";
import { InstanceTargetError } from "../domain/instance-target-error.js";
import type { InterruptReceipt, SteerReceipt } from "../domain/agent-runtime.js";
import type { ControlActor } from "../domain/commands.js";
import type { InstanceEvent, InstanceTurn } from "../domain/instance-turn.js";
import { createQueuedWorkerTurnCard, type WorkerTurnCardView } from "../domain/worker-turn-card-view.js";
import type { InstanceMessagingStore } from "../domain/ports/instance.js";
import type { WorkerPresentation } from "../domain/ports/presentation.js";
import { TurnControlRequestError, type TurnControlPort } from "../domain/ports/turn-control.js";
import { assertPromptInputSize } from "../domain/prompt-input-policy.js";
import type { InstanceConversationView, InstanceMessagingPort } from "../domain/ports/instance-workflows.js";
import { COMPLETION_ACTION_MESSAGES, type CompletionActionSelection } from "../domain/completion-action-set.js";

interface Options { store: InstanceMessagingStore; turnControl: Pick<TurnControlPort, "steer" | "interrupt">; wake: (instanceId: string) => void; wakeOutbound?: () => void; convergeWorkerTurn?: (turnId: string) => void | Promise<void>; idFactory: () => string; presentation: Pick<WorkerPresentation, "workerTurn">; maxQueueDepth?: number }
const INSTANCE_EVENT_POLL_INTERVAL_MS = 250;

export class InstanceMessagingWorkflow implements InstanceMessagingPort {
  constructor(private readonly options: Options) {}

  async submit(input: { idempotencyKey: string; actor: ControlActor; projectId: string; targetInstanceId: string; content: { kind: "turn" | "followup"; text: string }; source?: { messageId: string; rootMessageId: string; parentTurnId?: string | null } }): Promise<{ accepted: true; turn: InstanceTurn; card: WorkerTurnCardView | null; inserted: boolean }> {
    assertPromptInputSize(input.content.text);
    const target = this.authorize(input.actor, input.projectId, input.targetInstanceId);
    if (!target.runtimeRef || target.desiredState !== "running") throw new InstanceTargetError("instance_not_running");
    const id = this.options.idFactory();
    if (input.source) {
      const primaryAnswer = input.actor.kind === "thread-primary" ? { aggregateKind: "primary-turn" as const, aggregateId: input.actor.parentPromptId, generation: input.actor.bindingGeneration, messageId: null } : null;
      const view = createQueuedWorkerTurnCard({ turnId: id, instanceId: target.id, instanceGeneration: target.generation, workerSessionGeneration: target.workerSessionGeneration, workerName: target.name, parentTurnId: input.source.parentTurnId ?? null, rootMessageId: input.source.rootMessageId, requestText: input.content.text, queuePosition: 0, primaryAnswer, occurredAt: new Date().toISOString() });
      const result = this.options.store.acceptInstanceTurnWithCard({ id, idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: input.projectId, instanceId: target.id, instanceGeneration: target.generation, kind: input.content.kind, text: input.content.text, parentTurnId: input.source.parentTurnId ?? null, sourceMessageId: input.source.messageId, view, render: this.options.presentation.workerTurn, maxQueueDepth: this.options.maxQueueDepth ?? 20, unifiedSegment: { segmentId: `worker-turn:${id}`, submissionId: id, producerKey: `worker:${target.id}`, owner: { kind: "worker", id: target.id, generation: target.generation }, agentKind: target.agentKind === "pi" ? "pi" : "traex", expectedSessionId: target.runtimeRef?.nativeSessionId ?? null, rootMessageId: input.source.rootMessageId, occurredAt: new Date().toISOString() } });
      await this.convergeCompletionOwners(result.completionActionOwnerTurnIds);
      if (result.inserted) { this.options.wakeOutbound?.(); this.options.wake(target.id); }
      return { accepted: true, ...result, card: result.view };
    }
    const result = this.options.store.acceptInstanceTurn({ id, idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: input.projectId, instanceId: target.id, instanceGeneration: target.generation, kind: input.content.kind, text: input.content.text, maxQueueDepth: this.options.maxQueueDepth ?? 20 });
    if (result.inserted) this.options.wake(target.id);
    return { accepted: true, ...result, card: null };
  }

  async acceptWorkerCompletionAction(input: { actionSetId: string; selection?: CompletionActionSelection; optionId?: string; ownerTurnId: string; ownerGeneration: number; cardMessageId: string; chatId: string; actor: Extract<ControlActor, { kind: "human" }> }): Promise<{ accepted: true; turn: InstanceTurn; card: WorkerTurnCardView; inserted: boolean }> {
    if ((input.selection === undefined) === (input.optionId === undefined)) throw new Error("Exactly one Worker completion action identity is required");
    const owner = this.options.store.getInstanceTurn(input.ownerTurnId);
    const ownerView = owner ? this.options.store.loadWorkerTurnCard(owner.id) : null;
    const target = owner ? this.options.store.getAgentInstance(owner.instanceId) : null;
    if (!owner || !ownerView || !target || !target.runtimeRef || target.desiredState !== "running") throw new Error("Worker completion action is no longer available");
    const choice = input.optionId === undefined ? null : this.options.store.resolveWorkerCompletionChoice({ actionSetId: input.actionSetId, optionId: input.optionId, ownerTurnId: input.ownerTurnId, ownerGeneration: input.ownerGeneration, cardMessageId: input.cardMessageId, actorOpenId: input.actor.userId });
    const text = choice?.message ?? COMPLETION_ACTION_MESSAGES[input.selection!];
    const id = this.options.idFactory();
    const sourceKey = input.optionId ? `completion-choice:v1:${input.actionSetId}:${input.optionId}` : `completion-action:v1:${input.actionSetId}:${input.selection}`;
    const view = createQueuedWorkerTurnCard({
      turnId: id, instanceId: target.id, instanceGeneration: target.generation, workerSessionGeneration: target.workerSessionGeneration,
      workerName: target.name, parentTurnId: owner.id, rootMessageId: ownerView.rootMessageId, requestText: text, queuePosition: 0,
      primaryAnswer: ownerView.primaryAnswer, occurredAt: new Date().toISOString()
    });
    const result = this.options.store.acceptWorkerCompletionAction({
      actionSetId: input.actionSetId, ...(input.optionId ? { optionId: input.optionId } : { selection: input.selection! }), ownerTurnId: input.ownerTurnId, ownerGeneration: input.ownerGeneration,
      cardMessageId: input.cardMessageId, chatId: input.chatId, actorOpenId: input.actor.userId,
      accepted: { id, idempotencyKey: sourceKey, actor: input.actor, projectId: owner.projectId, instanceId: target.id, instanceGeneration: target.generation,
        kind: "followup", text, parentTurnId: owner.id, sourceMessageId: input.cardMessageId, view, render: this.options.presentation.workerTurn, maxQueueDepth: this.options.maxQueueDepth ?? 20,
        unifiedSegment: { segmentId: `worker-turn:${id}`, submissionId: id, producerKey: `worker:${target.id}`, owner: { kind: "worker", id: target.id, generation: target.generation },
          agentKind: target.agentKind === "pi" ? "pi" : "traex", expectedSessionId: target.runtimeRef.nativeSessionId, rootMessageId: ownerView.rootMessageId, occurredAt: new Date().toISOString() } }
    });
    await this.convergeCompletionOwners(result.completionActionOwnerTurnIds);
    if (result.inserted) { this.options.wakeOutbound?.(); this.options.wake(target.id); }
    return { accepted: true, ...result, card: result.view };
  }

  async ignoreWorkerCompletionAction(input: { actionSetId: string; ownerTurnId: string; ownerGeneration: number; cardMessageId: string; chatId: string; actor: Extract<ControlActor, { kind: "human" }> }) {
    const result = this.options.store.ignoreWorkerCompletionAction({
      actionSetId: input.actionSetId, ownerTurnId: input.ownerTurnId, ownerGeneration: input.ownerGeneration,
      cardMessageId: input.cardMessageId, chatId: input.chatId, actorOpenId: input.actor.userId
    });
    await this.convergeCompletionOwners([result.ownerId]);
    return result;
  }

  async decideFreshWorkerCompletionReview(input: { actionSetId: string; optionId: string; messageId: string; chatId: string; actor: Extract<ControlActor, { kind: "human" }> }): Promise<{ kind: "ignored"; changed: boolean } | { kind: "followup"; turn: InstanceTurn; card: WorkerTurnCardView; inserted: boolean }> {
    const review = this.options.store.resolveFreshWorkerCompletionReview({
      actionSetId: input.actionSetId, optionId: input.optionId, messageId: input.messageId,
      actorOpenId: input.actor.userId, chatId: input.chatId
    });
    if (!review) throw new Error("Worker completion action is no longer available");
    if (input.optionId === "ignore") {
      const ignored = await this.ignoreWorkerCompletionAction({
        actionSetId: input.actionSetId, ownerTurnId: review.ownerTurnId, ownerGeneration: review.ownerGeneration,
        cardMessageId: review.cardMessageId, chatId: input.chatId, actor: input.actor
      });
      return { kind: "ignored", changed: ignored.changed };
    }
    const accepted = await this.acceptWorkerCompletionAction({
      actionSetId: input.actionSetId, optionId: input.optionId, ownerTurnId: review.ownerTurnId,
      ownerGeneration: review.ownerGeneration, cardMessageId: review.cardMessageId,
      chatId: input.chatId, actor: input.actor
    });
    return { kind: "followup", turn: accepted.turn, card: accepted.card, inserted: accepted.inserted };
  }

  async steer(input: { idempotencyKey: string; actor: ControlActor; targetInstanceId: string; targetTurnId?: string; text: string; resultTargetMessageId?: string }): Promise<SteerReceipt & { durableResult?: boolean }> {
    assertPromptInputSize(input.text);
    const target = this.authorize(input.actor, undefined, input.targetInstanceId);
    if (input.targetTurnId) {
      const turn = this.options.store.getInstanceTurn(input.targetTurnId);
      if (!turn || turn.instanceId !== target.id || turn.instanceGeneration !== target.generation || !["running", "blocked"].includes(turn.state)) return { status: "not-active", ...(input.resultTargetMessageId ? { durableResult: false } : {}) };
      const active = this.options.store.getActiveInstanceTurn(target.id, target.generation);
      if (!active || active.id !== turn.id) return { status: "not-active", ...(input.resultTargetMessageId ? { durableResult: false } : {}) };
    }
    try {
      const outcome = await this.options.turnControl.steer({ owner: { kind: "instance", id: target.id }, actor: input.actor, text: input.text, idempotencyKey: input.idempotencyKey, ...(input.resultTargetMessageId ? { resultTargetMessageId: input.resultTargetMessageId } : {}) });
      if (outcome.mode === "input") return { status: "delivered", operationId: outcome.submissionId, ...(input.resultTargetMessageId ? { durableResult: true } : {}) };
      if (outcome.mode === "priority") return { status: "delivered", operationId: outcome.logicalTurnId, ...(input.resultTargetMessageId ? { durableResult: true } : {}) };
      const { operation } = outcome;
      return { ...turnControlSteerReceipt(operation.id, operation.state, operation.result), ...(input.resultTargetMessageId ? { durableResult: true } : {}) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const durable = input.resultTargetMessageId ? { durableResult: false as const } : {};
      if (error instanceof TurnControlRequestError) return { status: error.code, reason, ...durable };
      return { status: "failed", reason, ...durable };
    }
  }

  async interrupt(input: { idempotencyKey: string; actor: ControlActor; targetInstanceId: string; targetTurnId?: string; resultTargetMessageId?: string }): Promise<InterruptReceipt & { durableResult?: boolean }> {
    const target = this.authorize(input.actor, undefined, input.targetInstanceId);
    if (input.targetTurnId) {
      const turn = this.options.store.getInstanceTurn(input.targetTurnId);
      const active = this.options.store.getActiveInstanceTurn(target.id, target.generation);
      if (!turn || turn.instanceId !== target.id || turn.instanceGeneration !== target.generation || turn.state !== "running" || active?.id !== turn.id) return { status: "not-active", ...(input.resultTargetMessageId ? { durableResult: false } : {}) };
    }
    try {
      const outcome = await this.options.turnControl.interrupt({ owner: { kind: "instance", id: target.id }, actor: input.actor, idempotencyKey: input.idempotencyKey, ...(input.resultTargetMessageId ? { resultTargetMessageId: input.resultTargetMessageId } : {}) });
      if (outcome.mode === "input") return { status: "failed", reason: "Interrupt unexpectedly resolved to Agent Input", ...(input.resultTargetMessageId ? { durableResult: false } : {}) };
      if (outcome.mode === "priority") return { status: "failed", reason: "Interrupt unexpectedly resolved to a priority turn", ...(input.resultTargetMessageId ? { durableResult: false } : {}) };
      const { operation } = outcome;
      return { ...turnControlInterruptReceipt(operation.id, operation.state, operation.result), ...(input.resultTargetMessageId ? { durableResult: true } : {}) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const durable = input.resultTargetMessageId ? { durableResult: false as const } : {};
      if (error instanceof TurnControlRequestError) return { status: error.code, reason, ...durable };
      return { status: "failed", reason, ...durable };
    }
  }

  inspect(actor: ControlActor, instanceId: string): InstanceConversationView {
    const target = this.authorize(actor, undefined, instanceId);
    return { instance: target, turns: this.options.store.listInstanceTurns(target.id, { limit: 50 }).items, events: this.options.store.listInstanceEvents(target.id) };
  }

  list(actor: ControlActor, projectId: string): AgentInstance[] {
    if (actor.kind === "thread-primary") {
      const binding = this.requireCurrentPrimary(actor, projectId);
      if (!binding.paneId) return [];
      return this.options.store.listWorkerInstancesByParent({ bindingId: binding.id, paneId: binding.paneId });
    }
    return this.options.store.listAgentInstances(projectId).filter(({ role }) => role === "worker");
  }

  events(actor: ControlActor, instanceId: string, afterId = 0): InstanceEvent[] { const target = this.authorize(actor, undefined, instanceId); return this.options.store.listInstanceEvents(target.id, afterId); }

  async waitForEvents(actor: ControlActor, instanceId: string, afterId: number, timeoutMs: number): Promise<InstanceEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const events = this.events(actor, instanceId, afterId);
      if (events.length > 0 || Date.now() >= deadline) return events;
      await delay(Math.min(INSTANCE_EVENT_POLL_INTERVAL_MS, deadline - Date.now()));
    }
  }

  private authorize(actor: ControlActor, requestedProjectId: string | undefined, targetId: string): AgentInstance {
    const target = this.options.store.getAgentInstance(targetId);
    if (!target) throw new InstanceTargetError("instance_not_found");
    const projectId = requestedProjectId ?? target.projectId;
    if (target.projectId !== projectId) throw new InstanceTargetError("instance_project_mismatch");
    if (actor.kind === "thread-primary") {
      const binding = this.requireCurrentPrimary(actor, projectId);
      if (target.role !== "worker" || !binding.paneId || target.parent?.bindingId !== binding.id || target.parent.paneId !== binding.paneId) throw new Error("Primary tools can target only Workers owned by this Primary pane");
    }
    return target;
  }

  private requireCurrentPrimary(actor: Extract<ControlActor, { kind: "thread-primary" }>, projectId: string): import("../domain/types.js").Binding {
    const binding = this.options.store.getBinding(actor.bindingId);
    const prompt = this.options.store.getActiveOrdinaryPrompt(actor.bindingId, actor.bindingGeneration);
    if (!binding || binding.projectId !== actor.projectId || binding.projectId !== projectId || binding.generation !== actor.bindingGeneration || prompt?.id !== actor.parentPromptId) throw new Error("Caller is not the authorized current thread Primary");
    return binding;
  }

  private async convergeCompletionOwners(turnIds: readonly string[] | undefined): Promise<void> {
    if (!this.options.convergeWorkerTurn) return;
    for (const turnId of turnIds ?? []) await this.options.convergeWorkerTurn(turnId);
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); });
}

function turnControlSteerReceipt(operationId: string, state: import("../domain/turn-control.js").TurnControlState, result: Record<string, unknown> | null): SteerReceipt {
  if (result && typeof result.status === "string") return result as SteerReceipt;
  if (state === "accepted" || state === "dispatching") return { status: "accepted", operationId };
  return state === "uncertain" ? { status: "delivery-uncertain", operationId: "unknown", reason: "Stored steering result is unavailable" } : { status: "failed", reason: "Stored steering result is invalid" };
}
function turnControlInterruptReceipt(operationId: string, state: import("../domain/turn-control.js").TurnControlState, result: Record<string, unknown> | null): InterruptReceipt {
  if (result && typeof result.status === "string") return result as InterruptReceipt;
  if (state === "accepted" || state === "dispatching") return { status: "accepted", operationId };
  return state === "uncertain" ? { status: "delivery-uncertain", operationId: "unknown", reason: "Stored interrupt result is unavailable" } : { status: "failed", reason: "Stored interrupt result is invalid" };
}
