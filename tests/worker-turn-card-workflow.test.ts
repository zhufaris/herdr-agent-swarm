import { describe, expect, it, vi } from "vitest";
import { WorkerTurnCardWorkflow } from "../src/coordinator/worker-turn-card-workflow.js";
import { continuationSummary } from "../src/domain/card-page-handoff.js";
import type { WorkerTurnCardStore } from "../src/domain/ports/instance.js";
import { createQueuedWorkerTurnCard, reduceWorkerTurnCard, workerTurnElementId, type WorkerTurnCardPage } from "../src/domain/worker-turn-card-view.js";
import { workerPresentation } from "./helpers/presentation.js";

function fixture(answer: string, phase: "running" | "completed" = "completed") {
  const queued = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: "worker-1", instanceGeneration: 2, workerSessionGeneration: 3, workerName: "reviewer", parentTurnId: null, rootMessageId: "root-1", requestText: "review", queuePosition: 1, occurredAt: "2026-09-24T00:00:00.000Z" });
  const view = phase === "completed"
    ? reduceWorkerTurnCard(queued, { type: "completed", occurredAt: "2026-09-24T00:01:00.000Z", answer })
    : { ...reduceWorkerTurnCard(queued, { type: "running", occurredAt: "2026-09-24T00:00:01.000Z" }), answer };
  const page: WorkerTurnCardPage = { id: "turn-1:0", turnId: "turn-1", pageIndex: 0, pageStart: 0, elementId: workerTurnElementId("turn-1", 0), messageId: "message-1", cardId: "card-1", state: "active", sequence: 0, createdAt: view.createdAt, updatedAt: view.updatedAt };
  return { view: { ...view, messageId: page.messageId, cardId: page.cardId }, page };
}

function setup(answer: string, phase: "running" | "completed" = "completed", pageLimit = 120) {
  const { view, page } = fixture(answer, phase);
  const facts = { latestContent: null, finishPending: false, continuationPending: false, finalUpdateState: null };
  const store = {
    loadWorkerTurnCard: vi.fn(() => view), listWorkerTurnCardPages: vi.fn(() => [page]),
    getWorkerTurnCardDeliveryFacts: vi.fn(() => facts),
    getWorkerAnswerTimelinePage: vi.fn(() => ({ startCursor: { itemIndex: 0, markdownOffset: 0 }, deliveredCursor: null, deliveredItems: [], pending: false })),
    listFrozenWorkerAnswerTimelineItems: vi.fn(() => []), reserveWorkerAnswerTimelineCard: vi.fn(() => "reserved" as const),
    reserveWorkerTurnContent: vi.fn(() => "reserved" as const), reserveWorkerTurnProgress: vi.fn(() => "reserved" as const),
    reserveWorkerTurnFinish: vi.fn(() => "reserved" as const), reserveWorkerTurnCardHydration: vi.fn(() => "waiting" as const),
    reserveWorkerTurnContinuation: vi.fn(() => "reserved" as const)
  } satisfies WorkerTurnCardStore;
  const wake = vi.fn();
  const workflow = new WorkerTurnCardWorkflow(store, wake, workerPresentation, pageLimit);
  return { workflow, store, wake, facts, view, page };
}

