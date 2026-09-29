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
  ])("round-trips the %s CardKit surface through the portable AST", (name, render) => {
    const card = render();
    const view = cardKitToGatewayView(card);
    expect(view).toMatchObject({ schemaVersion: 1, fallbackText: expect.any(String), nodes: expect.any(Array) });
    const materialized = materializeFeishuView(view);
    if (name === "stream") {
      expect(materialized).toMatchObject({
        config: { streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: "fast" } }
      });
    } else expect(materialized).toEqual(card);
  });

  it("preserves the CardKit v2 form submit action through the portable AST", () => {
    const card = renderInstanceCreateCard({ projectId: "project", requestedBy: "user" });
    const materialized = JSON.stringify(materializeFeishuView(cardKitToGatewayView(card)));

    expect(materialized).toContain('\"form_action_type\":\"submit\"');
    expect(materialized).not.toContain('\"action_type\":\"form_submit\"');
  });

  it("round-trips wide native streaming presentation without widening standard cards", () => {
    const answer = renderRequestAnswerCard(createQueuedRunCard({ promptId: "prompt", bindingId: "binding", title: "Answer", workspaceId: "workspace", paneId: "pane", requestText: "question", queuePosition: 1, occurredAt: "now" })) as { config: Record<string, unknown> };
    answer.config.wide_screen_mode = true;
    answer.config.streaming_config = { print_frequency_ms: 70, print_step: 1, print_strategy: "fast" };
    const view = cardKitToGatewayView(answer);

    expect(view).toMatchObject({ width: "wide", streamPresentation: { printFrequencyMs: 70, printStep: 1, printStrategy: "fast" } });
    expect(materializeFeishuView(view)).toEqual({
      ...answer,
      config: {
        ...answer.config,
        streaming_config: {
          print_frequency_ms: { default: 70 },
          print_step: { default: 1 },
          print_strategy: "fast"
        }
      }
    });

    const main = materializeFeishuView(cardKitToGatewayView(renderProjectEntryCard({ ...initialTopicView("binding"), title: "Main" })));
    expect(JSON.stringify(main)).not.toMatch(/wide_screen_mode|streaming_config/);
  });

  it("keeps a terminal Answer wide while omitting inactive streaming configuration", () => {
    const view = cardKitToGatewayView({
      schema: "2.0",
      config: { update_multi: true, wide_screen_mode: true, streaming_mode: false, summary: { content: "Done" } },
      body: { elements: [{ tag: "markdown", content: "Complete" }] }
    });

    expect(materializeFeishuView(view)).toEqual({
      schema: "2.0",
      config: { update_multi: true, wide_screen_mode: true, summary: { content: "Done" } },
      body: { elements: [{ tag: "markdown", content: "Complete" }] }
    });
  });

  it("materializes form select defaults as CardKit value strings", () => {
    const card = materializeFeishuView(cardKitToGatewayView(renderInstanceCreateCard({ projectId: "project", requestedBy: "user" }))) as { body: { elements: Array<{ elements?: Array<Record<string, unknown>> }> } };
    const selects = card.body.elements[0]!.elements!.filter(({ tag }) => tag === "select_static");
    expect(selects.map(({ initial_option }) => initial_option)).toEqual(["traex", "true"]);
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
