import { describe, expect, it } from "vitest";
import { evaluatePaneClosureSafety, evaluatePaneRetention } from "../src/domain/pane-retention-policy.js";
import type { Binding, HerdrPane } from "../src/domain/types.js";

const binding = (patch: Partial<Binding> = {}): Binding => ({ id: "b1", creatorOpenId: null, projectId: null, workspaceId: "w1", chatId: "c1", topicId: null, rootMessageId: "r1", retiredTopicId: null, retiredRootMessageId: null, replacesBindingId: null, reservedTopicId: null, reservedRootMessageId: null, resetMessageId: null, paneId: "w1:p1", traexSessionId: "t1", title: "test", runtime: "traex", state: "active", statusMessageId: null, statusCardSequence: 0, lastAgentState: "idle", lastOutputFingerprint: null, lifecycle: "active", attachment: "attached", generation: 1, provisioningCheckpoint: "activated", degradationCount: 0, hasCompletedTurn: true, lastObservedAt: null, archivedAt: null, lastActivityAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...patch });
const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", terminalId: "t1", agentState: "idle", cwd: "/repo", label: null, foregroundExecutables: [] };

describe("pane retention policy", () => {
  it("uses the conservative seven-day threshold and forty-eight-hour grace period", () => {
    expect(evaluatePaneRetention({ binding: binding(), enabled: true, now: "2026-01-08T00:00:00.000Z", pendingWork: false, unresolvedTurn: false, runtimeState: "idle" }).status).toBe("warning");
    expect(evaluatePaneRetention({ binding: binding(), enabled: true, now: "2026-01-10T00:00:00.000Z", pendingWork: false, unresolvedTurn: false, runtimeState: "idle" }).status).toBe("eligible");
  });
  it("blocks retention while durable work or uncertain runtime exists", () => {
    expect(evaluatePaneRetention({ binding: binding(), enabled: true, now: "2026-02-01T00:00:00.000Z", pendingWork: true, unresolvedTurn: false, runtimeState: "idle" }).status).toBe("blocked");
    expect(evaluatePaneRetention({ binding: binding(), enabled: true, now: "2026-02-01T00:00:00.000Z", pendingWork: false, unresolvedTurn: true, runtimeState: "idle" }).status).toBe("blocked");
  });
  it("centralizes pane identity and runtime safety checks", () => {
    expect(evaluatePaneClosureSafety({ binding: binding(), pane, pendingWork: false, busy: false })).toEqual({ allowed: true });
    expect(evaluatePaneClosureSafety({ binding: binding(), pane: { ...pane, terminalId: "other" }, pendingWork: false, busy: false })).toMatchObject({ allowed: false });
  });
});
