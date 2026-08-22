import { describe, expect, it } from "vitest";
import { extractFinalTraexAnswer, parseTraexOutput, withProgressProtocol } from "../src/runtime/traex-output-parser.js";

describe("TraeX output parser", () => {
  it("extracts answer growth and normalized safe progress", () => {
    const previous = "✧ Working\n• Read /repo/src/a.ts\n◆ Fixed";
    const current = "✧ Working\n• Read /repo/src/a.ts\n• Edit /repo/src/b.ts\n• Bash npm test\n◆ Fixed login safely";
    expect(parseTraexOutput(previous, current, "/repo")).toMatchObject({
      answerSnapshot: "Fixed login safely",
      progressEvents: [],
      hasProgressSnapshot: false
    });
  });

  it("omits reasoning, tool JSON, and credential-shaped content", () => {
    const unsafe = '<think>secret plan</think>\n{"command":"curl","Authorization":"Bearer abc123"}\nPRIVATE KEY-----\n• Bash echo $TOKEN';
    expect(parseTraexOutput("", unsafe, "/repo")).toMatchObject({ answerSnapshot: "", progressEvents: [], hasProgressSnapshot: false });
  });

  it("uses the latest answer block for a later turn", () => {
    expect(extractFinalTraexAnswer("◆ answer 1\n────────\n◆ answer 2\n────────")).toBe("answer 2");
  });

  it("marks a newly appended answer block separately from growth of the current block", () => {
    const first = "◆ First message";
    expect(parseTraexOutput(first, `${first} continues`, "/repo")).toMatchObject({ answerSnapshot: "First message continues", answerUpdate: "replace" });
    expect(parseTraexOutput(first, `${first}\n◆ Second message`, "/repo")).toMatchObject({ answerSnapshot: "Second message", answerUpdate: "append" });
  });

  it("does not replay an unchanged answer from before the current prompt", () => {
    const previous = "◆ Previous turn answer\n────────";
    const current = `${previous}\n✧ Working`;

    expect(parseTraexOutput(previous, current, "/repo")).toMatchObject({ answerSnapshot: "", answerUpdate: "replace" });
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

    expect(parseTraexOutput(previous, current, "/repo")).toMatchObject({
      answerSnapshot: "Working\nImplemented change.",
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
    expect(parseTraexOutput("", output, "/repo")).toMatchObject({ answerSnapshot: "Answer\n• Read /repo/src/a.ts", progressEvents: [], hasProgressSnapshot: false });
  });

  it("returns the latest TraeX status frame as one replaceable snapshot", () => {
    const previous = "◆ 重新构建部署并重放 Query Log 与 Aeolus Chart… (35m 10s • ↓ 30.8K tokens)\n  9 tasks (7 done, 1 in progress, 1 open)\n  ■ 重新构建部署并重放 Query Log 与 Aeolus Chart\n  ◻ 更新 PROGRESS.md";
    const current = "◆ 重新构建部署并重放 Query Log 与 Aeolus Chart… (35m 20s • ↓ 31.1K tokens)\n  9 tasks (8 done, 1 in progress, 0 open)\n  ✔ 重新构建部署并重放 Query Log 与 Aeolus Chart\n  ■ 更新 PROGRESS.md";

    expect(parseTraexOutput(previous, current, "/repo")).toMatchObject({ answerSnapshot: current.slice(2), answerUpdate: "replace-status" });
  });
});
