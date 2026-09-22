import { describe, expect, it } from "vitest";
import { normalizeLarkMarkdown, normalizeLarkPreview, renderLarkMarkdownPage, renderLarkMarkdownPageForTest, truncateLarkMarkdown, truncateLarkMarkdownMiddle, truncateLarkMarkdownTail } from "../src/runtime/lark-markdown.js";

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

  it("keeps both JSON ends with a bounded middle omission marker", () => {
    const source = [
      "{", "  \"first\": true,",
      ...Array.from({ length: 80 }, (_, index) => `  \"middle-${index}\": ${index},`),
      "  \"last\": true", "}"
    ].join("\n");

    const result = truncateLarkMarkdownMiddle(source, 180);

    expect(result).toContain('\"first\": true');
    expect(result).toContain('\"last\": true');
    expect(result).toMatch(/… 已省略中间 \d+ 行 \/ \d+ 字符 …/);
    expect(result.length).toBeLessThanOrEqual(180);
  });

  it("keeps short middle previews unchanged and makes progress through long lines", () => {
    expect(truncateLarkMarkdownMiddle("short", 5)).toBe("short");
    const result = truncateLarkMarkdownMiddle("x".repeat(400), 80);
    expect(result).toContain("已省略中间");
    expect(result.startsWith("x")).toBe(true);
    expect(result.endsWith("x")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it("keeps fenced Markdown balanced when the omitted range crosses block boundaries", () => {
    const source = `${"prose".repeat(80)}\n\`\`\`json\n${"x".repeat(100)}\n\`\`\``;
    const result = truncateLarkMarkdownMiddle(source, 120);

    expect(result.match(/```/g) ?? []).toHaveLength(2);
    expect(result).toContain("已省略中间");
    expect(result.length).toBeLessThanOrEqual(120);
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
  it("treats unmatched and differently-sized backtick runs as literal text", () => {
    const unmatched = "`".repeat(20_000);
    const source = "prefix " + unmatched + " <b>visible</b>\n\n``code``` and `kept <i>inline</i>`";

    expect(renderLarkMarkdownPage(source, 0, source.length + 20)).toEqual({
      page: "prefix " + unmatched + " visible\n\n``code``` and `kept <i>inline</i>`",
      nextPageStart: null
    });
  });

  it("keeps many complete tool activities atomic while making monotonic source progress", () => {
    const activity = (index: number) => [
      `◆ **Ran** · command ${index}`, "", "```bash", `echo ${index}`, "```", "",
      "```text", ...Array.from({ length: 30 }, (_, line) => `output ${index}.${line}`), "```"
    ].join("\n");
    const source = Array.from({ length: 80 }, (_, index) => activity(index)).join("\n");
    const starts = [0];
    const pages: string[] = [];
    while (starts.at(-1)! < source.length) {
      const rendered = renderLarkMarkdownPage(source, starts.at(-1)!, 900);
      pages.push(rendered.page);
      if (rendered.nextPageStart === null) break;
      expect(rendered.nextPageStart).toBeGreaterThan(starts.at(-1)!);
      starts.push(rendered.nextPageStart);
    }

    expect(pages.length).toBeGreaterThan(20);
    expect(pages.every((page) => page.length <= 900)).toBe(true);
    expect(pages.join("\n")).toContain("⚙️ **Ran** · `echo 0` · ✓ command 0");
    expect(pages.join("\n")).not.toContain("output 0.0");
    expect(starts.every((start, index) => index === 0 || start > starts[index - 1]!)).toBe(true);
  });

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

  it("keeps the canonical table boundary after compact tool activity", () => {
    const source = [
      "```bash", "echo hi", "```", "",
      "[safe](https://example.com) [bad](javascript:alert(1))", "",
      "```bash", "echo hi", "```", "",
      "```bash", "echo hi", "```", "",
      "| A | B |", "| --- | --- |", "| x | y |", "",
      "◆ **Ran**", "", "```bash", "npm test", "```", "", "```text", "passed", "```", "",
      "[safe](https://example.com) [bad](javascript:alert(1))", "", "plain text", "",
      "| A | B |", "| --- | --- |", "| x | y |", "",
      "[safe](https://example.com) [bad](javascript:alert(1))"
    ].join("\n");

    const rendered = renderLarkMarkdownPage(source, 0, 282);

    expect(rendered.nextPageStart).toBe(299);
    expect(rendered.page).toContain("```text\n| A | B |\n| --- | --- |\n```");
  });

  it("normalizes CRLF while retaining canonical source offsets", () => {
    const source = "```ts\r\nconst first = 1;\r\nconst second = 2;\r\n```";
    const first = renderLarkMarkdownPage(source, 0, 34);
    const second = renderLarkMarkdownPage(source, first.nextPageStart!, 34);

    expect(first.page).not.toContain("\r");
    expect(second.page).not.toContain("\r");
    expect(first.nextPageStart).toBe(source.indexOf("const second"));
  });

  it("keeps multiline hidden HTML out of bounded pages while advancing canonical offsets", () => {
    const source = "before\n<script>\nhidden secret\n</script>\nafter";
    let start = 0;
    const pages: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const rendered = renderLarkMarkdownPage(source, start, 12);
      pages.push(rendered.page);
      if (rendered.nextPageStart === null) break;
      expect(rendered.nextPageStart).toBeGreaterThan(start);
      start = rendered.nextPageStart;
    }

    expect(pages.every((page) => page.length <= 12)).toBe(true);
    expect(pages.join("")).not.toContain("hidden secret");
    expect(pages.join("")).toContain("before");
    expect(pages.join("")).toContain("after");
  });

  it("does not expose hidden HTML when hard progress reaches a long sensitive block", () => {
    const source = `visible-${"x".repeat(30)}<script>${"hidden-secret-".repeat(100)}</script>${"after-".repeat(30)}`;
    let start = 0;
    const pages: string[] = [];
    for (let page = 0; page < 20 && start < source.length; page += 1) {
      const rendered = renderLarkMarkdownPage(source, start, 40);
      pages.push(rendered.page);
      if (rendered.nextPageStart === null) break;
      expect(rendered.nextPageStart).toBeGreaterThan(start);
      start = rendered.nextPageStart;
    }

    expect(pages.every((page) => page.length <= 40)).toBe(true);
    expect(pages.join("")).not.toContain("hidden-secret");
    expect(pages.join("")).toContain("visible-");
    expect(pages.join("")).toContain("after-");
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
    const { result: first, diagnostics } = renderLarkMarkdownPageForTest(source, 0, 40);

    expect(first.page).toHaveLength(40);
    expect(first.nextPageStart).toBe(40);
    expect(renderLarkMarkdownPage(source, first.nextPageStart!, 40).page).toHaveLength(40);
    expect(diagnostics.sourceCharactersRendered).toBe(40);
    expect(diagnostics.rangeRenderCount).toBe(1);
  });

  it("bounds rendered source work to the active page for a long mixed document", () => {
    const ticks = "`".repeat(3);
    const section = (index: number) => [
      `## Section ${index}`, "", "prose ".repeat(18), "",
      `${ticks}ts`, `const value${index} = ${index};`, ticks, ""
    ].join("\n");
    let source = "";
    for (let index = 0; source.length < 512 * 1024; index += 1) source += section(index);
    source = source.slice(0, 512 * 1024);
    const { result: rendered, diagnostics } = renderLarkMarkdownPageForTest(source, 0, 9_000);

    expect(rendered.page.length).toBeLessThanOrEqual(9_000);
    expect(rendered.nextPageStart).toBeGreaterThan(0);
    expect(diagnostics).toEqual({
      sourceCharactersIndexed: source.length,
      sourceCharactersRendered: expect.any(Number),
      rangeRenderCount: expect.any(Number)
    });
    expect(diagnostics.sourceCharactersRendered).toBeLessThanOrEqual(18_000);
    expect(diagnostics.rangeRenderCount).toBe(1);
  });

  it("keeps long tool-activity streams atomic without rerendering the full source", () => {
    const ticks = "`".repeat(3);
    const activity = (index: number) => [
      `◆ **Ran** · command ${index}`,
      "", `${ticks}bash`, `echo ${index}`, ticks, "", `${ticks}text`,
      ...Array.from({ length: 30 }, (_, line) => `output ${index}.${line}`), ticks
    ].join("\n");
    let source = "";
    for (let index = 0; source.length < 512 * 1024; index += 1) source += `${activity(index)}\n`;
    const { result: rendered, diagnostics } = renderLarkMarkdownPageForTest(source, 0, 9_000);

    expect(rendered.page).toContain("⚙️ **Ran** · `echo 0` · ✓ command 0");
    expect(rendered.page).not.toContain("output 0.0");
    expect(rendered.page.length).toBeLessThanOrEqual(9_000);
    expect(rendered.nextPageStart).toBeGreaterThan(0);
    expect(diagnostics.sourceCharactersRendered).toBeLessThanOrEqual(18_000);
    expect(diagnostics.rangeRenderCount).toBe(1);
  });

  it("keeps a tool activity with very large folded output atomic across pages", () => {
    const source = [
      "before",
      "◆ **Ran** · command 0",
      "", "```bash", "npm test", "```", "", "```text",
      ...Array.from({ length: 2_000 }, (_, line) => `output-${line}`),
      "```",
      "after"
    ].join("\n");
    const first = renderLarkMarkdownPage(source, 0, 900);

    expect(first.page).toContain("⚙️ **Ran** · `npm test` · ✓ command 0");
    expect(first.page).not.toContain("output-");
    expect(first.page).toContain("after");
    expect(first.nextPageStart).toBeNull();
  });
});
