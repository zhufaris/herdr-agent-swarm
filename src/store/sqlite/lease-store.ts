import type { InstanceLease } from "../../domain/types.js";
import { mapInstanceLease } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

const FENCED_TABLES = [
  "bindings", "binding_thread_aliases", "agent_instances", "worker_session_threads", "workspace_leases", "instance_removal_plans", "instance_turns", "worker_turn_cards", "worker_turn_card_pages", "worker_main_views", "card_context_invalidations", "instance_operations", "instance_events", "primary_tool_capabilities", "worker_card_display_requests", "approval_requests", "approval_grants", "conversation_targets", "inbound_messages", "bridge_messages", "prompt_jobs", "outbound_replies",
  "outbox_lane_heads", "outbox_lane_quarantines", "delivery_recoveries", "answer_delivery_coverage", "answer_recovery_links", "answer_recovery_candidates",
  "project_selections", "card_interactions", "session_operations", "swarm_command_intents", "pane_close_requests", "worker_pane_close_steps", "pane_control_operations", "turn_control_operations", "retired_pane_cleanup_operations", "binding_model_preferences", "audit_log", "lifecycle_events", "topic_views", "run_cards", "answer_pages"
] as const;

export class SqliteLeaseStore {
  constructor(private readonly context: SqliteContext) {}

  activateWriteFence(ownerId: string, fencingToken: number): void {
    this.deactivateWriteFence();
    this.context.database.exec("CREATE TEMP TABLE bridge_write_fence(owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL)");
    this.context.database.prepare("INSERT INTO temp.bridge_write_fence(owner_id, fencing_token) VALUES (?, ?)").run(ownerId, fencingToken);
    for (const table of FENCED_TABLES) for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const trigger = `bridge_fence_${table}_${operation.toLowerCase()}`;
      this.context.database.exec(`
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
    try {
      this.assertWriteFence();
      this.context.transaction(() => {
        const claims = this.context.database.prepare("SELECT id, lane_key FROM outbound_replies WHERE claim_attempt_id IS NOT NULL AND (claimed_fence IS NOT ? OR claimed_owner_id IS NOT ?)").all(fencingToken, ownerId) as Array<{ id: string; lane_key: string }>;
        for (const claim of claims) {
          this.context.database.prepare("UPDATE outbound_replies SET state = 'dead_letter', claim_attempt_id = NULL, claimed_fence = NULL, claimed_at = NULL, failure_class = 'unknown', effect_certainty = 'uncertain', error = 'Delivery outcome uncertain after owner loss; inspect before manual retry', dead_lettered_at = ?, updated_at = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), claim.id);
          this.context.database.prepare("INSERT INTO outbox_lane_quarantines(lane_key, failed_reply_id, lane_class, failure_class, state, action, reason, created_at, updated_at) VALUES (?, ?, 'immutable', 'unknown', 'active', 'blocked', 'Delivery outcome uncertain after owner loss', ?, ?) ON CONFLICT(lane_key) DO UPDATE SET failed_reply_id = excluded.failed_reply_id, lane_class = excluded.lane_class, failure_class = excluded.failure_class, state = 'active', action = 'blocked', reason = excluded.reason, updated_at = excluded.updated_at, released_at = NULL").run(claim.lane_key, claim.id, new Date().toISOString(), new Date().toISOString());
          this.context.database.prepare("DELETE FROM outbox_lane_heads WHERE lane_key = ?").run(claim.lane_key);
        }
      });
    } catch (error) {
      this.deactivateWriteFence();
      throw error;
    }
  }

  deactivateWriteFence(): void {
    for (const table of FENCED_TABLES) for (const operation of ["insert", "update", "delete"] as const) {
      this.context.database.exec(`DROP TRIGGER IF EXISTS temp.bridge_fence_${table}_${operation}`);
    }
    this.context.database.exec("DROP TABLE IF EXISTS temp.bridge_write_fence");
  }

  acquireInstanceLease(ownerId: string, currentTime: string, expiresAt: string): InstanceLease | null {
    return this.context.transaction(() => {
      const row = this.context.database.prepare("SELECT owner_id, fencing_token, expires_at, updated_at FROM instance_lease WHERE singleton_id = 1").get() as { owner_id: string; fencing_token: number; expires_at: string; updated_at: string } | undefined;
      if (!row) {
        this.context.database.prepare("INSERT INTO instance_lease(singleton_id, owner_id, fencing_token, expires_at, updated_at) VALUES (1, ?, 1, ?, ?)").run(ownerId, expiresAt, currentTime);
      } else if (row.owner_id === ownerId) {
        this.context.database.prepare("UPDATE instance_lease SET expires_at = ?, updated_at = ? WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ?").run(expiresAt, currentTime, ownerId, row.fencing_token);
      } else if (row.expires_at <= currentTime) {
        this.context.database.prepare("UPDATE instance_lease SET owner_id = ?, fencing_token = fencing_token + 1, expires_at = ?, updated_at = ? WHERE singleton_id = 1 AND fencing_token = ? AND expires_at <= ?").run(ownerId, expiresAt, currentTime, row.fencing_token, currentTime);
      } else {
        return null;
      }
      const acquired = this.context.database.prepare("SELECT owner_id, fencing_token, expires_at, updated_at FROM instance_lease WHERE singleton_id = 1 AND owner_id = ?").get(ownerId) as { owner_id: string; fencing_token: number; expires_at: string; updated_at: string } | undefined;
      return acquired ? mapInstanceLease(acquired) : null;
    });
  }

  renewInstanceLease(ownerId: string, fencingToken: number, currentTime: string, expiresAt: string): InstanceLease | null {
    const result = this.context.database.prepare("UPDATE instance_lease SET expires_at = ?, updated_at = ? WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ? AND expires_at > ?")
      .run(expiresAt, currentTime, ownerId, fencingToken, currentTime);
    if (result.changes !== 1) return null;
    const row = this.context.database.prepare("SELECT owner_id, fencing_token, expires_at, updated_at FROM instance_lease WHERE singleton_id = 1").get() as { owner_id: string; fencing_token: number; expires_at: string; updated_at: string };
    return mapInstanceLease(row);
  }

  releaseInstanceLease(ownerId: string, fencingToken: number): boolean {
    return this.context.database.prepare("DELETE FROM instance_lease WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ?").run(ownerId, fencingToken).changes === 1;
  }

  private assertWriteFence(): void {
    const valid = this.context.database.prepare(`
      SELECT 1 FROM main.instance_lease AS lease, temp.bridge_write_fence AS fence
      WHERE lease.singleton_id = 1 AND lease.owner_id = fence.owner_id
        AND lease.fencing_token = fence.fencing_token
        AND julianday(lease.expires_at) > julianday('now')
    `).get();
    if (!valid) throw new Error("stale_instance_lease");
  }
}
