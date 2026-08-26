import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import type { LarkPort } from "../src/domain/ports.js";
import { LarkOutboxDispatcher } from "../src/events/lark-outbox-dispatcher.js";
import { ANSWER_STREAM_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage } from "../src/runtime/answer-stream.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

let directory: string | null = null;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = null; });

describe("Answer page crash recovery", () => {
  it("converges a three-page terminal answer across repeated store and worker restarts", async () => {
    directory = mkdtempSync(join(tmpdir(), "answer-page-recovery-"));
    const databasePath = join(directory, "bridge.db");
    const cards = new Map<string, { messageId: string; contents: Array<{ sequence: number; content: string }>; finishes: Array<{ sequence: number; summary: string }> }>();
    let nextCard = 1;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async createStreamingCard() { const cardId = `card-${nextCard++}`; cards.set(cardId, { messageId: "", contents: [], finishes: [] }); return { cardId }; },
      async replyStreamingCardReference(_root, cardId) { const card = cards.get(cardId)!; card.messageId ||= `message-${cardId}`; return { messageId: card.messageId }; },
      async streamCardContent(cardId, _elementId, content, sequence) { cards.get(cardId)!.contents.push({ sequence, content }); },
      async finishStreamingCard(cardId, sequence, summary) { cards.get(cardId)!.finishes.push({ sequence, summary }); },
      async shareThread() { return { messageId: "shared" }; }
    };

    let store = new SqliteBindingStore(databasePath);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-26T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view: queued, rootMessageId: "root-1", answerCard: {} });

    const answer = `${"a".repeat(ANSWER_STREAM_PAGE_LIMIT)}\n${"b".repeat(ANSWER_STREAM_PAGE_LIMIT)}\n${"c".repeat(2_000)}`;
    const initialDispatcher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    await initialDispatcher.requestScan(true);
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    store.close();

    for (let step = 0; step < 20; step += 1) {
      store = new SqliteBindingStore(databasePath);
      const dispatcher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
      const workflow = new AnswerPageWorkflow(store, () => {}, pino({ enabled: false }));
      await workflow.converge("p1");
      await dispatcher.requestScan(true);
      const pages = store.listAnswerPages("p1");
      if (pages.at(-1)?.state === "finished") break;
      store.close();
    }

    const pages = store.listAnswerPages("p1");
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.slice(0, -1).every((page) => page.state === "frozen")).toBe(true);
    expect(pages.at(-1)?.state).toBe("finished");
    expect(cards.size).toBe(pages.length);
    for (const card of cards.values()) {
      const sequences = [...card.contents.map((item) => item.sequence), ...card.finishes.map((item) => item.sequence)];
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(sequences[0]).toBe(1);
    }
    const canonical = answerStreamContent(store.loadRunCard("p1")!);
    for (const page of pages) {
      const delivered = cards.get(page.cardId!)!;
      expect(delivered.contents.at(-1)?.content).toBe(renderAnswerStreamPage(canonical, page.sourceStart).page);
    }
    store.close();
  });
});
