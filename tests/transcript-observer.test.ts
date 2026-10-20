import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { TranscriptObserver } from "../src/coordinator/transcript-observer.js";
import { TURN_OUTPUT_TRUNCATION_MARKER } from "../src/runtime/bounded-turn-output.js";
import type { Binding, PromptJob } from "../src/domain/types.js";
import type { AgentTranscriptReaderPort } from "../src/domain/ports.js";
import { CoreSessionCursorExpiredError } from "../src/runtime/herdr-events-reader.js";

const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
const startedAt = "2026-09-13T00:00:00.000Z";

describe("TranscriptObserver detached output recovery", () => {
  it("surfaces an expired Core session cursor as an explicit recovery outcome", async () => {
    const reader: AgentTranscriptReaderPort = {
      async open() { return { mode: "unavailable", reason: "transcript_not_found" }; },
      async openAtTurn() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() { throw new CoreSessionCursorExpiredError("cursor-4", "cursor-10"); }
      } }; }
    };
    const observer = new TranscriptObserver({ allowLegacySettlementForTests: true,
      store: { getBinding: () => binding(), getPrompt: () => prompt(), claimPromptTranscriptTurn: vi.fn(), loadRunCard: () => ({ answer: "" }) as never },
      reader, herdr: { observeRuntime: vi.fn() }, adoptRuntimeIdentity: vi.fn(), logger: pino({ enabled: false }),
      isBindingActive: () => true, isStopping: () => false, publishObservation: vi.fn()
    });

    await expect(observer.openDetached(binding(), prompt())).resolves.toEqual({ mode: "unavailable", reason: "cursor_expired" });
  });

  it("replaces a legacy-truncated snapshot from the exact replayed turn", async () => {
    const prefix = "x".repeat(64 * 1024 - TURN_OUTPUT_TRUNCATION_MARKER.length);
    const persisted = `${prefix}${TURN_OUTPUT_TRUNCATION_MARKER}`;
    const replayed = `${prefix}\n\ncontinued after the old boundary`;
    let read = false;
    const reader: AgentTranscriptReaderPort = {
      async open() { return { mode: "unavailable", reason: "transcript_not_found" }; },
      async openAtTurn() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          if (read) return { answerDelta: "" };
          read = true;
          return { turnId, answerDelta: replayed, turnLifecycle: { turnId, state: "active", startedAt } };
        }
      } }; }
    };
    const publishObservation = vi.fn(async () => {});
    const observer = new TranscriptObserver({ allowLegacySettlementForTests: true,
      store: {
        getBinding: () => binding(), getPrompt: () => prompt(), claimPromptTranscriptTurn: vi.fn(),
        loadRunCard: () => ({ answer: persisted }) as never
      },
      reader, herdr: { observeRuntime: vi.fn() }, adoptRuntimeIdentity: vi.fn(), logger: pino({ enabled: false }),
      isBindingActive: () => true, isStopping: () => false, publishObservation
    });

    const source = await observer.openDetached(binding(), prompt());

    expect(source).toMatchObject({ mode: "typed", output: { text: replayed, truncated: false } });
    expect(publishObservation).toHaveBeenCalledWith("b1", "p1", {
      answer: { snapshot: replayed, update: "replace-all", toolActivities: [] }, main: {}
    });
  });

  it("keeps a legacy-truncated snapshot when exact replay does not match its prefix", async () => {
    const persisted = `${"x".repeat(64 * 1024 - TURN_OUTPUT_TRUNCATION_MARKER.length)}${TURN_OUTPUT_TRUNCATION_MARKER}`;
    let read = false;
    const reader: AgentTranscriptReaderPort = {
      async open() { return { mode: "unavailable", reason: "transcript_not_found" }; },
      async openAtTurn() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          if (read) return { answerDelta: "" };
          read = true;
          return { turnId, answerDelta: "different transcript content", turnLifecycle: { turnId, state: "active", startedAt } };
        }
      } }; }
    };
    const publishObservation = vi.fn(async () => {});
    const observer = new TranscriptObserver({ allowLegacySettlementForTests: true,
      store: {
        getBinding: () => binding(), getPrompt: () => prompt(), claimPromptTranscriptTurn: vi.fn(),
        loadRunCard: () => ({ answer: persisted }) as never
      },
      reader, herdr: { observeRuntime: vi.fn() }, adoptRuntimeIdentity: vi.fn(), logger: pino({ enabled: false }),
      isBindingActive: () => true, isStopping: () => false, publishObservation
    });

    const source = await observer.openDetached(binding(), prompt());

    expect(source).toMatchObject({ mode: "typed", output: { text: persisted } });
    expect(publishObservation).not.toHaveBeenCalled();
  });

  it("replays a durable timeline even when legacy answer text is unchanged", async () => {
    let read = false;
    const timelineDeltas = [{ kind: "agent_message" as const, id: "message:1", sequence: 1, markdown: "Recovered" }];
    const reader: AgentTranscriptReaderPort = {
      async open() { return { mode: "unavailable", reason: "transcript_not_found" }; },
      async openAtTurn() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          if (read) return { answerDelta: "" };
          read = true;
          return { turnId, answerDelta: "", timelineDeltas, turnLifecycle: { turnId, state: "active", startedAt } };
        }
      } }; }
    };
    const publishObservation = vi.fn(async () => {});
    const observer = new TranscriptObserver({ allowLegacySettlementForTests: true,
      store: { getBinding: () => binding(), getPrompt: () => prompt(), claimPromptTranscriptTurn: vi.fn(), loadRunCard: () => ({ answer: "" }) as never },
      reader, herdr: { observeRuntime: vi.fn() }, adoptRuntimeIdentity: vi.fn(), logger: pino({ enabled: false }),
      isBindingActive: () => true, isStopping: () => false, publishObservation
    });

    await observer.openDetached(binding(), prompt());

    expect(publishObservation).toHaveBeenCalledWith("b1", "p1", expect.objectContaining({ answer: expect.objectContaining({ timelineDeltas }) }));
  });
});

