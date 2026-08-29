import { describe, expect, it } from "vitest";
import { stripTraexConsoleStatus } from "../src/runtime/traex-output-parser.js";

describe("TraeX answer presentation parser", () => {
  it("removes orchestration status from compact card previews", () => {
    const source = ["Keep this", "5 agents running… · /ps to manage", "● Main [default] running · 20m"].join("\n");
    expect(stripTraexConsoleStatus(source)).toBe("Keep this");
  });
});
