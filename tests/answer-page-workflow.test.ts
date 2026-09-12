import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { answerElementId, createQueuedRunCard } from "../src/domain/run-card-view.js";
import { answerStreamContent } from "../src/runtime/answer-stream.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

function readyStore(path = ":memory:"): SqliteBindingStore {
  const store = new SqliteBindingStore(path);
  store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
  const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
  store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
  store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
  return store;
}

describe("AnswerPageWorkflow", () => {
  describe("immutable Answer snapshots", () => {
    it("does not requeue an unchanged delivered static snapshot on convergence", async () => {
      const store = readyStore();
      try {
        store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
        const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
        await workflow.converge("p1");
        const first = store.listPendingOutboundReplies()[0]!;
        store.markOutboundReplyDelivered(first.id, "answer-1");
        await workflow.converge("p1");
        expect(store.listPendingOutboundReplies()).toEqual([]);
        expect(store.getOutboundReply(first.id)).toMatchObject({ payload: first.payload, viewVersion: first.viewVersion, state: "delivered", attemptCount: 1 });
      } finally { store.close(); }
    });

    it("preserves rejection evidence for unchanged final content", () => {
      const store = readyStore();
      try {
        store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'p1'").run();
        const input = { promptId: "p1", pageIndex: 0, cardId: "card-1", messageId: "answer-1", card: { schema: "2.0" } };
        expect(store.reserveFinalAnswerCardUpdate(input)).toBe("reserved");
        const first = store.listPendingOutboundReplies()[0]!;
        store.markOutboundReplyFailedWithQuarantine(first.id, "content rejected", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "230028" });
        expect(store.getOutboundReply(first.id)).toMatchObject({ state: "dead_letter", larkErrorCode: "230028" });
        const failed = store.getOutboundReply(first.id);
        expect(store.reserveFinalAnswerCardUpdate(input)).toBe("waiting");
        expect(store.getOutboundReply(first.id)).toEqual(failed);
        expect(store.listPendingOutboundReplies()).toEqual([]);
      } finally { store.close(); }
    });

    it("does not resend identical final payload when only the view version advances", () => {
      const store = readyStore();
      try {
        store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'p1'").run();
        const input = { promptId: "p1", pageIndex: 0, cardId: "card-1", messageId: "answer-1", card: { schema: "2.0" } };
        store.reserveFinalAnswerCardUpdate(input);
        const first = store.listPendingOutboundReplies()[0]!;
        store.markOutboundReplyDelivered(first.id, "answer-1");
        expect(store.reserveFinalAnswerCardUpdate(input)).toBe("waiting");
        const view = store.loadRunCard("p1")!;
        store.saveRunCard({ ...view, viewVersion: view.viewVersion + 1 });
        expect(store.reserveFinalAnswerCardUpdate(input)).toBe("waiting");
        expect(store.getOutboundReply(first.id)).toMatchObject({ state: "delivered", payload: first.payload });
        expect(store.listPendingOutboundReplies()).toEqual([]);
      } finally { store.close(); }
    });
  });

  it("preserves an in-flight static snapshot and reserves A-B-A as distinct revisions", () => {
    const store = readyStore();
    try {
      store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static' WHERE prompt_id = 'p1'").run();
      const input = { promptId: "p1", pageIndex: 0, messageId: "answer-1", card: { content: "A" } };
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("reserved");
      const first = store.listPendingOutboundReplies()[0]!;
      const claim = store.claimOutboundReply(first.id, null)!;
      expect(store.reserveStaticAnswerCardUpdate({ ...input, card: { content: "B" } })).toBe("reserved");
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("reserved");
      expect(store.listPendingOutboundReplies().map((row) => JSON.parse(row.payload).content)).toEqual(["A", "B", "A"]);
      expect(store.database.prepare("SELECT snapshot_revision FROM outbound_replies WHERE projection_key IS NOT NULL ORDER BY snapshot_revision").all()).toEqual([{ snapshot_revision: 1 }, { snapshot_revision: 2 }, { snapshot_revision: 3 }]);
      expect(store.markOutboundReplyDelivered(claim, "answer-1")).toBe(true);
      expect(store.listPendingOutboundReplies().map((row) => JSON.parse(row.payload).content)).toEqual(["B", "A"]);
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("waiting");
      store.pruneDeliveredOutboundReplies("2099-01-01T00:00:00.000Z", 100);
      expect(store.getOutboundReply(first.id)).toBeNull();
      expect(store.reserveStaticAnswerCardUpdate(input)).toBe("waiting");
    } finally { store.close(); }
  });

  it.each(["full", "short", "rewritten", "generation"] as const)("requires a matching %s static replacement coverage receipt", async (scenario) => {
    const store = readyStore();
    try {
      const original = "original answer content";
      store.saveRunCard({ ...store.loadRunCard("p1")!, answer: original, answerSegments: [original], viewVersion: 2 });
      const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
      await workflow.converge("p1");
      const failed = store.listPendingOutboundReplies()[0]!;
      store.markOutboundReplyFailedWithQuarantine(store.claimOutboundReply(failed.id, null)!, "closed", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "300309", recoveryKind: "closed_answer_stream" });
      await workflow.converge("p1");
      const replacement = store.listPendingOutboundReplies()[0]!;
      store.markOutboundReplyDelivered(store.claimOutboundReply(replacement.id, null)!, "answer-2", "card-2");
      expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 1, deliveryRecoveries: { replacement_pending: 1, recovered: 0 } });
      const answer = scenario === "short" ? "original" : scenario === "rewritten" ? "different answer content" : `${original} appended`;
      store.saveRunCard({ ...store.loadRunCard("p1")!, answer, answerSegments: [answer], viewVersion: 3 });
      await workflow.converge("p1");
      const update = store.listPendingOutboundReplies()[0]!;
      const first = store.claimOutboundReply(update.id, null)!;
      expect(() => store.database.prepare("UPDATE answer_delivery_coverage SET source_hash = 'wrong' WHERE reply_id = ?").run(update.id)).toThrow("immutable_answer_coverage");
      store.markOutboundReplyFailedWithQuarantine(first, "temporary", { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
      const retry = store.claimOutboundReply(update.id, null)!;
      expect(store.markOutboundReplyDelivered(first, "answer-2")).toBe(false);
      expect(store.getOperationalSummary().deliveryRecoveries.recovered).toBe(0);
      if (scenario === "generation") store.database.prepare("UPDATE bindings SET generation = generation + 1 WHERE id = 'b1'").run();
      store.markOutboundReplyDelivered(retry, "answer-2");
      expect(store.getOperationalSummary().deliveryRecoveries.recovered).toBe(scenario === "full" ? 1 : 0);
      expect(store.getOperationalSummary().unresolvedDeadLetters).toBe(scenario === "full" ? 0 : 1);
      expect(store.listAnswerPages("p1")[0]).toMatchObject({ state: "frozen", messageId: "answer-1" });
    } finally { store.close(); }
  });

  it("does not infer closed-stream recovery from a raw Lark code", async () => {
    const store = readyStore();
    try {
      store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "partial answer", answerSegments: ["partial answer"], viewVersion: 2 });
      const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
      await workflow.converge("p1");
      const failed = store.listPendingOutboundReplies()[0]!;

      expect(store.markOutboundReplyFailedWithQuarantine(store.claimOutboundReply(failed.id, null)!, "closed", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "300309" })).toMatchObject({
        action: "blocked", laneClass: "answer_stream"
      });
      expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "active", deliveryMode: "streaming", messageId: "answer-1" })]);
      expect(store.listPendingOutboundReplies()).toEqual([]);
    } finally { store.close(); }
  });

  it("retains cross-page recovery links and coverage across reopen and outbox pruning", async () => {
    const directory = mkdtempSync(join(tmpdir(), "answer-evidence-"));
    const path = join(directory, "state.sqlite");
    let store = readyStore(path);
    try {
      store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "persisted content", answerSegments: ["persisted content"], viewVersion: 2 });
      let workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
      await workflow.converge("p1");
      const failed = store.listPendingOutboundReplies()[0]!;
      store.markOutboundReplyFailedWithQuarantine(store.claimOutboundReply(failed.id, null)!, "closed", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "300309", recoveryKind: "closed_answer_stream" });
      await workflow.converge("p1");
      const replacement = store.listPendingOutboundReplies()[0]!;
      store.markOutboundReplyDelivered(store.claimOutboundReply(replacement.id, null)!, "answer-2", "card-2");
      store.pruneDeliveredOutboundReplies("2099-01-01T00:00:00.000Z", 100);
      expect(store.getOutboundReply(replacement.id)).not.toBeNull();
      store.close();
      store = new SqliteBindingStore(path);
      workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
      await workflow.converge("p1");
      const update = store.listPendingOutboundReplies()[0]!;
      store.markOutboundReplyDelivered(store.claimOutboundReply(update.id, null)!, "answer-2");
      expect(store.getOperationalSummary().deliveryRecoveries.recovered).toBe(1);
      store.pruneDeliveredOutboundReplies("2099-01-01T00:00:00.000Z", 100);
      expect(store.getOutboundReply(replacement.id)).toBeNull();
      store.close();
      store = new SqliteBindingStore(path);
      expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 0, deliveryRecoveries: { recovered: 1 } });
      expect(store.database.prepare("SELECT resolved_by_reply_id, resolved_message_id FROM delivery_recoveries WHERE failed_reply_id = ?").get(failed.id)).toMatchObject({ resolved_by_reply_id: update.id, resolved_message_id: "answer-2" });
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("reserves one content intent and wakes delivery", async () => {
    const store = readyStore();
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "hello", answerSegments: ["hello"], viewVersion: 2 });
    const wake = vi.fn();
    await new AnswerPageWorkflow(store, wake, primaryPresentation, pino({ enabled: false })).converge("p1");
    expect(wake).toHaveBeenCalledOnce();
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    expect(store.getActiveAnswerPage("p1")?.sequence).toBe(1);
    await new AnswerPageWorkflow(store, wake, primaryPresentation).converge("p1");
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    store.close();
  });

  it("does nothing until the initial Answer card is delivered", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: null, requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const wake = vi.fn();
    await new AnswerPageWorkflow(store, wake, primaryPresentation).converge("p1");
    expect(wake).not.toHaveBeenCalled();
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    store.close();
  });

  it("reserves one terminal finish across repeated convergence", async () => {
    const store = readyStore();
    const content = "⏳ 已接收请求\n\ndone";
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 2 });
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: store.getActiveAnswerPage("p1")!.elementId, content })).toBe("reserved");
    const [contentReply] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(contentReply!.id, "card-1");
    const wake = vi.fn();
    const workflow = new AnswerPageWorkflow(store, wake, primaryPresentation);

    await Promise.all([workflow.converge("p1"), workflow.converge("p1"), workflow.converge("p1")]);

    expect(store.listPendingOutboundReplies()).toEqual([
      expect.objectContaining({ kind: "stream_finish", viewVersion: 2 }),
      expect.objectContaining({ kind: "card_update", cardRole: "answer" })
    ]);
    expect(store.getActiveAnswerPage("p1")?.sequence).toBe(2);
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("finishes a delivered recovery chunk at canonical EOF without creating an empty page", async () => {
    const store = readyStore();
    const completed = store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 2 });
    const content = answerStreamContent(completed);
    store.enqueueOutboundReply({
      id: "recovery-content", idempotencyKey: "startup-lite-content:failed-content", bindingId: "b1", promptId: "p1", viewVersion: 1, cardRole: "answer",
      rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: store.getActiveAnswerPage("p1")!.elementId, content, sequence: 1, sourceEnd: content.length })
    });
    store.markOutboundReplyDelivered("recovery-content", "card-1");

    await new AnswerPageWorkflow(store, vi.fn(), primaryPresentation).converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([
      expect.objectContaining({ kind: "stream_finish", viewVersion: 2 }),
      expect.objectContaining({ kind: "card_update", cardRole: "answer" })
    ]);
    expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "active" })]);
    store.close();
  });

  it("continues exactly from a delivered recovery chunk source end", async () => {
    const store = readyStore();
    const answer = "x".repeat(12_000);
    const completed = store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const content = answerStreamContent(completed);
    const sourceEnd = 4_000;
    store.enqueueOutboundReply({
      id: "recovery-content", idempotencyKey: "startup-lite-content:failed-content", bindingId: "b1", promptId: "p1", viewVersion: 1, cardRole: "answer",
      rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: store.getActiveAnswerPage("p1")!.elementId, content: content.slice(0, sourceEnd), sequence: 1, sourceEnd })
    });
    store.markOutboundReplyDelivered("recovery-content", "card-1");

    await new AnswerPageWorkflow(store, vi.fn(), primaryPresentation).converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([
      expect.objectContaining({ kind: "stream_finish" }),
      expect.objectContaining({ kind: "card_update", rootMessageId: "answer-1" }),
      expect.objectContaining({ kind: "stream_card_create", payload: expect.stringContaining(`\"pageStart\":${sourceEnd}`) })
    ]);
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, sourceStart: 0, state: "active" }),
      expect.objectContaining({ pageIndex: 1, sourceStart: sourceEnd, state: "creating" })
    ]);
    store.close();
  });

  it("updates a short frozen Answer Card to green exactly once after stream finish", async () => {
    const store = readyStore();
    const content = "⏳ 已接收请求\n\ndone";
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);

    await workflow.converge("p1");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    await workflow.converge("p1");

    const [update] = store.listPendingOutboundReplies();
    expect(update).toMatchObject({ kind: "card_update", cardRole: "answer", rootMessageId: "answer-1" });
    expect(update?.payload).toContain('\"template\":\"green\"');
    await workflow.converge("p1");
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    store.close();
  });

  it("keeps the continuation element id when rebuilding a completed closed stream as a static card", async () => {
    const store = readyStore();
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "final answer", answerSegments: ["final answer"], viewVersion: 2 });
    store.database.prepare("UPDATE answer_pages SET state = 'frozen', delivery_mode = 'static' WHERE prompt_id = 'p1' AND page_index = 0").run();
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);

    await workflow.converge("p1");

    const [replacement] = store.listPendingOutboundReplies();
    const payload = JSON.parse(replacement!.payload) as { card: { body: { elements: Array<Record<string, unknown>> } }; stream: { elementId: string } };
    const expectedElementId = answerElementId("p1", 1);
    expect(replacement).toMatchObject({ kind: "stream_card_create", cardRole: "answer", rootMessageId: "root-1" });
    expect(payload.stream.elementId).toBe(expectedElementId);
    expect(payload.card.body.elements).toEqual(expect.arrayContaining([expect.objectContaining({ tag: "markdown", element_id: expectedElementId })]));

    store.markOutboundReplyFailedWithQuarantine(replacement!.id, "invalid legacy payload", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "invalid_card" });
    await workflow.converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.getOutboundReply(replacement!.id)).toMatchObject({ state: "dead_letter", attemptCount: 1, error: "invalid legacy payload" });
    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(1);
    store.close();
  });

  it("upgrades a finished terminal page with folded code exactly once", async () => {
    const store = readyStore();
    const code = Array.from({ length: 81 }, (_, index) => `output line ${index}`).join("\n");
    const answer = `\`\`\`text\n${code}\n\`\`\``;
    const content = `⏳ 已接收请求\n\n${answer}`;
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);

    await workflow.converge("p1");
    const [finish] = store.listPendingOutboundReplies();
    expect(finish).toMatchObject({ kind: "stream_finish" });
    store.markOutboundReplyDelivered(finish!.id, "card-1");

    await workflow.converge("p1");
    const [upgrade] = store.listPendingOutboundReplies();
    expect(upgrade).toMatchObject({ kind: "card_update", cardRole: "answer", rootMessageId: "answer-1" });
    expect(upgrade?.payload).toContain("执行输出");
    expect(upgrade?.payload).toContain("81 行");
    store.markOutboundReplyDelivered(upgrade!.id, "answer-1");
    await workflow.converge("p1");
    expect(store.listPendingOutboundReplies()).toHaveLength(0);
    expect(store.listAnswerPages("p1")[0]).toMatchObject({ state: "finished", sequence: 2 });
    store.close();
  });

  it("preserves the last delivered continuation when the completed answer shrinks below its page start", async () => {
    const store = readyStore();
    const visibleContinuation = "the last visible continuation";
    const elementId = "answer_content_p1_1";
    store.database.exec("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1' AND page_index = 0");
    store.database.prepare("INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 1, 'answer-2', 'card-2', ?, 9351, 10, 'finished', 'streaming', 'now', 'now')").run(elementId);
    store.database.prepare("UPDATE run_cards SET answer_message_id = 'answer-2', answer_card_id = 'card-2', answer_element_id = ?, answer_page_index = 1, answer_page_start = 9351 WHERE prompt_id = 'p1'").run(elementId);
    store.enqueueOutboundReply({
      id: "visible-continuation", idempotencyKey: "visible-continuation", bindingId: "b1", promptId: "p1", viewVersion: 9, cardRole: "answer",
      rootMessageId: "card-2", kind: "stream_content", payload: JSON.stringify({ pageIndex: 1, elementId, content: visibleContinuation, sequence: 9 })
    });
    store.markOutboundReplyDelivered("visible-continuation", "card-2");
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "short final answer", answerSegments: ["short final answer"], viewVersion: 3 });
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);

    await workflow.converge("p1");

    const finalUpdate = store.listPendingOutboundReplies().find((reply) => reply.kind === "card_update")!;
    expect(finalUpdate).toMatchObject({ rootMessageId: "answer-2", cardRole: "answer" });
    expect(finalUpdate.payload).toContain(visibleContinuation);
    expect(finalUpdate.payload).not.toContain('"elements":[]');
    store.close();
  });

  it("appends changed final content while preserving the rejected revision", async () => {
    const store = readyStore();
    const code = Array.from({ length: 81 }, (_, index) => `output line ${index}`).join("\n");
    const answer = `\`\`\`text\n${code}\n\`\`\``;
    const content = `⏳ 已接收请求\n\n${answer}`;
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
    await workflow.converge("p1");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    await workflow.converge("p1");
    const original = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDeadLetter(original.id, "invalid card", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "bad_card" });
    const latestAnswer = `${answer}\n\nlatest terminal state`;
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: latestAnswer, answerSegments: [answer, "latest terminal state"], viewVersion: 3 });

    await workflow.converge("p1");

    const [reopened] = store.listPendingOutboundReplies();
    expect(reopened).toMatchObject({
      state: "pending", attemptCount: 0, error: null, failureClass: null, httpStatus: null, larkErrorCode: null, deadLetteredAt: null, autoRecoveryCount: 0, viewVersion: 3
    });
    expect(reopened!.payload).not.toBe(original.payload);
    expect(reopened!.payload).toContain("latest terminal state");
    expect(reopened!.id).not.toBe(original.id);
    expect(store.getOutboundReply(original.id)).toMatchObject({ state: "dead_letter", larkErrorCode: "bad_card" });
    expect(store.listOutboundLaneHeads(10, null)).toEqual([expect.objectContaining({ id: reopened!.id })]);
    expect(store.getAnswerPageDeliveryFacts("p1", 0).finalUpdateState).toBe("pending");
    store.markOutboundReplyDelivered(reopened!.id, "answer-1");
    expect(store.getAnswerPageDeliveryFacts("p1", 0).finalUpdateState).toBe("delivered");
    await workflow.converge("p1");
    expect(store.listPendingOutboundReplies()).toEqual([]);
    store.close();
  });

  it("does not reopen unchanged dismissed final content", async () => {
    const store = readyStore();
    const answer = `\`\`\`text\n${Array.from({ length: 81 }, (_, index) => `output line ${index}`).join("\n")}\n\`\`\``;
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content: `⏳ 已接收请求\n\n${answer}` })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn(), primaryPresentation);
    await workflow.converge("p1");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    await workflow.converge("p1");
    const original = store.listPendingOutboundReplies()[0]!;
    store.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'superseded', attempt_count = 3 WHERE id = ?").run(original.id);

    await workflow.converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.getOutboundReply(original.id)).toMatchObject({ state: "dismissed", attemptCount: 3, error: "superseded" });
    store.close();
  });
});
