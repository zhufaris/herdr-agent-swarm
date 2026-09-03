import type { ControlActor } from "./commands.js";
import type { AgentInstance } from "./agent-instance.js";
import type { InstanceEvent, InstanceTurn } from "./instance-turn.js";
import type { SteerReceipt } from "./agent-runtime.js";

/** Inbound application capability used by the Primary Tool transport. */
export interface PrimaryToolMessagingPort {
  submit(input: { idempotencyKey: string; actor: ControlActor; projectId: string; targetInstanceId: string; content: { kind: "turn" | "followup"; text: string } }): Promise<unknown>;
  steer(input: { idempotencyKey: string; actor: ControlActor; targetInstanceId: string; text: string }): Promise<SteerReceipt>;
  inspect(actor: ControlActor, instanceId: string): { instance: AgentInstance; turns: InstanceTurn[]; events: InstanceEvent[] };
  list(actor: ControlActor, projectId: string): AgentInstance[];
  events(actor: ControlActor, instanceId: string, afterId?: number): InstanceEvent[];
  interrupt(input: { idempotencyKey: string; actor: ControlActor; targetInstanceId: string }): Promise<unknown>;
}
