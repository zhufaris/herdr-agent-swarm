import { describe, expect, it } from "vitest";
import { normalizeLarkMarkdown, truncateLarkMarkdown } from "../src/runtime/lark-markdown.js";

describe("Lark Markdown normalization", () => {
  it("preserves supported document structure and closes a streaming fence in the rendered copy", () => {
    const source = [
      "# Heading", "", "- **bold** and ~~gone~~ with `code`", "> quoted", "---",
      "```ts", "const value = 1;"
    ].join("\n");

    expect(normalizeLarkMarkdown(source)).toBe(source + "\n```");
    expect(source.endsWith("```")).toBe(false);
  });

  it("converts images and tables while removing unsafe links and HTML", () => {
    const source = [
      "![Diagram](https://example.com/a.png) ![](javascript:alert(1))",
      "[safe](https://example.com) [bad](data:text/html,x) [relative](./doc.md)",
      "<b class=\"x\">visible</b><!-- hidden --><script>alert(1)</script>",
      "",
      "| Name | Value |",
      "| --- | ---: |",
      "| A | 1 |"
    ].join("\n");

    expect(normalizeLarkMarkdown(source)).toBe([
      "[图片：Diagram](https://example.com/a.png) 图片",
      "[safe](https://example.com) bad relative",
      "visible",
      "",
      "```text",
      "| Name | Value |",
      "| --- | ---: |",
      "| A | 1 |",
      "```"
    ].join("\n"));
  });

  it("does not rewrite link-like text inside inline or fenced code", () => {
    const source = [
      "`![inline](javascript:alert(1))`",
      "```md",
      "[raw](javascript:alert(1))",
      "```"
    ].join("\n");
    expect(normalizeLarkMarkdown(source)).toBe(source);
  });

  it("marks truncation and leaves valid fenced Markdown", () => {
    const result = truncateLarkMarkdown("before\n```ts\n" + "x".repeat(100), 48);
    expect(result).toContain("…（内容已截断）");
    expect((result.match(/```/g) ?? [])).toHaveLength(2);
    expect(result.length).toBeLessThanOrEqual(48);
  });
});
