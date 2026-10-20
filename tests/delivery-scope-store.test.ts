import { afterEach, describe, expect, it } from "vitest";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

let store: SqliteBindingStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe("durable Delivery Scope", () => {
  it("persists an exact Primary Pane scope", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({
      id: "binding",
      workspaceId: "workspace",
      chatId: "chat",
      topicId: "topic",
      rootMessageId: "root",
      title: "Task"
    });
    store.updateBinding("binding", {
      state: "active",
      lifecycle: "active",
      attachment: "attached",
      paneId: "pane"
    });

    const reply = store.enqueueOutboundReply({
      id: "reply",
      idempotencyKey: "reply",
      bindingId: "binding",
      bindingGeneration: 1,
      rootMessageId: "root",
      kind: "card_update",
      payload: "{}"
    });

    expect(reply.deliveryScope).toEqual({
      kind: "pane",
      workspaceId: "workspace",
      paneId: "pane"
    });
    expect(reply.deliveryOwnerFence).toEqual({ kind: "primary", id: "binding", generation: 1, sessionGeneration: 1 });
    expect(store.database.prepare(`
      SELECT scope_kind, scope_key, delivery_owner_kind, delivery_owner_id, delivery_owner_generation,
        delivery_owner_session_generation, delivery_parent_id
      FROM outbound_replies WHERE id = 'reply'
    `).get()).toEqual({
      scope_kind: "pane",
      scope_key: '["pane","workspace","pane"]',
      delivery_owner_kind: "primary",
      delivery_owner_id: "binding",
      delivery_owner_generation: 1,
      delivery_owner_session_generation: 1,
      delivery_parent_id: null
    });
  });

  it("persists an exact Worker Pane scope and leaves stale Worker evidence unscoped", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane" });
    const created = store.createWorkerAgentInstance({
      id: "worker", projectId: "project", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "workspace", paneId: "worker-pane", nativeSessionId: "worker-session" })!;

    const exact = store.enqueueOutboundReply({
      id: "worker-exact", idempotencyKey: "worker-exact", bindingId: "binding", workerId: worker.id,
      workerSessionGeneration: worker.workerSessionGeneration, rootMessageId: "worker-root", kind: "card_update", payload: "{}"
    });
    expect(() => store!.enqueueOutboundReply({
      id: "worker-stale", idempotencyKey: "worker-stale", bindingId: "binding", workerId: worker.id,
      workerSessionGeneration: worker.workerSessionGeneration + 1, rootMessageId: "worker-root", kind: "card_update", payload: "{}"
    })).toThrow("invalid_delivery_scope");

    expect(exact.deliveryScope).toEqual({
      kind: "pane",
      workspaceId: "workspace",
      paneId: "worker-pane"
    });
    expect(exact.deliveryOwnerFence).toEqual({ kind: "worker", id: "worker", generation: worker.generation, sessionGeneration: 1, parent: { id: "binding", generation: 1, sessionGeneration: 1 } });
  });

  it("rejects malformed scope shapes and mutation after the effect is frozen", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    store.enqueueOutboundReply({ id: "reply", idempotencyKey: "reply", bindingId: "binding", bindingGeneration: 1, rootMessageId: "root", kind: "card_update", payload: "{}" });

    expect(() => store!.database.prepare("UPDATE outbound_replies SET delivery_owner_kind = 'worker' WHERE id = 'reply'").run()).toThrow("invalid_delivery_scope");
    expect(() => store!.database.prepare("UPDATE outbound_replies SET scope_key = 'wrong' WHERE id = 'reply'").run()).toThrow("invalid_delivery_scope");
    store.prepareOutboundGatewayPlan("reply", { gatewayId: "feishu:primary", gatewayProfileId: "feishu-cardkit-v1", gatewayPlanJson: '{"operation":"surface.replace"}' });
    expect(() => store!.database.prepare(`UPDATE outbound_replies SET
      scope_kind = 'global', scope_key = '["global"]', delivery_owner_kind = NULL,
      scope_workspace_id = NULL, scope_pane_id = NULL, delivery_owner_id = NULL,
      delivery_owner_generation = NULL, delivery_owner_session_generation = NULL,
      delivery_parent_id = NULL, delivery_parent_generation = NULL, delivery_parent_session_generation = NULL
      WHERE id = 'reply'`).run()).toThrow("immutable_outbound_revision");
  });

});
