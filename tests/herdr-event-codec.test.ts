import { describe, expect, it } from "vitest";
import { decodePersistedAgentEvent, encodePersistedAgentEvent } from "../src/runtime/herdr-events/event-codec.js";
import { MAX_FREEFORM_EVENT_TEXT_BYTES } from "../src/domain/herdr-event-payload-schema.js";

describe("persisted Herdr event codec", () => {
  it("round-trips normalized response token usage", () => {
    const event = {
      schemaVersion: 1 as const,
      eventId: "event-token-usage",
      cursor: "source-1:token-usage",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-10-22T00:00:00.000Z",
      payload: {
        type: "token_usage" as const,
        responseId: "response-1",
        response: {
          inputTokens: 80,
          cachedInputTokens: 10,
          cacheCreationInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 105
        },
        thread: {
          inputTokens: 800,
          cachedInputTokens: 100,
          cacheCreationInputTokens: 0,
          outputTokens: 200,
          reasoningOutputTokens: 50,
          totalTokens: 1_050
        },
        modelContextWindow: 4_000,
        autoCompactLimit: 3_000
      }
    };

    expect(decodePersistedAgentEvent(encodePersistedAgentEvent(event))).toEqual(event);
  });

  it("round-trips an explicit developer message role", () => {
    const event = {
      schemaVersion: 1 as const,
      eventId: "event-developer",
      cursor: "source-1:developer",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-10-22T00:00:00.000Z",
      payload: {
        type: "message" as const,
        messageId: "message-developer",
        role: "developer" as const,
        channel: "commentary",
        text: "Use the repository contract.",
        truncated: false
      }
    };

    expect(decodePersistedAgentEvent(encodePersistedAgentEvent(event))).toEqual(event);
  });

  it("keeps a legacy assistant message role absent when round-tripped", () => {
    const event = {
      schemaVersion: 1 as const,
      eventId: "event-legacy-assistant",
      cursor: "source-1:legacy-assistant",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-10-22T00:00:01.000Z",
      payload: {
        type: "message" as const,
        messageId: "message-legacy-assistant",
        channel: "assistant",
        text: "Still visible to users.",
        truncated: false
      }
    };

    expect(decodePersistedAgentEvent(encodePersistedAgentEvent(event))).toEqual(event);
  });

  it("rejects a developer message above the 64 KiB UTF-8 boundary", () => {
    expect(() => decodePersistedAgentEvent({
      schemaVersion: 1,
      eventId: "event-developer-oversized",
      cursor: "source-1:developer-oversized",
      sourceId: "source-1",
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-10-22T00:00:02.000Z",
      payload: {
        type: "message",
        message_id: "message-developer-oversized",
        role: "developer",
        channel: "commentary",
        text: "x".repeat(64 * 1024 + 1),
        truncated: true
      }
    })).toThrow();
  });

  it("round-trips a Human Message choice selection reference", () => {
    const event = {
      schemaVersion: 1 as const,
      eventId: "event-1",
      cursor: "source-1:1",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-10-16T00:00:00.000Z",
      payload: {
        type: "human_message" as const,
        messageId: "message-1",
        text: "continue",
        truncated: false,
        submissionId: "submission-1",
        choice: {
          actionSetId: "actions-1",
          optionId: "approve",
          sourceMessageId: "review-1"
        }
      }
    };

    expect(decodePersistedAgentEvent(encodePersistedAgentEvent(event))).toEqual(event);
  });

  it("keeps legacy Human Message payloads without a choice selection reference", () => {
    const event = {
      schemaVersion: 1 as const,
      eventId: "event-legacy",
      cursor: "source-1:2",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-10-16T00:00:01.000Z",
      payload: { type: "human_message" as const, messageId: "message-legacy", text: "continue", truncated: false }
    };

    expect(decodePersistedAgentEvent(encodePersistedAgentEvent(event))).toEqual(event);
  });

  it("rejects malformed known Human Message choice selection references", () => {
    expect(() => decodePersistedAgentEvent({
      schemaVersion: 1,
      eventId: "event-malformed",
      cursor: "source-1:3",
      sourceId: "source-1",
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-10-16T00:00:02.000Z",
      payload: {
        type: "human_message",
        message_id: "message-malformed",
        text: "continue",
        truncated: false,
        choice: { actionSetId: "actions-1", optionId: "approve" }
      }
    })).toThrow();
  });

  it("rejects the same oversized free-form payload at the persistence boundary", () => {
    expect(() => decodePersistedAgentEvent({
      schemaVersion: 1,
      eventId: "event-oversized",
      cursor: "source-1:4",
      sourceId: "source-1",
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-10-16T00:00:03.000Z",
      payload: {
        type: "tool_result",
        call_id: "call-1",
        text: "x".repeat(MAX_FREEFORM_EVENT_TEXT_BYTES + 1),
        is_error: false,
        truncated: true
      }
    })).toThrow();
  });

  it("round-trips a free-form payload at the shared byte boundary", () => {
    const event = {
      schemaVersion: 1 as const,
      eventId: "event-boundary",
      cursor: "source-1:5",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-10-16T00:00:04.000Z",
      payload: {
        type: "tool_call" as const,
        callId: "call-1",
        name: "read_file",
        arguments: "x".repeat(MAX_FREEFORM_EVENT_TEXT_BYTES),
        truncated: false
      }
    };

    expect(decodePersistedAgentEvent(encodePersistedAgentEvent(event))).toEqual(event);
  });

  it("keeps assistant message text valid at the shared 1 MiB byte boundary", () => {
    const event = {
      schemaVersion: 1 as const,
      eventId: "event-assistant-boundary",
      cursor: "source-1:assistant-boundary",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-10-22T00:00:03.000Z",
      payload: {
        type: "message" as const,
        role: "assistant" as const,
        messageId: "message-assistant-boundary",
        channel: "final",
        text: "x".repeat(MAX_FREEFORM_EVENT_TEXT_BYTES),
        truncated: false
      }
    };

    expect(decodePersistedAgentEvent(encodePersistedAgentEvent(event))).toEqual(event);
  });
});
