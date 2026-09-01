import { afterEach, describe, expect, it, vi } from "vitest";
import { renderModelResultCard } from "../src/cards/model-card.js";
import { renderMoreActionsCard } from "../src/cards/interaction-card.js";
import { renderAttachStatusCard, renderFinalAnswerCard, renderHelpCard, renderProjectEntryCard, renderProjectSelectorCard, renderRequestAnswerCard, renderRequestRunCard, renderRunCard } from "../src/cards/run-card.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";

function findTaggedNodes(value: unknown, tag: string): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap((item) => findTaggedNodes(item, tag));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [...(record.tag === tag ? [record] : []), ...Object.values(record).flatMap((item) => findTaggedNodes(item, tag))];
}

describe("run card", () => {
  afterEach(() => vi.useRealTimers());

  it("renders attach success without a navigation button when no topic URL exists", () => {
    const card = JSON.stringify(renderAttachStatusCard({ spaceName: "datasage_semantic_knowledge", paneId: "w5:p3G" }));

    expect(card).toContain("Pane 连接成功");
    expect(card).toContain("datasage_semantic_knowledge");
    expect(card).toContain("w5:p3G");
    expect(card).not.toContain("打开项目话题");
  });

  it("documents how to attach an existing pane", () => {
    const help = JSON.stringify(renderHelpCard());
    expect(help).toContain("/swarm attach <space> <pane>");
    expect(help).toContain("ID 或唯一名称");
    expect(help).toContain("/swarm spaces");
  });

  it("documents and renders the model command result", () => {
    const help = JSON.stringify(renderHelpCard());
    expect(help).toContain("/swarm model [name]");

    const card = renderModelResultCard({
      bindingId: "binding-1", spaceName: "datasage", paneId: "w5:p3G", switched: false,
      output: "Select Model and Effort\n 1. Seed-Evolving          1000K context window\n 2. GPT-5.6-Sol (current)  support reasoning"
    });
    expect(card).toMatchObject({ header: { title: { content: "TraeX · datasage / w5:p3G" }, subtitle: { content: "HERDR MODEL" }, template: "blue" } });
    expect(card).toMatchObject({ body: { elements: expect.arrayContaining([expect.objectContaining({
      tag: "select_static", name: "model", initial_option: "GPT-5.6-Sol",
      behaviors: [{ type: "callback", value: { action: "select_model", bindingId: "binding-1" } }]
    })]) } });
  });

  it("documents priority stop steering and its safety boundary", () => {
    const help = JSON.stringify(renderHelpCard());
    expect(help).toContain("/swarm stop");
    expect(help).toContain("Herdr Esc");
    expect(help).toContain("/swarm steer <文本>");
    expect(help).toContain("其它 slash 命令会原样提交给 TraeX");
  });

  it("renders project buttons with opaque ids and no host routing details", () => {
    const card = renderProjectSelectorCard({
      selectionId: "selection-1",
      projects: [{ id: "bridge", displayName: "Herdr Lark Bridge", description: "Bridge service", workspaceId: "wH", cwd: "/secret/work/bridge" }]
    });
    const serialized = JSON.stringify(card);
    const latestMessage = (card as { body: { elements: Array<{ content?: string }> } }).body.elements
      .find((element) => element.content?.startsWith("**最新消息**"))?.content ?? "";

    expect(serialized).toContain("Herdr Lark Bridge");
    expect(serialized).toContain("Bridge service");
    expect(serialized).toContain(JSON.stringify({ action: "select_project", selectionId: "selection-1", projectId: "bridge" }));
    expect(serialized).not.toContain("/secret/work/bridge");
    expect(serialized).not.toContain('\"workspaceId\"');
    expect(serialized).not.toContain("wH");
  });

  it("bounds a large project selector and summarizes omitted projects", () => {
    const projects = Array.from({ length: 200 }, (_, index) => ({ id: `project-${index}`, displayName: `Project ${index}`, description: "x".repeat(500), workspaceId: `w${index}`, cwd: `/repo/${index}` }));
    const card = renderProjectSelectorCard({ selectionId: "selection-1", projects });
    const serialized = JSON.stringify(card);
    expect(serialized.length).toBeLessThanOrEqual(12_000);
    expect(serialized).toMatch(/另有 \d+ 个项目未在本卡展示/);
    expect(projects).toHaveLength(200);
  });

  it("shows observed model and context in the main-card metrics", () => {
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), model: "GPT-5.6-Sol", context: "31.1K tokens"
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("GPT-5.6-Sol");
    expect(serialized).toContain("context `31.1K tokens`");
  });

  it("renders CardKit 2.0 callback buttons without legacy action containers", () => {
    const main = renderProjectEntryCard({ ...initialTopicView("b1"), phase: "running", activePromptId: "p1", queueDepth: 1 });
    const more = renderMoreActionsCard({ bindingId: "b1", bindingGeneration: 1, creator: true, lifecycle: "active", attachment: "attached" });

    const mainButtons = findTaggedNodes(main, "button");
    const moreButtons = findTaggedNodes(more, "button");
    expect(mainButtons).toEqual([]);
    expect(moreButtons.map(callbackValue)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "session_status", bindingId: "b1" }),
      expect.objectContaining({ action: "session_stop", bindingId: "b1" })
    ]));
    expect([...mainButtons, ...moreButtons].every((button) => !Object.hasOwn(button, "value"))).toBe(true);
    expect(findTaggedNodes(main, "action")).toEqual([]);
    expect(findTaggedNodes(more, "action")).toEqual([]);
  });


  it("renders compact identity and runtime rows plus the Git worktree directory name", () => {
    const input = { ...initialTopicView("b1"), spaceName: "datasage", tabId: "w5:t1", paneId: "w5:p3G", worktreeName: "feat-main-card", model: "GPT-5.6-Sol", context: "31.1K tokens", queueDepth: 2 };
    const runCard = renderRunCard(input) as { body: { elements: Array<{ tag: string; content?: string }> } };
    const projectCard = renderProjectEntryCard(input) as { body: { elements: Array<{ tag: string; content?: string }> } };

    expect(runCard.body.elements[0]).toMatchObject({
      tag: "markdown",
      content: "**SPACE**  `datasage`   **TAB**  `w5:t1`   **PANE**  `w5:p3G`\n**MODEL**  `GPT-5.6-Sol`   **CONTEXT**  `31.1K tokens`   **QUEUE**  `2`\n**WORKTREE**  `feat-main-card`"
    });
    expect(projectCard.body.elements.at(-1)).toMatchObject({
      tag: "markdown",
      content: "`datasage` · `w5:t1` · `w5:p3G`\n`GPT-5.6-Sol` · context `31.1K tokens` · queue `2`\nworktree `feat-main-card`"
    });
    expect([...runCard.body.elements, ...projectCard.body.elements].some((element) => element.tag === "column_set")).toBe(false);
  });

  it("renders CardKit 2.0 from a projected state", () => {
    const card = renderRunCard({ ...initialTopicView("b1"), title: "Build bridge", workspaceId: "wG", spaceName: "datasage_semantic_knowledge", paneId: "wG:p2", phase: "blocked", agentState: "blocked", queueDepth: 2 });
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ schema: "2.0", config: { streaming_mode: false }, header: { template: "orange" } });
    expect((card as { header: Record<string, unknown> }).header).not.toHaveProperty("ud_icon");
    expect(serialized).not.toContain('"tag":"note"');
    expect(serialized).toContain("等待用户处理");
    expect(serialized).toContain("前往对应 Herdr Pane");
    expect(serialized).not.toContain("终端审批");
    expect(serialized).toContain("SPACE");
    expect(serialized).toContain("datasage_semantic_knowledge");
    expect(serialized).not.toContain("WORKSPACE");
    expect(serialized).not.toContain('**WORKSPACE**\n`wG`');
  });

  it("shows the durable Main Card activity time from topic state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:03:00Z"));
    const view = { ...initialTopicView("b1"), activityAt: "2026-08-27T12:00:00Z" };

    expect(JSON.stringify(renderProjectEntryCard(view))).toContain("3 分钟前更新");
    expect(JSON.stringify(renderProjectEntryCard({ ...view, activityAt: null }))).not.toContain("最后更新");
    expect(JSON.stringify(renderProjectEntryCard({ ...view, activityAt: "not-a-date" }))).not.toContain("最后更新");
  });

  it("renders a dedicated Main Card status bar with the complete plan and reliable metrics", () => {
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), phase: "running", liveStatus: {
        statusTitle: "Considering package installation", elapsedSeconds: 177, tokenCount: 4_570,
        planSteps: [
          { key: "plan:0", kind: "step", label: "确认部署版本", state: "done", occurredAt: "now" },
          { key: "plan:1", kind: "step", label: "重试失败 run", state: "active", occurredAt: "now" },
          { key: "plan:2", kind: "step", label: "核验发布结果", state: "pending", occurredAt: "now" }
        ]
      }
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("当前进展 · 1/3");
    expect(serialized).toContain("Considering package installation");
    expect(serialized).toContain("2m 57s · ↑ 4.57K tokens");
    expect(serialized).toContain("✔ 确认部署版本");
    expect(serialized).toContain("■ 重试失败 run");
    expect(serialized).toContain("◻ 核验发布结果");
  });

  it("makes live work the primary Main Card section and moves runtime identity to the footer", () => {
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), title: "Deploy Query Log", phase: "running",
      spaceName: "datasage", tabId: "w5:t2", paneId: "w5:p4E", worktreeName: "feat/query-log",
      model: "GPT-5.4", context: "36%", queueDepth: 0, activityAt: "2026-08-27T12:00:00Z",
      answer: "line-1\nline-2\nline-3\nline-4\nline-5\nline-6",
      liveStatus: {
        statusTitle: "Checking deployment state", elapsedSeconds: 177, tokenCount: 4_570,
        planSteps: [
          { key: "plan:0", kind: "step", label: "确认部署版本", state: "done", occurredAt: "now" },
          { key: "plan:1", kind: "step", label: "重试失败 run", state: "active", occurredAt: "now" }
        ]
      },
      recentProgress: [
        { key: "plan:0", kind: "step", label: "确认部署版本", state: "done", occurredAt: "now" },
        { key: "tool:1", kind: "test", label: "检查服务状态", state: "active", occurredAt: "now" }
      ]
    });
    const elements = (card as { body: { elements: Array<{ tag: string; content?: string; header?: { title?: { content?: string } } }> } }).body.elements;
    const serialized = JSON.stringify(card);
    const liveIndex = elements.findIndex((element) => element.header?.title?.content === "当前进展 · 1/2");
    const activityIndex = elements.findIndex((element) => element.header?.title?.content?.startsWith("最近活动"));
    const previewIndex = elements.findIndex((element) => element.content?.startsWith("**最新消息**"));
    const footerIndex = elements.findIndex((element) => element.content?.includes("`datasage` · `w5:t2` · `w5:p4E`"));

    expect(liveIndex).toBeGreaterThanOrEqual(0);
    expect(activityIndex).toBeGreaterThan(liveIndex);
    expect(previewIndex).toBeGreaterThan(activityIndex);
    expect(footerIndex).toBe(elements.length - 1);
    expect(serialized).not.toContain("**当前工作**");
    expect(serialized.match(/确认部署版本/g)).toHaveLength(1);
    expect(elements[previewIndex]?.content?.split("\n").slice(2)).toEqual(["line-1", "line-2", "line-3", "line-4", "line-5", "line-6"]);
    expect(serialized).toContain("`GPT-5.4` · context `36%` · queue `0`");
    expect(serialized).toContain("worktree `feat/query-log`");
  });

  it("keeps the legacy current-work fallback when no live status exists", () => {
    expect(JSON.stringify(renderProjectEntryCard({ ...initialTopicView("b1"), phase: "running" }))).toContain("**当前工作**");
  });

  it("renders a frozen Answer Card green even when no code block needs folding", () => {
    const view = { ...createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "start" }), phase: "completed" as const, answer: "short answer", finishedAt: "done" };
    expect(renderFinalAnswerCard(view, { initialContent: "short answer" })).toMatchObject({
      config: { streaming_mode: false }, header: { template: "green" }
    });
  });

  it("shows the newest compact answer preview and recent activity on the group project entry card", () => {
    const answer = `old answer ${"x".repeat(2_700)} newest conclusion`;
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), title: "datasage / Fix login", spaceName: "datasage_semantic_knowledge", paneId: "wD:p9",
      phase: "running", queueDepth: 2, answer, recentProgress: [{ key: "edit:a", kind: "edit", label: "changed secret.ts", state: "done", occurredAt: "now" }]
    });
    const serialized = JSON.stringify(card);

    expect(card).toMatchObject({
      config: { summary: { content: "datasage / Fix login" } },
      header: { title: { content: "datasage / Fix login" } }
    });
    expect(serialized).toContain("datasage_semantic_knowledge");
    expect(serialized).toContain("wD:p9");
    expect(serialized).toContain("TraeX 正在处理");
    expect(serialized).toContain("queue `2`");
    expect(serialized).toContain("最新消息");
    expect(serialized).toContain("newest conclusion");
    expect(serialized).toContain("old answer");
    expect(serialized).toContain("✓ 🛠️ changed secret.ts");
    expect(serialized).toContain("最近活动");
  });

  it("keeps both ends of a long JSON message in main-card previews without mutating state", () => {
    const answer = ["{", "  \"head-field\": true,", ...Array.from({ length: 180 }, (_, index) => `  \"middle-${index}\": ${index},`), "  \"tail-field\": true", "}"].join("\n");
    const input = { ...initialTopicView("b1"), phase: "done" as const, answer };

    const runCard = JSON.stringify(renderRunCard(input));
    expect(runCard).toContain("head-field");
    expect(runCard).toContain("tail-field");
    expect(runCard).toContain("已省略中间");

    const projectCard = JSON.stringify(renderProjectEntryCard(input));
    expect(projectCard).not.toContain("head-field");
    expect(projectCard).toContain("tail-field");
    expect(projectCard).toContain("middle-178");
    expect(input.answer).toBe(answer);
  });

  it("does not render subagent console status in the project card preview", () => {
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), title: "bridge task", phase: "running",
      answer: "◆ Reviewing changes\n5 agents running… · /ps to manage\n● Main [default] running · 20m\n◆ Review complete"
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("Review complete");
    expect(serialized).not.toContain("agents running");
    expect(serialized).not.toContain("Main [default]");
  });

  it("renders progress labels as one bounded line", () => {
    const wrappedLabel = `Run tool with a narrow terminal\n  then inspect the resulting card ${"x".repeat(240)}`;
    const card = renderRunCard({
      ...initialTopicView("b1"), phase: "running", recentProgress: [
        { key: "tool:wrapped", kind: "test", label: wrappedLabel, state: "active", occurredAt: "now" }
      ]
    });
    const progress = (card as { body: { elements: Array<{ content?: string }> } }).body.elements
      .find((element) => element.tag === "collapsible_panel")?.elements?.[0]?.content ?? "";

    expect(progress).toContain("🧪 Run tool with a narrow terminal then inspect the resulting card");
    expect(progress).not.toContain("terminal\n");
    expect(progress).toContain("…");
    expect(progress.length).toBeLessThanOrEqual(220);
  });

  it("shows the three newest tool activities and up to 12 latest answer lines on the project card", () => {
    const lines = Array.from({ length: 24 }, (_, index) => `message-${index + 1}`);
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), title: "Inspect project", spaceName: "datasage", paneId: "w5:p3G", phase: "running",
      answer: lines.join("\n"),
      recentProgress: [
        { key: "read:old", kind: "read", label: "读取旧配置", state: "done", occurredAt: "1" },
        { key: "edit:new", kind: "edit", label: "修改卡片渲染", state: "done", occurredAt: "2" },
        { key: "test:new", kind: "test", label: "运行聚焦测试", state: "active", occurredAt: "3" },
        { key: "search:new", kind: "search", label: "检查调用位置", state: "done", occurredAt: "4" }
      ]
    });
    const serialized = JSON.stringify(card);
    const latestMessage = (card as { body: { elements: Array<{ content?: string }> } }).body.elements
      .find((element) => element.content?.startsWith("**最新消息**"))?.content ?? "";

    expect(serialized).toContain("🛠️ 修改卡片渲染");
    expect(serialized).toContain("🧪 运行聚焦测试");
    expect(serialized).toContain("🔎 检查调用位置");
    expect(serialized).not.toContain("读取旧配置");
    expect(serialized).toContain("更早 1 项已省略");
    expect(latestMessage.split("\n").slice(2)).toEqual(lines.slice(-12));
    expect(serialized).not.toContain("**项目任务**");
  });

  it("keeps only the eight newest activity summaries on the project card", () => {
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), phase: "running",
      recentProgress: Array.from({ length: 10 }, (_, index) => ({
        key: `activity:${index + 1}`, kind: "read" as const, label: `activity-${index + 1}`, state: "done" as const, occurredAt: String(index + 1)
      }))
    });
    const serialized = JSON.stringify(card);
    const visibleActivities = [...serialized.matchAll(/activity-(\d+)/g)].map((match) => Number(match[1]));

    expect([...new Set(visibleActivities)].sort((left, right) => left - right)).toEqual([8, 9, 10]);
    expect(serialized).toContain("更早 7 项已省略");
  });

  it("bounds the 12-line project-card preview at 6000 characters", () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line-${index + 1}: ${String(index % 10).repeat(700)}`);
    const card = renderProjectEntryCard({
      ...initialTopicView("b1"), phase: "running", answer: lines.join("\n")
    });
    const latestMessage = (card as { body: { elements: Array<{ content?: string }> } }).body.elements
      .find((element) => element.content?.startsWith("**最新消息**"))?.content ?? "";
    const previewBody = latestMessage.split("\n").slice(2).join("\n");

    expect(previewBody).not.toContain("line-13:");
    expect(previewBody).toContain("line-14:");
    expect(previewBody).toContain("line-25:");
    expect(previewBody).toContain("已省略中间");
    expect(previewBody.length).toBeLessThanOrEqual(6_000);
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
    expect(serialized).toContain("已保留当前任务");
    expect(serialized).toContain("Herdr Pane");
    expect(serialized).toContain("自动重新同步");
    expect(serialized).not.toContain("重新发送");
    expect(serialized).not.toContain('"tag":"button"');
    expect(serialized).not.toContain("终端审批");
  });

  it("keeps blocked and orphaned topic-card recovery guidance read-only", () => {
    for (const phase of ["blocked", "orphaned"] as const) {
      const card = renderProjectEntryCard({ ...initialTopicView("b1"), phase, activePromptId: phase === "blocked" ? "p1" : null, notice: "Inspect this state" });
      const serialized = JSON.stringify(card);
      const actions = mainCardCallbackActions(card);
      expect(serialized).toContain("Inspect this state");
      expect(serialized).toContain("已保留当前任务");
      expect(serialized).toContain("Herdr Pane");
      expect(serialized).toContain("自动重新同步");
      expect(serialized).not.toContain("重新发送");
      expect(actions).toEqual([]);
    }
  });

  it("renders no Main Card actions for every state", () => {
    const cases = [
      { phase: "provisioning", queueDepth: 0, actions: [] },
      { phase: "draining", queueDepth: 0, actions: [] },
      { phase: "ready", queueDepth: 0, actions: [] },
      { phase: "queued", queueDepth: 2, actions: [] },
      { phase: "done", queueDepth: 0, actions: [] },
      { phase: "running", activePromptId: "p1", queueDepth: 0, actions: [] },
      { phase: "running", activePromptId: "p1", queueDepth: 2, actions: [] },
      { phase: "blocked", activePromptId: "p1", queueDepth: 0, actions: [] },
      { phase: "error", queueDepth: 0, actions: [] },
      { phase: "orphaned", queueDepth: 0, actions: [] },
      { phase: "archived", queueDepth: 0, actions: [] }
    ] as const;

    for (const entry of cases) {
      const card = renderProjectEntryCard({ ...initialTopicView("b1"), phase: entry.phase, activePromptId: "activePromptId" in entry ? entry.activePromptId : null, queueDepth: entry.queueDepth });
      expect(mainCardCallbackActions(card), `${entry.phase} with queue ${entry.queueDepth}`).toEqual(entry.actions);
    }
  });

  it("keeps Main Cards read-only when an interactive phase has no active prompt", () => {
    const running = renderProjectEntryCard({ ...initialTopicView("b1"), phase: "running", activePromptId: null });
    const blocked = renderProjectEntryCard({ ...initialTopicView("b1"), phase: "blocked", activePromptId: null, notice: "Turn ended" });

    expect(mainCardCallbackActions(running)).toEqual([]);
    expect(mainCardCallbackActions(blocked)).toEqual([]);
  });

  it("limits orphaned More Actions to recovery-safe controls", () => {
    const card = renderMoreActionsCard({ bindingId: "b1", bindingGeneration: 1, creator: true, lifecycle: "active", attachment: "orphaned" });
    const actions = findTaggedNodes(card, "button").map(callbackValue).map((value) => value.action);

    expect(actions).toEqual(["session_status", "open_reattach", "session_replace", "session_archive"]);
    expect(actions).not.toEqual(expect.arrayContaining(["session_stop", "session_model", "session_reset", "session_pane_close"]));
  });

  it("renders degraded recovery guidance and exposes reset only to the creator", () => {
    const mainCard = renderProjectEntryCard({ ...initialTopicView("b1"), phase: "degraded", notice: "TraeX 正在运行，但未注册为 Herdr Agent。" });
    const creatorCard = renderMoreActionsCard({ bindingId: "b1", bindingGeneration: 1, creator: true, lifecycle: "active", attachment: "degraded" });
    const memberCard = renderMoreActionsCard({ bindingId: "b1", bindingGeneration: 1, creator: false, lifecycle: "active", attachment: "degraded" });

    expect(JSON.stringify(mainCard)).toContain("TraeX 正在运行，但未注册为 Herdr Agent。");
    expect(mainCardCallbackActions(mainCard)).toEqual([]);
    expect(findTaggedNodes(creatorCard, "button").map(callbackValue).map((value) => value.action)).toContain("session_reset");
    expect(findTaggedNodes(memberCard, "button").map(callbackValue).map((value) => value.action)).not.toContain("session_reset");
  });

  it("keeps creator-only controls out of the shared Main Card", () => {
    const creatorOnlyActions = ["stop", "reset", "rename", "archive", "close_pane", "select_model", "reattach", "replace", "resume"];

    for (const phase of ["ready", "running", "blocked", "error", "degraded", "orphaned", "archived"] as const) {
      const actions = mainCardCallbackActions(renderProjectEntryCard({ ...initialTopicView("b1"), phase, queueDepth: 2 }));
      expect(actions).not.toEqual(expect.arrayContaining(creatorOnlyActions));
    }
  });

  it("keeps failed topic and request cards red", () => {
    const topicCard = renderRunCard({ ...initialTopicView("b1"), phase: "error", notice: "command failed" });
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Failed", workspaceId: "w1", paneId: "w1:p1", requestText: "Run", queuePosition: 1, occurredAt: "now" });
    const requestCard = renderRequestRunCard(reduceRunCard(queued, { type: "failed", occurredAt: "later", notice: "command failed" }));

    expect(topicCard).toMatchObject({ header: { template: "red" } });
    expect(requestCard).toMatchObject({ header: { template: "red" } });
  });

  it("offers replay only for rejected automatic steering with fenced identifiers", () => {
    const queued = createQueuedRunCard({ promptId: "auto-steer", bindingId: "b1", bindingGeneration: 3, title: "Continue", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 0, occurredAt: "now", steeringOrigin: "automatic" });
    const rejected = reduceRunCard(queued, { type: "steering-failed", occurredAt: "later", notice: "当前任务已结束，未自动注入", failureKind: "rejected" });
    const uncertain = reduceRunCard(queued, { type: "steering-failed", occurredAt: "later", notice: "投递结果无法确认", failureKind: "uncertain" });
    const explicit = reduceRunCard({ ...queued, steeringOrigin: "explicit" }, { type: "steering-failed", occurredAt: "later", notice: "未注入", failureKind: "rejected" });
    const converted = reduceRunCard({ ...queued, steeringOrigin: "converted" }, { type: "steering-failed", occurredAt: "later", notice: "未注入", failureKind: "rejected" });

    expect(findTaggedNodes(renderRequestAnswerCard(rejected), "button").map(callbackValue)).toContainEqual({ action: "enqueue_failed_steering", bindingId: "b1", bindingGeneration: 3, sourcePromptId: "auto-steer" });
    for (const view of [uncertain, explicit, converted]) expect(findTaggedNodes(renderRequestAnswerCard(view), "button").map(callbackValue).map((value) => value.action)).not.toContain("enqueue_failed_steering");
  });

  it("distinguishes automatic and explicit steering success copy", () => {
    const base = createQueuedRunCard({ promptId: "steer", bindingId: "b1", title: "Continue", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 0, occurredAt: "now" });
    const automatic = reduceRunCard({ ...base, steeringOrigin: "automatic" }, { type: "steering-delivered", occurredAt: "later", notice: "已自动加入当前执行" });
    const explicit = reduceRunCard({ ...base, steeringOrigin: "explicit" }, { type: "steering-delivered", occurredAt: "later", notice: "已加入当前执行" });

    expect(automatic).toMatchObject({ steeringOrigin: "automatic", steeringFailureKind: null, notice: "已自动加入当前执行" });
    expect(explicit).toMatchObject({ steeringOrigin: "explicit", steeringFailureKind: null, notice: "已加入当前执行" });
  });

  it("renders lifecycle only on the task card and gives the answer a stable stream element", () => {
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Fix login", sessionTitle: "datasage_semantic_knowledge / task-7kq2", workspaceId: "w1", spaceName: "datasage_semantic_knowledge", paneId: "w1:p2", requestText: "## Request\nFix **login** <script>bad()</script>", queuePosition: 1, occurredAt: "2026-08-22T10:00:00Z" });
    const output = reduceRunCard(queued, { type: "output", occurredAt: "2026-08-22T10:00:01Z", answerSnapshot: "partial", hasProgressSnapshot: true, progressEvents: [{ key: "implement", kind: "step", label: "实现双卡更新", state: "done", occurredAt: "2026-08-22T10:00:01Z" }] });
    const completed = reduceRunCard(output, { type: "completed", occurredAt: "2026-08-22T10:00:02Z", answer: "Fixed." });
    const taskCard = renderRequestRunCard(completed);
    const answerCard = renderRequestAnswerCard(completed);
    const task = JSON.stringify(taskCard);
    const answer = JSON.stringify(answerCard);
    expect(taskCard).toMatchObject({ schema: "2.0", header: { template: "green" } });
    expect(taskCard).toMatchObject({ header: { title: { content: "💬 你的请求" }, subtitle: { content: "Fix login" } } });
    expect(task).toContain("## Request\\nFix **login**");
    expect(task).not.toContain("bad()");
    expect(task).toContain("✅ 任务完成");
    expect(task).not.toContain("实现双卡更新");
    expect(task).not.toContain("执行计划");
    expect(task).not.toContain("Fixed.");
    expect(answer).toContain("Fixed.");
    expect(answer).toContain("实现双卡更新");
    expect(answer).not.toContain("Fix **login**");
    const panels = (taskCard as { body: { elements: Array<{ tag?: string }> } }).body.elements.filter((element) => element.tag === "collapsible_panel");
    expect(panels).toEqual([]);
    expect(answerCard).toMatchObject({ header: { title: { content: "✅ TraeX 回复已完成" }, subtitle: { content: "datasage_semantic_knowledge / task-7kq2 · Fix login" }, template: "green" } });
    expect(answerCard).toMatchObject({ config: { streaming_mode: false, summary: { content: "完成 · Fix login" } } });
    const answerElements = (answerCard as { body: { elements: Array<{ tag?: string; element_id?: string }> } }).body.elements;
    expect(answerElements).toContainEqual(expect.objectContaining({ tag: "markdown", element_id: "answer_content_p1_0" }));
    const elementId = answerElements.find((element) => element.element_id)?.element_id;
    expect(elementId).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    expect(elementId.length).toBeLessThanOrEqual(20);
    expect(createQueuedRunCard({ promptId: "3f0cea75-c8cd-41f0-8fca-87d402b2a2a1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: null, requestText: "go", queuePosition: 1, occurredAt: "now" }).answerElementId).toBe("element_cbb6cb5f9c09");
  });

  it("shows relative freshness and live or final output state on request cards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:03:00Z"));
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Freshness", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-27T12:00:00Z" });
    const running = { ...queued, phase: "running" as const, updatedAt: "2026-08-27T12:00:00Z" };
    const completed = { ...running, phase: "completed" as const, updatedAt: "2026-08-27T12:02:00Z" };

    expect(JSON.stringify(renderRequestRunCard(running))).toContain("最后更新 3 分钟前");
    expect(JSON.stringify(renderRequestAnswerCard(running))).toContain("实时更新中");
    expect(JSON.stringify(renderRequestAnswerCard(completed))).toContain("最终结果");
  });

  it("folds only oversized complete code blocks in a final Answer Card", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Fold code", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 0, occurredAt: "now" });
    const typescript = Array.from({ length: 81 }, (_, index) => `const line${index} = ${index};`).join("\n");
    const card = renderFinalAnswerCard({ ...view, phase: "completed" }, { initialContent: `结论\n\n\`\`\`ts\n${typescript}\n\`\`\`\n\n尾部说明` }) as any;

    expect(card.body.elements).toContainEqual(expect.objectContaining({ tag: "markdown", content: "结论" }));
    expect(card.body.elements).toContainEqual(expect.objectContaining({ tag: "markdown", content: "尾部说明" }));
    expect(JSON.stringify(card)).toContain("TypeScript 代码 · 81 行");
    expect(JSON.stringify(card)).toContain('\"expanded\":false');
    expect(JSON.stringify(card)).toContain("const line80 = 80;");
  });

  it("folds long one-line JSON but leaves short and malformed fences as Markdown", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Fold JSON", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 0, occurredAt: "now" });
    const longJson = `{\"data\":\"${"x".repeat(6_001)}\"}`;
    const folded = JSON.stringify(renderFinalAnswerCard({ ...view, phase: "completed" }, { initialContent: `\`\`\`json\n${longJson}\n\`\`\`` }));
    expect(folded).toContain("配置 / JSON");
    expect(folded).toContain("1 行");
    expect(folded).toContain("字符");
    expect(renderFinalAnswerCard({ ...view, phase: "completed" }, { initialContent: "```ts\nconst short = true;\n```" })).toMatchObject({ header: { template: "green" } });
    expect(renderFinalAnswerCard({ ...view, phase: "completed" }, { initialContent: "```ts\nconst incomplete = true;" })).toMatchObject({ header: { template: "green" } });
  });

  it("gives each oversized completed fence a semantic panel title", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Semantic panels", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 0, occurredAt: "now" });
    const long = Array.from({ length: 81 }, (_, index) => `line-${index}`).join("\n");
    const content = [
      "说明", "", `\`\`\`bash\n${long}\n\`\`\``, "", `\`\`\`text\n${long}\n\`\`\``, "",
      `\`\`\`diff\n${long}\n\`\`\``, "", `\`\`\`json\n${long}\n\`\`\``, "", `\`\`\`ts\n${long}\n\`\`\``
    ].join("\n");
    const card = renderFinalAnswerCard({ ...view, phase: "completed" }, { initialContent: content }) as any;
    const titles = card.body.elements.filter((element: { tag: string }) => element.tag === "collapsible_panel")
      .map((element: { header: { title: { content: string } } }) => element.header.title.content);

    expect(titles).toEqual(expect.arrayContaining([
      expect.stringContaining("命令"), expect.stringContaining("执行输出"), expect.stringContaining("变更 Diff"),
      expect.stringContaining("配置 / JSON"), expect.stringContaining("TypeScript 代码")
    ]));
    expect(titles.every((title: string) => title.includes("81 行") && title.includes("字符"))).toBe(true);
    expect(card.body.elements).toContainEqual(expect.objectContaining({ tag: "markdown", content: "说明" }));
  });

  it("uses a generic title for an unknown oversized fence language", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Unknown fence", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 0, occurredAt: "now" });
    const code = Array.from({ length: 81 }, (_, index) => `line-${index}`).join("\n");
    const card = JSON.stringify(renderFinalAnswerCard({ ...view, phase: "completed" }, { initialContent: `\`\`\`made-up\n${code}\n\`\`\`` }));

    expect(card).toContain("代码块 · 81 行");
    expect(card).not.toContain("made-up 代码");
  });

  it("renders a conversational answer with compact metadata and arbitrary continuation pages", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Explain rollout", sessionTitle: "datasage / task-7kq2", workspaceId: "w1", paneId: "w1:p9", requestText: "Explain", queuePosition: 1, occurredAt: "start" });
    const completed = { ...view, phase: "completed" as const, startedAt: "2026-08-22T10:00:00Z", finishedAt: "2026-08-22T10:01:05Z", answer: "older page" };
    const card = renderRequestAnswerCard(completed, { pageNumber: 7, initialContent: "Only page seven" }) as { header: { title: { content: string }; subtitle: { content: string } }; body: { elements: Array<{ tag: string; content?: string; element_id?: string }> } };

    expect(card.header).toMatchObject({ title: { content: "✅ TraeX 回复已完成 · 第 7 页" }, subtitle: { content: "datasage / task-7kq2 · Explain rollout" } });
    expect(card).toMatchObject({ config: { streaming_mode: false }, header: { title: { content: "✅ TraeX 回复已完成 · 第 7 页" }, template: "green" } });
    expect(card.body.elements[0]).toMatchObject({ tag: "markdown", content: "最终结果  ·  ✅ 任务完成  ·  Pane `w1:p9`  ·  用时 1m 5s  ·  第 7 页" });
    expect(card.body.elements[1]).toEqual({ tag: "hr" });
    expect(card.body.elements[2]).toMatchObject({ tag: "markdown", element_id: "answer_content_p1_0", content: "Only page seven" });
    expect(JSON.stringify(card)).not.toContain("older page");
  });

  it("enables cumulative CardKit streaming without character-by-character playback", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Stream", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 0, occurredAt: "start" });

    expect(renderRequestAnswerCard({ ...view, phase: "running" })).toMatchObject({
      config: { streaming_mode: true }
    });
    expect(JSON.stringify(renderRequestAnswerCard({ ...view, phase: "running" }))).not.toContain("streaming_config");
    expect(renderRequestAnswerCard({ ...view, phase: "completed" })).toMatchObject({ config: { streaming_mode: false } });
    expect(JSON.stringify(renderRequestAnswerCard({ ...view, phase: "completed" }))).not.toContain("streaming_config");
  });

  it("falls back to space and pane id for legacy Answer Card views", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Stream", workspaceId: "w1", spaceName: "datasage", paneId: "w5:p3G", requestText: "go", queuePosition: 0, occurredAt: "start" });

    expect(renderRequestAnswerCard({ ...view, phase: "running" })).toMatchObject({
      header: { title: { content: "✨ TraeX 回复" }, subtitle: { content: "datasage / w5:p3G · Stream" } }
    });
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

    expect(serialized).toContain("✅ 任务完成  ·  Pane `w1:p1`  ·  用时 2m 5s");
    expect(serialized).not.toContain("STATUS");
    expect(serialized).not.toContain("QUEUE");
  });

  it("renders an expanded conversational request with one compact metadata line", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Fix login", workspaceId: "w1", spaceName: "datasage_semantic_knowledge", paneId: "w1:p2", requestText: "Fix login", queuePosition: 1, occurredAt: "now" });
    const card = renderRequestRunCard(view) as { header: { title: { content: string }; subtitle: { content: string } }; body: { elements: Array<{ tag: string; content?: string }> } };

    expect(card.header).toMatchObject({ title: { content: "💬 你的请求" }, subtitle: { content: "Fix login" } });
    expect(card.body.elements.filter((element) => element.tag === "collapsible_panel")).toEqual([]);
    expect(card.body.elements.filter((element) => element.content?.includes("Fix login"))).toHaveLength(1);
    expect(card.body.elements.filter((element) => element.content?.includes("已排队  ·  Pane `w1:p2`  ·  队列第 1 位"))).toHaveLength(1);
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
    expect(serialized).toContain("old answer");
    expect(serialized).toContain("已省略中间");
  });

  it("keeps both ends of a long initial Answer Card render while preserving supplied page content", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Large JSON", workspaceId: "w1", paneId: "p1", requestText: "show", queuePosition: 0, occurredAt: "now" });
    const answer = ["{", "  \"head-field\": true,", ...Array.from({ length: 600 }, (_, index) => `  \"middle-${index}\": ${index},`), "  \"tail-field\": true", "}"].join("\n");
    const card = renderRequestAnswerCard({ ...view, phase: "completed", answer }) as { body: { elements: Array<{ content?: string; element_id?: string }> } };
    const content = card.body.elements.find((element) => element.element_id)?.content ?? "";
    expect(content).toContain("head-field");
    expect(content).toContain("tail-field");
    expect(content).toContain("已省略中间");
    expect(content.length).toBeLessThanOrEqual(9_000);
    expect(answer).toContain("middle-599");

    expect(JSON.stringify(renderRequestAnswerCard({ ...view, phase: "completed", answer }, { initialContent: "canonical page content" }))).toContain("canonical page content");
  });

  it("does not inspect accumulated answer fields when canonical page content is supplied", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Prepared", workspaceId: "w1", paneId: "p1", requestText: "show", queuePosition: 0, occurredAt: "now" });
    const prepared = { ...view, phase: "running" as const };
    for (const field of ["answer", "answerSegments", "answerDraft"] as const) {
      Object.defineProperty(prepared, field, { get() { throw new Error(`unexpected ${field} read`); } });
    }

    const card = renderRequestAnswerCard(prepared, { initialContent: "" }) as { body: { elements: Array<{ content?: string; element_id?: string }> } };

    expect(card.body.elements.find((element) => element.element_id)?.content).toBe("");
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
    expect(queued).toContain("Do the work");
    expect(queued).toContain("⏳ 已排队  ·  Pane `p1`  ·  队列第 3 位");

    const card = renderRequestRunCard({ ...view, phase: "running" });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("🧠 TraeX 正在处理  ·  Pane `p1`");
    expect(serialized).not.toContain("执行计划");
  });

  it("renders exact durable queue feedback without a steering conversion action", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", bindingGeneration: 3, conversionParentPromptId: "parent", title: "Task", workspaceId: "w1", paneId: "p1", requestText: "Do the work", queuePosition: 3, occurredAt: "now" });
    const card = renderRequestAnswerCard({ ...view, queueFeedback: { aheadCount: 2, activeElapsedSeconds: 48, estimateLowerSeconds: 60, estimateUpperSeconds: 180, sampleCount: 3, elapsedBucket: 1 } });
    expect(findTaggedNodes(card, "markdown").map((node) => node.content)).toContain("⏳ 已排队 · 前方 2 条\n当前任务已运行 48 秒\n预计等待约 1–3 分钟");
    expect(JSON.stringify(card)).not.toContain("改为立即补充");
  });

  it("omits only unavailable queue feedback lines", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "p1", requestText: "Do the work", queuePosition: 1, occurredAt: "now" });
    const insufficient = renderRequestAnswerCard({ ...view, queueFeedback: { aheadCount: 0, activeElapsedSeconds: 48, estimateLowerSeconds: null, estimateUpperSeconds: null, sampleCount: 2, elapsedBucket: 1 } });
    expect(findTaggedNodes(insufficient, "markdown").map((node) => node.content)).toContain("⏳ 已排队 · 前方 0 条\n当前任务已运行 48 秒");
    expect(JSON.stringify(insufficient)).not.toContain("预计等待");
    const noActive = renderRequestAnswerCard({ ...view, queueFeedback: { aheadCount: 0, activeElapsedSeconds: null, estimateLowerSeconds: 0, estimateUpperSeconds: 30, sampleCount: 3, elapsedBucket: null } });
    expect(findTaggedNodes(noActive, "markdown").map((node) => node.content)).toContain("⏳ 已排队 · 前方 0 条\n预计等待约 0–1 分钟");
    expect(JSON.stringify(noActive)).not.toContain("当前任务已运行");
  });
});

function mainCardCallbackActions(card: object): string[] {
  return findTaggedNodes(card, "button")
    .map((button) => callbackValue(button)?.action)
    .filter((action): action is string => typeof action === "string");
}

function callbackValue(button: Record<string, unknown>): Record<string, unknown> | undefined {
  const behaviors = button.behaviors;
  if (!Array.isArray(behaviors)) return undefined;
  const callback = behaviors.find((behavior) => behavior && typeof behavior === "object" && (behavior as Record<string, unknown>).type === "callback") as Record<string, unknown> | undefined;
  return callback?.value && typeof callback.value === "object" && !Array.isArray(callback.value) ? callback.value as Record<string, unknown> : undefined;
}
