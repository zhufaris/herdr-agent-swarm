import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { answerElementId, createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialRichTextAnswerPayload } from "../src/domain/rich-text.js";
import type { LarkPort } from "../src/domain/ports.js";
import { LarkOutboxDispatcher } from "../src/events/lark-outbox-dispatcher.js";
import { createFeishuCompatibilityDelivery } from "../src/gateways/feishu/plugin.js";
import { InProcessOutboundWorkNotifier } from "../src/events/outbound-work-notifier.js";
import { ANSWER_STREAM_PAGE_LIMIT } from "../src/runtime/answer-stream.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

let directory: string | null = null;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = null; });

describe("Answer page crash recovery", () => {
  it("converges a three-page terminal answer across repeated store and worker restarts", async () => {
    directory = mkdtempSync(join(tmpdir(), "answer-page-recovery-"));
    const databasePath = join(directory, "bridge.db");
    const posts = new Map<string, object[]>();
    const deliveries: string[] = [];
    let nextPost = 1;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard(messageId) { deliveries.push(`update:${messageId}`); },
      async replyRichText(_root, content) { const messageId = `post-${nextPost++}`; deliveries.push(`create:${messageId}`); posts.set(messageId, [content]); return { messageId }; },
      async updateRichText(messageId, content) { deliveries.push(`update:${messageId}`); posts.get(messageId)!.push(content); },
      async shareThread() { return { messageId: "shared" }; }
    };

    let store = new SqliteBindingStore(databasePath);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-26T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view: queued, rootMessageId: "root-1", answerCard: {} });
    const cardkitCreate = store.listPendingOutboundReplies().find((reply) => reply.promptId === "p1" && reply.cardRole === "answer")!;
    store.database.prepare("DELETE FROM outbound_replies WHERE id = ?").run(cardkitCreate.id);
    store.database.prepare("UPDATE answer_pages SET delivery_mode = 'rich_post', card_id = NULL WHERE prompt_id = 'p1' AND page_index = 0").run();
    store.enqueueOutboundReply({
      id: "historical-rich-p1",
      idempotencyKey: "answer-post:p1:0",
      bindingId: "b1",
      promptId: "p1",
      viewVersion: 1,
      cardRole: "answer",
      rootMessageId: "root-1",
      kind: "text",
      intentKind: "rich-text-reply",
      payload: JSON.stringify(initialRichTextAnswerPayload(0, 0, answerElementId("p1", 0))),
    });

    const answer = `${"a".repeat(ANSWER_STREAM_PAGE_LIMIT)}\n${"b".repeat(ANSWER_STREAM_PAGE_LIMIT)}\n${"c".repeat(2_000)}`;
    const logger = pino({ enabled: false });
    const initialDispatcher = new LarkOutboxDispatcher(store, createFeishuCompatibilityDelivery(lark), logger, new InProcessOutboundWorkNotifier(logger));
    await initialDispatcher.requestScan(true);
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    store.close();

    let finished = false;
    for (let step = 0; step < 20; step += 1) {
      store = new SqliteBindingStore(databasePath);
      const dispatcher = new LarkOutboxDispatcher(store, createFeishuCompatibilityDelivery(lark), logger, new InProcessOutboundWorkNotifier(logger));
      const workflow = new AnswerPageWorkflow(store, () => {}, primaryPresentation, pino({ enabled: false }));
      await workflow.converge("p1");
      await dispatcher.requestScan(true);
      const pages = store.listAnswerPages("p1");
      if (pages.at(-1)?.state === "finished") { finished = true; break; }
      store.close();
    }

    if (!finished) store = new SqliteBindingStore(databasePath);
    const pages = store.listAnswerPages("p1");
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.slice(0, -1).every((page) => page.state === "frozen")).toBe(true);
    expect(pages.at(-1)?.state).toBe("finished");
    expect(posts.size).toBe(pages.length);
    for (const page of pages.slice(0, -1)) {
      const updates = deliveries.filter((entry) => entry === `update:${page.messageId}`);
      const update = deliveries.indexOf(`update:${page.messageId}`);
      const nextCreate = deliveries.indexOf(`create:${pages[page.pageIndex + 1]!.messageId}`);
      expect(updates.length).toBeGreaterThan(0);
      expect(nextCreate).toBeGreaterThan(update);
    }
    expect(pages.every((page) => page.deliveryMode === "rich_post" && page.cardId === null)).toBe(true);
    store.close();
  });
});
