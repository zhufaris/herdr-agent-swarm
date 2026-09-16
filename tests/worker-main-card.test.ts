import { describe, expect, it } from "vitest";
import { renderWorkerMainCard, renderWorkerStatusSnapshot, renderWorkerThreadEntryCard, renderWorkerThreadEntryReadyCard } from "../src/cards/worker-main-card.js";
import { createWorkerMainView, reduceWorkerMainView } from "../src/domain/worker-main-view.js";

function view() {
  return createWorkerMainView({
    workerId: "worker-1", workerSessionGeneration: 3, parentBindingId: "binding-1", parentBindingGeneration: 7, parentPaneId: "pane-primary", primaryPaneName: "Primary Review", projectId: "swarm", workerName: "reviewer", ownerName: "Primary",
    runtimeGeneration: 4, runtimeState: "working", runtimeAttached: true, desiredState: "running", parentActive: true, paneId: "pane-worker", workspace: "/repo/.worktree/reviewer", branch: "swarm/reviewer", model: "GPT-5", occurredAt: "2026-09-05T00:00:00.000Z"
  });
}

describe("Worker Main card", () => {
  it("renders a compact Primary entry that only opens the canonical Worker Thread", () => {
    const card = renderWorkerThreadEntryReadyCard({ workerName: "reviewer", workerId: "worker-1", workerSessionGeneration: 3, messageId: "om_worker_main" }) as { config: { update_multi?: boolean } };
    const rendered = JSON.stringify(card);

    expect(rendered).toContain("Worker 已就绪 · reviewer");
    expect(rendered).toContain("打开 Worker Thread");
    expect(rendered).toContain('\"action\":\"card_target_open\"');
    expect(rendered).toContain('\"aggregateKind\":\"worker-session\"');
    expect(rendered).toContain('\"aggregateId\":\"worker-1\"');
    expect(rendered).toContain('\"generation\":3');
    expect(rendered).toContain("om_worker_main");
    expect(rendered).not.toContain("worker_new_task_form");
    expect(rendered).not.toContain("worker_task_instruction_form");
    expect(card.config.update_multi).toBe(true);
  });

  it("renders one immutable status snapshot with a stable timestamp and canonical-card target", () => {
    const card = renderWorkerStatusSnapshot({ ...view(), messageId: "om_worker_main" }, "2026-09-09T13:00:00.000Z") as { config: { update_multi?: boolean } };
    const rendered = JSON.stringify(card);
    expect(card.config.update_multi).not.toBe(false);
    expect(rendered).toContain("📸 Worker 状态快照 · reviewer");
    expect(rendered).toContain("一次性快照，不会自动更新");
    expect(rendered).toContain("2026-09-09T13:00:00.000Z");
    expect(rendered).toContain("card_target_open");
    expect(rendered).toContain("om_worker_main");
    expect(rendered).toContain('\"aggregateId\":\"worker-1\"');
    expect(rendered).toContain('\"generation\":3');
    expect(rendered).not.toContain("worker_new_task_form");
    expect(rendered).not.toContain("worker_task_instruction_form");
    expect(rendered).not.toContain("worker_task_interrupt");
  });

  it("keeps the immutable Worker Thread entry compatible with Feishu reply cards", () => {
    const card = renderWorkerThreadEntryCard(view(), "2026-09-09T13:00:00.000Z") as { config: { update_multi?: boolean } };
    expect(card.config.update_multi).toBe(true);
  });

  it("preserves current task details in the status snapshot", () => {
    const projected = reduceWorkerMainView(view(), { type: "tasks", currentTask: {
      turnId: "turn-current", title: "Review auth boundary", phase: "running", durationSeconds: 74, updatedAt: "2026-09-05T00:01:00.000Z",
      taskCard: { aggregateKind: "worker-turn", aggregateId: "turn-current", generation: 4, messageId: null },
      requestText: "Inspect the exact generation fence", answer: "Found a matching runtime turn", statusTitle: "Reviewing", progressEvents: [], notice: "Keep observing"
    }, queueCount: 2, nextTaskTitle: "Run recovery tests", recentTasks: [], occurredAt: "2026-09-05T00:01:00.000Z" });
    const rendered = JSON.stringify(renderWorkerStatusSnapshot(projected, "2026-09-09T13:00:00.000Z"));

    expect(rendered).toContain("Review auth boundary");
    expect(rendered).toContain("Inspect the exact generation fence");
    expect(rendered).toContain("Found a matching runtime turn");
    expect(rendered).toContain("Keep observing");
    expect(rendered).toContain("2 条等待");
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

    expect(rendered).toContain("🧭 Worker · reviewer");
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

  it("separates explicit plan progress from tool and legacy activity", () => {
    const projected = reduceWorkerMainView(view(), { type: "tasks", currentTask: {
      turnId: "turn-current", title: "Review auth boundary", phase: "running", durationSeconds: 74, updatedAt: "2026-09-05T00:01:00.000Z",
      taskCard: { aggregateKind: "worker-turn", aggregateId: "turn-current", generation: 4, messageId: null },
      statusTitle: "Inspecting ownership fences",
      progressEvents: [
        { key: "plan:inspect", kind: "step", label: "Inspect current state", state: "active", occurredAt: "2026-09-05T00:00:20.000Z" },
        { key: "tool:read", kind: "read", label: "Read ownership policy", state: "done", occurredAt: "2026-09-05T00:00:30.000Z" },
        { key: "legacy:event", kind: "step", label: "Legacy activity", state: "done", occurredAt: "2026-09-05T00:00:40.000Z" }
      ]
    }, queueCount: 0, nextTaskTitle: null, recentTasks: [], occurredAt: "2026-09-05T00:01:00.000Z" });
    const elements = (renderWorkerMainCard(projected) as { body: { elements: Array<{ content?: string; header?: { title?: { content?: string } }; elements?: Array<{ content?: string }> }> } }).body.elements;
    const progress = elements.find((element) => element.header?.title?.content?.startsWith("📋 任务清单"));
    const activity = elements.find((element) => element.header?.title?.content?.startsWith("⚙️ 最近活动"));

    expect(progress?.elements?.map(({ content }) => content).join("\n")).toContain("Inspect current state");
    expect(progress?.elements?.map(({ content }) => content).join("\n")).not.toMatch(/Read ownership policy|Legacy activity/);
    expect(activity?.elements?.map(({ content }) => content).join("\n")).toMatch(/Read ownership policy|Legacy activity/);
  });

  it("groups state, elapsed time, tokens, and plan under current task before latest message and activity", () => {
    const projected = reduceWorkerMainView(view(), { type: "tasks", currentTask: {
      turnId: "turn-current", title: "Review auth boundary", phase: "running", durationSeconds: 74, tokenCount: 4_570, updatedAt: "now",
      taskCard: { aggregateKind: "worker-turn", aggregateId: "turn-current", generation: 4, messageId: null },
      statusTitle: "Inspecting ownership fences", answer: "Latest bounded message",
      progressEvents: [
        { key: "plan:inspect", kind: "step", label: "Inspect current state", state: "active", occurredAt: "now" },
        { key: "tool:read", kind: "read", label: "Read ownership policy", state: "done", occurredAt: "now" }
      ]
    }, queueCount: 0, nextTaskTitle: null, recentTasks: [], occurredAt: "now" });
    const elements = (renderWorkerMainCard(projected) as { body: { elements: Array<{ content?: string; header?: { title?: { content?: string } }; elements?: Array<{ content?: string }> }> } }).body.elements;
    const text = (element: typeof elements[number]) => element.content ?? element.header?.title?.content ?? "";
    const taskIndex = elements.findIndex((element) => text(element).includes("当前任务"));
    const messageIndex = elements.findIndex((element) => text(element).includes("最新消息"));
    const activityIndex = elements.findIndex((element) => text(element).includes("最近活动"));
    const taskRegion = JSON.stringify(elements.slice(taskIndex, messageIndex));

    expect(taskRegion).toContain("Inspecting ownership fences");
    expect(taskRegion).toContain("1m 14s");
    expect(taskRegion).toContain("4.57K tokens");
    expect(taskRegion).toContain("Inspect current state");
    expect(messageIndex).toBeGreaterThan(taskIndex);
    expect(activityIndex).toBeGreaterThan(messageIndex);
    expect(JSON.stringify(elements[messageIndex])).toContain("Latest bounded message");
    expect(JSON.stringify(elements[activityIndex])).toContain("Read ownership policy");
    expect(JSON.stringify(elements)).not.toContain("当前输出");
    expect(JSON.stringify(elements)).not.toContain("当前进展");
  });

  it("omits token metadata when structured usage is unavailable", () => {
    const projected = reduceWorkerMainView(view(), { type: "tasks", currentTask: {
      turnId: "turn-current", title: "Run tests", phase: "running", durationSeconds: 10, updatedAt: "now",
      taskCard: { aggregateKind: "worker-turn", aggregateId: "turn-current", generation: 4, messageId: null }
    }, queueCount: 0, nextTaskTitle: null, recentTasks: [], occurredAt: "now" });

    expect(JSON.stringify(renderWorkerMainCard(projected))).not.toContain("tokens");
  });

  it("renders tool-only progress as recent activity without a misleading current-progress panel", () => {
    const projected = reduceWorkerMainView(view(), { type: "tasks", currentTask: {
      turnId: "turn-current", title: "Run tests", phase: "running", durationSeconds: 10, updatedAt: "now",
      taskCard: { aggregateKind: "worker-turn", aggregateId: "turn-current", generation: 4, messageId: null },
      progressEvents: [{ key: "tool:test", kind: "test", label: "Command · npm test", state: "active", occurredAt: "now" }]
    }, queueCount: 0, nextTaskTitle: null, recentTasks: [], occurredAt: "now" });
    const rendered = JSON.stringify(renderWorkerMainCard(projected));

    expect(rendered).not.toContain("📋 任务清单");
    expect(rendered).toContain("⚙️ 最近活动");
    expect(rendered).toContain("Command · npm test");
  });

  it("uses the Primary actionable-notice hierarchy for a blocked Worker", () => {
    const projected = reduceWorkerMainView({ ...view(), runtimeState: "blocked" }, { type: "tasks", currentTask: {
      turnId: "turn-current", title: "Review auth boundary", phase: "blocked", durationSeconds: 74, updatedAt: "now",
      taskCard: { aggregateKind: "worker-turn", aggregateId: "turn-current", generation: 4, messageId: null },
      notice: "Approve the exact command in Herdr.", answer: "stale output",
      progressEvents: [{ key: "plan:review", kind: "step", label: "Wait for review", state: "active", occurredAt: "now" }]
    }, queueCount: 0, nextTaskTitle: null, recentTasks: [], occurredAt: "now" });
    const card = renderWorkerMainCard(projected) as { config: { summary: { content: string } }; header: { template: string }; body: { elements: Array<{ content?: string; header?: { title?: { content?: string } }; elements?: Array<{ content?: string }> }> } };
    const elements = card.body.elements;
    const noticeIndex = elements.findIndex((element) => element.header?.title?.content === "需要处理");
    const progressIndex = elements.findIndex((element) => element.header?.title?.content?.startsWith("📋 任务清单"));
    const outputIndex = elements.findIndex((element) => element.content?.includes("最新消息"));

    expect(card.header.template).toBe("orange");
    expect(card.config.summary.content).toBe("reviewer · 等待用户处理");
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(progressIndex);
    expect(noticeIndex).toBeLessThan(outputIndex);
    expect(JSON.stringify(elements[noticeIndex])).toContain("Approve the exact command in Herdr.");

    const fallback = JSON.stringify(renderWorkerMainCard({ ...projected, currentTask: { ...projected.currentTask!, notice: null } }));
    expect(fallback).toContain("请前往 Herdr Pane");
    expect(fallback).toContain("pane-worker");
  });

  it("aligns the canonical header and runtime identity with Primary cards", () => {
    const card = renderWorkerMainCard(view(), { projectDisplayName: "Herdr Agent Swarm" }) as { header: { title: { content: string }; subtitle: { content: string }; template: string }; body: { elements: Array<{ content?: string }> } };
    const rendered = JSON.stringify(card);

    expect(card.header).toEqual({
      title: { tag: "plain_text", content: "🧭 Worker · reviewer" },
      subtitle: { tag: "plain_text", content: "HERDR WORKER · PRIMARY Primary Review · 🧠 工作中" },
      template: "blue"
    });
    expect(card.body.elements[0]?.content).toBe("🧠 工作中  ·  Worker `pane-worker`  ·  队列 `0`  ·  模型 `GPT-5`");
    expect(rendered).toContain("Project Herdr Agent Swarm (`swarm`)");
    expect(rendered).toContain("Primary Primary Review (`pane-primary`)");
    expect(rendered).toContain("Worker `pane-worker`");
    expect(rendered).toContain("Session `3`");
    expect(rendered).toContain("Runtime `4`");
    expect(rendered).toContain("Workspace  /repo/.worktree/reviewer");
    expect(rendered).toContain("Branch  `swarm/reviewer`");
  });

  it("uses durable identity fallbacks for legacy Worker views", () => {
    const card = renderWorkerMainCard({ ...view(), primaryPaneName: undefined, projectId: undefined, paneId: null }) as { header: { subtitle: { content: string } } };
    const rendered = JSON.stringify(card);

    expect(card.header.subtitle.content).toBe("HERDR WORKER · PRIMARY pane-primary · 🧠 工作中");
    expect(rendered).toContain("Project binding-1");
    expect(rendered).toContain("Primary pane-primary (`pane-primary`)");
    expect(rendered).toContain("Worker `未绑定`");
    expect(rendered).not.toContain("Unknown project");
  });

  it.each([
    ["blocked", "orange"],
    ["detached", "orange"],
    ["failed", "red"],
    ["stopped", "grey"],
    ["terminated", "grey"]
  ] as const)("uses the %s lifecycle template %s", (runtimeState, template) => {
    const card = renderWorkerMainCard({ ...view(), runtimeState }) as { header: { template: string } };
    expect(card.header.template).toBe(template);
  });

  it("orders current work and actions before history and runtime evidence", () => {
    const projected = reduceWorkerMainView(view(), { type: "tasks", currentTask: { turnId: "turn-current", title: "Current", phase: "running", durationSeconds: 4, updatedAt: "now", taskCard: { aggregateKind: "worker-turn", aggregateId: "turn-current", generation: 4, messageId: null }, requestText: "Inspect", statusTitle: "Working", progressEvents: [], answer: "Partial" }, queueCount: 1, nextTaskTitle: "Next", recentTasks: [{ turnId: "old", title: "Old", phase: "completed", durationSeconds: 2, updatedAt: "before", taskCard: { aggregateKind: "worker-turn", aggregateId: "old", generation: 4, messageId: null } }], occurredAt: "now" });
    const elements = (renderWorkerMainCard({ ...projected, messageId: "worker-main" }) as { body: { elements: Array<{ tag: string; content?: string }> } }).body.elements;
    const text = elements.map((element) => element.content ?? JSON.stringify(element));
    expect(text.findIndex((value) => value.includes("当前任务"))).toBeLessThan(text.findIndex((value) => value.includes("worker_task_instruction_form")));
    expect(text.findIndex((value) => value.includes("最近任务"))).toBeLessThan(text.findIndex((value) => value.includes("运行环境")));
    expect(text.at(-1)).toContain("运行环境");
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
