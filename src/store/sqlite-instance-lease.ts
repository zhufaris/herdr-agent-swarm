import type { DatabaseSync } from "node:sqlite";
import type { InstanceLease } from "../domain/types.js";

const FENCED_TABLES = [
  "bindings", "agent_instances", "workspace_leases", "instance_removal_plans", "instance_turns", "worker_turn_cards", "worker_turn_card_pages", "worker_main_views", "card_context_invalidations", "instance_operations", "instance_events", "primary_tool_capabilities", "approval_requests", "approval_grants", "conversation_targets", "inbound_messages", "bridge_messages", "prompt_jobs", "outbound_replies",
  "outbox_lane_heads", "outbox_lane_quarantines",
  "project_selections", "card_interactions", "session_operations", "swarm_command_intents", "pane_close_requests", "worker_pane_close_steps", "pane_control_operations", "turn_control_operations", "retired_pane_cleanup_operations", "binding_model_preferences", "audit_log", "lifecycle_events", "topic_views", "run_cards", "answer_pages"
] as const;

type InstanceLeaseRow = {
  owner_id: string;
  fencing_token: number;
  expires_at: string;
  updated_at: string;
};

export class SqliteInstanceLease {
  constructor(private readonly database: DatabaseSync) {}

  activateWriteFence(ownerId: string, fencingToken: number): void {
    this.deactivateWriteFence();
    this.database.exec("CREATE TEMP TABLE bridge_write_fence(owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL)");
    this.database.prepare("INSERT INTO temp.bridge_write_fence(owner_id, fencing_token) VALUES (?, ?)").run(ownerId, fencingToken);
    for (const table of FENCED_TABLES) for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const trigger = `bridge_fence_${table}_${operation.toLowerCase()}`;
      this.database.exec(`
        CREATE TEMP TRIGGER ${trigger} BEFORE ${operation} ON main.${table}
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM main.instance_lease AS lease, temp.bridge_write_fence AS fence
            WHERE lease.singleton_id = 1 AND lease.owner_id = fence.owner_id
              AND lease.fencing_token = fence.fencing_token
              AND julianday(lease.expires_at) > julianday('now')
          ) THEN RAISE(ABORT, 'stale_instance_lease') END;
        END;
      `);
    }
    try { this.assertWriteFence(); }
    catch (error) { this.deactivateWriteFence(); throw error; }
  }

  deactivateWriteFence(): void {
    for (const table of FENCED_TABLES) for (const operation of ["insert", "update", "delete"] as const) {
      this.database.exec(`DROP TRIGGER IF EXISTS temp.bridge_fence_${table}_${operation}`);
    }
    this.database.exec("DROP TABLE IF EXISTS temp.bridge_write_fence");
  }

  acquire(ownerId: string, currentTime: string, expiresAt: string): InstanceLease | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT owner_id, fencing_token, expires_at, updated_at FROM instance_lease WHERE singleton_id = 1").get() as InstanceLeaseRow | undefined;
      if (!row) {
        this.database.prepare("INSERT INTO instance_lease(singleton_id, owner_id, fencing_token, expires_at, updated_at) VALUES (1, ?, 1, ?, ?)").run(ownerId, expiresAt, currentTime);
      } else if (row.owner_id === ownerId) {
        this.database.prepare("UPDATE instance_lease SET expires_at = ?, updated_at = ? WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ?").run(expiresAt, currentTime, ownerId, row.fencing_token);
      } else if (row.expires_at <= currentTime) {
        this.database.prepare("UPDATE instance_lease SET owner_id = ?, fencing_token = fencing_token + 1, expires_at = ?, updated_at = ? WHERE singleton_id = 1 AND fencing_token = ? AND expires_at <= ?").run(ownerId, expiresAt, currentTime, row.fencing_token, currentTime);
      } else {
        this.database.exec("COMMIT");
        return null;
      }
      const acquired = this.database.prepare("SELECT owner_id, fencing_token, expires_at, updated_at FROM instance_lease WHERE singleton_id = 1 AND owner_id = ?").get(ownerId) as InstanceLeaseRow | undefined;
      this.database.exec("COMMIT");
      return acquired ? mapInstanceLease(acquired) : null;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  renew(ownerId: string, fencingToken: number, currentTime: string, expiresAt: string): InstanceLease | null {
    const result = this.database.prepare("UPDATE instance_lease SET expires_at = ?, updated_at = ? WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ? AND expires_at > ?")
      .run(expiresAt, currentTime, ownerId, fencingToken, currentTime);
    if (result.changes !== 1) return null;
    const row = this.database.prepare("SELECT owner_id, fencing_token, expires_at, updated_at FROM instance_lease WHERE singleton_id = 1").get() as InstanceLeaseRow;
    return mapInstanceLease(row);
  }

  release(ownerId: string, fencingToken: number): boolean {
    return this.database.prepare("DELETE FROM instance_lease WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ?").run(ownerId, fencingToken).changes === 1;
  }

  private assertWriteFence(): void {
    const valid = this.database.prepare(`
      SELECT 1 FROM main.instance_lease AS lease, temp.bridge_write_fence AS fence
      WHERE lease.singleton_id = 1 AND lease.owner_id = fence.owner_id
        AND lease.fencing_token = fence.fencing_token
        AND julianday(lease.expires_at) > julianday('now')
    `).get();
    if (!valid) throw new Error("stale_instance_lease");
  }
}

function mapInstanceLease(row: InstanceLeaseRow): InstanceLease {
  return { ownerId: row.owner_id, fencingToken: Number(row.fencing_token), expiresAt: row.expires_at, updatedAt: row.updated_at };
}
