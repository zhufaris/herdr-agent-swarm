import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedDelivery } from "../src/domain/delivery.js";
import { SqliteBindingLifecycleStore } from "../src/store/sqlite/binding-store.js";
import { SqliteBindingThreadAliasStore } from "../src/store/sqlite/binding-thread-alias-store.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteMigrations } from "../src/store/sqlite/migrations.js";
import { SqliteOutboxStore } from "../src/store/sqlite/outbox-store.js";

let context: SqliteContext | undefined;

afterEach(() => {
  context?.close();
  context = undefined;
});

function activePrimary() {
  context = new SqliteContext(":memory:");
  new SqliteMigrations(context).run();
  const bindings = new SqliteBindingLifecycleStore(context);
  bindings.createPendingBinding({
    id: "binding-1",
    workspaceId: "workspace-1",
    chatId: "chat-1",
    topicId: "canonical-topic",
    rootMessageId: "canonical-root",
    title: "Primary"
  });
  bindings.updateBinding("binding-1", {
    generation: 7,
    paneId: "workspace-1:pane-1",
    statusMessageId: "canonical-main",
    state: "active",
    lifecycle: "active",
    attachment: "attached"
  });
  return { aliases: new SqliteBindingThreadAliasStore(context), bindings };
}

function realOutbox(aliases: SqliteBindingThreadAliasStore, bindings: SqliteBindingLifecycleStore): SqliteOutboxStore {
  const outbox = new SqliteOutboxStore(context!, {
    getBinding: (id) => bindings.getBinding(id),
    getAgentInstance: () => null,
    loadRunCard: () => null,
    getActiveAnswerPage: () => null,
    loadWorkerTurnCard: () => null,
    listWorkerTurnCardPages: () => [],
    loadWorkerMainView: () => null,
    saveRunCard: () => { throw new Error("unused"); },
    persistBindingPatch: () => { throw new Error("unused"); },
    invalidateCardContexts: () => [],
    reconcileExpiredMessageDeletion: () => false
  }, aliases);
  outbox.setGatewayPlanPreparer((reply) => ({
    protocolVersion: 1,
    gatewayId: reply.gatewayId,
    profileId: reply.gatewayProfileId,
    rendererRevision: 1,
    operation: "conversation.create",
    intent: {
      kind: "conversation.create",
      purpose: "operation-result",
      conversationId: reply.targetChatId!,
      view: { schemaVersion: 1, nodes: [] },
      idempotencyKey: reply.idempotencyKey
    }
  }));
  return outbox;
}

