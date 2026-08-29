import { describe, expect, it } from "vitest";
import { cleanTerminalOutput, extractNewOutput, outputFingerprint } from "../src/runtime/output.js";

describe("terminal output", () => {
  it("extracts appended output and strips ANSI", () => {
    expect(extractNewOutput("old", "old\nnew answer")).toBe("new answer");
    expect(cleanTerminalOutput("\u001b[31manswer\u001b[0m")).toBe("answer");
    expect(outputFingerprint("same")).toBe(outputFingerprint("same"));
  });

  it("removes animated TraeX background-work status from durable output", () => {
    const base = "◆ Final answer\n\n⏱ Worked for 19m 11s\n\n  8 tasks (7 done, 1 in progress, 0 open)";

    expect(cleanTerminalOutput(`${base}\n\n✦ 1 background shell running… you can still chat · /ps to manage`)).toBe(base);
    expect(cleanTerminalOutput(`${base}\n\n◈ 1 background shell running… you can still chat · /ps to manage`)).toBe(base);
  });
});
