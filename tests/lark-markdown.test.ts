import { describe, expect, it } from "vitest";
import { normalizeLarkMarkdown, normalizeLarkPreview, renderLarkMarkdownPage, truncateLarkMarkdown, truncateLarkMarkdownTail } from "../src/runtime/lark-markdown.js";

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

  it("fences consecutive TraeX numbered diff rows without guessing at signed prose", () => {
    const source = [
      "Updated the renderer:",
      "    145 +        *_table(",
      "    146 +            [\"Relationship\", \"Count\"],",
      "     19 -                {\"legacy\": true}",
      "     20 +                {",
      "+ ordinary list-like prose",
      "Growth was +12%",
      "    210 + isolated row"
    ].join("\n");

    expect(normalizeLarkMarkdown(source)).toBe([
      "Updated the renderer:",
      "```diff",
      "    145 +        *_table(",
      "    146 +            [\"Relationship\", \"Count\"],",
      "     19 -                {\"legacy\": true}",
      "     20 +                {",
      "```",
      "+ ordinary list-like prose",
      "Growth was +12%",
      "    210 + isolated row"
    ].join("\n"));
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

describe("source-aware Lark Markdown pages", () => {
  it("normalizes mixed Markdown without changing the canonical source", () => {
    const source = [
      "# Result",
      "",
      "- **done** with `value`",
      "[safe](https://example.com) [bad](javascript:alert(1))",
      "<b>visible</b><!-- hidden -->",
      "",
      "```ts",
      "const value = 1;",
      "```"
    ].join("\n");

    expect(renderLarkMarkdownPage(source, 0, 9_000)).toEqual({
      page: [
        "# Result",
        "",
        "- **done** with `value`",
        "[safe](https://example.com) bad",
        "visible",
        "",
        "```ts",
        "const value = 1;",
        "```"
      ].join("\n"),
      nextPageStart: null
    });
    expect(source).toContain("javascript:alert(1)");
  });

  it("maps transformed table pages back to canonical source offsets", () => {
    const source = [
      "Before",
      "| Name | Value |",
      "| --- | ---: |",
      "| Alpha | 1 |",
      "| Beta | 2 |",
      "After"
    ].join("\n");
    const pages: Array<{ start: number; page: string }> = [];
    let start = 0;
    while (start < source.length) {
      const rendered = renderLarkMarkdownPage(source, start, 52);
      pages.push({ start, page: rendered.page });
      if (rendered.nextPageStart === null) break;
      expect(rendered.nextPageStart).toBeGreaterThan(start);
      start = rendered.nextPageStart;
    }

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every(({ page }) => page.length <= 52)).toBe(true);
    const tablePages = pages.filter(({ page }) => page.includes("|"));
    expect(tablePages.length).toBeGreaterThan(1);
    expect(tablePages.every(({ page }) => /```text\n[\s\S]*?\n```/.test(page))).toBe(true);
    expect(source.slice(pages[1]!.start)).not.toBe(source.slice(pages[0]!.page.length));
  });

  it("normalizes CRLF while retaining canonical source offsets", () => {
    const source = "```ts\r\nconst first = 1;\r\nconst second = 2;\r\n```";
    const first = renderLarkMarkdownPage(source, 0, 34);
    const second = renderLarkMarkdownPage(source, first.nextPageStart!, 34);

    expect(first.page).not.toContain("\r");
    expect(second.page).not.toContain("\r");
    expect(first.nextPageStart).toBe(source.indexOf("const second"));
  });

  it("preserves literal links inside code while splitting at canonical offsets", () => {
    const source = [
      "```md",
      "[raw](javascript:alert(1))",
      "second line",
      "```"
    ].join("\n");
    const first = renderLarkMarkdownPage(source, 0, 45);
    const second = renderLarkMarkdownPage(source, first.nextPageStart!, 45);

    expect(first.page).toContain("[raw](javascript:alert(1))");
    expect(first.page.endsWith("```")).toBe(true);
    expect(second.page.startsWith("```md\n")).toBe(true);
    expect(second.nextPageStart).toBeNull();
  });

  it("wraps a TraeX diff across pages while retaining canonical offsets", () => {
    const source = [
      "Before",
      "  145 + first changed line",
      "  146 + second changed line",
      "  147 - third changed line",
      "After"
    ].join("\n");
    const first = renderLarkMarkdownPage(source, 0, 48);
    const second = renderLarkMarkdownPage(source, first.nextPageStart!, 48);

    expect(first.page).toContain("```diff\n  145 + first changed line\n```");
    expect(second.page).toContain("```diff\n  146 + second changed line");
    expect(first.nextPageStart).toBe(source.indexOf("  146"));
  });

  it("makes bounded progress through one long source line", () => {
    const source = "x".repeat(120);
    const first = renderLarkMarkdownPage(source, 0, 40);

    expect(first.page).toHaveLength(40);
    expect(first.nextPageStart).toBe(40);
    expect(renderLarkMarkdownPage(source, first.nextPageStart!, 40).page).toHaveLength(40);
  });
});
