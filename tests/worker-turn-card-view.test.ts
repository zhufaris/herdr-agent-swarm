import { describe, expect, it } from "vitest";
import { createQueuedWorkerTurnCard, reduceWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";

const createdAt = "2026-09-01T00:00:00.000Z";

function queued() {
  return createQueuedWorkerTurnCard({
    turnId: "turn-a", instanceId: "worker-1", instanceGeneration: 2, workerName: "reviewer",
    parentTurnId: null, rootMessageId: "root-1", requestText: "Review the transaction boundary",
    queuePosition: 2, resultCapture: "pending", occurredAt: createdAt
  });
}

describe("WorkerTurnCardView", () => {
  it("creates a queued projection with stable delivery identity", () => {
    expect(queued()).toEqual({
      turnId: "turn-a", instanceId: "worker-1", instanceGeneration: 2, workerName: "reviewer", parentTurnId: null,
      rootMessageId: "root-1", messageId: null, cardId: null, elementId: "worker_turn_turn_a_0", progressSequence: 0,
      phase: "queued", requestText: "Review the transaction boundary", answer: "", statusTitle: null, progressEvents: [], progressSummary: { total: 0, stepTotal: 0, stepDone: 0 }, queuePosition: 2,
      startedAt: null, finishedAt: null, notice: null, resultCapture: "pending",
      workerSessionGeneration: 1, workerMain: { aggregateKind: "worker-session", aggregateId: "worker-1", generation: 1, messageId: null }, primaryAnswer: null, pageIndex: 0, pageStart: 0,
      sequence: 0, viewVersion: 1, deliveredVersion: 0, createdAt, updatedAt: createdAt
    });
  });

  it("reduces lifecycle and output changes monotonically", () => {
    const preparing = reduceWorkerTurnCard(queued(), { type: "preparing", occurredAt: "2026-09-01T00:00:01.000Z" });
    const running = reduceWorkerTurnCard(preparing, { type: "running", occurredAt: "2026-09-01T00:00:02.000Z" });
    const blocked = reduceWorkerTurnCard(running, { type: "blocked", occurredAt: "2026-09-01T00:00:03.000Z", notice: "Needs local approval" });
    const output = reduceWorkerTurnCard(blocked, { type: "output", occurredAt: "2026-09-01T00:00:04.000Z", answer: "Finding one" });
    const completed = reduceWorkerTurnCard(output, { type: "completed", occurredAt: "2026-09-01T00:00:05.000Z", answer: "Finding one\nFinding two" });

    expect(preparing).toMatchObject({ phase: "preparing", viewVersion: 2 });
    expect(running).toMatchObject({ phase: "running", startedAt: "2026-09-01T00:00:02.000Z", viewVersion: 3 });
    expect(blocked).toMatchObject({ phase: "blocked", notice: "Needs local approval", viewVersion: 4 });
    expect(output).toMatchObject({ phase: "blocked", answer: "Finding one", viewVersion: 5 });
    expect(completed).toMatchObject({ phase: "completed", answer: "Finding one\nFinding two", resultCapture: "captured", queuePosition: 0, finishedAt: "2026-09-01T00:00:05.000Z", viewVersion: 6 });
  });

  it("represents unavailable and uncertain results explicitly", () => {
    const unavailable = reduceWorkerTurnCard(queued(), { type: "completed-without-output", occurredAt: "2026-09-01T00:00:06.000Z", notice: "Structured output is unavailable" });
    const uncertain = reduceWorkerTurnCard(queued(), { type: "dispatch-uncertain", occurredAt: "2026-09-01T00:00:07.000Z", notice: "Delivery could not be proven" });
    const failed = reduceWorkerTurnCard(queued(), { type: "failed", occurredAt: "2026-09-01T00:00:08.000Z", notice: "Adapter unavailable" });
    const cancelled = reduceWorkerTurnCard(queued(), { type: "cancelled", occurredAt: "2026-09-01T00:00:09.000Z", notice: "Interrupted" });

    expect(unavailable).toMatchObject({ phase: "completed", resultCapture: "unavailable", answer: "", queuePosition: 0 });
    expect(uncertain).toMatchObject({ phase: "dispatch-uncertain", resultCapture: "pending", queuePosition: 0 });
    expect(failed).toMatchObject({ phase: "failed", finishedAt: "2026-09-01T00:00:08.000Z", queuePosition: 0 });
    expect(cancelled).toMatchObject({ phase: "cancelled", finishedAt: "2026-09-01T00:00:09.000Z", queuePosition: 0 });
  });

  it("does not increment the version for an unchanged queue position", () => {
    const current = queued();
    expect(reduceWorkerTurnCard(current, { type: "queue-position", occurredAt: "later", queuePosition: 2 })).toBe(current);
  });
});