describe("WorkerTurnCardWorkflow", () => {
  it("projects live progress through a durable stream reservation", async () => {
    const { workflow, store, wake } = setup("partial", "running");
    await workflow.converge("turn-1");
    expect(store.reserveWorkerTurnProgress).toHaveBeenCalledOnce();
    expect(store.reserveWorkerTurnContent).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledOnce();
  });

  it("streams terminal content before finishing", async () => {
    const { workflow, store } = setup("final answer");
    await workflow.converge("turn-1");
    expect(store.reserveWorkerTurnContent).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("final answer"), sourceEnd: expect.any(Number) }));
    expect(store.reserveWorkerTurnFinish).not.toHaveBeenCalled();
  });

  it("uses durable whole-card timeline snapshots for live Worker output", async () => {
    const { workflow, store, view } = setup("legacy", "running", 2_000);
    view.timelineItems = [
      { kind: "agent_message", id: "message:one", sequence: 1, markdown: "Checking" },
      { kind: "tool", id: "tool:one", sequence: 2, category: "test", label: "npm test", state: "running" }
    ];
    await workflow.converge("turn-1");

    expect(store.reserveWorkerAnswerTimelineCard).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn-1", pageIndex: 0, cursor: null, items: expect.arrayContaining([expect.objectContaining({ id: "tool:one" })])
    }));
    const card = store.reserveWorkerAnswerTimelineCard.mock.calls[0]![0].card;
    expect(JSON.stringify(card)).toContain("🧪 Test · npm test · … 运行中");
    expect(store.reserveWorkerTurnProgress).not.toHaveBeenCalled();
    expect(store.reserveWorkerTurnContent).not.toHaveBeenCalled();
  });

  it("keeps a fully delivered live Worker timeline open", async () => {
    const { workflow, store, view } = setup("legacy", "running", 2_000);
    view.timelineItems = [{ kind: "agent_message", id: "message:one", sequence: 1, markdown: "Still working" }];
    store.reserveWorkerAnswerTimelineCard.mockReturnValue("waiting");
    store.getWorkerAnswerTimelinePage.mockReturnValue({
      startCursor: { itemIndex: 0, markdownOffset: 0 }, deliveredCursor: null,
      deliveredItems: [], pending: false
    });

    await workflow.converge("turn-1");

    expect(store.reserveWorkerTurnFinish).not.toHaveBeenCalled();
    expect(store.reserveWorkerTurnContinuation).not.toHaveBeenCalled();
  });

  it("continues a delivered Worker timeline without splitting its Tool panel", async () => {
    const { workflow, store, view } = setup("legacy", "running", 500);
    view.timelineItems = [
      { kind: "agent_message", id: "message:long", sequence: 1, markdown: "line\n".repeat(50) },
      { kind: "tool", id: "tool:one", sequence: 2, category: "command", label: "npm test", command: "npm test", resultPreview: "passed", state: "succeeded" }
    ];
    await workflow.converge("turn-1");
    const first = store.reserveWorkerAnswerTimelineCard.mock.calls[0]![0];
    expect(JSON.stringify(first.card)).not.toContain("npm test");

    store.reserveWorkerAnswerTimelineCard.mockReturnValue("waiting");
    store.getWorkerAnswerTimelinePage.mockReturnValue({
      startCursor: { itemIndex: 0, markdownOffset: 0 }, deliveredCursor: first.cursor,
      deliveredItems: [], pending: false
    });
    await workflow.converge("turn-1");

    expect(store.reserveWorkerTurnContinuation).toHaveBeenCalledWith(expect.objectContaining({
      nextPageIndex: 1, timelineStartCursor: first.cursor, timelineItems: expect.arrayContaining([expect.objectContaining({ id: "tool:one" })])
    }));
    expect(JSON.stringify(store.reserveWorkerTurnContinuation.mock.calls[0]![0].card)).toContain("npm test");
  });

  it("projects a late Worker Tool result onto the active page", async () => {
    const { workflow, store, view, page } = setup("legacy", "running", 1_500);
    page.pageIndex = 1;
    page.pageStart = 1;
    page.id = "turn-1:1";
    page.elementId = workerTurnElementId("turn-1", 1);
    page.messageId = "message-2";
    page.cardId = "card-2";
    view.messageId = page.messageId;
    view.cardId = page.cardId;
    view.timelineItems = [
      { kind: "tool", id: "tool:late", sequence: 1, category: "command", label: "npm test", command: "npm test", resultPreview: "all tests passed", state: "succeeded" },
      { kind: "agent_message", id: "message:two", sequence: 2, markdown: "Continuing" }
    ];
    store.getWorkerAnswerTimelinePage.mockReturnValue({
      startCursor: { itemIndex: 1, markdownOffset: 0 }, deliveredCursor: null, deliveredItems: [], pending: false
    });
    store.listFrozenWorkerAnswerTimelineItems.mockReturnValue([{ pageIndex: 0, id: "tool:late", fingerprint: "old-running-tool" }]);

    await workflow.converge("turn-1");

    const update = store.reserveWorkerAnswerTimelineCard.mock.calls[0]![0];
    expect(update.messageId).toBe("message-2");
    expect(JSON.stringify(update.card)).toContain("npm test（更新自第 1 页）");
    expect(JSON.stringify(update.card)).toContain("all tests passed");
    expect(update.items.filter(({ id }) => id === "late:tool:late")).toHaveLength(1);
  });

  it("uses the shared handoff policy after the current content checkpoint", async () => {
    const { workflow, store, facts } = setup("line\n".repeat(200));
    const rendered = workerPresentation.workerTurnPage(store.loadWorkerTurnCard("turn-1")!, 0, 120);
    facts.latestContent = { content: rendered.page, sequence: 1, state: "delivered", sourceEnd: rendered.nextPageStart };
    await workflow.converge("turn-1");
    expect(store.reserveWorkerTurnContinuation).toHaveBeenCalledWith(expect.objectContaining({ nextPageIndex: 1, nextPageStart: rendered.nextPageStart, summary: continuationSummary(1), card: expect.objectContaining({ body: expect.any(Object) }) }));
    const continuationCard = store.reserveWorkerTurnContinuation.mock.calls[0]![0].card as { body: { elements: Array<{ content?: string }> } };
    expect(continuationCard.body.elements.some(({ content }) => content === workerPresentation.workerTurnPage(store.loadWorkerTurnCard("turn-1")!, rendered.nextPageStart!, 120).page)).toBe(true);
  });

  it("waits at pending and dead-lettered content checkpoints", async () => {
    for (const state of ["pending", "dead_letter"] as const) {
      const { workflow, store, facts } = setup("final answer");
      facts.latestContent = { content: "old", sequence: 1, state, sourceEnd: null };
      await workflow.converge("turn-1");
      expect(store.reserveWorkerTurnContent).not.toHaveBeenCalled();
      expect(store.reserveWorkerTurnFinish).not.toHaveBeenCalled();
      expect(store.reserveWorkerTurnContinuation).not.toHaveBeenCalled();
    }
  });

  it("serializes duplicate convergence and preserves store idempotency", async () => {
    const { workflow, store } = setup("final answer");
    store.reserveWorkerTurnContent.mockReturnValueOnce("reserved").mockReturnValueOnce("waiting");
    await Promise.all([workflow.converge("turn-1"), workflow.converge("turn-1")]);
    expect(store.reserveWorkerTurnContent).toHaveBeenCalledTimes(2);
  });
});
