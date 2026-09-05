import type { AgentInstance } from "../domain/agent-instance.js";
import type { InterruptReceipt, SteerReceipt } from "../domain/agent-runtime.js";
import type { ControlActor } from "../domain/commands.js";
import type { InstanceEvent, InstanceTurn } from "../domain/instance-turn.js";
import { createQueuedWorkerTurnCard, type WorkerTurnCardView } from "../domain/worker-turn-card-view.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import { renderWorkerTurnCard } from "../cards/worker-turn-card.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import type { PaneHost } from "../runtime/herdr/pane-host.js";
import type { TurnControlWorkflow } from "./turn-control-workflow.js";

interface Options { store: InstanceStore; drivers: AgentDriverRegistry; paneHost: PaneHost; turnControl: Pick<TurnControlWorkflow, "steer">; wake: (instanceId: string) => void; wakeOutbound?: () => void; idFactory: () => string; maxQueueDepth?: number }
export interface InstanceConversationView { instance: AgentInstance; turns: InstanceTurn[]; events: InstanceEvent[] }

export class InstanceMessagingWorkflow {
  constructor(private readonly options: Options) {}

  async submit(input: { idempotencyKey: string; actor: ControlActor; projectId: string; targetInstanceId: string; content: { kind: "turn" | "followup"; text: string }; source?: { messageId: string; rootMessageId: string; parentTurnId?: string | null } }): Promise<{ accepted: true; turn: InstanceTurn; card: WorkerTurnCardView | null; inserted: boolean }> {
    const target = this.authorize(input.actor, input.projectId, input.targetInstanceId);
    if (!target.runtimeRef || target.desiredState !== "running") throw new Error("Target instance is not running");
    const queueDepth = this.options.store.countPendingInstanceTurns(target.id);
    const id = this.options.idFactory();
    if (input.source) {
      const primaryAnswer = input.actor.kind === "thread-primary" ? { aggregateKind: "primary-turn" as const, aggregateId: input.actor.parentPromptId, generation: input.actor.bindingGeneration, messageId: null } : null;
      const view = createQueuedWorkerTurnCard({ turnId: id, instanceId: target.id, instanceGeneration: target.generation, workerSessionGeneration: target.workerSessionGeneration, workerName: target.name, parentTurnId: input.source.parentTurnId ?? null, rootMessageId: input.source.rootMessageId, requestText: input.content.text, queuePosition: queueDepth + 1, primaryAnswer, occurredAt: new Date().toISOString() });
      const result = this.options.store.acceptInstanceTurnWithCard({ id, idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: input.projectId, instanceId: target.id, instanceGeneration: target.generation, kind: input.content.kind, text: input.content.text, parentTurnId: input.source.parentTurnId ?? null, sourceMessageId: input.source.messageId, view, card: renderWorkerTurnCard(view), maxQueueDepth: this.options.maxQueueDepth ?? 20 });
      if (result.inserted) { this.options.wakeOutbound?.(); this.options.wake(target.id); }
      return { accepted: true, ...result, card: result.view };
    }
    const result = this.options.store.acceptInstanceTurn({ id, idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: input.projectId, instanceId: target.id, instanceGeneration: target.generation, kind: input.content.kind, text: input.content.text, maxQueueDepth: this.options.maxQueueDepth ?? 20 });
    if (result.inserted) this.options.wake(target.id);
    return { accepted: true, ...result, card: null };
  }

  async steer(input: { idempotencyKey: string; actor: ControlActor; targetInstanceId: string; targetTurnId?: string; text: string; resultTargetMessageId?: string }): Promise<SteerReceipt & { durableResult?: boolean }> {
    const target = this.authorize(input.actor, undefined, input.targetInstanceId);
    if (input.targetTurnId) {
      const turn = this.options.store.getInstanceTurn(input.targetTurnId);
      if (!turn || turn.instanceId !== target.id || turn.instanceGeneration !== target.generation || !["running", "blocked"].includes(turn.state)) return { status: "not-active", ...(input.resultTargetMessageId ? { durableResult: false } : {}) };
      const active = this.options.store.getActiveInstanceTurn(target.id, target.generation);
      if (!active || active.id !== turn.id) return { status: "not-active", ...(input.resultTargetMessageId ? { durableResult: false } : {}) };
    }
    try {
      const { operation } = await this.options.turnControl.steer({ owner: { kind: "instance", id: target.id }, actor: input.actor, text: input.text, idempotencyKey: input.idempotencyKey, ...(input.resultTargetMessageId ? { resultTargetMessageId: input.resultTargetMessageId } : {}) });
      return { ...turnControlSteerReceipt(operation.state, operation.result), ...(input.resultTargetMessageId ? { durableResult: true } : {}) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const durable = input.resultTargetMessageId ? { durableResult: false as const } : {};
      if (/no exact active runtime turn|not active/i.test(reason)) return { status: "not-active", reason, ...durable };
      if (/unsupported/i.test(reason)) return { status: "unsupported", reason, ...durable };
      if (/blocked/i.test(reason)) return { status: "blocked", reason, ...durable };
      return { status: "failed", reason, ...durable };
    }
  }

  async interrupt(input: { idempotencyKey: string; actor: ControlActor; targetInstanceId: string }): Promise<InterruptReceipt> {
    const target = this.authorize(input.actor, undefined, input.targetInstanceId);
    const driver = this.options.drivers.get(target.agentKind);
    if (!target.runtimeRef || !["working", "blocked"].includes(target.observedState)) return { status: "not-active" };
    const accepted = this.options.store.acceptInstanceOperation({ id: this.options.idFactory(), idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: target.projectId, instanceId: target.id, instanceGeneration: target.generation, kind: "interrupt", payload: null });
    const claimed = this.options.store.claimInstanceOperation(accepted.operation.id, target.generation);
    if (!claimed) return accepted.operation.state === "accepted" || accepted.operation.state === "running" ? { status: "failed", reason: "Interrupt operation is already in progress" } : operationInterruptReceipt(accepted.operation.result);
    let result: InterruptReceipt;
    if (driver?.interrupt) result = await driver.interrupt(target.runtimeRef);
    else { try { await this.options.paneHost.interruptPane(target.runtimeRef.paneId); result = { status: "interrupted" }; } catch (error) { result = { status: "failed", reason: error instanceof Error ? error.message : String(error) }; } }
    this.options.store.updateInstanceOperation({ id: accepted.operation.id, expectedGeneration: target.generation, state: result.status === "interrupted" ? "succeeded" : result.status === "not-active" ? "rejected" : "failed", result: JSON.stringify(result) });
    return result;
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

  private authorize(actor: ControlActor, requestedProjectId: string | undefined, targetId: string): AgentInstance {
    const target = this.options.store.getAgentInstance(targetId);
    if (!target) throw new Error("Target instance not found");
    const projectId = requestedProjectId ?? target.projectId;
    if (target.projectId !== projectId) throw new Error("Target instance is not in the requested project");
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
}

function turnControlSteerReceipt(state: import("../domain/turn-control.js").TurnControlState, result: Record<string, unknown> | null): SteerReceipt {
  if (result && typeof result.status === "string") return result as SteerReceipt;
  return state === "uncertain" ? { status: "delivery-uncertain", operationId: "unknown", reason: "Stored steering result is unavailable" } : { status: "failed", reason: "Stored steering result is invalid" };
}
function operationInterruptReceipt(result: string | null): InterruptReceipt { try { return JSON.parse(result ?? "{}") as InterruptReceipt; } catch { return { status: "failed", reason: "Stored interrupt result is invalid" }; } }
