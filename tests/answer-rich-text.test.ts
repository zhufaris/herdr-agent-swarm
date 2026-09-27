import { describe, expect, it } from "vitest";
import { planRichTextAnswerPage, richTextAnswerTitle, safeStreamingMarkdown, shouldRefreshRichText } from "../src/runtime/answer-rich-text.js";

describe("safe rich-text Answer streaming", () => {
  it("throttles small rapid snapshots but admits a useful later chunk", () => {
    const previous = JSON.stringify({ document: { markdown: "hello\n\n▌" } });
    expect(shouldRefreshRichText(previous, { markdown: "hello again\n\n▌" }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:00.500Z"))).toBe(false);
    expect(shouldRefreshRichText(previous, { markdown: `hello ${"x".repeat(60)}\n\n▌` }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:01.000Z"))).toBe(true);
  });
  it("withholds an incomplete fenced block until it closes", () => {
    expect(safeStreamingMarkdown("Before\n\n```ts\nconst value = 1;")).toBe("Before");
    expect(safeStreamingMarkdown("Before\n\n```ts\nconst value = 1;\n```\nAfter")).toContain("const value = 1;");
  });

  it("withholds incomplete inline code and links", () => {
    expect(safeStreamingMarkdown("Ready `partial")).toBe("Ready");
    expect(safeStreamingMarkdown("Read [the docs")).toBe("Read");
    expect(safeStreamingMarkdown("Read [the docs](https://example.com)")).toBe("Read [the docs](https://example.com)");
  });

  it("adds a cursor only to active pages", () => {
    const items = [{ kind: "agent_message" as const, id: "m1", sequence: 1, markdown: "Hello **world**" }];
    expect(planRichTextAnswerPage(items, null, { active: true, pageIndex: 0 }).document).toEqual({ markdown: "Hello **world**\n\n▌" });
    expect(planRichTextAnswerPage(items, null, { active: false, pageIndex: 0 }).document).toEqual({ markdown: "Hello **world**" });
  });

  it("builds stable Primary and Worker metadata titles with token preference", () => {
    expect(richTextAnswerTitle({ projectId: "herdr-agent-swarm", paneId: "wN:p4D", paneToken: "vdfn" }, 0))
      .toBe("🤖 herdr-agent-swarm · vdfn");
    expect(richTextAnswerTitle({ projectId: "herdr-agent-swarm", paneId: "wN:p4E", paneToken: "yx0c", workerName: "reviewer" }, 1))
      .toBe("🤖 herdr-agent-swarm · yx0c · reviewer · 续 2");
  });

  it("falls back to Pane ID and safely bounds malformed title metadata", () => {
    expect(richTextAnswerTitle({ projectId: " bridge\nproject ", paneId: "wN:p4D", paneToken: null }, 0))
      .toBe("🤖 bridge project · wN:p4D");
    const title = richTextAnswerTitle({ projectId: `token=secret ${"p".repeat(200)}`, paneId: null, paneToken: null, workerName: "worker\nname" }, 0);
    expect(title).toContain("token=[REDACTED]");
    expect(title).toContain("未知 Pane");
    expect(title).toContain("worker name");
    expect(title.length).toBeLessThanOrEqual(200);
  });

  it("attaches metadata titles to active and terminal page documents", () => {
    const metadata = { projectId: "bridge", paneId: "w1:p1", paneToken: "abcd" };
    expect(planRichTextAnswerPage([], null, { active: true, pageIndex: 0, metadata }).document.title).toBe("🤖 bridge · abcd");
    expect(planRichTextAnswerPage([], null, { active: false, pageIndex: 2, metadata }).document.title).toBe("🤖 bridge · abcd · 续 3");
  });

  it("renders tool activity inline and labels continuation pages", () => {
    const items = [{ kind: "tool" as const, id: "t1", sequence: 1, category: "command" as const, label: "npm test", command: "npm test", resultPreview: "ok", state: "succeeded" as const }];
    const page = planRichTextAnswerPage(items, null, { active: true, pageIndex: 1 });
    expect(page.document.title).toBe("回答（续 2）");
    expect(page.document.markdown).toContain("⚙️ Ran · `npm test` · ✓");
    expect(page.document.markdown).toContain("> └ ok");
    expect(page.document.markdown).not.toContain("```bash");
  });

  it("uses distinct compact markers for tool and status activity", () => {
    const items = [
      { kind: "tool" as const, id: "read", sequence: 1, category: "read" as const, label: "src/main.ts", state: "running" as const },
      { kind: "tool" as const, id: "search", sequence: 2, category: "search" as const, label: "planRichText", state: "succeeded" as const },
      { kind: "tool" as const, id: "edit", sequence: 3, category: "edit" as const, label: "answer-rich-text.ts", state: "failed" as const },
      { kind: "tool" as const, id: "test", sequence: 4, category: "test" as const, label: "vitest", state: "succeeded" as const },
      { kind: "tool" as const, id: "step", sequence: 5, category: "step" as const, label: "deploy", state: "running" as const },
      { kind: "status" as const, id: "running", sequence: 6, label: "正在分析", state: "running" as const },
      { kind: "status" as const, id: "blocked", sequence: 7, label: "需要授权", state: "blocked" as const },
      { kind: "status" as const, id: "failed", sequence: 8, label: "连接中断", state: "failed" as const }
    ];
    const markdown = planRichTextAnswerPage(items, null, { active: true, pageIndex: 0 }).document.markdown;
    expect(markdown).toContain("📖 Read · src/main.ts · …");
    expect(markdown).toContain("🔍 Search · planRichText · ✓");
    expect(markdown).toContain("✏️ Edit · answer-rich-text.ts · ✗");
    expect(markdown).toContain("🧪 Test · vitest · ✓");
    expect(markdown).toContain("🛠️ Step · deploy · …");
    expect(markdown).toContain("⏳ 处理中 · 正在分析");
    expect(markdown).toContain("⚠️ 等待用户处理 · 需要授权");
    expect(markdown).toContain("❌ 执行失败 · 连接中断");
  });

  it("compacts, sanitizes, and redacts tool previews", () => {
    const items = [{
      kind: "tool" as const, id: "t1", sequence: 1, category: "read" as const, label: "\u001b[32msrc/config.ts\u001b[0m",
      resultPreview: "\u001b[31mfirst line\u001b[0m\n\nclient_secret=do-not-show\nthird line", state: "succeeded" as const
    }];
    const markdown = planRichTextAnswerPage(items, null, { active: false, pageIndex: 0 }).document.markdown;
    expect(markdown).toContain("📖 Read · src/config.ts · ✓");
    expect(markdown).toContain("> └ first line …（省略 2 行）");
    expect(markdown).not.toContain("do-not-show");
    expect(markdown).not.toContain("\u001b");
  });

  it("keeps one current task-list snapshot before the active cursor", () => {
    const progressEvents = [
      { key: "search:1", kind: "search" as const, label: "not a plan step", state: "done" as const, occurredAt: "1" },
      ...Array.from({ length: 7 }, (_, index) => ({
        key: `plan:${index}`, kind: "step" as const, label: `步骤 ${index + 1}`,
        state: (["done", "done", "done", "done", "active", "pending", "failed"] as const)[index]!, occurredAt: String(index + 2)
      }))
    ];
    const active = planRichTextAnswerPage([], null, { active: true, pageIndex: 0, progressEvents }).document.markdown;
    expect(active).toContain("📋 **任务 4/7**");
    expect(active).toContain("- … 2 个较早步骤");
    expect(active).not.toContain("步骤 1");
    expect(active).toContain("- ✔ 步骤 3");
    expect(active).toContain("- ■ 步骤 5");
    expect(active).toContain("- ◻ 步骤 6");
    expect(active).toContain("- ✕ 步骤 7");
    expect(active).toMatch(/📋 \*\*任务 4\/7\*\*[\s\S]*\n\n▌$/);

    const terminal = planRichTextAnswerPage([], null, { active: false, pageIndex: 0, progressEvents }).document.markdown;
    expect(terminal).toContain("📋 **任务 4/7**");
    expect(terminal).not.toContain("▌");
  });

  it("advances the canonical cursor across long Markdown without whitespace", () => {
    const items = [{ kind: "final_answer" as const, id: "m1", sequence: 1, markdown: "a".repeat(20_000) }];
    const first = planRichTextAnswerPage(items, null, { active: false, pageIndex: 0, limit: 9_000 });
    const second = planRichTextAnswerPage(items, first.nextCursor, { active: false, pageIndex: 1, limit: 9_000 });
    expect(first.nextCursor?.markdownOffset).toBeGreaterThan(0);
    expect(second.nextCursor?.markdownOffset).toBeGreaterThan(first.nextCursor!.markdownOffset);
    expect(second.document.title).toBe("回答（续 2）");
  });
});
