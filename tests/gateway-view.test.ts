import { describe, expect, it } from "vitest";
import { renderInstanceCreateCard } from "../src/cards/instance-control-card.js";
import { renderModelSelectionCard } from "../src/cards/model-card.js";
import { renderProjectEntryCard, renderRequestAnswerCard } from "../src/cards/run-card.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { cardKitToGatewayView, materializeFeishuView } from "../src/gateways/feishu/cardkit-view.js";
import { feishuGatewayApplicationPresentation } from "../src/gateways/feishu/presentation.js";
import { createFeishuCompatibilityDelivery } from "../src/gateways/feishu/plugin.js";
import { OutboundDeliveryExecutor } from "../src/events/outbound-delivery-executor.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import pino from "pino";
import { vi } from "vitest";
import { createInMemoryGatewayPlugin, type InMemoryGatewayControl } from "./helpers/in-memory-gateway-plugin.js";

describe("GatewayView", () => {
  it.each([
    ["form", () => renderInstanceCreateCard({ projectId: "project", requestedBy: "user" })],
    ["select", () => renderModelSelectionCard({ bindingId: "binding", spaceName: "space", paneId: "pane", models: [{ name: "model", displayName: "Model" }], preference: null })],
    ["main", () => renderProjectEntryCard({ ...initialTopicView("binding"), title: "Gateway main" })],
    ["stream", () => renderRequestAnswerCard(createQueuedRunCard({ promptId: "prompt", bindingId: "binding", title: "Answer", workspaceId: "workspace", paneId: "pane", requestText: "question", queuePosition: 1, occurredAt: "now" }))]
  ])("round-trips the %s CardKit surface through the portable AST", (_name, render) => {
    const card = render();
    const view = cardKitToGatewayView(card);
    expect(view).toMatchObject({ schemaVersion: 1, fallbackText: expect.any(String), nodes: expect.any(Array) });
    expect(materializeFeishuView(view)).toEqual(card);
  });

  it("degrades a rich view deterministically to fallback text for a plain Gateway", async () => {
    const control: InMemoryGatewayControl = { delivered: [], fallbackMessages: [], async emit() { throw new Error("not started"); } };
    const session = createInMemoryGatewayPlugin(control).create({ gatewayId: "memory:test" }, {});
    const view = cardKitToGatewayView(renderInstanceCreateCard({ projectId: "project", requestedBy: "user" }));
    const plan = session.delivery.prepare({ kind: "message.reply.view", purpose: "operation-result", rootMessageId: "root", view, idempotencyKey: "key" });
    await session.delivery.execute(plan, { attemptId: "attempt", leaseFencingToken: null, idempotencyKey: "key", priorCheckpoints: [], async checkpoint() {} });
    expect(control.fallbackMessages).toEqual(["创建 Worker"]);
  });

  it("persists a portable view plan while Feishu receives equivalent CardKit", async () => {
    const card = feishuGatewayApplicationPresentation.commandResult({ title: "Done", text: "Completed safely." });
    const replyCard = vi.fn(async () => ({ messageId: "message-1" }));
    const store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "portable", idempotencyKey: "portable", rootMessageId: "root", kind: "card_reply", payload: JSON.stringify(card) });
    const transport = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "topic", rootMessageId: "root" }; }, async replyText() { return { messageId: "message" }; }, replyCard, async updateCard() {}, async shareThread() { return { messageId: "shared" }; } };

    await new OutboundDeliveryExecutor(store, createFeishuCompatibilityDelivery(transport), pino({ enabled: false })).deliver(store.getOutboundReply("portable")!, null);

    const persisted = store.getOutboundReply("portable")!;
    expect(JSON.parse(persisted.gatewayPlanJson!)).toMatchObject({ rendererRevision: 1, intent: { view: { schemaVersion: 1, fallbackText: "Done" } } });
    expect(replyCard).toHaveBeenCalledWith("root", expect.objectContaining({ schema: "2.0", header: expect.objectContaining({ title: { tag: "plain_text", content: "Done" } }) }), "portable");
    store.close();
  });
});
