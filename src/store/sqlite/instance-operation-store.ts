import type { InstanceTarget } from "../../domain/agent-instance.js";
import type { ControlActor } from "../../domain/commands.js";
import type { InstanceOperation } from "../../domain/instance-turn.js";
import type { AgentInstance } from "../../domain/agent-instance.js";
import type { SqliteContext } from "./context.js";

export class SqliteInstanceOperationStore {
  constructor(private readonly context: SqliteContext, private readonly getAgentInstance: (id: string) => AgentInstance | null) {}
  private get database() { return this.context.database; }

  acceptInstanceOperation(input: { id: string; idempotencyKey: string; actor: ControlActor; projectId: string; instanceId: string; instanceGeneration: number; kind: InstanceOperation["kind"]; payload: string | null }): { operation: InstanceOperation; inserted: boolean } {
    const timestamp = now();
    const instance = this.getAgentInstance(input.instanceId);
    if (!instance || instance.projectId !== input.projectId || instance.generation !== input.instanceGeneration) throw new Error("Instance generation changed before operation acceptance");
    const inserted = this.database.prepare(`INSERT INTO instance_operations(id, idempotency_key, project_id, instance_id, instance_generation, actor_json, kind, payload, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`).run(input.id, input.idempotencyKey, input.projectId, input.instanceId, input.instanceGeneration, JSON.stringify(input.actor), input.kind, input.payload, timestamp, timestamp).changes === 1;
    const row = this.database.prepare("SELECT * FROM instance_operations WHERE idempotency_key = ?").get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Accepted instance operation could not be loaded");
    const operation = mapInstanceOperation(row);
    if (operation.instanceId !== input.instanceId || operation.kind !== input.kind || operation.payload !== input.payload) throw new Error("Idempotency key belongs to a different instance operation");
    return { operation, inserted };
  }

  claimInstanceOperation(id: string, expectedGeneration: number): InstanceOperation | null {
    const changed = this.database.prepare(`UPDATE instance_operations SET state = 'running', result = 'running', updated_at = ? WHERE id = ? AND instance_generation = ? AND state = 'accepted' AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.id = instance_operations.instance_id AND i.generation = ?)` ).run(now(), id, expectedGeneration, expectedGeneration);
    if (changed.changes !== 1) return null;
    return mapInstanceOperation(this.database.prepare("SELECT * FROM instance_operations WHERE id = ?").get(id) as Record<string, unknown>);
  }

  updateInstanceOperation(input: { id: string; expectedGeneration: number; state: InstanceOperation["state"]; result: string }): InstanceOperation | null {
    const changed = this.database.prepare("UPDATE instance_operations SET state = ?, result = ?, updated_at = ? WHERE id = ? AND instance_generation = ?").run(input.state, input.result, now(), input.id, input.expectedGeneration);
    if (changed.changes !== 1) return null;
    return mapInstanceOperation(this.database.prepare("SELECT * FROM instance_operations WHERE id = ?").get(input.id) as Record<string, unknown>);
  }

  getConversationTarget(chatId: string): { projectId: string; target: InstanceTarget } | null {
    const row = this.database.prepare("SELECT project_id, target_kind, instance_id, instance_generation FROM conversation_targets WHERE chat_id = ?").get(chatId) as { project_id: string; target_kind: string; instance_id: string | null; instance_generation: number | null } | undefined;
    if (!row) return null;
    return { projectId: row.project_id, target: row.target_kind === "primary" ? { kind: "primary" } : { kind: "instance", instanceId: row.instance_id!, ...(row.instance_generation === null ? {} : { expectedGeneration: Number(row.instance_generation) }) } };
  }

  setConversationTarget(input: { chatId: string; projectId: string; target: InstanceTarget }): void {
    this.database.prepare(`INSERT INTO conversation_targets(chat_id, project_id, target_kind, instance_id, instance_generation, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET project_id = excluded.project_id, target_kind = excluded.target_kind, instance_id = excluded.instance_id, instance_generation = excluded.instance_generation, updated_at = excluded.updated_at`).run(input.chatId, input.projectId, input.target.kind, input.target.kind === "instance" ? input.target.instanceId : null, input.target.kind === "instance" ? input.target.expectedGeneration ?? null : null, now());
  }
}

function mapInstanceOperation(row: Record<string, unknown>): InstanceOperation { return { id: String(row.id), idempotencyKey: String(row.idempotency_key), projectId: String(row.project_id), instanceId: String(row.instance_id), instanceGeneration: Number(row.instance_generation), actor: JSON.parse(String(row.actor_json)) as ControlActor, kind: String(row.kind) as InstanceOperation["kind"], payload: row.payload === null ? null : String(row.payload), state: String(row.state) as InstanceOperation["state"], result: row.result === null ? null : String(row.result), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function now(): string { return new Date().toISOString(); }
