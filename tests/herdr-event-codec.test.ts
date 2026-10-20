import { describe, expect, it } from "vitest";
import { decodePersistedAgentEvent, encodePersistedAgentEvent } from "../src/runtime/herdr-events/event-codec.js";
import { MAX_FREEFORM_EVENT_TEXT_BYTES } from "../src/domain/herdr-event-payload-schema.js";

describe("persisted Herdr event codec", () => {
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
});
