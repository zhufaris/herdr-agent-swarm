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
}
