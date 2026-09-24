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

function setup(answer: string, phase: "running" | "completed" = "completed") {
  const { view, page } = fixture(answer, phase);
  const facts = { latestContent: null, finishPending: false, continuationPending: false, finalUpdateState: null };
  const store = {
    loadWorkerTurnCard: vi.fn(() => view), listWorkerTurnCardPages: vi.fn(() => [page]),
    getWorkerTurnCardDeliveryFacts: vi.fn(() => facts),
    reserveWorkerTurnContent: vi.fn(() => "reserved" as const), reserveWorkerTurnProgress: vi.fn(() => "reserved" as const),
    reserveWorkerTurnFinish: vi.fn(() => "reserved" as const), reserveWorkerTurnCardHydration: vi.fn(() => "waiting" as const),
    reserveWorkerTurnContinuation: vi.fn(() => "reserved" as const)
  } satisfies WorkerTurnCardStore;
  const wake = vi.fn();
  const workflow = new WorkerTurnCardWorkflow(store, wake, workerPresentation, 120);
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
