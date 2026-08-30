import type { AgentInstance } from "../domain/agent-instance.js";
import type { InterruptReceipt, SteerReceipt } from "../domain/agent-runtime.js";
import type { ControlActor } from "../domain/commands.js";
import type { InstanceEvent, InstanceTurn } from "../domain/instance-turn.js";
import type { InstanceStore } from "../domain/ports.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import type { PaneHost } from "../runtime/herdr/pane-host.js";

interface Options { store: InstanceStore; drivers: AgentDriverRegistry; paneHost: PaneHost; wake: (instanceId: string) => void; idFactory: () => string; maxQueueDepth?: number }
export interface InstanceConversationView { instance: AgentInstance; turns: InstanceTurn[]; events: InstanceEvent[] }

export class InstanceMessagingWorkflow {
  constructor(private readonly options: Options) {}

  async submit(input: { idempotencyKey: string; actor: ControlActor; projectId: string; targetInstanceId: string; content: { kind: "turn" | "followup"; text: string } }): Promise<{ accepted: true; turn: InstanceTurn; inserted: boolean }> {
    const target = this.authorize(input.actor, input.projectId, input.targetInstanceId);
    if (!target.runtimeRef || target.desiredState !== "running") throw new Error("Target instance is not running");
    if (this.options.store.countPendingInstanceTurns(target.id) >= (this.options.maxQueueDepth ?? 20)) throw new Error("Target instance queue is full");
    const result = this.options.store.acceptInstanceTurn({ id: this.options.idFactory(), idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: input.projectId, instanceId: target.id, instanceGeneration: target.generation, kind: input.content.kind, text: input.content.text });
    if (result.inserted) this.options.wake(target.id);
    return { accepted: true, ...result };
  }

  async steer(input: { idempotencyKey: string; actor: ControlActor; targetInstanceId: string; text: string }): Promise<SteerReceipt> {
    const target = this.authorize(input.actor, undefined, input.targetInstanceId);
    const driver = this.options.drivers.get(target.agentKind);
    if (!driver || driver.describe().steering === "unsupported" || !driver.steer) return { status: "unsupported" };
    if (!target.runtimeRef || !["working", "blocked"].includes(target.observedState)) return { status: "not-active" };
    const accepted = this.options.store.acceptInstanceOperation({ id: this.options.idFactory(), idempotencyKey: input.idempotencyKey, actor: input.actor, projectId: target.projectId, instanceId: target.id, instanceGeneration: target.generation, kind: "steer", payload: input.text });
    const claimed = this.options.store.claimInstanceOperation(accepted.operation.id, target.generation);
    if (!claimed) return accepted.operation.state === "accepted" || accepted.operation.state === "running" ? { status: "failed", reason: "Steering operation is already in progress" } : operationSteerReceipt(accepted.operation.result);
    const result = await driver.steer(target.runtimeRef, input.text);
    this.options.store.updateInstanceOperation({ id: accepted.operation.id, expectedGeneration: target.generation, state: result.status === "delivered" ? "succeeded" : result.status === "not-active" || result.status === "unsupported" ? "rejected" : "failed", result: JSON.stringify(result) });
    return result;
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
    if (actor.kind === "primary-agent") this.requireCurrentPrimary(actor, projectId);
    return this.options.store.listAgentInstances(projectId);
  }

  events(actor: ControlActor, instanceId: string, afterId = 0): InstanceEvent[] { const target = this.authorize(actor, undefined, instanceId); return this.options.store.listInstanceEvents(target.id, afterId); }

  private authorize(actor: ControlActor, requestedProjectId: string | undefined, targetId: string): AgentInstance {
    const target = this.options.store.getAgentInstance(targetId);
    if (!target) throw new Error("Target instance not found");
    const projectId = requestedProjectId ?? target.projectId;
    if (target.projectId !== projectId) throw new Error("Target instance is not in the requested project");
    if (actor.kind === "primary-agent") {
      this.requireCurrentPrimary(actor, projectId);
      if (target.role !== "worker") throw new Error("Primary tools can target only same-project workers");
    }
    return target;
  }

  private requireCurrentPrimary(actor: Extract<ControlActor, { kind: "primary-agent" }>, projectId: string): AgentInstance {
    const caller = this.options.store.getAgentInstance(actor.instanceId);
    if (!caller || caller.projectId !== actor.projectId || caller.projectId !== projectId || caller.role !== "primary" || caller.generation !== actor.generation) throw new Error("Caller is not the authorized current primary");
    return caller;
  }
}

function operationSteerReceipt(result: string | null): SteerReceipt { try { return JSON.parse(result ?? "{}") as SteerReceipt; } catch { return { status: "failed", reason: "Stored steering result is invalid" }; } }
function operationInterruptReceipt(result: string | null): InterruptReceipt { try { return JSON.parse(result ?? "{}") as InterruptReceipt; } catch { return { status: "failed", reason: "Stored interrupt result is invalid" }; } }
