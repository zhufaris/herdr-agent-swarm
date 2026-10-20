import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectPreparedDeliveryProducers } from "../src/composition/create-outbound-runtime.js";
import type { GatewayDeliveryIntent } from "../src/gateways/contract/plugin.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";

let temporaryDirectory: string | undefined;
let graph: SqliteCapabilityGraph | undefined;

afterEach(() => {
  graph?.context.close();
  graph = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function databasePath(): string {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "delivery-contraction-"));
  return join(temporaryDirectory, "bridge.db");
}

function connectPreparation(target: SqliteCapabilityGraph): void {
  connectPreparedDeliveryProducers(target.capabilityModules().outbox, target, {
    prepare: (intent: GatewayDeliveryIntent) => ({
      protocolVersion: 1,
      gatewayId: "feishu:primary",
      profileId: "feishu-cardkit-v1",
      rendererRevision: 1,
      operation: intent.kind,
      intent
    })
  }, { enqueuePreparedDelivery() {} });
}

function restoreVersion108Compatibility(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("DROP TRIGGER IF EXISTS outbound_replies_immutable_claim");
  database.exec("DROP TRIGGER IF EXISTS outbound_replies_valid_delivery_scope_insert; DROP TRIGGER IF EXISTS outbound_replies_valid_delivery_scope_update");
  const columns = new Set((database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
  if (!columns.has("scheduler_owner")) {
    database.exec("ALTER TABLE outbound_replies ADD COLUMN scheduler_owner TEXT NOT NULL DEFAULT 'ring' CHECK(scheduler_owner IN ('legacy','ring'))");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS delivery_scheduler_control(
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
      mode TEXT NOT NULL CHECK(mode IN ('ring','legacy')),
      updated_at TEXT NOT NULL
    );
    INSERT OR REPLACE INTO delivery_scheduler_control(singleton_id,mode,updated_at)
      VALUES(1,'ring','2026-10-06T00:00:00.000Z');
    CREATE TABLE IF NOT EXISTS outbox_lane_heads(
      lane_key TEXT PRIMARY KEY,
      reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE CASCADE,
      delivery_order INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outbox_lane_heads_delivery_order ON outbox_lane_heads(delivery_order);
    CREATE TRIGGER IF NOT EXISTS outbox_lane_heads_after_insert AFTER INSERT ON outbound_replies BEGIN SELECT 1; END;
    DROP TABLE IF EXISTS schema_metadata;
    DELETE FROM schema_migrations WHERE version=109 OR version>=112;
  `);
  return database;
}

function createTwoScopedDeliveries(path: string): { pendingId: string; historyId: string } {
  graph = new SqliteCapabilityGraph(path);
  connectPreparation(graph);
  expect(graph.outbox.reserveShortcutPanel("chat-pending", { schema: "2.0" })).toBe("reserved");
  expect(graph.outbox.reserveShortcutPanel("chat-history", { schema: "2.0" })).toBe("reserved");
  const replies = graph.outbox.listPendingOutboundReplies().sort((a, b) => a.deliveryOrder - b.deliveryOrder);
  expect(replies).toHaveLength(2);
  const [pending, history] = replies;
  graph.context.database.prepare(`UPDATE outbound_replies SET
    gateway_checkpoint_json='{"kind":"surface","gatewayId":"feishu:primary","opaqueId":"checkpoint"}',
    card_id_checkpoint='checkpoint'
    WHERE id=?`).run(pending.id);
  graph.context.database.prepare(`UPDATE outbound_replies SET
    state='dead_letter',failure_class='permanent',effect_certainty='rejected',error='rejected',
    dead_lettered_at='2026-10-06T00:00:02.000Z',updated_at='2026-10-06T00:00:02.000Z'
    WHERE id=?`).run(history.id);
  graph.context.database.prepare(`INSERT OR REPLACE INTO outbox_lane_quarantines(
    lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at,released_at
  ) VALUES(?,?,'immutable','permanent','active','blocked','rejected','2026-10-06T00:00:02.000Z','2026-10-06T00:00:02.000Z',NULL)`).run(history.laneKey, history.id);
  graph.context.close();
  graph = undefined;
  return { pendingId: pending.id, historyId: history.id };
}

describe("T9 delivery scheduler contraction", () => {
  it("refuses to stamp v109 when a scheduler-less database still has actionable unscoped work", () => {
    const path = databasePath();
    graph = new SqliteCapabilityGraph(path);
    connectPreparation(graph);
    expect(graph.outbox.reserveShortcutPanel("chat-unscoped", { schema: "2.0" })).toBe("reserved");
    const replyId = graph.outbox.listPendingOutboundReplies()[0]!.id;
    graph.context.close();
    graph = undefined;

    const malformed = new DatabaseSync(path);
    malformed.exec(`
      DROP TRIGGER outbound_replies_immutable_claim;
      DROP TRIGGER outbound_replies_valid_delivery_scope_insert;
      DROP TRIGGER outbound_replies_valid_delivery_scope_update;
      DROP TABLE IF EXISTS schema_metadata;
      DELETE FROM schema_migrations WHERE version>=112;
      DELETE FROM schema_migrations WHERE version=109;
    `);
    malformed.prepare(`UPDATE outbound_replies SET
      scope_kind=NULL,scope_key=NULL,scope_workspace_id=NULL,scope_pane_id=NULL,
      delivery_owner_kind=NULL,delivery_owner_id=NULL,delivery_owner_generation=NULL,
      delivery_owner_session_generation=NULL,delivery_parent_id=NULL,
      delivery_parent_generation=NULL,delivery_parent_session_generation=NULL
      WHERE id=?`).run(replyId);
    malformed.close();

    expect(() => new SqliteCapabilityGraph(path)).toThrow(/delivery_contraction_blocked.*unscoped=1/i);
  });

  it("rejects a Global Ring row carrying a Pane owner fence", () => {
    graph = new SqliteCapabilityGraph(":memory:");
    connectPreparation(graph);
    expect(graph.outbox.reserveShortcutPanel("chat-global-owner", { schema: "2.0" })).toBe("reserved");
    const replyId = graph.outbox.listPendingOutboundReplies()[0]!.id;
    graph.context.database.exec("DROP TRIGGER outbound_replies_immutable_claim");

    expect(() => graph!.context.database.prepare(`UPDATE outbound_replies SET
      delivery_owner_kind='primary',delivery_owner_id='binding-1',
      delivery_owner_generation=1,delivery_owner_session_generation=1
      WHERE id=?`).run(replyId)).toThrow(/invalid_delivery_scope/i);
  });

  it("refuses to contract while actionable legacy or unscoped delivery work remains", () => {
    const path = databasePath();
    const { pendingId } = createTwoScopedDeliveries(path);
    const database = restoreVersion108Compatibility(path);
    database.prepare("UPDATE outbound_replies SET scheduler_owner='legacy',scope_kind=NULL,scope_key=NULL WHERE id=?").run(pendingId);
    database.close();

    expect(() => new SqliteCapabilityGraph(path)).toThrow(/delivery_contraction_blocked.*legacy.*unscoped/i);

    const preserved = new DatabaseSync(path);
    expect(preserved.prepare("SELECT version FROM schema_migrations WHERE version=109").get()).toBeUndefined();
    expect(preserved.prepare("SELECT scheduler_owner,scope_key FROM outbound_replies WHERE id=?").get(pendingId)).toEqual({ scheduler_owner: "legacy", scope_key: null });
    preserved.close();
  });

  it.each([
    {
      debt: "unresolved dead letter",
      settle: (database: DatabaseSync, historyId: string) => {
        database.prepare(`UPDATE outbox_lane_quarantines SET
          state='released',action='manual_dismiss',released_at='2026-10-06T00:00:03.000Z',updated_at='2026-10-06T00:00:03.000Z'
          WHERE failed_reply_id=?`).run(historyId);
      }
    },
    {
      debt: "quarantined dead letter",
      settle: (database: DatabaseSync, historyId: string) => {
        database.prepare(`UPDATE delivery_recoveries SET
          state='dismissed',action='manual_dismiss',resolved_at='2026-10-06T00:00:03.000Z',updated_at='2026-10-06T00:00:03.000Z'
          WHERE failed_reply_id=?`).run(historyId);
      }
    }
  ])("refuses to contract with an actionable $debt", ({ settle }) => {
    const path = databasePath();
    const { historyId } = createTwoScopedDeliveries(path);
    const database = restoreVersion108Compatibility(path);
    settle(database, historyId);
    database.prepare("UPDATE outbound_replies SET scheduler_owner='legacy',scope_kind=NULL,scope_key=NULL WHERE id=?").run(historyId);
    database.close();

    expect(() => new SqliteCapabilityGraph(path)).toThrow(/delivery_contraction_blocked.*legacy=1.*unscoped=1/i);

    const preserved = new DatabaseSync(path);
    expect(preserved.prepare("SELECT version FROM schema_migrations WHERE version=109").get()).toBeUndefined();
    expect(preserved.prepare("SELECT scheduler_owner,scope_key,state FROM outbound_replies WHERE id=?").get(historyId)).toEqual({
      scheduler_owner: "legacy",
      scope_key: null,
      state: "dead_letter"
    });
    preserved.close();
  });

  it("reopens a ring-only database without lane schema while preserving delivery and recovery evidence", () => {
    const path = databasePath();
    const { pendingId, historyId } = createTwoScopedDeliveries(path);
    const before = new DatabaseSync(path);
    before.prepare(`UPDATE delivery_recoveries SET
      state='dismissed',action='manual_dismiss',resolved_at='2026-10-06T00:00:03.000Z',updated_at='2026-10-06T00:00:03.000Z'
      WHERE failed_reply_id=?`).run(historyId);
    before.prepare(`UPDATE outbox_lane_quarantines SET
      state='released',action='manual_dismiss',released_at='2026-10-06T00:00:03.000Z',updated_at='2026-10-06T00:00:03.000Z'
      WHERE failed_reply_id=?`).run(historyId);
    const expectedPending = before.prepare(`SELECT id,idempotency_key,delivery_order,scope_kind,scope_key,gateway_plan_json,
      gateway_plan_hash,gateway_checkpoint_json,card_id_checkpoint FROM outbound_replies WHERE id=?`).get(pendingId);
    const expectedRecovery = before.prepare("SELECT * FROM delivery_recoveries WHERE failed_reply_id=?").get(historyId);
    const expectedQuarantine = before.prepare("SELECT * FROM outbox_lane_quarantines WHERE failed_reply_id=?").get(historyId);
    before.close();
    const compatibility = restoreVersion108Compatibility(path);
    compatibility.prepare("UPDATE outbound_replies SET scheduler_owner='ring' WHERE scope_key IS NOT NULL").run();
    compatibility.close();

    graph = new SqliteCapabilityGraph(path);

    expect(graph.context.database.prepare("SELECT version FROM schema_migrations WHERE version=109").get()).toEqual({ version: 109 });
    expect(graph.context.database.prepare("SELECT name FROM sqlite_master WHERE name IN ('delivery_scheduler_control','outbox_lane_heads','outbox_lane_heads_after_insert','outbox_lane_heads_delivery_order') ORDER BY name").all()).toEqual([]);
    expect((graph.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toContain("scheduler_owner");
    expect(graph.context.database.prepare(`SELECT id,idempotency_key,delivery_order,scope_kind,scope_key,gateway_plan_json,
      gateway_plan_hash,gateway_checkpoint_json,card_id_checkpoint FROM outbound_replies WHERE id=?`).get(pendingId)).toEqual(expectedPending);
    expect(graph.context.database.prepare("SELECT * FROM delivery_recoveries WHERE failed_reply_id=?").get(historyId)).toEqual(expectedRecovery);
    expect(graph.context.database.prepare("SELECT * FROM outbox_lane_quarantines WHERE failed_reply_id=?").get(historyId)).toEqual(expectedQuarantine);
    expect(graph.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 20, at: "2099-01-01T00:00:00.000Z" }).items).toEqual([
      expect.objectContaining({ replyId: pendingId, scopeKey: '["global"]' })
    ]);
    graph.context.close();
    graph = new SqliteCapabilityGraph(path);
    expect(graph.context.database.prepare("SELECT name FROM sqlite_master WHERE name IN ('delivery_scheduler_control','outbox_lane_heads')").all()).toEqual([]);
    expect((graph.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toContain("scheduler_owner");
    const immutableClaim = graph.context.database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='outbound_replies_immutable_claim'").get() as { sql: string };
    graph.context.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    graph.context.database.prepare("UPDATE outbound_replies SET lane_key='legacy-reopen-probe' WHERE id=?").run(pendingId);
    graph.context.database.exec(immutableClaim.sql);
    graph.context.close();
    graph = new SqliteCapabilityGraph(path);
    expect(graph.context.database.prepare("SELECT lane_key FROM outbound_replies WHERE id=?").get(pendingId)).toEqual({ lane_key: "legacy-reopen-probe" });
    expect(graph.context.database.prepare("SELECT name FROM sqlite_master WHERE name IN ('delivery_scheduler_control','outbox_lane_heads')").all()).toEqual([]);
  });

  it("keeps production source free of the retired lane scheduler and rollback surface", () => {
    const root = new URL("..", import.meta.url);
    for (const relative of [
      "src/events/outbound-lane-drain.ts",
      "src/events/gateway-outbox-dispatcher.ts",
      "src/events/lark-outbox-dispatcher.ts"
    ]) expect(existsSync(new URL(relative, root))).toBe(false);

    const sourceFiles = [
      "src/composition/create-outbound-runtime.ts",
      "src/composition/create-bridge-runtime.ts",
      "src/composition/managed-bridge-runtime.ts",
      "src/domain/ports/outbox.ts",
      "src/domain/ports/prepared-delivery.ts",
      "src/cli/service-lifecycle.ts",
      "package.json",
      "scripts/swarm-service.sh"
    ];
    const source = sourceFiles.map((file) => readFileSync(new URL(file, root), "utf8")).join("\n");
    for (const retired of [
      "OutboundLaneDrain",
      "GatewayOutboxDispatcher",
      "OutboundScanStore",
      "DeliverySchedulerMode",
      "rollback-delivery-rings"
    ]) expect(source).not.toContain(retired);
  });
});
