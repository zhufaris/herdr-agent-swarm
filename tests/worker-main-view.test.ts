import { describe, expect, it } from "vitest";
import { createWorkerMainView, reduceWorkerMainView, type WorkerMainTaskSummary } from "../src/domain/worker-main-view.js";

const createdAt = "2026-09-05T00:00:00.000Z";

function task(index: number, phase: WorkerMainTaskSummary["phase"] = "completed"): WorkerMainTaskSummary {
  return {
    turnId: `turn-${index}`, title: `Task ${index}`, phase, durationSeconds: index * 10,
    taskCard: { aggregateKind: "worker-turn", aggregateId: `turn-${index}`, generation: 4, messageId: `message-${index}` },
    updatedAt: `2026-09-05T00:0${index}:00.000Z`
  };
}

function initial() {
  return createWorkerMainView({
    workerId: "worker-1", workerSessionGeneration: 3, parentBindingId: "binding-1", parentBindingGeneration: 7, parentPaneId: "pane-primary",
    workerName: "reviewer", ownerName: "Primary", runtimeGeneration: 4, runtimeState: "idle", runtimeAttached: true, desiredState: "running", parentActive: true, workspace: "/repo/.worktree/reviewer", branch: "swarm/reviewer", model: "GPT-5", occurredAt: createdAt
  });
}

describe("WorkerMainView", () => {
  it("keeps session identity across runtime replacement and freezes the exact session generation", () => {
    const restarted = reduceWorkerMainView(initial(), { type: "runtime", runtimeGeneration: 5, runtimeState: "working", runtimeAttached: true, desiredState: "running", parentActive: true, paneId: "pane-replacement", occurredAt: "2026-09-05T00:01:00.000Z" });
    const frozen = reduceWorkerMainView(restarted, { type: "terminated", occurredAt: "2026-09-05T00:02:00.000Z" });
    const late = reduceWorkerMainView(frozen, { type: "runtime", runtimeGeneration: 6, runtimeState: "idle", paneId: "late-pane", occurredAt: "2026-09-05T00:03:00.000Z" });

    expect(restarted).toMatchObject({ workerId: "worker-1", workerSessionGeneration: 3, runtimeGeneration: 5, paneId: "pane-replacement", frozenAt: null, viewVersion: 2 });
    expect(frozen).toMatchObject({ workerSessionGeneration: 3, runtimeState: "terminated", frozenAt: "2026-09-05T00:02:00.000Z", viewVersion: 3 });
    expect(late).toBe(frozen);
  });

  it("keeps one current task, a bounded queue summary, and five newest terminal summaries", () => {
    const view = reduceWorkerMainView(initial(), {
      type: "tasks",
      currentTask: { ...task(9, "running"), requestText: "full request", answer: "bounded answer", statusTitle: "working" },
      queueCount: 3,
      nextTaskTitle: "Next safe task",
      recentTasks: [task(1), task(6, "failed"), task(3), task(5), task(2), task(4)],
      occurredAt: "2026-09-05T00:10:00.000Z"
    });

    expect(view.currentTask).toMatchObject({ turnId: "turn-9", title: "Task 9", phase: "running" });
    expect(view.queueCount).toBe(3);
    expect(view.nextTaskTitle).toBe("Next safe task");
    expect(view.recentTasks.map(({ turnId }) => turnId)).toEqual(["turn-6", "turn-5", "turn-4", "turn-3", "turn-2"]);
    expect(view.currentTask).toMatchObject({ requestText: "full request", answer: "bounded answer", statusTitle: "working" });
    expect(view.recentTasks.every((item) => item.requestText === undefined && item.answer === undefined)).toBe(true);
  });

  it("does not advance the view version for an unchanged projection", () => {
    const current = initial();
    expect(reduceWorkerMainView(current, { type: "runtime", runtimeGeneration: 4, runtimeState: "idle", runtimeAttached: true, desiredState: "running", parentActive: true, paneId: null, occurredAt: "later" })).toBe(current);
    expect(reduceWorkerMainView(current, { type: "tasks", currentTask: null, queueCount: 0, nextTaskTitle: null, recentTasks: [], dependencyRevision: 2, occurredAt: "later" })).toMatchObject({ viewVersion: 1, dependencyRevision: 2 });
  });
});
