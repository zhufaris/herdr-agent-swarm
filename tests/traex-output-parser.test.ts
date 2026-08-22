import { describe, expect, it } from "vitest";
import { extractFinalTraexAnswer, parseTraexOutput, withProgressProtocol } from "../src/runtime/traex-output-parser.js";

describe("TraeX output parser", () => {
  it("extracts answer growth and normalized safe progress", () => {
    const previous = "✧ Working\n• Read /repo/src/a.ts\n◆ Fixed";
    const current = "✧ Working\n• Read /repo/src/a.ts\n• Edit /repo/src/b.ts\n• Bash npm test\n◆ Fixed login safely";
    expect(parseTraexOutput(previous, current, "/repo")).toEqual({
      answerDelta: " login safely",
      progressEvents: [],
      hasProgressSnapshot: false
    });
  });

  it("omits reasoning, tool JSON, and credential-shaped content", () => {
    const unsafe = '<think>secret plan</think>\n{"command":"curl","Authorization":"Bearer abc123"}\nPRIVATE KEY-----\n• Bash echo $TOKEN';
    expect(parseTraexOutput("", unsafe, "/repo")).toEqual({ answerDelta: "", progressEvents: [], hasProgressSnapshot: false });
  });

  it("uses the latest answer block for a later turn", () => {
    expect(extractFinalTraexAnswer("◆ answer 1\n────────\n◆ answer 2\n────────")).toBe("answer 2");
  });

  it("asks TraeX for structured steps without changing the user-facing prompt", () => {
    const submitted = withProgressProtocol("Fix login");
    expect(submitted).toContain("Fix login");
    expect(submitted).toContain("<herdr_progress>");
    expect(submitted).toContain("pending");
  });

  it("extracts the newest structured plan and hides protocol blocks from answers", () => {
    const previous = `◆ Working\n<herdr_progress>\n{"steps":[{"id":"inspect","text":"Inspect code","status":"in_progress"}]}\n</herdr_progress>`;
    const current = `${previous}\nImplemented change.\n<herdr_progress>\n{"steps":[{"id":"inspect","text":"Inspect code","status":"completed"},{"id":"test","text":"Run tests","status":"in_progress"}]}\n</herdr_progress>`;

    expect(parseTraexOutput(previous, current, "/repo")).toEqual({
      answerDelta: "\nImplemented change.",
      progressEvents: [
        { key: "step:inspect", kind: "step", label: "Inspect code", state: "done" },
        { key: "step:test", kind: "step", label: "Run tests", state: "active" }
      ],
      hasProgressSnapshot: true
    });
    expect(extractFinalTraexAnswer(`${current}\n────────`)).toBe("Working\nImplemented change.");
  });

  it("does not turn tool activity or malformed progress into steps", () => {
    const output = `◆ Answer\n• Read /repo/src/a.ts\n<herdr_progress>{bad json}</herdr_progress>`;
    expect(parseTraexOutput("", output, "/repo")).toEqual({ answerDelta: "Answer\n• Read /repo/src/a.ts", progressEvents: [], hasProgressSnapshot: false });
  });
});
