import { describe, expect, it } from "vitest";
import { ANSWER_STREAM_PAGE_LIMIT, renderAnswerStreamPage, splitAnswerStreamPage } from "../src/runtime/answer-stream.js";

describe("Answer stream pagination", () => {
  it("uses a 9,000-character default page limit", () => {
    expect(ANSWER_STREAM_PAGE_LIMIT).toBe(9_000);
  });

  it("keeps short content on one card", () => {
    expect(splitAnswerStreamPage("Working\nDone", 28_000)).toEqual({ page: "Working\nDone", remainder: "" });
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
