import { describe, expect, it } from "vitest";
import { foldFinalAnswerContent } from "../src/cards/final-answer-content.js";

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
});
