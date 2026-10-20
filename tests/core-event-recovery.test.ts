import { describe, expect, it, vi } from "vitest";
import type { AgentTranscriptReaderPort } from "../src/domain/ports/external.js";
import type { Binding, PromptJob } from "../src/domain/types.js";
import { assessDetachedPromptReceipt } from "../src/coordinator/core-event-recovery.js";

const prompt = {
  id: "prompt-1", bindingId: "binding-1", state: "running", observationState: "detached",
  nativeSubmissionId: "prompt-1", transcriptTurnId: null, transcriptTurnStartedAt: null
} as PromptJob;
const binding = {
  id: "binding-1", generation: 3, state: "active", lifecycle: "active", agentKind: "traex",
  paneId: "workspace:pane", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
  agentSessionKind: "id", agentSessionValue: "session-1"
} as unknown as Binding;

describe("Core event detached Prompt recovery", () => {
  it.each([
    ["accepted", { outcome: "accepted", prompt }],
    ["uncertain", { outcome: "uncertain", prompt, reason: "submission_outcome_uncertain" }],
    ["rejected", { outcome: "rejected", prompt, reason: "submission_rejected_before_boundary" }]
  ] as const)("recovers a lost native queue response from the durable %s receipt without turn identity", async (state, expected) => {
    const store = { getPrompt: vi.fn(() => prompt), getBinding: vi.fn(() => binding) };
    const reader = {
      getNativeSubmissionReceipt: vi.fn(async () => ({
        submissionId: "prompt-1", terminalId: "terminal-1", agentKind: "traex" as const,
        sessionId: "session-1", state, createdAt: 10, updatedAt: 11
      }))
    } as unknown as AgentTranscriptReaderPort;

    await expect(assessDetachedPromptReceipt({ prompt, store, reader })).resolves.toEqual(expected);
  });

  it("treats a later exact turn identity as optional enrichment", async () => {
    const enriched = { ...prompt, transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-10-02T10:00:00.000Z" } as PromptJob;
    const reader = { getNativeSubmissionReceipt: vi.fn() } as unknown as AgentTranscriptReaderPort;
    const store = { getPrompt: vi.fn(() => enriched), getBinding: vi.fn(() => binding) };

    await expect(assessDetachedPromptReceipt({ prompt: enriched, store, reader })).resolves.toEqual({ outcome: "owned", prompt: enriched });
    expect(reader.getNativeSubmissionReceipt).not.toHaveBeenCalled();
  });

  it("does not fall through to the legacy transcript receipt when the v2 receipt is not yet available", async () => {
    const getSubmissionReceipt = vi.fn();
    const reader = {
      getNativeSubmissionReceipt: vi.fn(async () => null), getSubmissionReceipt
    } as unknown as AgentTranscriptReaderPort;
    const store = { getPrompt: vi.fn(() => prompt), getBinding: vi.fn(() => binding) };

    await expect(assessDetachedPromptReceipt({ prompt, store, reader })).resolves.toEqual({
      outcome: "pending", reason: "submission_receipt_unavailable"
    });
    expect(getSubmissionReceipt).not.toHaveBeenCalled();
  });

  it("never claims Prompt-to-turn ownership from a terminal receipt", async () => {
    const store = {
      getPrompt: vi.fn(() => prompt),
      getBinding: vi.fn(() => binding)
    };
    const reader = { getSubmissionReceipt: vi.fn(async () => ({
      submissionId: "prompt-1", state: "terminal" as const, agentKind: "traex" as const,
      sessionId: "session-1", turnId: "turn-1", startedAt: "2026-09-30T00:00:00.000Z", terminalState: "completed"
    })) } as unknown as AgentTranscriptReaderPort;

    await expect(assessDetachedPromptReceipt({ prompt, store, reader })).resolves.toEqual({ outcome: "unavailable", reason: "submission_terminal_without_event" });
  });

  it("leaves prepared and unavailable receipts detached without guessing ownership", async () => {
    const store = {
      getPrompt: vi.fn(() => prompt),
      getBinding: vi.fn(() => binding)
    };
    const prepared = { getSubmissionReceipt: vi.fn(async () => ({
      submissionId: "prompt-1", state: "prepared" as const, agentKind: "traex" as const, sessionId: "session-1"
    })) } as unknown as AgentTranscriptReaderPort;

    await expect(assessDetachedPromptReceipt({ prompt, store, reader: prepared })).resolves.toEqual({ outcome: "pending", reason: "submission_not_observed" });
    prepared.getSubmissionReceipt = vi.fn(async () => null);
    await expect(assessDetachedPromptReceipt({ prompt, store, reader: prepared })).resolves.toEqual({ outcome: "pending", reason: "submission_receipt_unavailable" });
  });

  it("rejects a receipt with a different submission or native session", async () => {
    const store = {
      getPrompt: vi.fn(() => prompt),
      getBinding: vi.fn(() => binding)
    };
    const reader = { getSubmissionReceipt: vi.fn(async () => ({
      submissionId: "another-prompt", state: "terminal" as const, agentKind: "traex" as const,
      sessionId: "session-1", turnId: "turn-1", startedAt: "2026-09-30T00:00:00.000Z"
    })) } as unknown as AgentTranscriptReaderPort;

    await expect(assessDetachedPromptReceipt({ prompt, store, reader })).resolves.toEqual({ outcome: "unavailable", reason: "submission_receipt_identity_mismatch" });
    reader.getSubmissionReceipt = vi.fn(async () => ({
      submissionId: "prompt-1", state: "observed" as const, agentKind: "traex" as const,
      sessionId: "another-session", turnId: "turn-1", startedAt: "2026-09-30T00:00:00.000Z"
    }));
    await expect(assessDetachedPromptReceipt({ prompt, store, reader })).resolves.toEqual({ outcome: "unavailable", reason: "submission_receipt_session_mismatch" });
  });

  it("rejects a durable native submission id that differs from the Prompt id", async () => {
    const mismatched = { ...prompt, nativeSubmissionId: "legacy-submission" } as PromptJob;
    const store = {
      getPrompt: vi.fn(() => mismatched),
      getBinding: vi.fn(() => binding)
    };
    const reader = { getSubmissionReceipt: vi.fn() } as unknown as AgentTranscriptReaderPort;

    await expect(assessDetachedPromptReceipt({ prompt: mismatched, store, reader })).resolves.toEqual({ outcome: "unavailable", reason: "submission_identity_mismatch" });
    expect(reader.getSubmissionReceipt).not.toHaveBeenCalled();
  });
});
