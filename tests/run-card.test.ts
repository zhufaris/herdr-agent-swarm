import { describe, expect, it } from "vitest";
import { renderModelResultCard } from "../src/cards/model-card.js";
import { renderAttachStatusCard, renderHelpCard, renderProjectEntryCard, renderProjectSelectorCard, renderRequestAnswerCard, renderRequestRunCard, renderRunCard } from "../src/cards/run-card.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";

describe("run card", () => {
  it("renders attach success without a navigation button when no topic URL exists", () => {
    const card = JSON.stringify(renderAttachStatusCard({ spaceName: "datasage_semantic_knowledge", paneId: "w5:p3G" }));

    expect(card).toContain("Pane 连接成功");
    expect(card).toContain("datasage_semantic_knowledge");
    expect(card).toContain("w5:p3G");
    expect(card).not.toContain("打开项目话题");
  });

  it("documents how to attach an existing pane", () => {
    const help = JSON.stringify(renderHelpCard());
    expect(help).toContain("/herdr attach <space> <pane>");
    expect(help).toContain("ID 或唯一名称");
    expect(help).toContain("/herdr spaces");
  });

  it("documents and renders the model command result", () => {
    const help = JSON.stringify(renderHelpCard());
    expect(help).toContain("/model [name]");
    expect(help).toContain("/herdr model [name]");

    const card = renderModelResultCard({ spaceName: "datasage", paneId: "w5:p3G", output: "Current model: GPT-5.5", switched: false });
    expect(card).toMatchObject({ header: { title: { content: "TraeX · datasage / w5:p3G" }, subtitle: { content: "HERDR MODEL" }, template: "blue" } });
    expect(JSON.stringify(card)).toContain("Current model: GPT-5.5");
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

  it("shows the newest compact answer preview and recent activity on the group project entry card", () => {
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
    expect(serialized).toContain("🛠️ changed secret.ts");
    expect(serialized).toContain("最近动态");
  });

  it("shows the three newest tool activities and the latest answer paragraph on the project card", () => {
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), title: "Inspect project", spaceName: "datasage", paneId: "w5:p3G", phase: "running",
      answer: "已检查项目配置。\n\n正在运行聚焦测试。",
      recentProgress: [
        { key: "read:old", kind: "read", label: "读取旧配置", state: "done", occurredAt: "1" },
        { key: "edit:new", kind: "edit", label: "修改卡片渲染", state: "done", occurredAt: "2" },
        { key: "test:new", kind: "test", label: "运行聚焦测试", state: "active", occurredAt: "3" },
        { key: "search:new", kind: "search", label: "检查调用位置", state: "done", occurredAt: "4" }
      ]
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("🛠️ 修改卡片渲染");
    expect(serialized).toContain("🛠️ 运行聚焦测试");
    expect(serialized).toContain("🛠️ 检查调用位置");
    expect(serialized).not.toContain("读取旧配置");
    expect(serialized).toContain("正在运行聚焦测试。");
    expect(serialized).not.toContain("已检查项目配置。");
  });

  it("falls back to the newest formatted activity when the project has no answer prose", () => {
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), phase: "running", answer: null,
      recentProgress: [{ key: "test:focused", kind: "test", label: "正在运行聚焦测试", state: "active", occurredAt: "now" }]
    });
    const latestMessage = (card as { body: { elements: Array<{ content?: string }> } }).body.elements
      .find((element) => element.content?.startsWith("**最新消息**"))?.content;

    expect(latestMessage).toContain("🛠️ 正在运行聚焦测试");
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

  it("renders lifecycle only on the task card and gives the answer a stable stream element", () => {
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Fix login", workspaceId: "w1", spaceName: "datasage_semantic_knowledge", paneId: "w1:p2", requestText: "## Request\nFix **login** <script>bad()</script>", queuePosition: 1, occurredAt: "2026-08-22T10:00:00Z" });
    const output = reduceRunCard(queued, { type: "output", occurredAt: "2026-08-22T10:00:01Z", answerSnapshot: "partial", hasProgressSnapshot: true, progressEvents: [{ key: "implement", kind: "step", label: "实现双卡更新", state: "done", occurredAt: "2026-08-22T10:00:01Z" }] });
    const completed = reduceRunCard(output, { type: "completed", occurredAt: "2026-08-22T10:00:02Z", answer: "Fixed." });
    const taskCard = renderRequestRunCard(completed);
    const answerCard = renderRequestAnswerCard(completed);
    const task = JSON.stringify(taskCard);
    const answer = JSON.stringify(answerCard);
    expect(taskCard).toMatchObject({ schema: "2.0", header: { template: "green" } });
    expect(task).toContain("📩 **已接收请求**");
    expect(task).toContain("## Request\\nFix **login**");
    expect(task).not.toContain("bad()");
    expect(task).toContain("✅ 任务完成");
    expect(task).not.toContain("实现双卡更新");
    expect(task).not.toContain("执行计划");
    expect(task).not.toContain("Fixed.");
    expect(answer).toContain("Fixed.");
    expect(answer).not.toContain("实现双卡更新");
    expect(answer).not.toContain("Fix **login**");
    const panels = (taskCard as { body: { elements: Array<{ tag?: string }> } }).body.elements.filter((element) => element.tag === "collapsible_panel");
    expect(panels).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: "collapsible_panel", expanded: false, header: expect.objectContaining({ title: expect.objectContaining({ content: "原始请求" }) }) })
    ]));
    expect(answerCard).toMatchObject({ header: { title: { content: "TraeX · datasage_semantic_knowledge / w1:p2" }, subtitle: { content: "HERDR ANSWER · Fix login" } } });
    expect(answerCard).toMatchObject({ config: { summary: { content: "完成 · Fix login" } } });
    expect(answerCard).toMatchObject({ body: { elements: [expect.objectContaining({ tag: "markdown", element_id: "answer_content_p1_0" })] } });
    const elementId = (answerCard as { body: { elements: Array<{ element_id: string }> } }).body.elements[0]!.element_id;
    expect(elementId).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  });

  it("keeps native TraeX task status out of the answer card", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Replay Query Log", workspaceId: "w1", spaceName: "datasage", paneId: "w1:p1", requestText: "Replay", queuePosition: 0, occurredAt: "start" });
    const running = { ...view, phase: "running" as const, answer: "重新构建部署… (35m 10s • ↓ 30.8K tokens)\n9 tasks (7 done, 1 in progress, 1 open)\n■ 重放 Query Log\n◻ 更新 PROGRESS.md", progressEvents: [
      { key: "one", kind: "step" as const, label: "重放 Query Log", state: "active" as const, occurredAt: "now" },
      ...Array.from({ length: 6 }, (_, index) => ({ key: `done-${index}`, kind: "step" as const, label: `完成 ${index}`, state: "done" as const, occurredAt: "now" })),
      { key: "open", kind: "step" as const, label: "更新 PROGRESS.md", state: "pending" as const, occurredAt: "now" }
    ] };
    const serialized = JSON.stringify(renderRequestAnswerCard(running));

    expect(serialized).toContain("TraeX 正在执行 · 6/8");
    expect(serialized).not.toContain("30.8K tokens");
    expect(serialized).not.toContain("■ 重放 Query Log");
  });

  it("removes an embedded native task frame without dropping surrounding prose", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Replay", workspaceId: "w1", paneId: "w1:p1", requestText: "Replay", queuePosition: 0, occurredAt: "start" });
    const serialized = JSON.stringify(renderRequestAnswerCard({
      ...view, phase: "running", answer: "已完成部署。\n\n◆ 执行任务… (2m 1s • 2K tokens)\n2 tasks (1 done, 1 open)\n✔ 部署\n◻ 验证\n\n正在检查健康状态。"
    }));

    expect(serialized).toContain("已完成部署。");
    expect(serialized).toContain("正在检查健康状态。");
    expect(serialized).not.toContain("2 tasks");
    expect(serialized).not.toContain("✔ 部署");
  });

  it("removes a terminal-wrapped native task frame from answer prose", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Replay", workspaceId: "w1", paneId: "w1:p1", requestText: "Replay", queuePosition: 0, occurredAt: "start" });
    const serialized = JSON.stringify(renderRequestAnswerCard({
      ...view, phase: "running", answer: "已完成部署。\n\nRebuild Query Log and Aeolus\nChart…\n(2m 1s • 2K tokens • esc to interrupt)\n2 tasks (1 done, 1 open)\n✔ 部署\n◻ 验证"
    }));

    expect(serialized).toContain("已完成部署。");
    expect(serialized).not.toContain("Rebuild Query Log");
    expect(serialized).not.toContain("2 tasks");
  });

  it("shows phase-aware status and elapsed duration instead of a queue dash", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "Run", queuePosition: 1, occurredAt: "2026-08-22T10:00:00Z" });
    const completed = { ...view, phase: "completed" as const, queuePosition: 0, startedAt: "2026-08-22T10:00:10Z", finishedAt: "2026-08-22T10:02:15Z" };
    const serialized = JSON.stringify(renderRequestRunCard(completed));

    expect(serialized).toContain("STATUS");
    expect(serialized).toContain("已完成");
    expect(serialized).toContain("用时 2m 5s");
    expect(serialized).not.toContain('**QUEUE**\n`—`');
  });

  it("identifies the agent, space, and pane in request card headers", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Fix login", workspaceId: "w1", spaceName: "datasage_semantic_knowledge", paneId: "w1:p2", requestText: "Fix login", queuePosition: 1, occurredAt: "now" });
    expect(renderRequestRunCard(view)).toMatchObject({ header: { title: { content: "TraeX · datasage_semantic_knowledge / w1:p2" } } });
  });

  it("ignores all legacy progress activity on the lifecycle-only request card", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Large", workspaceId: "w1", paneId: "p1", requestText: "Inspect files", queuePosition: 1, occurredAt: "now" });
    const card = renderRequestRunCard({ ...view, progressEvents: [
      { key: "legacy", kind: "read" as const, label: "已读取 secret.ts", state: "done" as const, occurredAt: "now" },
      ...Array.from({ length: 20 }, (_, index) => ({ key: "step:" + index, kind: "step" as const, label: "任务步骤 " + index, state: "pending" as const, occurredAt: "now" }))
    ] });
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("secret.ts");
    expect(serialized).not.toContain("任务步骤 0");
    expect(serialized).not.toContain("任务步骤 19");
    expect(serialized).not.toContain("执行计划");
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

  it("renders stable answer segments followed by only the current draft", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Stable answer", workspaceId: "w1", paneId: "p1", requestText: "Run", queuePosition: 1, occurredAt: "now" });
    const card = renderRequestAnswerCard({
      ...view, phase: "running", answer: "stale aggregate",
      answerSegments: ["已完成检查。", "已更新实现。"], answerDraft: "正在运行测试…"
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("已完成检查。");
    expect(serialized).toContain("已更新实现。");
    expect(serialized).toContain("正在运行测试…");
    expect(serialized).not.toContain("stale aggregate");
  });

  it("shows request and lifecycle without an execution-plan panel", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "p1", requestText: "Do the work", queuePosition: 3, occurredAt: "now" });
    const queued = JSON.stringify(renderRequestRunCard(view));
    expect(queued).toContain("📩 **已接收请求**");
    expect(queued).toContain("⏳ 已进入队列 · 当前第 3 位");

    const card = renderRequestRunCard({ ...view, phase: "running" });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("🧠 TraeX 正在处理");
    expect(serialized).not.toContain("执行计划");
  });
});
