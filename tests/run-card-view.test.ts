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
      type: "output", occurredAt: "2026-08-22T10:00:02.000Z", answerSnapshot: "Working ",
      progressEvents: [{ key: "read:src/a.ts", kind: "read", label: "已读取 src/a.ts", state: "done", occurredAt: "2026-08-22T10:00:02.000Z" }]
    });
    const duplicate = reduceRunCard(observed, {
      type: "output", occurredAt: "2026-08-22T10:00:03.000Z", answerSnapshot: "Working on it",
      progressEvents: [{ key: "read:src/a.ts", kind: "read", label: "已读取 src/a.ts", state: "done", occurredAt: "2026-08-22T10:00:03.000Z" }]
    });
    const completed = reduceRunCard(duplicate, {
      type: "completed", occurredAt: "2026-08-22T10:00:04.000Z", answer: "Fixed login."
    });

    expect(queued).toMatchObject({ promptId: "p1", requestText: "Please **fix** login", phase: "queued", queuePosition: 2, viewVersion: 1 });
    expect(running).toMatchObject({ phase: "running", startedAt: "2026-08-22T10:00:01.000Z", viewVersion: 2 });
    expect(duplicate).toMatchObject({ answer: "Working on it", viewVersion: 4 });
    expect(duplicate.progressEvents).toHaveLength(1);
    expect(completed).toMatchObject({ phase: "completed", answer: "Working on it\n\nFixed login.", finishedAt: "2026-08-22T10:00:04.000Z", viewVersion: 5 });
  });

  it("replaces a live status snapshot and ignores an identical refresh", () => {
    const queued = createQueuedRunCard({
      promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "run", queuePosition: 1, occurredAt: "start"
    });
    const running = reduceRunCard(queued, { type: "started", occurredAt: "started" });
    const prose = reduceRunCard(running, { type: "output", occurredAt: "prose", answerSnapshot: "Finished inspection", answerUpdate: "replace", progressEvents: [] });
    const first = reduceRunCard(prose, { type: "output", occurredAt: "one", answerSnapshot: "Working (1m)\n9 tasks (7 done)", answerUpdate: "replace-status", progressEvents: [] });
    const second = reduceRunCard(first, { type: "output", occurredAt: "two", answerSnapshot: "Working (2m)\n9 tasks (8 done)", answerUpdate: "replace-status", progressEvents: [] });
    const resumed = reduceRunCard(second, { type: "output", occurredAt: "resume", answerSnapshot: "Implemented fix", answerUpdate: "append", progressEvents: [] });
    const duplicate = reduceRunCard(second, { type: "output", occurredAt: "three", answerSnapshot: "Working (2m)\n9 tasks (8 done)", answerUpdate: "replace-status", progressEvents: [] });

    expect(second).toMatchObject({ answerSegments: ["Finished inspection"], answerDraft: "Working (2m)\n9 tasks (8 done)", answerDraftTransient: true });
    expect(second.answer).not.toContain("Working (1m)");
    expect(resumed).toMatchObject({ answerSegments: ["Finished inspection"], answerDraft: "Implemented fix", answer: "Finished inspection\n\nImplemented fix" });
    expect(duplicate).toBe(second);
  });

  it("accumulates distinct answer blocks while replacing growth of the current block", () => {
    const queued = createQueuedRunCard({
      promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "run", queuePosition: 1, occurredAt: "start"
    });
    const first = reduceRunCard(queued, { type: "output", occurredAt: "one", answerSnapshot: "First", previousAnswerSnapshot: "", answerUpdate: "replace", progressEvents: [] });
    const grown = reduceRunCard(first, { type: "output", occurredAt: "two", answerSnapshot: "First complete", previousAnswerSnapshot: "First", answerUpdate: "replace", progressEvents: [] });
    const second = reduceRunCard(grown, { type: "output", occurredAt: "three", answerSnapshot: "Second", previousAnswerSnapshot: "First complete", answerUpdate: "append", progressEvents: [] });
    const secondGrown = reduceRunCard(second, { type: "output", occurredAt: "four", answerSnapshot: "Second complete", previousAnswerSnapshot: "Second", answerUpdate: "replace", progressEvents: [] });

    expect(first).toMatchObject({ answerSegments: [], answerDraft: "First", answer: "First" });
    expect(grown).toMatchObject({ answerSegments: [], answerDraft: "First complete", answer: "First complete" });
    expect(second).toMatchObject({ answerSegments: ["First complete"], answerDraft: "Second", answer: "First complete\n\nSecond" });
    expect(secondGrown).toMatchObject({ answerSegments: ["First complete"], answerDraft: "Second complete", answer: "First complete\n\nSecond complete" });

    const completed = reduceRunCard(secondGrown, { type: "completed", occurredAt: "done", answer: "Second complete" });
    expect(completed).toMatchObject({ answerSegments: ["First complete", "Second complete"], answerDraft: "", answer: "First complete\n\nSecond complete" });
  });

  it("uses a grown final answer instead of preserving its partial draft", () => {
    const queued = createQueuedRunCard({
      promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "run", queuePosition: 1, occurredAt: "start"
    });
    const partial = reduceRunCard(queued, { type: "output", occurredAt: "one", answerSnapshot: "Implemented", answerUpdate: "replace", progressEvents: [] });
    const completed = reduceRunCard(partial, { type: "completed", occurredAt: "done", answer: "Implemented and verified." });

    expect(completed).toMatchObject({ answerSegments: ["Implemented and verified."], answerDraft: "", answer: "Implemented and verified." });
  });

  it("replaces the full transient terminal transcript after a screen redraw", () => {
    const queued = createQueuedRunCard({
      promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "run", queuePosition: 1, occurredAt: "start"
    });
    const first = reduceRunCard(queued, { type: "output", occurredAt: "one", answerSnapshot: "◆ Old screen", answerUpdate: "append", progressEvents: [] });
    const redrawn = reduceRunCard(first, { type: "output", occurredAt: "two", answerSnapshot: "◆ Current screen", answerUpdate: "replace-all", progressEvents: [] });

    expect(redrawn).toMatchObject({ answer: "◆ Current screen", answerSegments: [], answerDraft: "◆ Current screen" });
    expect(redrawn.answer).not.toContain("Old screen");
  });

  it("ignores an identical structured progress snapshot with a newer observation time", () => {
    const queued = createQueuedRunCard({
      promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "run", queuePosition: 1, occurredAt: "start"
    });
    const first = reduceRunCard(queued, { type: "output", occurredAt: "one", answerSnapshot: "Working", hasProgressSnapshot: true, progressEvents: [{ key: "step:test", kind: "step", label: "Run tests", state: "active", occurredAt: "one" }] });
    const duplicate = reduceRunCard(first, { type: "output", occurredAt: "two", answerSnapshot: "Working", hasProgressSnapshot: true, progressEvents: [{ key: "step:test", kind: "step", label: "Run tests", state: "active", occurredAt: "two" }] });

    expect(duplicate).toBe(first);
  });

  it("keeps the current answer when an observation only refreshes progress", () => {
    const queued = createQueuedRunCard({
      promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "run", queuePosition: 1, occurredAt: "start"
    });
    const answer = reduceRunCard(queued, { type: "output", occurredAt: "one", answerSnapshot: "Inspecting code", progressEvents: [] });
    const progressOnly = reduceRunCard(answer, {
      type: "output", occurredAt: "two", answerSnapshot: "", hasProgressSnapshot: true,
      progressEvents: [{ key: "step:test", kind: "step", label: "Run tests", state: "active", occurredAt: "two" }]
    });

    expect(progressOnly).toMatchObject({ answer: "Inspecting code", answerSegments: [], answerDraft: "Inspecting code" });
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
