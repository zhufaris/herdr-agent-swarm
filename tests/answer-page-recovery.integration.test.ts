import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { answerElementId, createQueuedRunCard } from "../src/domain/run-card-view.js";
import type { LarkPort } from "../src/domain/ports.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
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
      async replyStreamingCard(_root, card) { const messageId = `post-${nextPost++}`; const cardId = `card-${nextPost - 1}`; deliveries.push(`create:${messageId}`); posts.set(cardId, [card]); return { messageId, cardId }; },
      async streamCardContent(cardId, _elementId, content) { deliveries.push(`update:${cardId}`); posts.get(cardId)!.push(content); },
      async finishStreamingCard(cardId) { deliveries.push(`finish:${cardId}`); },
      async shareThread() { return { messageId: "shared" }; }
    };

    let store = new SqliteBindingStore(databasePath);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1" });
    const logger = pino({ enabled: false });
    const initialDispatcher = createTestPublisher(store, lark, logger);
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-26T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view: queued, rootMessageId: "root-1", answerCard: { card: { schema: "2.0", body: { elements: [{ tag: "markdown", element_id: answerElementId("p1", 0), content: "Preparing Answer…" }] } }, stream: { pageIndex: 0, pageStart: 0, elementId: answerElementId("p1", 0) } } });

    const answer = `${"a".repeat(ANSWER_STREAM_PAGE_LIMIT)}\n${"b".repeat(ANSWER_STREAM_PAGE_LIMIT)}\n${"c".repeat(2_000)}`;
    await initialDispatcher.requestScan(true);
    await initialDispatcher.stop();
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    store.close();

    let finished = false;
    for (let step = 0; step < 20; step += 1) {
      store = new SqliteBindingStore(databasePath);
      const dispatcher = createTestPublisher(store, lark, logger);
      const workflow = new AnswerPageWorkflow(store, () => {}, primaryPresentation, pino({ enabled: false }));
      await workflow.converge("p1");
      await dispatcher.requestScan(true);
      const pages = store.listAnswerPages("p1");
      if (pages.at(-1)?.state === "finished") { finished = true; await dispatcher.stop(); break; }
      await dispatcher.stop();
      store.close();
    }

    if (!finished) store = new SqliteBindingStore(databasePath);
    const pages = store.listAnswerPages("p1");
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.slice(0, -1).every((page) => page.state === "frozen")).toBe(true);
    expect(pages.at(-1)?.state).toBe("finished");
    expect(posts.size).toBe(pages.length);
    for (const page of pages.slice(0, -1)) {
      const updates = deliveries.filter((entry) => entry === `update:${page.cardId}`);
      const update = deliveries.indexOf(`update:${page.cardId}`);
      const nextCreate = deliveries.indexOf(`create:${pages[page.pageIndex + 1]!.messageId}`);
      expect(updates.length).toBeGreaterThan(0);
      expect(nextCreate).toBeGreaterThan(update);
    }
    expect(pages.every((page) => page.deliveryMode === "streaming" && page.cardId !== null)).toBe(true);
    store.close();
  });
});
