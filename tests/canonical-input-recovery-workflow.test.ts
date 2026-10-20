import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverPendingCanonicalTurns } from "../src/coordinator/canonical-input-recovery-workflow.js";
import type { CoreSubmissionReceipt, SubmissionIntent } from "../src/domain/submission-intent.js";
import { createTestStoreBundle, type TestStoreBundle } from "./helpers/create-test-store-bundle.js";

describe("Canonical Input recovery workflow", () => {
  it("isolates one malformed historical turn and continues the bounded recovery batch", async () => {
    const outcomes: Array<{ submissionId: string; outcome: string }> = [];
    const warn = vi.fn();
    const candidates = ["broken", "healthy"].map(canonicalCandidate);

    const result = await recoverPendingCanonicalTurns({
      store: {
        claimPendingCanonicalRecoveryPage: () => ({ items: candidates, nextCursor: null, hasMore: false, scanCutoff: "2026-10-05T14:00:01.000Z" }),
        completeCanonicalRecoveryPage: ({ outcomes: batch }) => { outcomes.push(...batch); },
        getCanonicalRecoverySummary: () => ({ indexing: 0, needsHuman: 0, lastFailureCode: null })
      },
      recover: vi.fn(async (candidate) => {
        if (candidate.submissionId === "broken") throw new Error("equal start/end boundary");
        return "recovered" as const;
      }),
      logger: { warn },
      now: () => "2026-10-05T14:00:01.000Z"
    });

    expect(outcomes).toEqual([
      { submissionId: "broken", outcome: "unavailable" },
      { submissionId: "healthy", outcome: "recovered" }
    ]);
    expect(result).toEqual({ indexing: 0, needsHuman: 0, lastFailureCode: null, hasMore: false });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "canonical-input-recovery-failed", submissionId: "broken", outcome: "auto_closed"
    }), expect.any(String));
  });

  it("consumes one frozen 33-item pass as 16, 16, and 1 without replay", async () => {
    const stores = createTestStoreBundle();
    seedCanonicalCandidates(stores, 33);
    const recovered: string[] = [];
    const run = () => recoverPendingCanonicalTurns({
      store: stores.agentInputs, limit: 16, now: () => "2026-10-05T14:10:00.000Z",
      recover: async (candidate) => { recovered.push(candidate.submissionId); return "not_found"; }
    });

    await expect(run()).resolves.toMatchObject({ hasMore: true });
    expect(recovered).toHaveLength(16);
    await expect(run()).resolves.toMatchObject({ hasMore: true });
    expect(recovered).toHaveLength(32);
    await expect(run()).resolves.toMatchObject({ hasMore: false });

    expect(recovered).toEqual(Array.from({ length: 33 }, (_, index) => canonicalId(index)));
    expect(new Set(recovered)).toHaveProperty("size", 33);
  });

  it("resumes the exact frozen canonical cursor after database reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "canonical-recovery-reopen-"));
    const databasePath = join(directory, "bridge.sqlite");
    let stores = createTestStoreBundle(databasePath);
    try {
      seedCanonicalCandidates(stores, 33);
      const first: string[] = [];
      await recoverPendingCanonicalTurns({
        store: stores.agentInputs, limit: 16, now: () => "2026-10-05T14:10:00.000Z",
        recover: async (candidate) => { first.push(candidate.submissionId); return "not_found"; }
      });
      stores.driver.close();

      stores = createTestStoreBundle(databasePath);
      const second: string[] = [];
      await recoverPendingCanonicalTurns({
        store: stores.agentInputs, limit: 16, now: () => "2026-10-05T15:10:00.000Z",
        recover: async (candidate) => { second.push(candidate.submissionId); return "not_found"; }
      });

      expect(first).toEqual(Array.from({ length: 16 }, (_, index) => canonicalId(index)));
      expect(second).toEqual(Array.from({ length: 16 }, (_, index) => canonicalId(index + 16)));
    } finally {
      stores.driver.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back canonical outcomes and cursor advancement as one batch", () => {
    const stores = createTestStoreBundle();
    seedCanonicalCandidates(stores, 3);
    const page = stores.agentInputs.claimPendingCanonicalRecoveryPage({ limit: 2, currentTime: "2026-10-05T14:10:00.000Z" });

    expect(() => stores.agentInputs.completeCanonicalRecoveryPage({
      page,
      outcomes: [
        { submissionId: page.items[0]!.submissionId, outcome: "recovered" },
        { submissionId: "not-in-page", outcome: "not_found" }
      ],
      occurredAt: "2026-10-05T14:10:01.000Z"
    })).toThrow("canonical_input_recovery_outcome_identity_mismatch");

    expect(stores.agentInputs.getCanonicalRecoverySummary()).toEqual({ indexing: 0, needsHuman: 0, lastFailureCode: null });
    const retried = stores.agentInputs.claimPendingCanonicalRecoveryPage({ limit: 2, currentTime: "2026-10-05T15:10:00.000Z" });
    expect(retried.scanCutoff).toBe(page.scanCutoff);
    expect(retried.items.map(({ submissionId }) => submissionId)).toEqual(page.items.map(({ submissionId }) => submissionId));
  });
});

