import { describe, expect, it } from "vitest";
import { extractNewOutput } from "../src/coordinator/sync-coordinator.js";
import { cleanTerminalOutput, outputFingerprint } from "../src/runtime/output.js";

describe("terminal output", () => {
  it("extracts appended output and strips ANSI", () => {
    expect(extractNewOutput("old", "old\nnew answer")).toBe("new answer");
    expect(cleanTerminalOutput("\u001b[31manswer\u001b[0m")).toBe("answer");
    expect(outputFingerprint("same")).toBe(outputFingerprint("same"));
  });
});
