import { describe, expect, it } from "vitest";
import { planRichTextAnswerPage, safeStreamingMarkdown, shouldRefreshRichText } from "../src/runtime/answer-rich-text.js";

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

  it("renders tool activity inline and labels continuation pages", () => {
    const items = [{ kind: "tool" as const, id: "t1", sequence: 1, category: "command" as const, label: "npm test", command: "npm test", resultPreview: "ok", state: "succeeded" as const }];
    const page = planRichTextAnswerPage(items, null, { active: true, pageIndex: 1 });
    expect(page.document.title).toBe("回答（续 2）");
    expect(page.document.markdown).toContain("⚙️ Command · npm test · ✓ 完成");
    expect(page.document.markdown).toContain("```bash\nnpm test\n```");
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
