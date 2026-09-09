import { describe, expect, it } from "vitest";
import { renderWorkerMainCard, renderWorkerStatusSnapshot } from "../src/cards/worker-main-card.js";
import { createWorkerMainView, reduceWorkerMainView } from "../src/domain/worker-main-view.js";

function view() {
  return createWorkerMainView({
    workerId: "worker-1", workerSessionGeneration: 3, parentBindingId: "binding-1", parentBindingGeneration: 7, parentPaneId: "pane-primary", workerName: "reviewer", ownerName: "Primary",
    runtimeGeneration: 4, runtimeState: "working", runtimeAttached: true, desiredState: "running", parentActive: true, workspace: "/repo/.worktree/reviewer", branch: "swarm/reviewer", model: "GPT-5", occurredAt: "2026-09-05T00:00:00.000Z"
  });
}

describe("Worker Main card", () => {
  it("renders one immutable status snapshot with a stable timestamp and canonical-card target", () => {
    const rendered = JSON.stringify(renderWorkerStatusSnapshot({ ...view(), messageId: "om_worker_main" }, "2026-09-09T13:00:00.000Z"));
    expect(rendered).toContain("📸 Worker 状态快照 · reviewer");
    expect(rendered).toContain("一次性快照，不会自动更新");
    expect(rendered).toContain("2026-09-09T13:00:00.000Z");
    expect(rendered).toContain("card_target_open");
    expect(rendered).toContain("om_worker_main");
    expect(rendered).not.toContain("worker_new_task_form");
    expect(rendered).not.toContain("worker_task_instruction_form");
    expect(rendered).not.toContain("worker_task_interrupt");
  });

  it("renders the current task in the stable Worker card without Task Card links", () => {
    const projected = reduceWorkerMainView(view(), { type: "tasks", currentTask: {
      turnId: "turn-current", title: "Review auth boundary", phase: "running", durationSeconds: 74, updatedAt: "2026-09-05T00:01:00.000Z",
      taskCard: { aggregateKind: "worker-turn", aggregateId: "turn-current", generation: 4, messageId: null },
      requestText: "Review auth boundary and summarize findings", statusTitle: "Inspecting ownership fences",
      progressEvents: [{ key: "inspect", kind: "tool", label: "Read ownership policy", state: "done", occurredAt: "2026-09-05T00:00:30.000Z" }],
      answer: "Current bounded output"
    }, queueCount: 1, nextTaskTitle: "Run recovery tests", recentTasks: [], occurredAt: "2026-09-05T00:01:00.000Z" });
    const rendered = JSON.stringify(renderWorkerMainCard({ ...projected, messageId: "om_worker_main" }));

    expect(rendered).toContain("🤖 Worker · reviewer");
    expect(rendered).toContain("Review auth boundary and summarize findings");
    expect(rendered).toContain("Inspecting ownership fences");
    expect(rendered).toContain("Read ownership policy");
    expect(rendered).toContain("Current bounded output");
    expect(rendered).toContain("Run recovery tests");
    expect(rendered).toContain("worker_task_instruction_form");
    expect(rendered).toContain("worker_task_interrupt");
    expect(rendered).not.toContain("card_target_open");
    expect(rendered).toContain("worker_new_task_form");
  });

  it("keeps the latest terminal result visible and offers an explicit follow-up", () => {
    const projected = reduceWorkerMainView(view(), { type: "tasks", currentTask: {
      turnId: "turn-done", title: "Finished task", phase: "completed", durationSeconds: 8, updatedAt: "2026-09-05T00:01:00.000Z",
      taskCard: { aggregateKind: "worker-turn", aggregateId: "turn-done", generation: 4, messageId: null }, answer: "Final result"
    }, queueCount: 0, nextTaskTitle: null, recentTasks: [], occurredAt: "2026-09-05T00:01:00.000Z" });
    const rendered = JSON.stringify(renderWorkerMainCard({ ...projected, messageId: "om_worker_main" }));
    expect(rendered).toContain("Final result");
    expect(rendered).toContain("worker_task_instruction_form");
    expect(rendered).not.toContain("worker_task_interrupt");
  });

  it("exposes no live controls after termination", () => {
    const frozen = reduceWorkerMainView(view(), { type: "terminated", occurredAt: "2026-09-05T00:02:00.000Z" });
    const text = JSON.stringify(renderWorkerMainCard(frozen));
    expect(text).toContain("已终止");
    expect(text).toContain("📦 Worker session 已终止并冻结");
    expect(text).not.toContain("instance_steer");
    expect(text).not.toContain("instance_stop");
  });

  it("states that a new task can run immediately when the Worker is idle", () => {
    const text = JSON.stringify(renderWorkerMainCard({ ...view(), messageId: "om_worker_main", runtimeState: "idle" }));
    expect(text).toContain("立即执行");
    expect(text).toContain("发起新任务");
  });

  it("does not emit callbacks until the stable card message identity is checkpointed", () => {
    const text = JSON.stringify(renderWorkerMainCard(view()));
    expect(text).not.toContain("worker_new_task_form");
    expect(text).not.toContain("sourceCardMessageId");
  });

  it.each(["unprovisioned", "starting", "detached", "stopped", "failed", "terminated"] as const)("hides new-task controls while runtime is %s", (runtimeState) => {
    const text = JSON.stringify(renderWorkerMainCard({ ...view(), messageId: "om_worker_main", runtimeState }));
    expect(text).not.toContain("worker_new_task_form");
  });

  it.each([
    { runtimeAttached: false, desiredState: "running" as const, parentActive: true },
    { runtimeAttached: true, desiredState: "stopped" as const, parentActive: true },
    { runtimeAttached: true, desiredState: "running" as const, parentActive: false }
  ])("hides new-task controls when submission ownership is unavailable: %j", (availability) => {
    const text = JSON.stringify(renderWorkerMainCard({ ...view(), ...availability, messageId: "om_worker_main", runtimeState: "idle" }));
    expect(text).not.toContain("worker_new_task_form");
  });
});
