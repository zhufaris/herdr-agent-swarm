import { afterEach, describe, expect, it, vi } from "vitest";
import { connectPreparedDeliveryProducers } from "../src/composition/create-outbound-runtime.js";
import type { GatewayDeliveryIntent } from "../src/gateways/contract/plugin.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";

let graph: SqliteCapabilityGraph | undefined;
afterEach(() => { graph?.context.close(); graph = undefined; });

function fixture() {
  graph = new SqliteCapabilityGraph(":memory:");
  const handedOff = vi.fn();
  connectPreparedDeliveryProducers(graph.capabilityModules().outbox, graph, {
    prepare: (intent: GatewayDeliveryIntent) => ({ protocolVersion: 1, gatewayId: "feishu:primary", profileId: "feishu-cardkit-v1", rendererRevision: 1, operation: intent.kind, intent })
  }, { enqueuePreparedDelivery: handedOff });
  return { graph, handedOff };
}

describe("T8 Global Ring cutover", () => {
  it("routes an explicit non-Pane producer to the Global Ring", async () => {
    const target = fixture();
    expect(target.graph.outbox.reserveShortcutPanel("chat", { schema: "2.0" })).toBe("reserved");
    await Promise.resolve();
    const reply = target.graph.outbox.listPendingOutboundReplies()[0]!;
    expect(reply).toMatchObject({ kind: "group_card_create", deliveryScope: { kind: "global" }, deliveryOwnerFence: null });
    expect(reply.gatewayPlanHash).not.toBeNull();
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply.id, scope: { kind: "global" } }));
  });

  it("fails closed when a Pane delivery has incomplete ownership evidence", () => {
    const target = fixture();
    target.graph.bindings.createPendingBinding({ id: "incomplete-primary", projectId: "project", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Incomplete Primary" });
    expect(() => target.graph.outbox.reservePreparedOutboundReply({
      id: "incomplete-pane-delivery", idempotencyKey: "incomplete-pane-delivery",
      bindingId: "incomplete-primary", bindingGeneration: 1, rootMessageId: "root",
      kind: "card_reply", payload: '{"schema":"2.0"}'
    })).toThrow("invalid_delivery_scope");
    expect(target.handedOff).not.toHaveBeenCalled();
  });
});
