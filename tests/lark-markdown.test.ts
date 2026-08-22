import { describe, expect, it } from "vitest";
import { normalizeLarkMarkdown, normalizeLarkPreview, truncateLarkMarkdown, truncateLarkMarkdownTail } from "../src/runtime/lark-markdown.js";

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

  it("keeps the newest safe Markdown when truncating a rolling window", () => {
    const result = truncateLarkMarkdownTail(`<script>bad()</script>${"old".repeat(800)}\n\n**new result**`, 80);
    expect(result).toContain("较早内容已省略");
    expect(result).toContain("**new result**");
    expect(result).not.toContain("bad()");
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it("unwraps narrow terminal prose while preserving Markdown blocks", () => {
    const source = [
      "当前主线已", "从“代码/部", "署问题”收敛", "为“下游系统", "不支持当前", "服务账号身", "份”。", "",
      "下一步需要二", "选一：", "", "- 短期：完成授权", "- 长期：支持 service principal", "",
      "```text", "keep", "line breaks", "```"
    ].join("\n");

    expect(normalizeLarkPreview(source)).toBe([
      "当前主线已从“代码/部署问题”收敛为“下游系统不支持当前服务账号身份”。", "",
      "下一步需要二选一：", "", "- 短期：完成授权", "- 长期：支持 service principal", "",
      "```text", "keep", "line breaks", "```"
    ].join("\n"));
  });
});
