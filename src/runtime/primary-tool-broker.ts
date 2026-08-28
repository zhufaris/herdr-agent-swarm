import type { ControlActor } from "../domain/commands.js";
import type { InstanceMessagingWorkflow } from "../coordinator/instance-messaging-workflow.js";

export interface PrimaryIdentity { projectId: string; instanceId: string; generation: number; parentTurnId: string }

export class PrimaryToolBroker {
  private readonly actor: Extract<ControlActor, { kind: "primary-agent" }>;
  constructor(identity: PrimaryIdentity, private readonly messaging: InstanceMessagingWorkflow) { this.actor = { kind: "primary-agent", ...identity }; }
  listInstances(input: { state?: string } = {}) { const all = this.messaging.list(this.actor, this.actor.projectId); return input.state ? all.filter(({ observedState }) => observedState === input.state) : all; }
  promptInstance(input: { instanceId: string; task: string; idempotencyKey: string }) { return this.messaging.submit({ idempotencyKey: input.idempotencyKey, actor: this.actor, projectId: this.actor.projectId, targetInstanceId: input.instanceId, content: { kind: "turn", text: input.task } }); }
  followUpInstance(input: { instanceId: string; text: string; idempotencyKey: string }) { return this.messaging.submit({ idempotencyKey: input.idempotencyKey, actor: this.actor, projectId: this.actor.projectId, targetInstanceId: input.instanceId, content: { kind: "followup", text: input.text } }); }
  steerInstance(input: { instanceId: string; text: string; idempotencyKey: string }) { return this.messaging.steer({ ...input, actor: this.actor, targetInstanceId: input.instanceId }); }
  inspectInstance(input: { instanceId: string }) { return this.messaging.inspect(this.actor, input.instanceId); }
  waitInstance(input: { instanceId: string; afterCursor?: string; timeoutMs?: number }) { const events = this.messaging.events(this.actor, input.instanceId, Number(input.afterCursor ?? 0)); return Promise.resolve({ events, cursor: String(events.at(-1)?.id ?? input.afterCursor ?? "0") }); }
  interruptInstance(input: { instanceId: string; idempotencyKey: string }) { return this.messaging.interrupt({ ...input, actor: this.actor, targetInstanceId: input.instanceId }); }
}
