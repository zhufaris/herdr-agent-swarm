import { describe, expect, it } from "vitest";
import { createCurrentRuntimeIdentityClaim, createUnclaimedRuntimeIdentityClaim, fingerprintRuntimeIdentityEvidence, sameNativeRuntimeIdentity } from "../src/domain/runtime-identity-claim.js";

const evidence = {
  workspaceId: "workspace-1",
  paneId: "workspace-1:pane-1",
  terminalId: "terminal-1",
  agentKind: "traex" as const,
  agentSession: {
    source: "herdr:traex",
    agent: "traex",
    kind: "id",
    value: "session-1"
  },
  paneToken: "old-token",
  observedAt: "2026-10-18T00:00:00.000Z"
};

describe("runtime identity claim", () => {
  it("fingerprints semantic mismatch evidence without presentation or timing metadata", () => {
    const fingerprint = fingerprintRuntimeIdentityEvidence(evidence);

    expect(fingerprintRuntimeIdentityEvidence({
      ...evidence,
      paneToken: "new-token",
      observedAt: "2026-10-18T00:01:00.000Z"
    })).toBe(fingerprint);
    expect(fingerprintRuntimeIdentityEvidence({
      ...evidence,
      terminalId: "terminal-2"
    })).not.toBe(fingerprint);
    expect(fingerprintRuntimeIdentityEvidence({
      ...evidence,
      agentSession: { ...evidence.agentSession, value: "session-2" }
    })).not.toBe(fingerprint);
  });

  it("requires complete current identity while keeping unclaimed owners identity-free", () => {
    const base = {
      owner: { bindingId: "binding-1", bindingGeneration: 2, sessionEpoch: 3 },
      lastRejectedEvidenceFingerprint: null,
      lastRejectedReason: null,
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z"
    };
    expect(createUnclaimedRuntimeIdentityClaim(base)).toMatchObject({ state: "unclaimed", nativeIdentity: null, attachment: null });
    expect(createCurrentRuntimeIdentityClaim({
      ...base,
      nativeIdentity: evidence.agentSession,
      attachment: { state: "attached", workspaceId: evidence.workspaceId, paneId: evidence.paneId, terminalId: evidence.terminalId }
    })).toMatchObject({ state: "current", nativeIdentity: evidence.agentSession, attachment: { state: "attached" } });
    expect(() => createCurrentRuntimeIdentityClaim({
      ...base,
      nativeIdentity: { ...evidence.agentSession, value: " " },
      attachment: { state: "attached", workspaceId: evidence.workspaceId, paneId: evidence.paneId, terminalId: evidence.terminalId }
    })).toThrow(/complete/i);
  });

  it("compares only the complete normalized native identity", () => {
    expect(sameNativeRuntimeIdentity(evidence.agentSession, { ...evidence.agentSession, value: " session-1 " })).toBe(true);
    expect(sameNativeRuntimeIdentity(evidence.agentSession, { ...evidence.agentSession, kind: "path" })).toBe(false);
  });

  it("requires every claim owner to carry one positive generation and session epoch", () => {
    const base = {
      owner: { bindingId: "binding-1", bindingGeneration: 0, sessionEpoch: 1 },
      lastRejectedEvidenceFingerprint: null,
      lastRejectedReason: null,
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z"
    };
    expect(() => createUnclaimedRuntimeIdentityClaim(base)).toThrow(/owner/i);
  });
});
