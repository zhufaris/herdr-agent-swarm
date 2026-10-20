import { describe, expect, it } from "vitest";
import { decideRuntimeIdentityReconciliation, requireMatchingPane } from "../src/coordinator/pane-runtime-identity.js";
import { ProjectCatalog } from "../src/coordinator/project-catalog.js";
import type { CurrentRuntimeIdentityClaim } from "../src/domain/runtime-identity-claim.js";

const project = { id: "project", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" };
const binding = { id: "b1", projectId: "project", workspaceId: "w1", paneId: "w1:p1", traexSessionId: "terminal-1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" } as never;
const pane = (overrides: Record<string, unknown> = {}) => ({ paneId: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", cwd: "/repo", agentState: "idle", foregroundExecutables: ["traex"], ...overrides });
const projects = new ProjectCatalog([project]);

describe("pane runtime identity", () => {
  it("persists one semantic refusal and makes identical mismatch evidence a no-op", () => {
    const claim: CurrentRuntimeIdentityClaim = {
      owner: { bindingId: "b1", bindingGeneration: 1, sessionEpoch: 1 },
      state: "current",
      nativeIdentity: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      attachment: { state: "attached", workspaceId: "w1", paneId: "w1:p1", terminalId: "terminal-1" },
      lastRejectedEvidenceFingerprint: null,
      lastRejectedReason: null,
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z"
    };
    const observation = pane({ agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-2" } }) as never;

    const first = decideRuntimeIdentityReconciliation({ binding, claim, pane: observation });
    expect(first).toMatchObject({ outcome: "refused", reason: "native_session_mismatch", evidenceFingerprint: expect.any(String) });
    if (first.outcome !== "refused") throw new Error("expected first semantic refusal");
    expect(decideRuntimeIdentityReconciliation({
      binding,
      claim: { ...claim, lastRejectedEvidenceFingerprint: first.evidenceFingerprint, lastRejectedReason: first.reason },
      pane: observation
    })).toMatchObject({ outcome: "unchanged_refusal", reason: "native_session_mismatch" });
  });

  it("permits only attached complete native evidence to adopt an unclaimed owner", () => {
    const claim = { owner: { bindingId: "b1", bindingGeneration: 1, sessionEpoch: 1 }, state: "unclaimed", nativeIdentity: null, attachment: null, lastRejectedEvidenceFingerprint: null, lastRejectedReason: null, createdAt: "start", updatedAt: "start" } as const;
    const adopted = decideRuntimeIdentityReconciliation({
      binding: { ...binding, generation: 1, sessionEpoch: 1, agentKind: "traex", agentSessionSource: null, agentSessionAgent: null, agentSessionKind: null, agentSessionValue: null, attachment: "attached" },
      claim,
      pane: pane({ agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } }) as never
    });
    expect(adopted).toEqual({ outcome: "adopt" });
    expect(decideRuntimeIdentityReconciliation({
      binding: { ...binding, generation: 1, sessionEpoch: 1, agentKind: "traex", agentSessionSource: null, agentSessionAgent: null, agentSessionKind: null, agentSessionValue: null, attachment: "attached" },
      claim,
      pane: pane({ agentKind: "traex" }) as never
    })).toEqual({ outcome: "observe_unclaimed" });
    expect(decideRuntimeIdentityReconciliation({
      binding: { ...binding, generation: 1, sessionEpoch: 1, agentKind: "traex", attachment: "attached" },
      claim: {
        owner: { bindingId: "b1", bindingGeneration: 1, sessionEpoch: 1 }, state: "current",
        nativeIdentity: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
        attachment: { state: "attached", workspaceId: "w1", paneId: "w1:p1", terminalId: "terminal-1" },
        lastRejectedEvidenceFingerprint: null, lastRejectedReason: null, createdAt: "start", updatedAt: "start"
      },
      pane: pane({ agentKind: "traex" }) as never
    })).toMatchObject({ outcome: "refused", reason: "continuity_not_proven" });
  });

  it("distinguishes same-session terminal refresh and orphan recovery", () => {
    const claim: CurrentRuntimeIdentityClaim = {
      owner: { bindingId: "b1", bindingGeneration: 1, sessionEpoch: 1 }, state: "current",
      nativeIdentity: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      attachment: { state: "attached", workspaceId: "w1", paneId: "w1:p1", terminalId: "terminal-1" },
      lastRejectedEvidenceFingerprint: null, lastRejectedReason: null, createdAt: "start", updatedAt: "start"
    };
    const refresh = decideRuntimeIdentityReconciliation({ binding: { ...binding, generation: 1, sessionEpoch: 1, agentKind: "traex", attachment: "attached" }, claim, pane: pane({ terminalId: "terminal-2", agentKind: "traex", agentSession: claim.nativeIdentity }) as never });
    expect(refresh).toEqual({ outcome: "terminal_refresh" });
    expect(decideRuntimeIdentityReconciliation({ binding: { ...binding, generation: 1, sessionEpoch: 1, agentKind: "traex", attachment: "orphaned" }, claim: { ...claim, attachment: { ...claim.attachment, state: "orphaned" } }, pane: pane({ agentKind: "traex", agentSession: claim.nativeIdentity }) as never })).toEqual({ outcome: "orphan_recovery" });
  });

  it("re-evaluates changed semantic mismatch evidence", () => {
    const claim: CurrentRuntimeIdentityClaim = {
      owner: { bindingId: "b1", bindingGeneration: 1, sessionEpoch: 1 }, state: "current",
      nativeIdentity: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      attachment: { state: "attached", workspaceId: "w1", paneId: "w1:p1", terminalId: "terminal-1" },
      lastRejectedEvidenceFingerprint: null, lastRejectedReason: null, createdAt: "start", updatedAt: "start"
    };
    const first = decideRuntimeIdentityReconciliation({ binding: { ...binding, generation: 1, sessionEpoch: 1, agentKind: "traex", attachment: "attached" }, claim, pane: pane({ agentKind: "traex", agentSession: { ...claim.nativeIdentity, value: "session-2" } }) as never });
    if (first.outcome !== "refused") throw new Error("expected refusal");
    expect(decideRuntimeIdentityReconciliation({ binding: { ...binding, generation: 1, sessionEpoch: 1, agentKind: "traex", attachment: "attached" }, claim: { ...claim, lastRejectedEvidenceFingerprint: first.evidenceFingerprint, lastRejectedReason: first.reason }, pane: pane({ agentKind: "traex", agentSession: { ...claim.nativeIdentity, value: "session-3" } }) as never })).toMatchObject({ outcome: "refused", reason: "native_session_mismatch" });
  });

  it("restores a durable native session when a matching runtime observation omits it", async () => {
    const result = await requireMatchingPane({ observeRuntime: async () => ({ pane: pane(), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, binding, "w1:p1");
    expect(result.agentSession).toEqual({ source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" });
  });

  it("fails closed when a reported native session conflicts with the durable identity", async () => {
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: pane({ agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "other" } }), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, binding, "w1:p1"))
      .rejects.toThrow(/session identity changed/);
  });

  it("rejects retired shim sessions", async () => {
    const aliased = { ...binding, agentSessionSource: "herdr:codex" } as never;
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: pane({ agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" } }), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, aliased, "w1:p1"))
      .rejects.toThrow(/session identity changed/);
  });

  it("rejects a native Herdr TraeX source for a legacy binding", async () => {
    const legacy = { ...binding, agentSessionSource: "herdr:codex" } as never;
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: pane({ agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } }), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, legacy, "w1:p1"))
      .rejects.toThrow(/session identity changed/);
  });

  it("does not treat arbitrary reporter sources as aliases", async () => {
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: pane({ agentSession: { source: "other-reporter", agent: "traex", kind: "id", value: "session-1" } }), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, binding, "w1:p1"))
      .rejects.toThrow(/session identity changed/);
  });

  it("does not use durable session restoration to bypass a terminal identity mismatch", async () => {
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: pane({ terminalId: "terminal-2" }), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, binding, "w1:p1"))
      .rejects.toThrow(/pane identity changed/);
  });

  it("accepts only the exact persisted non-TraeX Agent kind and session", async () => {
    const piBinding = { ...binding, agentKind: "pi", agentSessionSource: "herdr:pi", agentSessionAgent: "pi", agentSessionValue: "pi-session" } as never;
    const matching = pane({ foregroundExecutables: ["pi"], agentKind: "pi", agentSession: { source: "herdr:pi", agent: "pi", kind: "id", value: "pi-session" } });

    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: matching, traexProcess: false, composerReady: false, evidenceSource: "structured" }) } as never, projects, piBinding, "w1:p1"))
      .resolves.toMatchObject({ agentKind: "pi" });
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: { ...matching, agentKind: "codex" }, traexProcess: false, composerReady: false, evidenceSource: "structured" }) } as never, projects, piBinding, "w1:p1"))
      .rejects.toThrow(/Agent kind changed/);
  });
});
