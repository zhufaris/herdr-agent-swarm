import type { ControlActor } from "../domain/commands.js";
import type { PrimaryToolMessagingPort } from "../domain/primary-tool-messaging.js";

export interface PrimaryIdentity { projectId: string; bindingId: string; bindingGeneration: number; parentPromptId: string; sourceMessageId: string; rootMessageId: string }

export class PrimaryToolBroker {
  private readonly actor: Extract<ControlActor, { kind: "thread-primary" }>;
  constructor(private readonly identity: PrimaryIdentity, private readonly messaging: PrimaryToolMessagingPort) { this.actor = { kind: "thread-primary", projectId: identity.projectId, bindingId: identity.bindingId, bindingGeneration: identity.bindingGeneration, parentPromptId: identity.parentPromptId }; }
  listInstances(input: { state?: string } = {}) { const all = this.messaging.list(this.actor, this.actor.projectId); return input.state ? all.filter(({ observedState }) => observedState === input.state) : all; }
  promptInstance(input: { instanceId: string; task: string; idempotencyKey: string }) { return this.messaging.submit({ idempotencyKey: input.idempotencyKey, actor: this.actor, projectId: this.actor.projectId, targetInstanceId: input.instanceId, content: { kind: "turn", text: input.task }, source: { messageId: this.identity.sourceMessageId, rootMessageId: this.identity.rootMessageId } }); }
  followUpInstance(input: { instanceId: string; text: string; idempotencyKey: string }) { return this.messaging.submit({ idempotencyKey: input.idempotencyKey, actor: this.actor, projectId: this.actor.projectId, targetInstanceId: input.instanceId, content: { kind: "followup", text: input.text }, source: { messageId: this.identity.sourceMessageId, rootMessageId: this.identity.rootMessageId } }); }
  steerInstance(input: { instanceId: string; text: string; idempotencyKey: string }) { return this.messaging.steer({ ...input, actor: this.actor, targetInstanceId: input.instanceId }); }
  inspectInstance(input: { instanceId: string }) { return this.messaging.inspect(this.actor, input.instanceId); }
  waitInstance(input: { instanceId: string; afterCursor?: string; timeoutMs?: number }) { const events = this.messaging.events(this.actor, input.instanceId, Number(input.afterCursor ?? 0)); return Promise.resolve({ events, cursor: String(events.at(-1)?.id ?? input.afterCursor ?? "0") }); }
  interruptInstance(input: { instanceId: string; idempotencyKey: string }) { return this.messaging.interrupt({ ...input, actor: this.actor, targetInstanceId: input.instanceId }); }
}
