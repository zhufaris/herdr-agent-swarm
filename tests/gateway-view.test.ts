import { describe, expect, it } from "vitest";
import { renderInstanceCreateCard } from "../src/cards/instance-control-card.js";
import { renderModelSelectionCard } from "../src/cards/model-card.js";
import { renderProjectEntryCard, renderRequestAnswerCard } from "../src/cards/run-card.js";
import { renderTopicPaneDirectoryCard } from "../src/cards/topic-pane-directory-card.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { cardKitToGatewayView, materializeFeishuView } from "../src/gateways/feishu/cardkit-view.js";
import { feishuGatewayApplicationPresentation, materializeFeishuPresentationView } from "../src/gateways/feishu/presentation.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import pino from "pino";
import { vi } from "vitest";
import { createInMemoryGatewayPlugin, type InMemoryGatewayControl } from "./helpers/in-memory-gateway-plugin.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { isGatewayView } from "../src/gateways/contract/view.js";
import { createCardKitApplicationPresentation } from "../src/cards/cardkit-application-presentation.js";

function countPropertyValue(value: unknown, property: string, expected: string): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countPropertyValue(item, property, expected), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  return (record[property] === expected ? 1 : 0)
    + Object.values(record).reduce((count, item) => count + countPropertyValue(item, property, expected), 0);
}

