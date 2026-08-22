import { describe, expect, it } from "vitest";
import { extractFinalTraexAnswer, parseTraexOutput } from "../src/runtime/traex-output-parser.js";

describe("TraeX output parser", () => {
  it("extracts answer growth and normalized safe progress", () => {
    const previous = "✧ Working\n• Read /repo/src/a.ts\n◆ Fixed";
    const current = "✧ Working\n• Read /repo/src/a.ts\n• Edit /repo/src/b.ts\n• Bash npm test\n◆ Fixed login safely";
    expect(parseTraexOutput(previous, current, "/repo")).toEqual({
      answerDelta: " login safely",
      progressEvents: [
        { key: "edit:src/b.ts", kind: "edit", label: "已修改 src/b.ts", state: "done" },
        { key: "test:run", kind: "test", label: "正在运行测试", state: "active" }
      ]
    });
  });

  it("omits reasoning, tool JSON, and credential-shaped content", () => {
    const unsafe = '<think>secret plan</think>\n{"command":"curl","Authorization":"Bearer abc123"}\nPRIVATE KEY-----\n• Bash echo $TOKEN';
    expect(parseTraexOutput("", unsafe, "/repo")).toEqual({ answerDelta: "", progressEvents: [] });
  });

  it("uses the latest answer block for a later turn", () => {
    expect(extractFinalTraexAnswer("◆ answer 1\n────────\n◆ answer 2\n────────")).toBe("answer 2");
  });
});