describe("TranscriptObserver first-turn acquisition", () => {
  it("opens once without polling identity for an explicit sessionless bootstrap", async () => {
    const sessionless = {
      ...binding(), hasCompletedTurn: false,
      agentSessionSource: null, agentSessionAgent: null, agentSessionKind: null, agentSessionValue: null
    };
    const open = vi.fn(async () => ({ mode: "unavailable" as const, reason: "missing_session_identity" as const }));
    const getBinding = vi.fn(() => sessionless);
    const observer = new TranscriptObserver({ allowLegacySettlementForTests: true,
      store: { getBinding, getPrompt: () => prompt(), claimPromptTranscriptTurn: vi.fn(), loadRunCard: () => ({ answer: "" }) as never },
      reader: { open }, herdr: { observeRuntime: vi.fn() }, adoptRuntimeIdentity: vi.fn(), logger: pino({ enabled: false }),
      isBindingActive: () => true, isStopping: () => false, publishObservation: vi.fn()
    });

    await expect(observer.acquire(sessionless, new AbortController().signal, "sessionless-bootstrap"))
      .resolves.toEqual({ mode: "unavailable", reason: "missing_session_identity" });

    expect(open).toHaveBeenCalledOnce();
    expect(getBinding).not.toHaveBeenCalled();
  });

  it("retains delayed identity acquisition for an ordinary first turn", async () => {
    const sessionless = {
      ...binding(), hasCompletedTurn: false,
      agentSessionSource: null, agentSessionAgent: null, agentSessionKind: null, agentSessionValue: null
    };
    const upgraded = { ...sessionless, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-created" };
    const cursor = { async readDelta() { return ""; } };
    const open = vi.fn(async (source: Parameters<AgentTranscriptReaderPort["open"]>[0]) => source.nativeSession
      ? { mode: "typed" as const, cursor }
      : { mode: "unavailable" as const, reason: "missing_session_identity" as const });
    const getBinding = vi.fn(() => upgraded);
    const observer = new TranscriptObserver({ allowLegacySettlementForTests: true,
      store: { getBinding, getPrompt: () => prompt(), claimPromptTranscriptTurn: vi.fn(), loadRunCard: () => ({ answer: "" }) as never },
      reader: { open }, herdr: { observeRuntime: vi.fn() }, adoptRuntimeIdentity: vi.fn(), logger: pino({ enabled: false }),
      isBindingActive: () => true, isStopping: () => false, publishObservation: vi.fn()
    });

    await expect(observer.acquire(sessionless, new AbortController().signal)).resolves.toMatchObject({ mode: "typed" });

    expect(getBinding).toHaveBeenCalledWith("b1");
    expect(open).toHaveBeenCalledTimes(2);
  });
});

function binding(): Binding {
  return {
    id: "b1", gatewayId: "feishu:primary", creatorOpenId: null, projectId: "project", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", retiredTopicId: null, retiredRootMessageId: null, replacesBindingId: null, reservedTopicId: null, reservedRootMessageId: null, resetMessageId: null, paneId: "w1:p1", traexSessionId: "terminal", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session", title: "Task", runtime: "traex", state: "active", statusMessageId: "main", statusCardSequence: 1, lastAgentState: "working", lastOutputFingerprint: null, lifecycle: "active", attachment: "attached", generation: 1, provisioningCheckpoint: "activated", degradationCount: 0, hasCompletedTurn: true, lastObservedAt: null, archivedAt: null, lastActivityAt: startedAt, createdAt: startedAt, updatedAt: startedAt
  };
}

function prompt(): PromptJob {
  return { id: "p1", bindingId: "b1", larkMessageId: "message", actorOpenId: "user", body: "work", parentPromptId: null, executionOrigin: "bridge", priority: "normal", wasDetached: true, dispatchedAt: startedAt, transcriptTurnId: turnId, transcriptTurnStartedAt: startedAt, modelName: null, modelRevision: null, state: "running", observationState: "detached", attemptCount: 1, error: null, createdAt: startedAt, updatedAt: startedAt };
}