describe("Primary Pane thread prepared reservation", () => {
  it("freezes the exact alias identity and recovery metadata before handing off after commit", async () => {
    const { aliases, bindings } = activePrimary();
    const outbox = realOutbox(aliases, bindings);
    const enqueuePreparedDelivery = vi.fn();
    aliases.setPreparedDeliveryReservation(outbox, { enqueuePreparedDelivery });

    expect(aliases.reserve({
      publicationKey: "primary-thread:binding-1:7",
      actionMessageId: "pane-directory-card",
      bindingId: "binding-1",
      bindingGeneration: 7,
      paneId: "workspace-1:pane-1",
      sourceMainMessageId: "canonical-main",
      targetChatId: "chat-1",
      viewVersion: 11,
      card: { schema: "2.0", body: "frozen" },
      recovery: { kind: "primary-answer", promptId: "prompt-1", pageIndex: 3 }
    })).toBe("reserved");

    const alias = context!.database.prepare(`SELECT id,publication_key,binding_id,binding_generation,chat_id,pane_id,
      source_main_message_id,action_message_id,state FROM binding_thread_aliases`).get() as Record<string, unknown>;
    const reply = context!.database.prepare(`SELECT id,idempotency_key,binding_id,thread_alias_id,target_chat_id,
      prompt_id,stream_page_index,view_version,root_message_id,kind,payload,gateway_plan_json,gateway_plan_hash,
      scope_kind,scope_key,scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,
      delivery_owner_generation,delivery_owner_session_generation FROM outbound_replies`).get() as Record<string, unknown>;
    expect(reply).toMatchObject({
      idempotency_key: "primary-thread:binding-1:7",
      binding_id: "binding-1",
      thread_alias_id: alias.id,
      target_chat_id: "chat-1",
      prompt_id: "prompt-1",
      stream_page_index: 3,
      view_version: 11,
      root_message_id: null,
      kind: "group_card_create",
      payload: JSON.stringify({ schema: "2.0", body: "frozen" }),
      gateway_plan_json: expect.any(String),
      gateway_plan_hash: expect.any(String),
      scope_kind: "pane",
      scope_key: JSON.stringify(["pane", "workspace-1", "workspace-1:pane-1"]),
      scope_workspace_id: "workspace-1",
      scope_pane_id: "workspace-1:pane-1",
      delivery_owner_kind: "primary",
      delivery_owner_id: "binding-1",
      delivery_owner_generation: 7,
      delivery_owner_session_generation: 1
    });
    expect(alias).toEqual({
      id: alias.id,
      publication_key: "primary-thread:binding-1:7",
      binding_id: "binding-1",
      binding_generation: 7,
      chat_id: "chat-1",
      pane_id: "workspace-1:pane-1",
      source_main_message_id: "canonical-main",
      action_message_id: "pane-directory-card",
      state: "reserving"
    });
    expect(enqueuePreparedDelivery).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(enqueuePreparedDelivery).toHaveBeenCalledOnce();
    const delivery = enqueuePreparedDelivery.mock.calls[0]![0] as PreparedDelivery;
    expect(delivery).toMatchObject({
      replyId: reply.id,
      scope: { kind: "pane", workspaceId: "workspace-1", paneId: "workspace-1:pane-1" },
      ownerFence: { kind: "primary", id: "binding-1", generation: 7, sessionGeneration: 1 },
      idempotencyKey: "primary-thread:binding-1:7"
    });
  });

  it("rolls back the alias and suppresses handoff when the enclosing transaction fails", async () => {
    const { aliases, bindings } = activePrimary();
    const outbox = realOutbox(aliases, bindings);
    const enqueuePreparedDelivery = vi.fn();
    aliases.setPreparedDeliveryReservation(outbox, { enqueuePreparedDelivery });

    expect(() => context!.transaction(() => {
      expect(aliases.reserve({
        publicationKey: "primary-thread:rollback",
        actionMessageId: "pane-directory-card",
        bindingId: "binding-1",
        bindingGeneration: 7,
        paneId: "workspace-1:pane-1",
        sourceMainMessageId: "canonical-main",
        targetChatId: "chat-1",
        card: { schema: "2.0" }
      })).toBe("reserved");
      throw new Error("forced rollback");
    })).toThrow("forced rollback");

    await Promise.resolve();
    expect(context!.database.prepare("SELECT COUNT(*) AS count FROM binding_thread_aliases").get()).toEqual({ count: 0 });
    expect(context!.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    expect(enqueuePreparedDelivery).not.toHaveBeenCalled();
  });

  it.each([
    ["pane", { paneId: "workspace-1:stale-pane", sourceMainMessageId: "canonical-main" }],
    ["source Main", { paneId: "workspace-1:pane-1", sourceMainMessageId: "stale-main" }]
  ])("rejects a stale %s identity before reserving delivery", (_label, identity) => {
    const { aliases, bindings } = activePrimary();
    const outbox = realOutbox(aliases, bindings);
    const enqueuePreparedDelivery = vi.fn();
    aliases.setPreparedDeliveryReservation(outbox, { enqueuePreparedDelivery });

    expect(aliases.reserve({
      publicationKey: `stale:${_label}`,
      actionMessageId: "pane-directory-card",
      bindingId: "binding-1",
      bindingGeneration: 7,
      paneId: identity.paneId,
      sourceMainMessageId: identity.sourceMainMessageId,
      targetChatId: "chat-1",
      card: { schema: "2.0" }
    })).toBe("stale");
    expect(context!.database.prepare("SELECT COUNT(*) AS count FROM binding_thread_aliases").get()).toEqual({ count: 0 });
    expect(context!.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    expect(enqueuePreparedDelivery).not.toHaveBeenCalled();
  });

});