function seedCanonicalCandidates(stores: TestStoreBundle, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const submissionId = canonicalId(index);
    const recordedAt = `2026-10-05T14:00:${String(index).padStart(2, "0")}.000Z`;
    stores.agentInputs.admit({
      submissionId, ingressSource: "feishu:primary", sourceMessageKey: `message-${index}`,
      actor: { kind: "human", id: "user-1", gatewayId: "feishu:primary", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1" },
      text: `recover ${index}`, owner: { kind: "primary", id: "binding-1", generation: 1 },
      paneId: "workspace-1:pane-1", terminalId: "terminal-1", expectedAgentKind: "traex", expectedSessionId: "session-1", recordedAt
    });
    stores.agentInputs.claimRecorded(submissionId, recordedAt);
    stores.agentInputs.recordReceipt(submissionId, canonicalReceipt(submissionId));
  }
}

function canonicalCandidate(submissionId: string): SubmissionIntent {
  return {
    submissionId, ingressSource: "feishu:primary", sourceMessageKey: `message-${submissionId}`,
    actor: { kind: "human", id: "user-1", gatewayId: "feishu:primary", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1" },
    text: "recover", owner: { kind: "primary", id: `binding-${submissionId}`, generation: 1 },
    paneId: `w1:${submissionId}`, terminalId: `terminal-${submissionId}`, expectedAgentKind: "traex",
    expectedSessionId: `session-${submissionId}`, state: "observed", receipt: canonicalReceipt(submissionId, `session-${submissionId}`),
    uncertainty: null, cancellation: null, attemptedAt: "2026-10-05T14:00:00.000Z",
    createdAt: "2026-10-05T14:00:00.000Z", updatedAt: "2026-10-05T14:00:00.000Z"
  };
}

function canonicalReceipt(submissionId: string, sessionId = "session-1"): CoreSubmissionReceipt {
  return {
    submissionId, paneId: submissionId === "broken" || submissionId === "healthy" ? `w1:${submissionId}` : "workspace-1:pane-1",
    terminalId: submissionId === "broken" || submissionId === "healthy" ? `terminal-${submissionId}` : "terminal-1",
    agentKind: "traex", sessionId, state: "observed", turnId: `turn-${submissionId}`,
    startedAt: "2026-10-05T14:00:00.000Z", terminalState: null,
    createdAt: Date.parse("2026-10-05T14:00:00.000Z"), updatedAt: Date.parse("2026-10-05T14:00:00.000Z")
  };
}

function canonicalId(index: number): string { return `submission-${String(index).padStart(2, "0")}`; }
