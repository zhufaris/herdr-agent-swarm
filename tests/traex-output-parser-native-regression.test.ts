import { describe, expect, it } from "vitest";
import { inferTraexAgentState, isTraexComposerReady } from "../src/runtime/traex-output-parser.js";

describe("TraeX native parser regressions", () => {
  it("recognizes the visible TraeX composer without mistaking active output for readiness", () => {
    expect(isTraexComposerReady("◆ completed\n────────\n❯ Use /skills to list available skills")).toBe(true);
    expect(isTraexComposerReady("header\n────────\n❯ Write tests for @filename\n────────\nGPT-5.6-Sol")).toBe(true);
    expect(isTraexComposerReady("◆ Working…\n2 tasks (1 in progress)\n• editing code")).toBe(false);
  });

  it("infers only strong live-tail TraeX states", () => {
    expect(inferTraexAgentState("◆ completed\n────────\n❯ Use /skills to list available skills")).toBe("idle");
    expect(inferTraexAgentState("◆ Working…\n• editing code")).toBe("working");
    expect(inferTraexAgentState("◈ Organizing test procedures (1m 21s • ↑ 2.62K tokens • esc to interrupt)\nGPT-5.6-Sol · Context 78% left · Auto Mode")).toBe("working");
    expect(inferTraexAgentState("Approve command?\n1. Allow once\n2. Deny")).toBe("blocked");
    expect(inferTraexAgentState("ordinary shell output")).toBe("unknown");
  });
});
