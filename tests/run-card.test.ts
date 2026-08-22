import { describe, expect, it } from "vitest";
import { renderHelpCard, renderProjectEntryCard, renderProjectSelectorCard, renderRequestAnswerCard, renderRequestRunCard, renderRunCard } from "../src/cards/run-card.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";

describe("run card", () => {
  it("documents how to attach an existing pane", () => {
    expect(JSON.stringify(renderHelpCard())).toContain("/herdr attach <space> <pane-id>");
  });

  it("renders project buttons with opaque ids and no host routing details", () => {
    const card = renderProjectSelectorCard({
      selectionId: "selection-1",
      projects: [{ id: "bridge", displayName: "Herdr Lark Bridge", description: "Bridge service", workspaceId: "wH", cwd: "/secret/work/bridge" }]
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("Herdr Lark Bridge");
    expect(serialized).toContain("Bridge service");
    expect(serialized).toContain(JSON.stringify({ action: "select_project", selectionId: "selection-1", projectId: "bridge" }));
    expect(serialized).not.toContain("/secret/work/bridge");
    expect(serialized).not.toContain('\"workspaceId\"');
    expect(serialized).not.toContain("wH");
  });

  it("renders CardKit 2.0 from a projected state", () => {
    const card = renderRunCard({ ...initialTopicView("b1"), title: "Build bridge", workspaceId: "wG", spaceName: "datasage_semantic_knowledge", paneId: "wG:p2", phase: "blocked", agentState: "blocked", queueDepth: 2 });
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ schema: "2.0", config: { streaming_mode: false }, header: { template: "orange" } });
    expect((card as { header: Record<string, unknown> }).header).not.toHaveProperty("ud_icon");
    expect(serialized).not.toContain('"tag":"note"');
    expect(serialized).toContain("等待用户处理");
    expect(serialized).toContain("查看对应 Herdr panel");
    expect(serialized).not.toContain("终端审批");
    expect(serialized).toContain("SPACE");
    expect(serialized).toContain("datasage_semantic_knowledge");
    expect(serialized).not.toContain("WORKSPACE");
    expect(serialized).not.toContain('**WORKSPACE**\n`wG`');
  });

  it("shows only the newest compact answer preview on the group project entry card", () => {
    const answer = `old answer ${"x".repeat(2_700)} newest conclusion`;
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), title: "datasage / Fix login", spaceName: "datasage_semantic_knowledge", paneId: "wD:p9",
      phase: "running", queueDepth: 2, answer, recentProgress: [{ key: "edit:a", kind: "edit", label: "changed secret.ts", state: "done", occurredAt: "now" }]
    });
    const serialized = JSON.stringify(card);

    expect(card).toMatchObject({ header: { title: { content: "TraeX · datasage_semantic_knowledge / wD:p9" } } });
    expect(serialized).toContain("datasage_semantic_knowledge");
    expect(serialized).toContain("wD:p9");
    expect(serialized).toContain("TraeX 正在处理");
    expect(serialized).toContain("QUEUE");
    expect(serialized).toContain("最新消息");
    expect(serialized).toContain("newest conclusion");
    expect(serialized).not.toContain("old answer");
    expect(serialized).not.toContain("changed secret.ts");
    expect(serialized).not.toContain("执行进度");
  });

  it("prioritizes actionable notices over answer previews", () => {
    const card = renderProjectEntryCard({ ...initialTopicView("b1"), phase: "blocked", answer: "stale answer", notice: "Approve in pane" });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Approve in pane");
    expect(serialized).not.toContain("stale answer");
  });

  it("renders blocked requests as warnings and preserves the supplied action notice", () => {
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Need input", workspaceId: "w1", paneId: "w1:p1", requestText: "Continue", queuePosition: 1, occurredAt: "now" });
    const blocked = reduceRunCard(queued, { type: "blocked", occurredAt: "later", notice: "请选择目标环境。" });
    const card = renderRequestRunCard(blocked);
    const serialized = JSON.stringify(card);

    expect(card).toMatchObject({ header: { template: "orange" } });
    expect(serialized).toContain("等待用户处理");
    expect(serialized).toContain("请选择目标环境。");
    expect(serialized).not.toContain("终端审批");
  });

  it("keeps failed topic and request cards red", () => {
    const topicCard = renderRunCard({ ...initialTopicView("b1"), phase: "error", notice: "command failed" });
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Failed", workspaceId: "w1", paneId: "w1:p1", requestText: "Run", queuePosition: 1, occurredAt: "now" });
    const requestCard = renderRequestRunCard(reduceRunCard(queued, { type: "failed", occurredAt: "later", notice: "command failed" }));

    expect(topicCard).toMatchObject({ header: { template: "red" } });
    expect(requestCard).toMatchObject({ header: { template: "red" } });
  });

  it("renders real steps on the task card and the answer only on its sibling card", () => {
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Fix login", workspaceId: "w1", spaceName: "datasage_semantic_knowledge", paneId: "w1:p2", requestText: "## Request\nFix **login** <script>bad()</script>", queuePosition: 1, occurredAt: "2026-08-22T10:00:00Z" });
    const output = reduceRunCard(queued, { type: "output", occurredAt: "2026-08-22T10:00:01Z", answerDelta: "partial", hasProgressSnapshot: true, progressEvents: [{ key: "implement", kind: "step", label: "实现双卡更新", state: "done", occurredAt: "2026-08-22T10:00:01Z" }] });
    const completed = reduceRunCard(output, { type: "completed", occurredAt: "2026-08-22T10:00:02Z", answer: "Fixed." });
    const taskCard = renderRequestRunCard(completed);
    const answerCard = renderRequestAnswerCard(completed);
    const task = JSON.stringify(taskCard);
    const answer = JSON.stringify(answerCard);
    expect(taskCard).toMatchObject({ schema: "2.0", config: { streaming_mode: false }, header: { template: "green" } });
    expect(task).toContain("任务步骤");
    expect(task).toContain("📩 **已接收请求**");
    expect(task).toContain("## Request\\nFix **login**");
    expect(task).not.toContain("bad()");
    expect(task).toContain("✓ 实现双卡更新");
    expect(task).not.toContain("Fixed.");
    expect(answer).toContain("Fixed.");
    expect(answer).not.toContain("实现双卡更新");
    expect(answer).not.toContain("Fix **login**");
  });

  it("identifies the agent, space, and pane in request card headers", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Fix login", workspaceId: "w1", spaceName: "datasage_semantic_knowledge", paneId: "w1:p2", requestText: "Fix login", queuePosition: 1, occurredAt: "now" });
    expect(renderRequestRunCard(view)).toMatchObject({ header: { title: { content: "TraeX · datasage_semantic_knowledge / w1:p2" } } });
  });

  it("filters legacy tool activity and renders real steps", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Large", workspaceId: "w1", paneId: "p1", requestText: "Inspect files", queuePosition: 1, occurredAt: "now" });
    const card = renderRequestRunCard({ ...view, progressEvents: [
      { key: "legacy", kind: "read" as const, label: "已读取 secret.ts", state: "done" as const, occurredAt: "now" },
      ...Array.from({ length: 20 }, (_, index) => ({ key: "step:" + index, kind: "step" as const, label: "任务步骤 " + index, state: "pending" as const, occurredAt: "now" }))
    ] });
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("secret.ts");
    expect(serialized).toContain("☐ 任务步骤 0");
    expect(serialized).toContain("☐ 任务步骤 19");
  });

  it("keeps the newest answer window in request cards", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Large answer", workspaceId: "w1", paneId: "p1", requestText: "Keep this request beginning", queuePosition: 1, occurredAt: "now" });
    const answer = `old answer ${"x".repeat(13_000)} newest conclusion`;
    const card = renderRequestAnswerCard({ ...view, phase: "completed", answer });
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("Keep this request beginning");
    expect(serialized).toContain("newest conclusion");
    expect(serialized).not.toContain("old answer");
    expect(serialized).toContain("较早内容已省略");
  });

  it("shows request, queue state, and lifecycle fallback without inferred steps", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "p1", requestText: "Do the work", queuePosition: 3, occurredAt: "now" });
    const queued = JSON.stringify(renderRequestRunCard(view));
    expect(queued).toContain("📩 **已接收请求**");
    expect(queued).toContain("⏳ 已进入队列 · 当前第 3 位");

    const card = renderRequestRunCard({ ...view, phase: "running" });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("正在等待 TraeX 提供任务计划");
  });
});
