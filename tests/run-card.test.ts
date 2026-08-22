import { describe, expect, it } from "vitest";
import { renderProjectSelectorCard, renderRequestRunCard, renderRunCard } from "../src/cards/run-card.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";

describe("run card", () => {
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

  it("renders separate expanded progress and answer regions for a completed request", () => {
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Fix login", workspaceId: "w1", spaceName: "datasage_semantic_knowledge", paneId: "w1:p2", requestText: "## Request\nFix **login** <script>bad()</script>", queuePosition: 1, occurredAt: "2026-08-22T10:00:00Z" });
    const output = reduceRunCard(queued, { type: "output", occurredAt: "2026-08-22T10:00:01Z", answerDelta: "partial", progressEvents: [{ key: "read:a", kind: "read", label: "已读取 src/a.ts", state: "done", occurredAt: "2026-08-22T10:00:01Z" }] });
    const completed = reduceRunCard(output, { type: "completed", occurredAt: "2026-08-22T10:00:02Z", answer: "Fixed." });
    const card = renderRequestRunCard(completed);
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ schema: "2.0", config: { streaming_mode: false }, header: { template: "green" } });
    expect(serialized).toContain("执行进度");
    expect(serialized).toContain("📩 **已接收请求**");
    expect(serialized).toContain("## Request\\nFix **login**");
    expect(serialized).not.toContain("bad()");
    expect(serialized).toContain("📖 已读取 src/a.ts");
    expect(serialized).toContain("回答");
    expect(serialized).toContain("Fixed.");
    expect(serialized).not.toContain("partial");
    expect(serialized).toContain("SPACE");
    expect(serialized).toContain("datasage_semantic_knowledge");
    expect(serialized).not.toContain("WORKSPACE");
    expect(serialized).not.toContain('**WORKSPACE**\n`w1`');
  });

  it("keeps recent progress and reports omitted older entries", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Large", workspaceId: "w1", paneId: "p1", requestText: "Inspect files", queuePosition: 1, occurredAt: "now" });
    const card = renderRequestRunCard({ ...view, progressEvents: Array.from({ length: 90 }, (_, index) => ({ key: "read:" + index, kind: "read" as const, label: "已读取 file-" + index, state: "done" as const, occurredAt: "now" })) });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("已省略 30 条较早记录");
    expect(serialized).not.toContain("已读取 file-0\"");
    expect(serialized).toContain("已读取 file-89");
  });

  it("shows request, queue state, and semantic emoji for every progress kind", () => {
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "p1", requestText: "Do the work", queuePosition: 3, occurredAt: "now" });
    const queued = JSON.stringify(renderRequestRunCard(view));
    expect(queued).toContain("📩 **已接收请求**");
    expect(queued).toContain("⏳ 已进入队列 · 当前第 3 位");

    const card = renderRequestRunCard({ ...view, phase: "running", progressEvents: [
      { key: "a", kind: "analyze", label: "正在分析请求", state: "active", occurredAt: "now" },
      { key: "s", kind: "search", label: "正在查找相关代码", state: "active", occurredAt: "now" },
      { key: "r", kind: "read", label: "已读取 a.ts", state: "done", occurredAt: "now" },
      { key: "e", kind: "edit", label: "已修改 a.ts", state: "done", occurredAt: "now" },
      { key: "t", kind: "test", label: "正在运行测试", state: "active", occurredAt: "now" },
      { key: "td", kind: "test", label: "测试通过", state: "done", occurredAt: "now" },
      { key: "f", kind: "test", label: "测试失败", state: "failed", occurredAt: "now" }
    ] });
    const serialized = JSON.stringify(card);
    for (const line of ["🧠 正在分析请求", "🔍 正在查找相关代码", "📖 已读取 a.ts", "✏️ 已修改 a.ts", "🧪 正在运行测试", "✅ 测试通过", "❌ 测试失败"]) {
      expect(serialized).toContain(line);
    }
  });
});
