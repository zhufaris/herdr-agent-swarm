import { describe, expect, it } from "vitest";
import { planRichTextAnswerPage, richTextAnswerTitle, safeStreamingMarkdown, shouldRefreshRichText } from "../src/runtime/answer-rich-text.js";

describe("safe rich-text Answer streaming", () => {
  it("uses a 500ms floor and admits an eight-character content delta", () => {
    const previous = JSON.stringify({ document: { markdown: "hello\n\n💭" } });
    expect(shouldRefreshRichText(previous, { markdown: "hello12345678\n\n💭·" }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:00.499Z"))).toBe(false);
    expect(shouldRefreshRichText(previous, { markdown: "hello12345678\n\n💭·" }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:00.500Z"))).toBe(true);
  });

  it("refreshes small semantic boundaries after the floor", () => {
    const previous = JSON.stringify({ document: { markdown: "hello\n\n💭" } });
    expect(shouldRefreshRichText(previous, { markdown: "hello.\n\n💭·" }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:00.500Z"))).toBe(true);
    expect(shouldRefreshRichText(previous, { markdown: "hello\nnext\n\n💭·" }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:00.500Z"))).toBe(true);
  });

  it("eventually refreshes a small real delta but never a cursor-only change", () => {
    const previous = JSON.stringify({ document: { markdown: "hello\n\n💭" } });
    expect(shouldRefreshRichText(previous, { markdown: "hello+\n\n💭·" }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:01.199Z"))).toBe(false);
    expect(shouldRefreshRichText(previous, { markdown: "hello+\n\n💭·" }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:01.200Z"))).toBe(true);
    expect(shouldRefreshRichText(previous, { markdown: "hello\n\n💭··" }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:02.000Z"))).toBe(false);
  });

  it("refreshes non-append tool or task mutations after the floor", () => {
    const previous = JSON.stringify({ document: { markdown: "⚙️ Ran · …\n\n💭" } });
    expect(shouldRefreshRichText(previous, { markdown: "⚙️ Ran · ✓\n\n💭·" }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:00.499Z"))).toBe(false);
    expect(shouldRefreshRichText(previous, { markdown: "⚙️ Ran · ✓\n\n💭·" }, "2026-09-27T00:00:00.000Z", Date.parse("2026-09-27T00:00:00.500Z"))).toBe(true);
  });

  it("fails open for changed content when the previous update timestamp is invalid", () => {
    const previous = JSON.stringify({ document: { markdown: "hello\n\n💭" } });
    expect(shouldRefreshRichText(previous, { markdown: "hello+\n\n💭·" }, "not-a-time", Date.parse("2026-09-27T00:00:00.500Z"))).toBe(true);
    expect(shouldRefreshRichText(previous, { markdown: "hello\n\n💭·" }, "not-a-time", Date.parse("2026-09-27T00:00:00.500Z"))).toBe(false);
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
    expect(planRichTextAnswerPage(items, null, { active: true, pageIndex: 0 }).document).toEqual({ markdown: "Hello **world**\n\n💭" });
    expect(planRichTextAnswerPage(items, null, { active: false, pageIndex: 0 }).document).toEqual({ markdown: "Hello **world**" });
  });

  it("advances the active marker from durable activity frames", () => {
    const items = [{ kind: "agent_message" as const, id: "m1", sequence: 1, markdown: "Working" }];
    expect([0, 1, 2, 3, 4].map((activityFrame) => planRichTextAnswerPage(items, null, { active: true, pageIndex: 0, activityFrame }).document.markdown))
      .toEqual(["Working\n\n💭", "Working\n\n💭·", "Working\n\n💭··", "Working\n\n💭···", "Working\n\n💭"]);
  });

  it("builds stable Primary and Worker metadata titles with token preference", () => {
    expect(richTextAnswerTitle({ projectId: "herdr-agent-swarm", paneId: "wN:p4D", paneToken: "vdfn" }, 0))
      .toBe("🤖 herdr-agent-swarm · vdfn");
    expect(richTextAnswerTitle({ projectId: "herdr-agent-swarm", paneId: "wN:p4E", paneToken: "yx0c", workerName: "reviewer" }, 1))
      .toBe("🤖 herdr-agent-swarm · yx0c · reviewer · 第 2 页");
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
    const metadata = { projectId: "bridge", paneId: "w1:p1", paneToken: "abcd", taskTitle: "Fix Markdown" };
    expect(planRichTextAnswerPage([], null, { active: true, pageIndex: 0, metadata }).document.title).toBe("🤖 bridge · abcd · Fix Markdown");
    expect(planRichTextAnswerPage([], null, { active: false, pageIndex: 2, metadata }).document.title).toBe("🤖 bridge · abcd · Fix Markdown · 第 3 页");
  });

  it("renders command tool activity as bash Markdown and labels continuation pages", () => {
    const items = [{ kind: "tool" as const, id: "t1", sequence: 1, category: "command" as const, label: "npm test", command: "npm test", resultPreview: "ok", state: "succeeded" as const }];
    const page = planRichTextAnswerPage(items, null, { active: true, pageIndex: 1 });
    expect(page.document.title).toBe("回答（第 2 页）");
    expect(page.document.markdown).toContain("🖥️ Ran · npm test · ✅\n\n```bash\nnpm test\n```");
    expect(page.document.markdown).toContain("> └ ok");
    expect(page.document.markdown).not.toContain("`npm test`");
  });

  it("preserves multiline test commands and uses a fence longer than embedded backticks", () => {
    const command = "npm test -- --runInBand\nprintf '```inside```'";
    const items = [{ kind: "tool" as const, id: "t1", sequence: 1, category: "test" as const, label: "npm test", command, state: "running" as const }];
    const markdown = planRichTextAnswerPage(items, null, { active: true, pageIndex: 0 }).document.markdown;
    expect(markdown).toContain("🧪 Tested · npm test -- --runInBand · ⏳\n\n````bash\n" + command + "\n````");
  });

  it("sanitizes and redacts command blocks", () => {
    const items = [{ kind: "tool" as const, id: "t1", sequence: 1, category: "command" as const, label: "shell", command: "\u001b[32mecho ok\u001b[0m\nclient_secret=do-not-show", state: "succeeded" as const }];
    const markdown = planRichTextAnswerPage(items, null, { active: false, pageIndex: 0 }).document.markdown;
    expect(markdown).toContain("```bash\necho ok\nclient_secret=[REDACTED]\n```");
    expect(markdown).not.toContain("do-not-show");
    expect(markdown).not.toContain("\u001b");
  });

  it("uses distinct compact markers for tool and status activity", () => {
    const items = [
      { kind: "tool" as const, id: "read", sequence: 1, category: "read" as const, label: "src/main.ts", state: "running" as const },
      { kind: "tool" as const, id: "search", sequence: 2, category: "search" as const, label: "planRichText", state: "succeeded" as const },
      { kind: "tool" as const, id: "edit", sequence: 3, category: "edit" as const, label: "answer-rich-text.ts", state: "failed" as const },
      { kind: "tool" as const, id: "input", sequence: 4, category: "input" as const, label: "session 263", command: "echo first\necho second", state: "succeeded" as const },
      { kind: "tool" as const, id: "test", sequence: 5, category: "test" as const, label: "vitest", state: "succeeded" as const },
      { kind: "tool" as const, id: "step", sequence: 6, category: "step" as const, label: "deploy", state: "running" as const },
      { kind: "status" as const, id: "running", sequence: 7, label: "正在分析", state: "running" as const },
      { kind: "status" as const, id: "blocked", sequence: 8, label: "需要授权", state: "blocked" as const },
      { kind: "status" as const, id: "failed", sequence: 9, label: "连接中断", state: "failed" as const }
    ];
    const markdown = planRichTextAnswerPage(items, null, { active: true, pageIndex: 0 }).document.markdown;
    expect(markdown).toContain("📖 Read · src/main.ts · ⏳");
    expect(markdown).toContain("🔎 Search · planRichText · ✅");
    expect(markdown).toContain("✏️ Edited · answer-rich-text.ts · ❌");
    expect(markdown).toContain("⌨️ Input · session 263 · ✅");
    expect(markdown).toContain("```bash\necho first\necho second\n```");
    expect(markdown).toContain("🧪 Tested · vitest · ✅");
    expect(markdown).toContain("🔧 Tool · deploy · ⏳");
    expect(markdown).toContain("💭 正在生成 · 正在分析");
    expect(markdown).toContain("⚠️ 等待用户处理 · 需要授权");
    expect(markdown).toContain("❌ 执行失败 · 连接中断");
  });

  it("selects useful preview lines by tool state while sanitizing and redacting output", () => {
    const items = [
      { kind: "tool" as const, id: "running", sequence: 1, category: "read" as const, label: "running", resultPreview: "first\nlatest", state: "running" as const },
      { kind: "tool" as const, id: "succeeded", sequence: 2, category: "read" as const, label: "\u001b[32msrc/config.ts\u001b[0m", resultPreview: "\u001b[31mfirst line\u001b[0m\n\nclient_secret=do-not-show\nthird line", state: "succeeded" as const },
      { kind: "tool" as const, id: "failed", sequence: 3, category: "test" as const, label: "failed", resultPreview: "error header\ndetail one\ndetail two\nfinal cause", state: "failed" as const }
    ];
    const markdown = planRichTextAnswerPage(items, null, { active: false, pageIndex: 0 }).document.markdown;
    expect(markdown).toContain("📖 Read · src/config.ts · ✅");
    expect(markdown).toContain("> └ latest （前 1 行已省略）");
    expect(markdown).toContain("> └ third line （前 2 行已省略）");
    expect(markdown).toContain("> └ error header …（省略 2 行）… final cause");
    expect(markdown).not.toContain("do-not-show");
    expect(markdown).not.toContain("\u001b");
  });

  it("preserves both ends of a long failed tool preview", () => {
    const items = [{
      kind: "tool" as const, id: "failed", sequence: 1, category: "test" as const, label: "suite",
      resultPreview: `${"header ".repeat(40)}\nintermediate\n${"detail ".repeat(40)}final cause`, state: "failed" as const
    }];
    const markdown = planRichTextAnswerPage(items, null, { active: false, pageIndex: 0 }).document.markdown;

    expect(markdown).toContain("> └ header");
    expect(markdown).toContain("final cause");
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
    expect(active).toContain("- … 5 个其他步骤");
    expect(active).not.toContain("步骤 1");
    expect(active).toContain("- ■ 步骤 5");
    expect(active).toContain("- ✕ 步骤 7");
    expect(active).toMatch(/📋 \*\*任务 4\/7\*\*[\s\S]*\n\n💭$/);

    const terminal = planRichTextAnswerPage([], null, { active: false, pageIndex: 0, progressEvents }).document.markdown;
    expect(terminal).toContain("📋 **任务 4/7**");
    expect(terminal).not.toContain("💭");
  });

  it("renders terminal state and valid duration only on terminal pages", () => {
    const items = [{ kind: "final_answer" as const, id: "m1", sequence: 1, markdown: "Done" }];
    const completed = planRichTextAnswerPage(items, null, {
      active: false, pageIndex: 0,
      terminalSummary: { state: "completed", startedAt: "2026-09-27T00:00:00.000Z", finishedAt: "2026-09-27T00:01:05.000Z" }
    }).document.markdown;
    expect(completed).toContain("---\n✅ 已完成 · 用时 1m 5s");

    const invalid = planRichTextAnswerPage(items, null, {
      active: false, pageIndex: 0,
      terminalSummary: { state: "failed", startedAt: "later", finishedAt: "earlier" }
    }).document.markdown;
    expect(invalid).toContain("---\n❌ 执行失败");
    expect(invalid).not.toContain("用时");

    const active = planRichTextAnswerPage(items, null, {
      active: true, pageIndex: 0,
      terminalSummary: { state: "cancelled", startedAt: "2026-09-27T00:00:00.000Z", finishedAt: "2026-09-27T00:00:01.000Z" }
    }).document.markdown;
    expect(active).not.toContain("已取消");
    expect(planRichTextAnswerPage(items, null, { active: false, pageIndex: 0 }).document.markdown).not.toMatch(/已完成|执行失败|已取消|状态不确定/);
  });

  it("advances the canonical cursor across long Markdown without whitespace", () => {
    const items = [{ kind: "final_answer" as const, id: "m1", sequence: 1, markdown: "a".repeat(20_000) }];
    const first = planRichTextAnswerPage(items, null, { active: false, pageIndex: 0, limit: 9_000 });
    const second = planRichTextAnswerPage(items, first.nextCursor, { active: false, pageIndex: 1, limit: 9_000 });
    expect(first.nextCursor?.markdownOffset).toBeGreaterThan(0);
    expect(second.nextCursor?.markdownOffset).toBeGreaterThan(first.nextCursor!.markdownOffset);
    expect(second.document.title).toBe("回答（第 2 页）");
  });

  it("budgets tool-heavy pages from the compact Markdown that is actually delivered", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      kind: "tool" as const,
      id: `tool:${index}`,
      sequence: index + 1,
      category: "command" as const,
      label: `command ${index}`,
      command: `printf '${"x".repeat(2_000)}'`,
      resultPreview: "result ".repeat(2_000),
      state: "succeeded" as const
    }));

    const first = planRichTextAnswerPage(items, null, { active: false, pageIndex: 0, limit: 12_000 });

    expect(first.document.markdown.length).toBeGreaterThan(8_000);
    expect(first.document.markdown.length).toBeLessThanOrEqual(12_000);
    expect(first.nextCursor?.itemIndex).toBeGreaterThanOrEqual(8);
  });
});
