import { describe, expect, it } from "vitest";
import { ANSWER_STREAM_PAGE_LIMIT, renderAnswerStreamPage, renderFinalAnswerPage, splitAnswerStreamPage } from "../src/runtime/answer-stream.js";
import { renderLarkMarkdownPage } from "../src/runtime/lark-markdown.js";

describe("Answer stream pagination", () => {
  it("uses a 9,000-character default page limit", () => {
    expect(ANSWER_STREAM_PAGE_LIMIT).toBe(9_000);
  });

  it("keeps short content on one card", () => {
    expect(splitAnswerStreamPage("Working\nDone", 28_000)).toEqual({ page: "Working\nDone", remainder: "" });
  });

  it("adds a render-only continuation warning without changing the canonical boundary", () => {
    const content = `${"first".repeat(30)}\n${"second".repeat(40)}`;
    const result = renderAnswerStreamPage(content, 0, 200);
    const warning = "… 本页接近显示上限，后续内容将继续显示在下一张 Answer Card。";
    const expected = renderLarkMarkdownPage(content, 0, 200 - warning.length - 2);

    expect(result.nextPageStart).not.toBeNull();
    expect(result.page).toBe(`${expected.page}\n\n${warning}`);
    expect(result.nextPageStart).toBe(expected.nextPageStart);
    expect(content.slice(result.nextPageStart!)).toContain("second");
    expect(result.page.length).toBeLessThanOrEqual(200);
  });

  it("reserves warning space when the canonical page would otherwise fill the limit", () => {
    const result = renderAnswerStreamPage("x".repeat(ANSWER_STREAM_PAGE_LIMIT + 1), 0);

    expect(result.page).toContain("本页接近显示上限");
    expect(result.page.length).toBeLessThanOrEqual(ANSWER_STREAM_PAGE_LIMIT);
    expect(result.nextPageStart).toBeGreaterThan(0);
    expect(result.nextPageStart).toBeLessThan(ANSWER_STREAM_PAGE_LIMIT);
  });

  it("does not add a continuation warning to a complete page", () => {
    expect(renderAnswerStreamPage("Working\nDone", 0, 80).page).not.toContain("本页接近显示上限");
  });

  it("keeps command activities as Markdown during streaming with canonical continuation offsets", () => {
    const command = ["◆ **Ran** · command 7", "", "```bash", "npm test", "```", "", "```text", "passed", "```"].join("\n");
    const content = `${"before\n".repeat(20)}${command}\nafter`;
    const first = renderAnswerStreamPage(content, 0, 180);
    const rendered = renderAnswerStreamPage(content, first.nextPageStart!, 180);

    expect(rendered.page).toContain("⚙️ **Ran** · `npm test` · ✓ command 7");
    expect(rendered.page).not.toContain("collapsible_panel");
    expect(first.nextPageStart).not.toBeNull();
    expect(content.slice(first.nextPageStart!)).toContain("◆ **Ran**");
  });

  it("splits at the latest newline before the CardKit limit without losing text", () => {
    const content = `${"a".repeat(20_000)}\n${"b".repeat(12_000)}`;
    const result = splitAnswerStreamPage(content, 28_000);
    expect(result.page).toBe("a".repeat(20_000));
    expect(result.remainder).toBe("b".repeat(12_000));
    expect(`${result.page}\n${result.remainder}`).toBe(content);
  });

  it("uses a hard boundary when no newline is available", () => {
    const content = "x".repeat(30_000);
    const result = splitAnswerStreamPage(content, 28_000);
    expect(result.page).toHaveLength(28_000);
    expect(result.remainder).toHaveLength(2_000);
    expect(result.page + result.remainder).toBe(content);
  });

  it("closes an incomplete Bash fence only in the render copy", () => {
    const content = ["Intro", "```bash", "echo hello"].join("\n");

    expect(renderAnswerStreamPage(content, 0, 28_000)).toEqual({
      page: ["Intro", "```bash", "echo hello", "```"].join("\n"),
      nextPageStart: null
    });
    expect(content.endsWith("```")).toBe(false);
    expect(renderAnswerStreamPage(content + "\n```", 0, 28_000).page).toBe(content + "\n```");
  });

  it("closes and reopens a Bash fence across continuation pages", () => {
    const content = ["```bash", "echo first", "echo second", "```"].join("\n");
    const first = renderAnswerStreamPage(content, 0, 28);

    expect(first.page).toBe(["```bash", "echo first", "```"].join("\n"));
    expect(first.nextPageStart).toBe(19);
    expect(renderAnswerStreamPage(content, first.nextPageStart!, 28)).toEqual({
      page: ["```bash", "echo second", "```"].join("\n"),
      nextPageStart: null
    });
  });

  it("preserves the boundary newline in exactly one rendered page", () => {
    const content = "first line\nsecond line";
    const first = renderAnswerStreamPage(content, 0, 12);
    const second = renderAnswerStreamPage(content, first.nextPageStart!, 12);

    expect(first.page + second.page).toBe(content);
    expect(first.nextPageStart).toBe(11);
  });

  it("makes progress when a fence closure pushes a newline split over the limit", () => {
    const content = "```bash\n123456\nremaining\n```";
    const first = renderAnswerStreamPage(content, 0, 17);

    expect(first.page.length).toBeLessThanOrEqual(17);
    expect(first.nextPageStart).toBeGreaterThan(0);
  });

  it("renders tables with a monospaced CardKit fallback", () => {
    const content = ["Summary", "| Key | Value |", "| --- | --- |", "| mode | fast |"].join("\n");

    expect(renderAnswerStreamPage(content, 0).page).toBe([
      "Summary", "```text", "| Key | Value |", "| --- | --- |", "| mode | fast |", "```"
    ].join("\n"));
  });

  it("renders accumulated TraeX numbered diff output as a code block", () => {
    const content = [
      "◆ Edited scripts/render.py",
      "    145 +        *_table(",
      "    146 +            [\"Relationship\", \"Count\"],",
      "    147 +        )"
    ].join("\n");

    expect(renderAnswerStreamPage(content, 0).page).toBe([
      "◆ Edited scripts/render.py",
      "```diff",
      "    145 +        *_table(",
      "    146 +            [\"Relationship\", \"Count\"],",
      "    147 +        )",
      "```"
    ].join("\n"));
  });

  it("renders command activity as one compact Herdr-like row while streaming", () => {
    const content = ["before", "", "◆ **Ran**", "", "```bash", "npm test", "```", "", "```text", "12 tests passed", "```", "", "after"].join("\n");
    const rendered = renderAnswerStreamPage(content, 0).page;

    expect(rendered).toContain("⚙️ **Ran** · `npm test` · ✓ 完成");
    expect(rendered).not.toContain("```bash");
    expect(rendered).not.toContain("12 tests passed");
  });

  it("renders final command detail only within the proven canonical page boundary", () => {
    const first = ["◆ **Ran**", "", "```bash", "npm test", "```", "", "```text", "12 tests passed", "```"].join("\n");
    const content = `${first}\nNEXT PAGE`;

    const rendered = renderFinalAnswerPage(content, 0, first.length);

    expect(rendered.page).toContain("12 tests passed");
    expect(rendered.page).not.toContain("NEXT PAGE");
    expect(rendered.nextPageStart).toBe(first.length);
  });

  it.each([
    ["JSON", "jq . result.json", (index: number) => `\"key-${index}\": ${index}`],
    ["Git diff", "git diff", (index: number) => `+changed line ${index}`],
    ["Git status", "git status --short", (index: number) => `M  src/file-${index}.ts`],
    ["Git log", "git log --oneline", (index: number) => `abc${index} commit ${index}`],
    ["test output", "npm test", (index: number) => `test ${index} passed`],
    ["plain text", "printf output", (index: number) => `plain line ${index}`]
  ])("compacts %s tool results only in the rendered page", (_kind, command, line) => {
    const canonicalLines = Array.from({ length: 35 }, (_, index) => line(index + 1));
    const canonical = ["◆ **Ran**", "", "```bash", command, "```", "", "```text", ...canonicalLines, "```"].join("\n");
    const rendered = renderAnswerStreamPage(canonical, 0).page;
    expect(rendered).toBe(`⚙️ **Ran** · \`${command}\` · ✓ 完成`);
    expect(rendered).not.toContain(canonicalLines[0]!);
    expect(canonical.split("\n")).toContain(canonicalLines[20]);
  });

  it("keeps one bounded tool result together when prose nearly fills a page", () => {
    const resultLines = Array.from({ length: 35 }, (_, index) => "result-" + (index + 1));
    const ticks = String.fromCharCode(96).repeat(3);
    const activity = ["◆ **Ran**", "", ticks + "bash", "git log --oneline", ticks, "", ticks + "text", ...resultLines, ticks].join("\n");
    const content = "intro ".repeat(70) + "\n\n" + activity;
    const first = renderAnswerStreamPage(content, 0, 600);
    const second = renderAnswerStreamPage(content, first.nextPageStart!, 600);

    expect(first.page).not.toContain("⚙️ **Ran**");
    expect(second.page).toContain("⚙️ **Ran**");
    expect(second.page).toContain("⚙️ **Ran** · `git log --oneline` · ✓ 完成");
    expect(second.page).not.toContain("result-1");
  });

  it("sanitizes prose but leaves fenced code literals unchanged", () => {
    const content = [
      "<b>Result</b> [unsafe](data:text/plain,no)",
      "```md",
      "<b>[literal](javascript:alert(1))</b>",
      "```"
    ].join("\n");

    expect(renderAnswerStreamPage(content, 0).page).toBe([
      "Result unsafe",
      "```md",
      "<b>[literal](javascript:alert(1))</b>",
      "```"
    ].join("\n"));
  });
});
