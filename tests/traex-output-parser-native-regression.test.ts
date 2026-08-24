import { describe, expect, it } from "vitest";
import { inferTraexAgentState, isTraexComposerReady, parseTerminalStreamDelta } from "../src/runtime/traex-output-parser.js";

describe("TraeX native parser regressions", () => {
  it("recognizes the visible TraeX composer without mistaking active output for readiness", () => {
    expect(isTraexComposerReady("◆ completed\n────────\n❯ Use /skills to list available skills")).toBe(true);
    expect(isTraexComposerReady("header\n────────\n❯ Write tests for @filename\n────────\nGPT-5.6-Sol")).toBe(true);
    expect(isTraexComposerReady("◆ Working…\n2 tasks (1 in progress)\n• editing code")).toBe(false);
  });

  it("infers only strong live-tail TraeX states", () => {
    expect(inferTraexAgentState("◆ completed\n────────\n❯ Use /skills to list available skills")).toBe("idle");
    expect(inferTraexAgentState("◆ Working…\n• editing code")).toBe("working");
    expect(inferTraexAgentState("Approve command?\n1. Allow once\n2. Deny")).toBe("blocked");
    expect(inferTraexAgentState("ordinary shell output")).toBe("unknown");
  });

  it("replaces an ambiguous rolling terminal window instead of appending the whole snapshot", () => {
    const previous = [
      "old output that has scrolled away",
      "◆ Running tests (1m 10s)",
      "PASS parser.test.ts"
    ].join("\n");
    const current = [
      "▍ deploy",
      "◆ Running tests (1m 12s)",
      "PASS parser.test.ts",
      "PASS conversation-view-projector.test.ts"
    ].join("\n");

    expect(parseTerminalStreamDelta(previous, current, "deploy")).toMatchObject({
      delta: "◆ Running tests (1m 12s)PASS parser.test.ts PASS conversation-view-projector.test.ts",
      update: "replace-all",
      snapshot: current
    });
  });

  it("does not replay output from earlier prompts when a new prompt window is redrawn", () => {
    const previous = [
      "TraeCode CLI banner",
      "▍ previous request",
      "◆ previous answer"
    ].join("\n");
    const current = [
      "TraeCode CLI banner",
      "▍ previous request",
      "◆ previous answer",
      "▍ switch to native worktree",
      "◆ switched to feat/native"
    ].join("\n");

    expect(parseTerminalStreamDelta(previous + "\nold footer", current, "switch to native worktree")).toMatchObject({
      delta: "◆ switched to feat/native",
      update: "replace-all"
    });
  });

  it("keeps the active card unchanged when neither continuity nor the current prompt boundary is visible", () => {
    const previous = "old terminal window";
    const current = "unrelated redrawn terminal history";

    expect(parseTerminalStreamDelta(previous, current, "current prompt")).toMatchObject({
      delta: "", update: "replace-all", snapshot: current
    });
  });

  it("does not treat an incidental short overlap as append-only continuity", () => {
    const previous = `old window ${"x".repeat(80)}same`;
    const current = `same${"y".repeat(80)}\n▍ deploy\nnew window`;

    expect(parseTerminalStreamDelta(previous, current, "deploy")).toMatchObject({
      delta: "new window", update: "replace-all"
    });
  });

});
