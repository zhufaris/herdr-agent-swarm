import { describe, expect, it } from "vitest";
import { applyMonotonicAgentState, isConfirmedUnregisteredTraexAgent, isTraexCompatiblePane } from "../src/domain/binding-runtime-convergence-policy.js";
import type { HerdrPane } from "../src/domain/types.js";

const pane = (overrides: Partial<HerdrPane> = {}): HerdrPane => ({
  workspaceId: "w1", paneId: "p1", tabId: "t1", cwd: "/repo", foregroundCwd: "/repo", label: "Primary",
  agentState: "idle", stateChangeSeq: 2, terminalId: "terminal-1", agentKind: "traex", foregroundExecutables: ["traex"],
  ...overrides
});

describe("binding runtime convergence policy", () => {
  it("preserves the prior state for stale observations of the same terminal", () => {
    const result = applyMonotonicAgentState(pane({ agentState: "idle", stateChangeSeq: 2 }), { terminalId: "terminal-1", sequence: 3, state: "working" });
    expect(result).toEqual({ pane: expect.objectContaining({ agentState: "working" }), observation: null });
  });

  it("accepts a lower sequence after terminal identity changes", () => {
    const current = pane({ terminalId: "terminal-2", stateChangeSeq: 1, agentState: "blocked" });
    expect(applyMonotonicAgentState(current, { terminalId: "terminal-1", sequence: 9, state: "done" })).toEqual({
      pane: current, observation: { terminalId: "terminal-2", sequence: 1, state: "blocked" }
    });
  });

  it("classifies compatible and explicitly unregistered TraeX panes", () => {
    expect(isTraexCompatiblePane(pane())).toBe(true);
    expect(isConfirmedUnregisteredTraexAgent(pane({ agentKind: null }))).toBe(true);
    expect(isTraexCompatiblePane(pane({ agentKind: null, foregroundExecutables: ["bash"] }))).toBe(false);
  });
});
