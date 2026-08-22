import { describe, expect, it } from "vitest";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";

describe("request run-card view", () => {
  it("accumulates safe output, deduplicates progress, and completes with the final answer", () => {
    const queued = createQueuedRunCard({
      promptId: "p1", bindingId: "b1", title: "Fix login", workspaceId: "w1",
      paneId: "w1:p2", requestText: "Please **fix** login", queuePosition: 2, occurredAt: "2026-08-22T10:00:00.000Z"
    });
    const running = reduceRunCard(queued, {
      type: "started", occurredAt: "2026-08-22T10:00:01.000Z"
    });
    const observed = reduceRunCard(running, {
      type: "output", occurredAt: "2026-08-22T10:00:02.000Z", answerDelta: "Working ",
      progressEvents: [{ key: "read:src/a.ts", kind: "read", label: "已读取 src/a.ts", state: "done", occurredAt: "2026-08-22T10:00:02.000Z" }]
    });
    const duplicate = reduceRunCard(observed, {
      type: "output", occurredAt: "2026-08-22T10:00:03.000Z", answerDelta: "on it",
      progressEvents: [{ key: "read:src/a.ts", kind: "read", label: "已读取 src/a.ts", state: "done", occurredAt: "2026-08-22T10:00:03.000Z" }]
    });
    const completed = reduceRunCard(duplicate, {
      type: "completed", occurredAt: "2026-08-22T10:00:04.000Z", answer: "Fixed login."
    });

    expect(queued).toMatchObject({ promptId: "p1", requestText: "Please **fix** login", phase: "queued", queuePosition: 2, viewVersion: 1 });
    expect(running).toMatchObject({ phase: "running", startedAt: "2026-08-22T10:00:01.000Z", viewVersion: 2 });
    expect(duplicate).toMatchObject({ answer: "Working on it", viewVersion: 4 });
    expect(duplicate.progressEvents).toHaveLength(1);
    expect(completed).toMatchObject({ phase: "completed", answer: "Fixed login.", finishedAt: "2026-08-22T10:00:04.000Z", viewVersion: 5 });
  });

  it("does not advance the version for an identical visible update", () => {
    const queued = createQueuedRunCard({
      promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1",
      paneId: null, requestText: "Task", queuePosition: 1, occurredAt: "2026-08-22T10:00:00.000Z"
    });
    expect(reduceRunCard(queued, { type: "queue-position", occurredAt: "later", queuePosition: 1 })).toBe(queued);
    const running = reduceRunCard(queued, { type: "started", occurredAt: "started" });
    expect(reduceRunCard(running, { type: "started", occurredAt: "later" })).toBe(running);
    const blocked = reduceRunCard(running, { type: "blocked", occurredAt: "blocked", notice: "approval needed" });
    expect(reduceRunCard(blocked, { type: "blocked", occurredAt: "later", notice: "approval needed" })).toBe(blocked);
  });

  it("completes a steering card with an acknowledgement instead of a copied answer", () => {
    const queued = createQueuedRunCard({
      promptId: "s1", bindingId: "b1", title: "Change course", workspaceId: "w1",
      paneId: "w1:p1", requestText: "Change course", queuePosition: 0, occurredAt: "start"
    });
    const delivered = reduceRunCard(queued, { type: "steering-delivered", occurredAt: "done", notice: "已加入当前执行" });
    expect(delivered).toMatchObject({ phase: "completed", answer: "", notice: "已加入当前执行", queuePosition: 0, finishedAt: "done" });
  });
});
