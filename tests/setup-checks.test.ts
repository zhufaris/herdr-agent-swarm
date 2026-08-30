import { describe, expect, it } from "vitest";
import { evaluateSetupChecks } from "../src/setup/setup-checks.js";

describe("setup check policy", () => {
  it("blocks saving and startup on failure", () => {
    expect(evaluateSetupChecks([{ id: "lark.auth", status: "fail", summary: "unauthorized" }]))
      .toEqual({ canSave: false, canStart: false, hasWarnings: false, hasSkipped: false });
  });

  it("allows saving but blocks startup after an explicit skip", () => {
    expect(evaluateSetupChecks([{ id: "lark.chat", status: "skipped", summary: "skipped by operator" }]))
      .toEqual({ canSave: true, canStart: false, hasWarnings: false, hasSkipped: true });
  });

  it("allows warnings while retaining them for review", () => {
    expect(evaluateSetupChecks([{ id: "lark.bot", status: "warning", summary: "verify manually" }]))
      .toEqual({ canSave: true, canStart: true, hasWarnings: true, hasSkipped: false });
  });
});
