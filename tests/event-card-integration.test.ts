import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { QueueFeedbackProjector } from "../src/events/queue-feedback-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { ANSWER_STREAM_PAGE_LIMIT, renderAnswerStreamPage } from "../src/runtime/answer-stream.js";

describe("event-driven card projection", () => {
  it("coalesces repeated queue-feedback ticks to the newest durable answer update", async () => {
    let clock = "2026-08-29T12:00:20.000Z";
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const active = createQueuedRunCard({ promptId: "active", bindingId: "b1", title: "Active", workspaceId: "w1", paneId: "w1:p1", requestText: "active", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "active", bindingId: "b1", larkMessageId: "m-active", actorOpenId: "u1", body: "active" }, view: active, rootMessageId: "m1", answerCard: {} });
    store.updatePrompt("active", "running"); store.markPromptDispatched("active");
    store.database.prepare("UPDATE run_cards SET phase = 'running', started_at = '2026-08-29T12:00:00.000Z' WHERE prompt_id = 'active'").run();
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m-p1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "m1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, reply.promptId === "p1" ? "answer-1" : "active-answer", reply.promptId === "p1" ? "card-1" : "active-card");
    const outboundWork = { subscribe: () => () => {}, wake: vi.fn() };
    const projector = new QueueFeedbackProjector({ store, outboundWork, logger: pino({ enabled: false }), now: () => clock });

    await projector.refresh("b1");
    clock = "2026-08-29T12:00:31.000Z";
    await projector.refresh("b1");

    const updates = store.listPendingOutboundReplies().filter((reply) => reply.promptId === "p1" && reply.kind === "card_update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ viewVersion: 3, rootMessageId: "answer-1", cardRole: "answer" });
    expect(updates[0]!.payload).toContain("当前任务已运行 31 秒");
    await projector.stop(); store.close();
  });

  it("reduces an event, persists the view, then updates the same card", async () => {
    const updates: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; },
      async replyCard() { return { messageId: "card1" }; },
      async updateCard(_messageId, card) { updates.push(card); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p2", state: "active", statusMessageId: "card1" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stop = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })).start();

    await bus.publish({ eventId: "e1", bindingId: "b1", type: "BindingCreated", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Task", workspaceId: "w1", paneId: "w1:p2" } });
    await bus.publish({ eventId: "e2", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer: "Finished", queueDepth: 0 } });

    expect(store.loadTopicView("b1")).toMatchObject({ phase: "done", answer: "Finished" });
    await publisher.drain();
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates.at(-1))).toContain("已完成");
    expect(JSON.stringify(updates.at(-1))).toContain("Finished");
    stop(); stopPublisher(); store.close();
  });

  it("previews live output on the primary card and prioritizes a blocked notice", async () => {
    const updates: Array<{ messageId: string; card: object }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; },
      async replyCard() { return { messageId: "request-card" }; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "primary-card", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", statusMessageId: "primary-card" });
    const request = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Do work", workspaceId: "w1", paneId: "w1:p1", requestText: "Do work", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-message", actorOpenId: "u1", body: "Do work" }, view: request, rootMessageId: "primary-card", taskCard: {}, answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) {
      store.markOutboundReplyDelivered(reply.id, reply.cardRole === "task" ? "request-task-card" : "request-answer-card");
    }
    store.saveTopicView({ ...initialTopicView("b1"), title: "repo / task", workspaceId: "w1", paneId: "w1:p1", phase: "done" });
    store.listBindings = () => { throw new Error("ConversationViewProjector must use point binding lookup"); };
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }));
    const stopProjector = projector.start();

    await bus.publish({ eventId: "start", bindingId: "b1", type: "TurnStarted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", queueDepth: 1 } });
    await bus.publish({ eventId: "output", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:01Z", payload: { promptId: "p1", answerSnapshot: "live answer", progressEvents: [{ key: "edit:card", kind: "edit", label: "更新主卡片", state: "active" }] } });
    await bus.publish({ eventId: "blocked", bindingId: "b1", type: "AgentStateChanged", origin: "herdr", occurredAt: "2026-08-22T00:01:02Z", payload: { promptId: "p1", state: "blocked", queueDepth: 1 } });
    await publisher.drain();

    expect(store.loadTopicView("b1")).toMatchObject({ phase: "blocked", answer: "live answer", recentProgress: [expect.objectContaining({ key: "edit:card" })] });
    const latestPrimary = updates.filter((update) => update.messageId === "primary-card").at(-1)!;
    expect(JSON.stringify(latestPrimary.card)).toContain("等待用户处理");
    expect(JSON.stringify(latestPrimary.card)).toContain("TraeX 需要人工审批");
    expect(JSON.stringify(latestPrimary.card)).not.toContain("live answer");
    expect(JSON.stringify(latestPrimary.card)).toContain("🛠️ 更新主卡片");
    expect(updates.some((update) => update.messageId === "request-task-card")).toBe(false);
    expect(updates.some((update) => {
      if (update.messageId !== "request-answer-card") return false;
      const serialized = JSON.stringify(update.card);
      return serialized.includes("live answer") && serialized.includes("TraeX 需要人工审批");
    })).toBe(true);

    stopProjector(); stopPublisher(); store.close();
  });

  it("updates the same answer card with the accumulated live message window", async () => {
    vi.useFakeTimers();
    const updates: Array<{ messageId: string; card: object }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; },
      async replyCard() { return { messageId: "request-card" }; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "primary-card", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", statusMessageId: "primary-card" });
    const request = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Do work", workspaceId: "w1", paneId: "w1:p1", requestText: "Do work", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-message", actorOpenId: "u1", body: "Do work" }, view: request, rootMessageId: "primary-card", taskCard: {}, answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, reply.cardRole === "task" ? "request-task-card" : "request-answer-card");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), undefined, undefined, { cardUpdateDebounceMs: 1_500 });
    const stopProjector = projector.start();

    await bus.publish({ eventId: "start", bindingId: "b1", type: "TurnStarted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", queueDepth: 1 } });
    await bus.publish({ eventId: "first", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:01Z", payload: { promptId: "p1", answerSnapshot: "第一条", answerUpdate: "replace", progressEvents: [] } });
    await bus.publish({ eventId: "first-grown", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:02Z", payload: { promptId: "p1", answerSnapshot: "第一条中间消息。", answerUpdate: "replace", progressEvents: [] } });
    await bus.publish({ eventId: "second", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:03Z", payload: { promptId: "p1", answerSnapshot: "第二条", answerUpdate: "append", progressEvents: [] } });
    await bus.publish({ eventId: "second-grown", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:04Z", payload: { promptId: "p1", answerSnapshot: "第二条中间消息。", answerUpdate: "replace", progressEvents: [] } });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(updates.filter((update) => update.messageId === "request-answer-card")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await publisher.drain();

    const answerUpdates = updates.filter((update) => update.messageId === "request-answer-card");
    expect(answerUpdates.length).toBeGreaterThan(0);
    const latest = JSON.stringify(answerUpdates.at(-1)!.card);
    expect(latest).toContain("第一条中间消息。");
    expect(latest).toContain("第二条中间消息。");
    expect(store.loadRunCard("p1")).toMatchObject({ answerSegments: ["第一条中间消息。"], answerDraft: "第二条中间消息。" });
    expect(new Set(answerUpdates.map((update) => update.messageId))).toEqual(new Set(["request-answer-card"]));

    stopProjector(); stopPublisher(); store.close(); vi.useRealTimers();
  });

  it("freezes a bounded answer card and continues on a persisted new card", async () => {
    const created: object[] = [];
    const streamed: Array<{ cardId: string; elementId: string; content: string; sequence: number }> = [];
    const finished: Array<{ cardId: string; sequence: number; summary: string }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async replyStreamingCard(_rootMessageId, card) { created.push(card); const number = created.length; return { messageId: `answer-${number}`, cardId: `cardkit-${number}` }; },
      async streamCardContent(cardId, elementId, content, sequence) { streamed.push({ cardId, elementId, content, sequence }); },
      async finishStreamingCard(cardId, sequence, summary) { finished.push({ cardId, sequence, summary }); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.listBindings = () => { throw new Error("ConversationViewProjector must use point binding lookup"); };
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    await publisher.drain();

    const pageHalf = Math.ceil(ANSWER_STREAM_PAGE_LIMIT / 2);
    const answer = [
      "<b>Result</b> [unsafe](javascript:alert(1))",
      "| Key | Value |",
      "| --- | --- |",
      "| mode | fast |",
      "```ts",
      "const preserved = '[literal](javascript:alert(1))';",
      "```",
      "a".repeat(pageHalf),
      "b".repeat(pageHalf)
    ].join("\n");
    await bus.publish({ eventId: "done", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer, queueDepth: 0 } });
    await vi.waitFor(() => expect(finished).toHaveLength(2));

    const fullContent = `⏳ 已接收请求\n\n${answer}`;
    const firstPage = renderAnswerStreamPage(fullContent, 0, ANSWER_STREAM_PAGE_LIMIT);
    const secondPage = renderAnswerStreamPage(fullContent, firstPage.nextPageStart!, ANSWER_STREAM_PAGE_LIMIT);
    expect(answer.length).toBeLessThan(28_000);
    expect(firstPage.nextPageStart).not.toBeNull();
    expect(created).toHaveLength(2);
    expect(streamed.map(({ cardId, elementId, content }) => ({ cardId, elementId, content }))).toEqual([
      { cardId: "cardkit-1", elementId: "answer_content_p1_0", content: firstPage.page },
      { cardId: "cardkit-2", elementId: "answer_content_p1_1", content: secondPage.page }
    ]);
    expect(streamed[0]!.content).toContain("Result unsafe");
    expect(streamed[0]!.content).toContain("```text\n| Key | Value |");
    expect(streamed[0]!.content).toContain("[literal](javascript:alert(1))");
    expect(streamed[0]!.content).not.toContain("<b>Result</b>");
    expect(finished.map(({ cardId, summary }) => ({ cardId, summary }))).toEqual([
      { cardId: "cardkit-1", summary: "回答将在第 2 页继续" }, { cardId: "cardkit-2", summary: "Completed" }
    ]);
    expect(JSON.stringify(created[1])).toContain("TraeX 继续回复 · 第 2 页");
    expect(JSON.stringify(created[1])).toContain('\"streaming_mode\":true');
    expect(store.loadRunCard("p1")).toMatchObject({ answerCardId: "cardkit-2", answerMessageId: "answer-2", answerPageIndex: 1, answerPageStart: firstPage.nextPageStart, answerElementId: "answer_content_p1_1" });

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("does not append stale old-page events while a continuation card is pending", async () => {
    vi.useFakeTimers();
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    store.enqueueOutboundReply({
      id: "page-2", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "root-1", kind: "stream_card_create",
      payload: JSON.stringify({ card: { body: { elements: [{ element_id: "answer_content_p1_1" }] } }, stream: { pageIndex: 1, pageStart: 3_500, elementId: "answer_content_p1_1" } })
    });
    const bus = new BridgeEventBus();
    const pendingWrites: string[] = [];
    const publisher = {
      onAnswerCheckpoint: () => () => {}, requestScan: async () => {},
      async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {},
      async enqueueStreamCardCreate() { pendingWrites.push("stream_card_create"); },
      async enqueueStreamFinish() { pendingWrites.push("stream_finish"); },
      async enqueueStreamContent() { pendingWrites.push("stream_content"); }
    };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();

    await bus.publish({ eventId: "output-after-rollover", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answerSnapshot: "new live output", answerUpdate: "replace", progressEvents: [] } });
    await vi.advanceTimersByTimeAsync(1_000);

    const answerReplies = store.listPendingOutboundReplies().filter((reply) => reply.promptId === "p1");
    expect(answerReplies).toHaveLength(1);
    expect(answerReplies[0]).toMatchObject({ id: "page-2", kind: "stream_card_create" });
    expect(pendingWrites).toEqual([]);
    await projector.stop(); store.close(); vi.useRealTimers();
  });

  it("streams a render-safe Bash fence while preserving the canonical answer", async () => {
    const streamed: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async replyStreamingCard() { return { messageId: "answer-1", cardId: "cardkit-1" }; },
      async streamCardContent(_cardId, _elementId, content) { streamed.push(content); },
      async finishStreamingCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Bash answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    await publisher.drain();

    const answer = ["Run this:", "```bash", "echo hello"].join("\n");
    await bus.publish({ eventId: "bash", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer, queueDepth: 0 } });
    await vi.waitFor(() => expect(streamed.length).toBeGreaterThan(0));

    expect(streamed.at(-1)).toBe(["⏳ 已接收请求", "", "Run this:", "```bash", "echo hello", "```"].join("\n"));
    expect(store.loadRunCard("p1")?.answer).toBe(answer);

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("keeps Bash fences valid when streaming rolls over to a continuation card", async () => {
    const created: object[] = [];
    const streamed: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async replyStreamingCard(_rootMessageId, card) { created.push(card); return { messageId: `answer-${created.length}`, cardId: `cardkit-${created.length}` }; },
      async streamCardContent(_cardId, _elementId, content) { streamed.push(content); },
      async finishStreamingCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long Bash answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    await publisher.drain();

    const answer = ["```bash", ...Array.from({ length: 3_500 }, (_, index) => `echo line-${index}`), "```"].join("\n");
    await bus.publish({ eventId: "bash-rollover", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer, queueDepth: 0 } });
    await vi.waitFor(() => expect(streamed.length).toBeGreaterThanOrEqual(2));

    expect(streamed[0]).toMatch(/^⏳ 已接收请求\n\n```bash\n/);
    for (const [index, page] of streamed.entries()) {
      expect(page).toMatch(/```bash\n/);
      expect(page.length).toBeLessThanOrEqual(ANSWER_STREAM_PAGE_LIMIT);
      if (index < streamed.length - 1) {
        expect(page).toMatch(/\n```\n\n… 本页接近显示上限/);
      } else {
        expect(page).toMatch(/\n```$/);
      }
    }
    expect(store.loadRunCard("p1")?.answer).toBe(answer);

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("keeps the newest output on the last continuation card without rewriting frozen cards", async () => {
    const created: Array<{ cardId: string; card: object }> = [];
    const updates = new Map<string, string[]>();
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async replyStreamingCard(_rootMessageId, card) {
        const cardId = `cardkit-${created.length + 1}`;
        created.push({ cardId, card });
        return { messageId: `answer-${created.length}`, cardId };
      },
      async streamCardContent(cardId, _elementId, content) { updates.set(cardId, [...(updates.get(cardId) ?? []), content]); },
      async finishStreamingCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    await publisher.drain();

    const latestMarker = "LATEST_MESSAGE_MUST_REMAIN_VISIBLE";
    const answer = `${Array.from({ length: 4_500 }, (_, index) => `unique-line-${String(index).padStart(4, "0")}`).join("\n")}\n${latestMarker}`;
    await bus.publish({ eventId: "long-answer", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer, queueDepth: 0 } });
    await vi.waitFor(() => expect(created.length).toBeGreaterThanOrEqual(3));

    const lastCardId = created.at(-1)!.cardId;
    expect(updates.get(lastCardId)?.at(-1)).toContain(latestMarker);
    expect([...updates.entries()].filter(([cardId]) => cardId !== lastCardId).every(([, contents]) => contents.every((content) => !content.includes(latestMarker)))).toBe(true);
    expect([...updates.values()].slice(0, -1).every((contents) => contents.length === 1)).toBe(true);
    expect(store.loadRunCard("p1")?.answer).toBe(answer);

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("restarts CardKit stream sequence from one on each continuation card", async () => {
    const streamed: Array<{ cardId: string; content: string; sequence: number }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async replyStreamingCard(_rootMessageId, _card) {
        const number = new Set(streamed.map((update) => update.cardId)).size + 1;
        return { messageId: `answer-${number}`, cardId: `cardkit-${number}` };
      },
      async streamCardContent(cardId, _elementId, content, sequence) { streamed.push({ cardId, content, sequence }); },
      async finishStreamingCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    await publisher.drain();

    const firstAnswer = `${"a".repeat(ANSWER_STREAM_PAGE_LIMIT - 100)}\n${"b".repeat(600)}`;
    await bus.publish({ eventId: "first-page", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answerSnapshot: firstAnswer, answerUpdate: "replace", progressEvents: [] } });
    await vi.waitFor(() => expect(streamed.filter((update) => update.cardId === "cardkit-2")).toHaveLength(1));

    const latestMarker = "LATEST_CONTINUATION_CONTENT";
    await bus.publish({ eventId: "second-page", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:01Z", payload: { promptId: "p1", answerSnapshot: `${firstAnswer}\n${"c".repeat(500)}\n${latestMarker}`, answerUpdate: "replace", progressEvents: [] } });
    await vi.waitFor(() => expect(streamed.filter((update) => update.cardId === "cardkit-2")).toHaveLength(2));

    const continuationUpdates = streamed.filter((update) => update.cardId === "cardkit-2");
    expect(continuationUpdates.map((update) => update.sequence)).toEqual([1, 2]);
    expect(continuationUpdates.at(-1)?.content).toContain(latestMarker);

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("stops projection without waiting for background card delivery", async () => {
    let releaseUpdate!: () => void;
    const updateBlocked = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let updated = false;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; },
      async replyCard() { return { messageId: "card1" }; },
      async updateCard() { await updateBlocked; updated = true; }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p2", state: "active", statusMessageId: "card1" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }));
    publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }));
    projector.start();

    const publishing = bus.publish({ eventId: "e-stop", bindingId: "b1", type: "BindingCreated", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Task", workspaceId: "w1", paneId: "w1:p2" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let stopped = false;
    const stopping = projector.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(true);

    releaseUpdate();
    await Promise.all([publishing, stopping]);

    expect(updated).toBe(true);
    await expect(projector.stop()).resolves.toBeUndefined();
    await publisher.stop();
    store.close();
  });

  it("projects concurrent events for one binding in publication order", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const updates: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "card1" }; },
      async updateCard(_messageId, card) {
        const value = JSON.stringify(card);
        if (value.includes("First")) await firstBlocked;
        updates.push(value);
      }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p2", state: "active", statusMessageId: "card1" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();

    const first = bus.publish({ eventId: "first", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "First" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = bus.publish({ eventId: "second", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:01Z", payload: { title: "Second" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.loadTopicView("b1")?.title).toBe("Second");

    releaseFirst();
    await Promise.all([first, second]);
    expect(store.loadTopicView("b1")?.title).toBe("Second");
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates.map((value) => value.includes("First") ? "First" : "Second")).toEqual(["First", "Second"]);
    await projector.stop(); await publisher.stop(); store.close();
  });

  it("continues a binding projection tail after one event fails", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p2", state: "active" });
    const originalSave = store.saveTopicView.bind(store);
    let failOnce = true;
    store.saveTopicView = (view) => { if (failOnce) { failOnce = false; throw new Error("projection failed"); } originalSave(view); };
    const bus = new BridgeEventBus();
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; }, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();

    await expect(bus.publish({ eventId: "failed", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Failed" } })).resolves.toBeUndefined();
    expect(store.loadTopicView("b1")).toBeNull();
    expect(bus.snapshot()).toMatchObject({ subscriberFailures: 1, lastFailedSubscriber: "conversation-view-projector" });
    await expect(bus.publish({ eventId: "recovered", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:01Z", payload: { title: "Recovered" } })).resolves.toBeUndefined();
    expect(store.loadTopicView("b1")?.title).toBe("Recovered");
    await projector.stop(); await publisher.stop(); store.close();
  });

  it("projects different bindings independently", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const store = new SqliteBindingStore(":memory:");
    for (const id of ["b1", "b2"]) {
      store.createPendingBinding({ id, workspaceId: "w1", chatId: "c1", topicId: `t-${id}`, rootMessageId: `m-${id}`, title: id });
      store.updateBinding(id, { paneId: `w1:p-${id}`, state: "active", statusMessageId: `card-${id}` });
    }
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; },
      async updateCard(messageId) { if (messageId === "card-b1") await firstBlocked; }
    };
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();

    const first = bus.publish({ eventId: "first", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Blocked" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = bus.publish({ eventId: "second", bindingId: "b2", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:01Z", payload: { title: "Independent" } });
    await vi.waitFor(() => expect(store.loadTopicView("b2")?.title).toBe("Independent"));
    releaseFirst();
    await Promise.all([first, second]);
    await projector.stop(); await publisher.stop(); store.close();
  });
});
