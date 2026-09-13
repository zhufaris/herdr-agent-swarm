import type { ControlActor } from "../domain/commands.js";
import type { PrimaryToolMessagingPort } from "../domain/primary-tool-messaging.js";
import type { WorkerCardDisplayWorkflow } from "../coordinator/worker-card-display-workflow.js";
import type { AgentKind, CreateWorkerResult } from "../domain/agent-instance.js";

export interface PrimaryIdentity { projectId: string; bindingId: string; bindingGeneration: number; parentPromptId: string; sourceMessageId: string; rootMessageId: string }
export interface PrimaryWorkerCreationPort {
  createWorkerFromPrimaryTool(input: PrimaryIdentity & { idempotencyKey: string; command: { kind: "worker_create"; name: string; agentKind: AgentKind; model: string | null; start: boolean } }): Promise<CreateWorkerResult>;
}

export class PrimaryToolBroker {
  private readonly actor: Extract<ControlActor, { kind: "thread-primary" }>;
  constructor(private readonly identity: PrimaryIdentity, private readonly messaging: PrimaryToolMessagingPort, private readonly workerCards?: Pick<WorkerCardDisplayWorkflow, "show">, private readonly workerCreation?: PrimaryWorkerCreationPort) { this.actor = { kind: "thread-primary", projectId: identity.projectId, bindingId: identity.bindingId, bindingGeneration: identity.bindingGeneration, parentPromptId: identity.parentPromptId }; }
  listInstances(input: { state?: string } = {}) { const all = this.messaging.list(this.actor, this.actor.projectId); return input.state ? all.filter(({ observedState }) => observedState === input.state) : all; }
  promptInstance(input: { instanceId: string; task: string; idempotencyKey: string }) { return this.messaging.submit({ idempotencyKey: input.idempotencyKey, actor: this.actor, projectId: this.actor.projectId, targetInstanceId: input.instanceId, content: { kind: "turn", text: input.task }, source: { messageId: this.identity.sourceMessageId, rootMessageId: this.identity.rootMessageId } }); }
  followUpInstance(input: { instanceId: string; parentTurnId: string; text: string; idempotencyKey: string }) { return this.messaging.submit({ idempotencyKey: input.idempotencyKey, actor: this.actor, projectId: this.actor.projectId, targetInstanceId: input.instanceId, content: { kind: "followup", text: input.text }, source: { messageId: this.identity.sourceMessageId, rootMessageId: this.identity.rootMessageId, parentTurnId: input.parentTurnId } }); }
  steerInstance(input: { instanceId: string; text: string; idempotencyKey: string }) { return this.messaging.steer({ ...input, actor: this.actor, targetInstanceId: input.instanceId }); }
  inspectInstance(input: { instanceId: string }) { return this.messaging.inspect(this.actor, input.instanceId); }
  waitInstance(input: { instanceId: string; afterCursor?: string; timeoutMs?: number }) { const events = this.messaging.events(this.actor, input.instanceId, Number(input.afterCursor ?? 0)); return Promise.resolve({ events, cursor: String(events.at(-1)?.id ?? input.afterCursor ?? "0") }); }
  interruptInstance(input: { instanceId: string; idempotencyKey: string }) { return this.messaging.interrupt({ ...input, actor: this.actor, targetInstanceId: input.instanceId }); }
  showWorkerCards(input: { workerName: string; idempotencyKey: string }) {
    if (!this.workerCards) throw new Error("Worker card display is unavailable");
    if (typeof input.workerName !== "string" || typeof input.idempotencyKey !== "string") throw new Error("Worker card display requires workerName and idempotencyKey strings");
    return this.workerCards.show({ ...this.identity, workerName: input.workerName, idempotencyKey: input.idempotencyKey });
  }
  createWorker(input: { name: string; agentKind: AgentKind; model?: string | null; start?: boolean; idempotencyKey: string }) {
    if (!this.workerCreation) throw new Error("Worker creation is unavailable");
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.name)) throw new Error("Invalid Worker name");
    if (!(["traex", "codex", "claude-code", "pi"] as const).includes(input.agentKind)) throw new Error("Invalid Worker agent kind");
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey) throw new Error("Worker creation requires an idempotencyKey");
    return this.workerCreation.createWorkerFromPrimaryTool({ ...this.identity, idempotencyKey: input.idempotencyKey, command: { kind: "worker_create", name: input.name, agentKind: input.agentKind, model: input.model ?? null, start: input.start ?? true } });
  }
}
