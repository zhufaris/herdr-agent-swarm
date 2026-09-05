import { describe, expect, it } from "vitest";
import { renderWorkerMainCard } from "../src/cards/worker-main-card.js";
import { createWorkerMainView, reduceWorkerMainView } from "../src/domain/worker-main-view.js";

function view() {
  return createWorkerMainView({
    workerId: "worker-1", workerSessionGeneration: 3, parentBindingId: "binding-1", parentBindingGeneration: 7, parentPaneId: "pane-primary", workerName: "reviewer", ownerName: "Primary",
    runtimeGeneration: 4, runtimeState: "working", workspace: "/repo/.worktree/reviewer", branch: "swarm/reviewer", model: "GPT-5", occurredAt: "2026-09-05T00:00:00.000Z"
  });
}

describe("Worker Main card", () => {
  it("renders bounded summaries and hides links until their delivery checkpoint exists", () => {
    const projected = reduceWorkerMainView(view(), { type: "tasks", currentTask: {
      turnId: "turn-current", title: "Review auth boundary", phase: "running", durationSeconds: 74, updatedAt: "2026-09-05T00:01:00.000Z",
      taskCard: { aggregateKind: "worker-turn", aggregateId: "turn-current", generation: 4, messageId: null }
    }, queueCount: 1, nextTaskTitle: "Run recovery tests", recentTasks: [], occurredAt: "2026-09-05T00:01:00.000Z" });
    const withoutLink = JSON.stringify(renderWorkerMainCard(projected));
    const withLink = JSON.stringify(renderWorkerMainCard({ ...projected, currentTask: { ...projected.currentTask!, taskCard: { ...projected.currentTask!.taskCard, messageId: "om_task_card" } } }));

    expect(withoutLink).toContain("reviewer");
    expect(withoutLink).toContain("Review auth boundary");
    expect(withoutLink).toContain("Run recovery tests");
    expect(withoutLink).not.toContain("om_task_card");
    expect(withLink).toContain("om_task_card");
    expect(withLink).not.toContain("requestText");
    expect(withLink).not.toContain("answer");
  });

  it("exposes no live controls after termination", () => {
    const frozen = reduceWorkerMainView(view(), { type: "terminated", occurredAt: "2026-09-05T00:02:00.000Z" });
    const text = JSON.stringify(renderWorkerMainCard(frozen));
    expect(text).toContain("已终止");
    expect(text).not.toContain("instance_steer");
    expect(text).not.toContain("instance_stop");
  });
});
