import type { SqliteContext } from "../context.js";

const LEGACY_GATEWAY_ID = "feishu:primary";
const LEGACY_PROFILE_ID = "feishu-cardkit-v1";

export class GatewayMigrations {
  constructor(private readonly context: SqliteContext) {}

  ensureGatewayIdentityAndPlans(): void {
    const add = (table: string, column: string, definition: string) => {
      const names = new Set((this.context.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));
      if (!names.has(column)) this.context.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    add("bindings", "gateway_id", `TEXT NOT NULL DEFAULT '${LEGACY_GATEWAY_ID}'`);
    add("inbound_messages", "gateway_id", `TEXT NOT NULL DEFAULT '${LEGACY_GATEWAY_ID}'`);
    add("outbound_replies", "gateway_id", `TEXT NOT NULL DEFAULT '${LEGACY_GATEWAY_ID}'`);
    add("outbound_replies", "gateway_profile_id", `TEXT NOT NULL DEFAULT '${LEGACY_PROFILE_ID}'`);
    add("outbound_replies", "gateway_plan_json", "TEXT");
    add("outbound_replies", "gateway_plan_hash", "TEXT");
    add("outbound_replies", "gateway_checkpoint_json", "TEXT");
    this.context.database.exec("CREATE INDEX IF NOT EXISTS bindings_gateway_route ON bindings(gateway_id, chat_id, topic_id); CREATE INDEX IF NOT EXISTS inbound_messages_gateway_event ON inbound_messages(gateway_id, event_id); CREATE INDEX IF NOT EXISTS outbound_replies_gateway_state ON outbound_replies(gateway_id, state, delivery_order);");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (39)").run();
  }

  ensureGatewayScopedOutboxLanes(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 40").get();
    const unscoped = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE lane_key NOT LIKE 'gateway:%' LIMIT 1").get();
    if (!migrated || unscoped) {
      this.context.database.exec("BEGIN IMMEDIATE");
      try {
        this.context.database.exec(`
          DROP TRIGGER IF EXISTS outbound_replies_immutable_claim;
          UPDATE outbox_lane_quarantines
          SET lane_key = 'gateway:' || (SELECT gateway_id FROM outbound_replies WHERE id = failed_reply_id) || ':' || lane_key,
              updated_at = datetime('now')
          WHERE lane_key NOT LIKE 'gateway:%';
          UPDATE outbound_replies
          SET lane_key = 'gateway:' || gateway_id || ':' || lane_key
          WHERE lane_key NOT LIKE 'gateway:%';
          DELETE FROM outbox_lane_heads;
          INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
            SELECT pending.lane_key, pending.id, pending.delivery_order, pending.next_attempt_at, pending.created_at
            FROM outbound_replies pending
            WHERE pending.state = 'pending'
              AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = pending.lane_key AND q.state = 'active')
              AND pending.delivery_order = (
                SELECT MIN(candidate.delivery_order) FROM outbound_replies candidate
                WHERE candidate.state = 'pending' AND candidate.lane_key = pending.lane_key
              );
          INSERT OR IGNORE INTO schema_migrations(version) VALUES (40);
        `);
        this.context.database.exec("COMMIT");
      } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
    }
    this.context.database.exec("DROP TRIGGER IF EXISTS outbound_replies_gateway_lane_insert; DROP TRIGGER IF EXISTS outbound_replies_gateway_lane_update");
  }
}
