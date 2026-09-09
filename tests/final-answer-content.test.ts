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

  it("renders exact command activities as compact live rows and collapsed final details", () => {
    const source = ["before", "", "◆ **Ran**", "", "```bash", "npm test", "```", "", "```text", "12 tests passed", "```", "", "after"].join("\n");

    expect(compactAnswerToolActivity(source)).toBe(["before", "", "⚙️ **Ran** · `npm test` · ✓ 完成", "", "after"].join("\n"));
    const elements = foldFinalAnswerContent(source);
    expect(elements.map(({ tag }) => tag)).toEqual(["markdown", "collapsible_panel", "markdown"]);
    expect(elements[1]).toMatchObject({
      expanded: false, header: { title: { content: "⚙️ Ran · npm test · ✓ 完成" } },
      elements: [{ content: expect.stringContaining("```text\n12 tests passed\n```") }]
    });
  });

  it("folds completed commands without output, including the final Answer element", () => {
    const command = ["◆ **Ran**", "", "```bash", "npm test", "```"].join("\n");
    expect(foldFinalAnswerContent(`before\n\n${command}`)).toEqual([
      { tag: "markdown", content: "before" },
      {
        tag: "collapsible_panel", expanded: false, border: { color: "grey", corner_radius: "6px" },
        header: { title: { tag: "plain_text", content: "⚙️ Ran · npm test · ✓ 完成" } },
        elements: [{ tag: "markdown", content: "```bash\nnpm test\n```\n\n命令已完成，无可展示输出。" }]
      }
    ]);
  });

  it("folds failed commands without detail but keeps running commands compact", () => {
    const failed = ["◆ **Ran** · ✗ exit 2", "", "```bash", "npm test", "```"].join("\n");
    expect(foldFinalAnswerContent(failed)[0]).toMatchObject({
      tag: "collapsible_panel", header: { title: { content: "⚙️ Ran · npm test · ✗ exit 2" } }
    });
    const running = ["◆ **Ran** · 运行中", "", "```bash", "npm test", "```"].join("\n");
    expect(foldFinalAnswerContent(running)).toEqual([{ tag: "markdown", content: "⚙️ **Ran** · `npm test` · … 运行中" }]);
  });

  it("falls back to compact Markdown when an empty-output command panel exceeds the payload budget", () => {
    const command = ["◆ **Ran**", "", "```bash", "npm test", "```"].join("\n");
    expect(foldFinalAnswerContent(command, 100)).toEqual([{ tag: "markdown", content: "⚙️ **Ran** · `npm test` · ✓ 完成" }]);
  });

  it("preserves command lookalike prose", () => {
    const lookalike = ["◆ **Ran**", "not a bridge command block"].join("\n");
    expect(compactAnswerToolActivity(lookalike)).toBe(lookalike);
  });

  it("bounds command titles and expanded output", () => {
    const source = ["◆ **Ran**", "", "```bash", `echo ${"x".repeat(200)}`, "```", "", "```text", "y".repeat(5_000), "```"].join("\n");
    const [panel] = foldFinalAnswerContent(source);

    const title = (panel?.header as { title: { content: string } }).title.content;
    expect(title).toBe(`⚙️ Ran · echo ${"x".repeat(154)}… · ✓ 完成`);
    const detail = (panel?.elements as Array<{ content: string }>)[0]!.content;
    expect(detail).toContain(`\n${`echo ${"x".repeat(154)}…`}\n`);
    expect(detail).not.toContain("x".repeat(155));
    expect(detail).toContain(`\n${"y".repeat(3_999)}…\n`);
    expect(detail).not.toContain("y".repeat(4_001));
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