describe("GatewayView", () => {
  it("rejects partial, provider-shaped, and extension-bearing values", () => {
    const valid = cardKitToGatewayView(renderProjectEntryCard({ ...initialTopicView("binding"), title: "Strict view" }));
    expect(isGatewayView(valid)).toBe(true);
    expect(isGatewayView({ schemaVersion: 1, fallbackText: "partial", nodes: [] })).toBe(false);
    expect(isGatewayView({ ...valid, schema: "2.0" })).toBe(false);
    expect(isGatewayView({ ...valid, nodes: [{ kind: "markdown", content: "safe", tag: "markdown" }] })).toBe(false);
    expect(isGatewayView({ ...valid, nodes: [{ kind: "button", label: "bad", action: () => undefined }] })).toBe(false);
  });

  it("materializes a wrapped Turn Card page exactly like the current CardKit presentation", () => {
    const limits = { payloadLimitChars: 12_000, answerStreamLimitChars: 28_000 };
    const view = {
      segmentId: "segment", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "demo",
      projectLabel: "demo", tabLabel: "tab", paneToken: "pane", requestText: "inspect",
      state: "working" as const, timelineItems: [{ kind: "agent_message" as const, id: "answer", sequence: 1, markdown: "Done" }],
      gapWarning: null, viewVersion: 1,
    };
    const current = createCardKitApplicationPresentation(limits).turnCardPage(view, { pageIndex: 0 });
    const portable = feishuGatewayApplicationPresentation.turnCardPage(view, { pageIndex: 0 });
    expect(isGatewayView(portable.card)).toBe(true);
    expect(materializeFeishuPresentationView(portable.card as ReturnType<typeof cardKitToGatewayView>)).toEqual(current.card);
  });

  it("preserves one Turn Card page slot through Gateway and CardKit materialization", () => {
    const elementId = "turn-card:segment:page:0";
    const view = {
      segmentId: "segment", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "demo",
      projectLabel: "demo", tabLabel: "tab", paneToken: "pane", requestText: "inspect",
      state: "working" as const,
      timelineItems: [
        { kind: "thinking" as const, id: "thinking", sequence: 1, label: "Inspect", markdown: "Nested thinking" },
        { kind: "agent_message" as const, id: "answer", sequence: 2, markdown: "Visible assistant update" }
      ],
      gapWarning: null, viewVersion: 1,
    };
    const portable = feishuGatewayApplicationPresentation.turnCardPage(view, { pageIndex: 0, elementId });
    const materialized = materializeFeishuView(portable.card);

    expect(countPropertyValue(portable.card, "slot", elementId)).toBe(1);
    expect(countPropertyValue(materialized, "element_id", elementId)).toBe(1);
  });

  it("keeps a Completion Review mention semantic until the Feishu adapter materializes it", () => {
    const view = feishuGatewayApplicationPresentation.completionReview({
      actionSetId: `completion-review:v3:${"b".repeat(64)}`,
      mentionOpenId: "ou_requester",
      choicePrompt: {
        question: "Which path?", defaultOption: { id: "approve", label: "Approve", submitText: "default" }, alternatives: []
      }
    });

    expect(isGatewayView(view)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("<at");
    expect(view).toMatchObject({ nodes: expect.arrayContaining([
      expect.objectContaining({ kind: "mention", userId: "ou_requester", content: "Which path?\n\n请参考上方最终回复" })
    ]) });
    expect(JSON.stringify(materializeFeishuPresentationView(view as ReturnType<typeof cardKitToGatewayView>)))
      .toContain("<at id=ou_requester></at> Which path?\\n\\n请参考上方最终回复");
  });

  it.each([
    ["form", () => renderInstanceCreateCard({ projectId: "project", requestedBy: "user" })],
    ["select", () => renderModelSelectionCard({ bindingId: "binding", spaceName: "space", paneId: "pane", models: [{ name: "model", displayName: "Model" }], snapshot: { state: "none", effective: null, desired: null, promptPinned: false } })],
    ["main", () => renderProjectEntryCard({ ...initialTopicView("binding"), title: "Gateway main" })],
    ["stream", () => renderRequestAnswerCard(createQueuedRunCard({ promptId: "prompt", bindingId: "binding", title: "Answer", workspaceId: "workspace", paneId: "pane", requestText: "question", queuePosition: 1, occurredAt: "now" }))],
    ["direct thread link", () => renderTopicPaneDirectoryCard([{ bindingId: "binding", bindingGeneration: 1, paneId: "pane", sourceMainMessageId: "om_main", chatId: "oc_chat", threadId: "omt_thread", title: "Thread", spaceName: "space", agentState: "idle", workers: [] }])]
  ])("round-trips the %s CardKit surface through the portable AST", (_name, render) => {
    const card = render();
    const view = cardKitToGatewayView(card);
    expect(view).toMatchObject({ schemaVersion: 1, fallbackText: expect.any(String), nodes: expect.any(Array) });
    expect(materializeFeishuView(view)).toEqual(card);
  });

  it("preserves the CardKit v2 form submit action through the portable AST", () => {
    const card = renderInstanceCreateCard({ projectId: "project", requestedBy: "user" });
    const materialized = JSON.stringify(materializeFeishuView(cardKitToGatewayView(card)));

    expect(materialized).toContain('\"form_action_type\":\"submit\"');
    expect(materialized).not.toContain('\"action_type\":\"form_submit\"');
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
    store.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Gateway view" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const transport = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "topic", rootMessageId: "root" }; }, async replyText() { return { messageId: "message" }; }, replyCard, async updateCard() {}, async shareThread() { return { messageId: "shared" }; } };
    const publisher = createTestPublisher(store, transport, pino({ enabled: false }));
    await publisher.enqueueCard("root", "portable", card, "binding", "operation_result");
    await publisher.drain();

    const persistedId = (store.database.prepare("SELECT id FROM outbound_replies WHERE idempotency_key='portable'").get() as { id: string }).id;
    const persisted = store.getOutboundReply(persistedId)!;
    expect(JSON.parse(persisted.gatewayPlanJson!)).toMatchObject({ rendererRevision: 1, intent: { view: { schemaVersion: 1, fallbackText: "Done" } } });
    expect(replyCard).toHaveBeenCalledWith("root", expect.objectContaining({ schema: "2.0", header: expect.objectContaining({ title: { tag: "plain_text", content: "Done" } }) }), "portable");
    await publisher.stop();
    store.close();
  });
});
