import type { AgentInstance, CreateWorkerResult, InstanceRemovalPlan, WorkspaceLease } from "../agent-instance.js";
import type { InterruptReceipt, SteerReceipt } from "../agent-runtime.js";
import type { ControlActor, CreateWorkerCommand } from "../commands.js";
import type { InstanceEvent, InstanceTurn } from "../instance-turn.js";
import type { WorkerTurnCardView } from "../worker-turn-card-view.js";

export interface InstanceControlPort {
  createWorker(command: CreateWorkerCommand): Promise<CreateWorkerResult>;
  start(input: { actor: ControlActor; instanceId: string }): Promise<AgentInstance>;
  stop(input: { actor: ControlActor; instanceId: string }): Promise<AgentInstance>;
  planRemoval(input: { actor: ControlActor; instanceId: string }): Promise<InstanceRemovalPlan>;
  confirmRemoval(input: { actor: ControlActor; planId: string }): Promise<boolean>;
  inspect(instanceId: string): { instance: AgentInstance; workspace: WorkspaceLease };
  listWorkers(projectId: string): AgentInstance[];
  listWorkersForParent(parent: { bindingId: string; paneId: string }): AgentInstance[];
}

export interface InstanceConversationView {
  instance: AgentInstance;
  turns: InstanceTurn[];
  events: InstanceEvent[];
}

export interface InstanceMessagingPort {
  submit(input: {
    idempotencyKey: string; actor: ControlActor; projectId: string; targetInstanceId: string;
    content: { kind: "turn" | "followup"; text: string };
    source?: { messageId: string; rootMessageId: string; parentTurnId?: string | null };
  }): Promise<{ accepted: true; turn: InstanceTurn; card: WorkerTurnCardView | null; inserted: boolean }>;
  steer(input: { idempotencyKey: string; actor: ControlActor; targetInstanceId: string; targetTurnId?: string; text: string; resultTargetMessageId?: string }): Promise<SteerReceipt & { durableResult?: boolean }>;
  interrupt(input: { idempotencyKey: string; actor: ControlActor; targetInstanceId: string; targetTurnId?: string; resultTargetMessageId?: string }): Promise<InterruptReceipt & { durableResult?: boolean }>;
  inspect(actor: ControlActor, instanceId: string): InstanceConversationView;
  list(actor: ControlActor, projectId: string): AgentInstance[];
  events(actor: ControlActor, instanceId: string, afterId?: number): InstanceEvent[];
  waitForEvents(actor: ControlActor, instanceId: string, afterId: number, timeoutMs: number): Promise<InstanceEvent[]>;
}
