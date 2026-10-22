import { describe, expect, it } from "vitest";
import type { CoreEventEnvelope } from "../src/domain/core-event-inbox.js";
import {
  coreEventSemanticHash,
  sameCoreEventSemantics
} from "../src/store/sqlite/core-event-identity.js";

function event(overrides: Partial<CoreEventEnvelope> = {}): CoreEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    cursor: "live:1",
    sourceId: "live-source",
    agentKind: "traex",
    sessionId: "session-1",
    turnId: "turn-1",
    occurredAt: "2026-10-17T00:00:00.000Z",
    payload: { type: "message", message_id: "message-1", channel: "final", text: "done", truncated: false },
    ...overrides
  };
}

describe("Core event semantic identity", () => {
  it("ignores transport source and cursor while canonicalizing object key order", () => {
    const left = event();
    const right = event({
      sourceId: "replay-source",
      cursor: "replay:99",
      payload: { truncated: false, text: "done", channel: "final", message_id: "message-1", type: "message" }
    });

    expect(coreEventSemanticHash(left)).toBe(coreEventSemanticHash(right));
    expect(sameCoreEventSemantics(left, right)).toBe(true);
  });

  it("normalizes a missing legacy Turn identity to null", () => {
    const legacy = { ...event({ turnId: null }) } as CoreEventEnvelope & { turnId?: string | null };
    delete legacy.turnId;

    expect(coreEventSemanticHash(legacy as CoreEventEnvelope)).toBe(coreEventSemanticHash(event({ turnId: null })));
  });

  it("excludes generated occurrence time only for record-skipped diagnostics", () => {
    const skipped = event({ occurredAt: "2026-10-17T00:00:00.000Z", payload: { type: "record_skipped", code: "record_too_large" } });
    const replay = event({ occurredAt: "2026-10-18T00:00:00.000Z", payload: { type: "record_skipped", code: "record_too_large" } });
    expect(coreEventSemanticHash(skipped)).toBe(coreEventSemanticHash(replay));

    expect(coreEventSemanticHash(event({ occurredAt: "2026-10-17T00:00:00.000Z" })))
      .not.toBe(coreEventSemanticHash(event({ occurredAt: "2026-10-18T00:00:00.000Z" })));
  });

  it("keeps submission IDs and typed human choices in semantic identity", () => {
    const canonical = event({
      payload: {
        type: "human_message", message_id: "human-1", text: "approve", truncated: false,
        submission_id: "submission-1", choice: { actionSetId: "set-1", optionId: "approve", sourceMessageId: "message-1" }
      }
    });
    const replay = event({
      sourceId: "replay", cursor: "replay:1",
      payload: { type: "human_message", message_id: "human-1", text: "approve", truncated: false }
    });

    expect(coreEventSemanticHash(canonical)).not.toBe(coreEventSemanticHash(replay));
    expect(sameCoreEventSemantics(canonical, replay)).toBe(false);
  });

  it.each([
    ["a changed submission ID", {
      type: "human_message", message_id: "human-1", text: "approve", truncated: false,
      submission_id: "submission-2", choice: { actionSetId: "set-1", optionId: "approve", sourceMessageId: "message-1" }
    }],
    ["a missing typed choice", {
      type: "human_message", message_id: "human-1", text: "approve", truncated: false, submission_id: "submission-1"
    }],
    ["a changed typed choice", {
      type: "human_message", message_id: "human-1", text: "approve", truncated: false,
      submission_id: "submission-1", choice: { actionSetId: "set-1", optionId: "reject", sourceMessageId: "message-1" }
    }],
    ["changed source-derived content", {
      type: "message", message_id: "message-1", channel: "final", text: "rewritten", truncated: false
    }]
  ])("treats %s as a semantic conflict", (_label, changedPayload) => {
    const canonical = event({
      payload: {
        type: "human_message", message_id: "human-1", text: "approve", truncated: false,
        submission_id: "submission-1", choice: { actionSetId: "set-1", optionId: "approve", sourceMessageId: "message-1" }
      }
    });
    const changed = event({ sourceId: "replay", cursor: "replay:1", payload: changedPayload });

    expect(sameCoreEventSemantics(canonical, changed)).toBe(false);
  });

  it("treats message role as part of semantic identity", () => {
    const canonical = event({
      payload: {
        type: "message",
        message_id: "message-1",
        role: "developer",
        channel: "commentary",
        text: "Repository-only guidance",
        truncated: false
      }
    });
    const replay = event({
      sourceId: "replay",
      cursor: "replay:1",
      payload: {
        type: "message",
        message_id: "message-1",
        channel: "commentary",
        text: "Repository-only guidance",
        truncated: false
      }
    });

    expect(coreEventSemanticHash(canonical)).not.toBe(coreEventSemanticHash(replay));
    expect(sameCoreEventSemantics(canonical, replay)).toBe(false);
  });

  it("treats normalized token usage as part of semantic identity while ignoring transport fields", () => {
    const canonical = event({
      payload: {
        type: "token_usage",
        response_id: "response-1",
        response: {
          input_tokens: 80,
          cached_input_tokens: 10,
          cache_creation_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 105
        },
        thread: {
          input_tokens: 800,
          cached_input_tokens: 100,
          cache_creation_input_tokens: 0,
          output_tokens: 200,
          reasoning_output_tokens: 50,
          total_tokens: 1_050
        },
        auto_compact_limit: 3_000
      }
    });
    const replay = event({
      sourceId: "replay",
      cursor: "replay:1",
      payload: {
        auto_compact_limit: 3_000,
        thread: {
          total_tokens: 1_050,
          reasoning_output_tokens: 50,
          output_tokens: 200,
          cache_creation_input_tokens: 0,
          cached_input_tokens: 100,
          input_tokens: 800
        },
        response: {
          total_tokens: 105,
          reasoning_output_tokens: 5,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cached_input_tokens: 10,
          input_tokens: 80
        },
        response_id: "response-1",
        type: "token_usage"
      }
    });

    expect(coreEventSemanticHash(canonical)).toBe(coreEventSemanticHash(replay));
    expect(sameCoreEventSemantics(canonical, replay)).toBe(true);
  });

  it.each([
    ["changed response id", {
      type: "token_usage",
      response_id: "response-2",
      response: {
        input_tokens: 80,
        cached_input_tokens: 10,
        cache_creation_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 105
      }
    }],
    ["changed thread total", {
      type: "token_usage",
      response_id: "response-1",
      response: {
        input_tokens: 80,
        cached_input_tokens: 10,
        cache_creation_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 105
      },
      thread: {
        input_tokens: 800,
        cached_input_tokens: 100,
        cache_creation_input_tokens: 0,
        output_tokens: 200,
        reasoning_output_tokens: 50,
        total_tokens: 1_051
      }
    }],
    ["changed compact limit", {
      type: "token_usage",
      response_id: "response-1",
      response: {
        input_tokens: 80,
        cached_input_tokens: 10,
        cache_creation_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 105
      },
      auto_compact_limit: 2_500
    }]
  ])("treats %s as a token-usage semantic conflict", (_label, changedPayload) => {
    const canonical = event({
      payload: {
        type: "token_usage",
        response_id: "response-1",
        response: {
          input_tokens: 80,
          cached_input_tokens: 10,
          cache_creation_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 105
        },
        thread: {
          input_tokens: 800,
          cached_input_tokens: 100,
          cache_creation_input_tokens: 0,
          output_tokens: 200,
          reasoning_output_tokens: 50,
          total_tokens: 1_050
        },
        auto_compact_limit: 3_000
      }
    });

    expect(sameCoreEventSemantics(canonical, event({ sourceId: "replay", cursor: "replay:1", payload: changedPayload }))).toBe(false);
  });

  it.each([
    ["missing payload type", {}],
    ["primitive payload", 42],
    ["unknown payload type", { type: "future_unknown_event" }],
    ["malformed known payload", { type: "turn_aborted" }],
    ["non-JSON payload", { type: "message", value: undefined }],
    ["non-finite number", { type: "message", value: Number.NaN }]
  ])("fails closed for %s", (_case, payload) => {
    expect(coreEventSemanticHash(event({ payload }))).toBeNull();
  });
});
