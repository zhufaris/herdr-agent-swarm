import { describe, expect, it } from "vitest";
import { deriveTerminalContinuation, parseTraexTerminalBlocks, renderTraexTerminalBlocks } from "../src/runtime/traex-terminal-blocks.js";

describe("TraeX terminal blocks", () => {
  it("parses an explicit compact Edit block without losing row boundaries", () => {
    expect(parseTraexTerminalBlocks([
      "◆ Edited src/model.py (+2 -0)",
      "  10      existing = true",
      "  11 +    first = true",
      "  12 ⋮",
      "  20 +    second = true"
    ].join("\n"))).toEqual([{
      kind: "diff",
      title: "◆ Edited src/model.py (+2 -0)",
      lines: [
        "  10      existing = true",
        "  11 +    first = true",
        "  12 ⋮",
        "  20 +    second = true"
      ]
    }]);
  });

  it("derives and consumes an Edit continuation without repeating its title", () => {
    const previous = "◆ Edited src/model.py (+2 -0)\n  10 + first = true";
    const continuation = deriveTerminalContinuation(previous);

    expect(continuation).toEqual({ kind: "diff", title: "◆ Edited src/model.py (+2 -0)" });
    expect(parseTraexTerminalBlocks("  11 + second = true\n◆ Done", continuation)).toEqual([
      { kind: "diff", title: null, lines: ["  11 + second = true"] },
      { kind: "prose", lines: ["◆ Done"] }
    ]);
  });

  it("leaves unmarked signed text as prose", () => {
    expect(parseTraexTerminalBlocks("+ prose\nGrowth was +12%\n  10 + isolated row")).toEqual([
      { kind: "prose", lines: ["+ prose", "Growth was +12%", "  10 + isolated row"] }
    ]);
  });

  it("serializes diff and prose blocks as balanced Markdown", () => {
    const blocks = parseTraexTerminalBlocks([
      "◆ Edited src/model.py (+1 -0)",
      "  10 + value = true",
      "◆ Completed successfully"
    ].join("\n"));

    expect(renderTraexTerminalBlocks(blocks)).toBe([
      "◆ Edited src/model.py (+1 -0)",
      "```diff",
      "  10 + value = true",
      "```",
      "◆ Completed successfully"
    ].join("\n"));
  });
});
