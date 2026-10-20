import { describe, expect, it } from "vitest";
import { compactAnswerToolActivity, foldFinalAnswerContent } from "../src/cards/final-answer-content.js";

describe("final answer content", () => {
  it("folds oversized complete code while preserving surrounding Markdown", () => {
    const code = Array.from({ length: 81 }, (_, index) => `line-${index}`).join("\n");
    const elements = foldFinalAnswerContent(`intro\n\n\`\`\`ts\n${code}\n\`\`\`\n\noutro`);
    expect(elements).toContainEqual({ tag: "markdown", content: "intro" });
    expect(elements).toContainEqual({ tag: "markdown", content: "outro" });
    const panel = elements.find((element) => element.tag === "collapsible_panel") as { expanded: boolean; header: { title: { content: string } } } | undefined;
    expect(panel).toMatchObject({ expanded: false });
    expect(panel?.header.title.content).toContain("TypeScript 代码 · 81 行");
  });

  it("leaves short and incomplete fences as Markdown", () => {
    expect(foldFinalAnswerContent("```ts\nconst ready = true;\n```")).toEqual([{ tag: "markdown", content: "```ts\nconst ready = true;\n```" }]);
    expect(foldFinalAnswerContent("```ts\nconst incomplete = true;")).toEqual([{ tag: "markdown", content: "```ts\nconst incomplete = true;" }]);
  });

  it("renders literal legacy command Markdown without special handling", () => {
    const source = ["before", "", "◆ **Ran**", "", "```bash", "npm test", "```", "", "```text", "12 tests passed", "```", "", "after"].join("\n");

    expect(compactAnswerToolActivity(source)).toBe(source);
    const elements = foldFinalAnswerContent(source);
    expect(elements).toEqual([
      { tag: "markdown", content: "before\n\n◆ **Ran**" },
      { tag: "markdown", content: "```bash\nnpm test\n```" },
      { tag: "markdown", content: "```text\n12 tests passed\n```" },
      { tag: "markdown", content: "after" }
    ]);
  });

  it("adds one type emoji to recognized activity rows without touching prose or fenced literals", () => {
    const source = [
      "✓ Read · src/main.ts", "… Search · answer · 运行中", "✗ Edit · run-card.ts · denied",
      "✓ Skill · brainstorming", "✓ Agent · reviewer", "✓ Tool · future_tool",
      "✓ 等待完成 · session 42", "ordinary Read · prose", "```text", "✓ Read · literal.txt", "```"
    ].join("\n");

    expect(compactAnswerToolActivity(source)).toBe([
      "📖 Read · src/main.ts", "🔍 Search · answer · 运行中", "✏️ Edit · run-card.ts · denied",
      "🧩 Skill · brainstorming", "🤖 Agent · reviewer", "🛠️ Tool · future_tool",
      "⏳ Wait · session 42 · ✓ 完成", "ordinary Read · prose", "```text", "✓ Read · literal.txt", "```"
    ].join("\n"));
  });
});
