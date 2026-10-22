import { describe, expect, it, vi } from "vitest";
import { HerdrEventsAdapter } from "../src/adapters/herdr-events-adapter.js";
import type { CommandRunner } from "../src/infra/command-runner.js";
import { decodePersistedAgentEvent, encodePersistedAgentEvent } from "../src/runtime/herdr-events/event-codec.js";
import { agentEvent, attachedSource, coreEventResponse } from "./helpers/herdr-events.js";

describe("HerdrEventsAdapter", () => {
  it("normalizes attach sources and owns Core CLI argument construction", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => coreEventResponse({
      type: "agent_events_attached",
      source_id: "source-1",
      attach_offset: 10,
      sources: [attachedSource("source-1", "active", "source-1:12")]
    }));
    const adapter = new HerdrEventsAdapter({ run }, "herdr");

    await expect(adapter.attach({
      paneId: "w1:p1",
      agentKind: "traex",
      sessionId: "session-1",
      path: "/tmp/session.jsonl",
      from: "start"
    })).resolves.toEqual({
      sourceId: "source-1",
      attachOffset: 10,
      sources: [{
        sourceId: "source-1",
        terminalId: "terminal-1",
        agentKind: "traex",
        sessionId: "session-1",
        state: "active",
        checkpointOffset: 10,
        latestCursor: "source-1:12"
      }]
    });
    expect(run).toHaveBeenCalledWith("herdr", [
      "agent", "events", "attach", "--pane", "w1:p1", "--kind", "traex",
      "--session-id", "session-1", "--path", "/tmp/session.jsonl", "--from", "start"
    ], 2_000, undefined, expect.any(AbortSignal));
  });

  it("rejects responses beyond the bounded Core transport limit", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => ({ stdout: "x".repeat(2 * 1024 * 1024 + 1), stderr: "" }));
    const adapter = new HerdrEventsAdapter({ run }, "herdr");

    await expect(adapter.capabilities()).rejects.toThrow("oversized event response");
  });

  it("accepts canonical conversation activity while isolating an unknown event in the same batch", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => coreEventResponse({
      type: "agent_events_batch",
      events: [
        agentEvent("source-1:1", "turn-1", "2026-10-07T00:00:00Z", { type: "model_changed", model: "GPT-5.6-Sol" }),
        agentEvent("source-1:2", "turn-1", "2026-10-07T00:00:01Z", { type: "future_activity", private_detail: "must not escape" }),
        agentEvent("source-1:3", "turn-1", "2026-10-07T00:00:02Z", { type: "context_compacted", summary: "must not escape" }),
        agentEvent("source-1:4", "turn-1", "2026-10-07T00:00:03Z", {
          type: "agent_activity", agent_id: "reviewer", state: "completed", model: "GPT-5.6-Sol",
          result_handoff: "delivered_to_parent",
          content: "Checking the recovery path.", content_truncated: false
        })
      ],
      next_cursor: "source-1:4",
      earliest_cursor: "source-1:1",
      latest_cursor: "source-1:9"
    }));
    const adapter = new HerdrEventsAdapter({ run }, "herdr");

    await expect(adapter.read("source-1", "start")).resolves.toMatchObject({
      events: [
        { cursor: "source-1:1", payload: { type: "model_changed", model: "GPT-5.6-Sol" } },
        { cursor: "source-1:3", payload: { type: "context_compacted" } },
        { cursor: "source-1:4", payload: { type: "agent_activity", agentId: "reviewer", state: "completed", model: "GPT-5.6-Sol", resultHandoff: "delivered_to_parent", content: "Checking the recovery path.", contentTruncated: false } }
      ],
      nextCursor: "source-1:4",
      latestCursor: "source-1:9"
    });
  });

  it("still fails closed for a malformed known conversation activity event", async () => {
    const adapter = new HerdrEventsAdapter({ run: async () => coreEventResponse({
      type: "agent_events_batch",
      events: [agentEvent("source-1:1", "turn-1", "2026-10-07T00:00:00Z", { type: "model_changed", model: "" })],
      next_cursor: "source-1:1",
      earliest_cursor: "source-1:1",
      latest_cursor: "source-1:1"
    }) }, "herdr");

    await expect(adapter.read("source-1", "start")).rejects.toThrow();
  });

  it("preserves structured completion Choice metadata on the same final message", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => coreEventResponse({
      type: "agent_events_batch",
      events: [agentEvent("source-1:1", "turn-1", "2026-10-07T00:00:00Z", {
        type: "message",
        message_id: "answer-1",
        channel: "final",
        text: "Clean answer",
        truncated: false,
        completion_choice: {
          version: 2,
          intent: "human_review",
          question: "Continue?",
          default: "continue",
          options: [{ id: "continue", label: "Continue", message: "default" }]
        }
      })],
      next_cursor: "source-1:1",
      earliest_cursor: "source-1:1",
      latest_cursor: "source-1:1"
    }));
    const adapter = new HerdrEventsAdapter({ run }, "herdr");

    await expect(adapter.read("source-1", "start")).resolves.toMatchObject({
      events: [{ payload: {
        type: "message",
        text: "Clean answer",
        completionChoice: {
          version: 2,
          intent: "human_review",
          question: "Continue?",
          default: "continue",
          options: [{ id: "continue", label: "Continue", message: "default" }]
        }
      } }]
    });
  });

  it("round-trips structured completion Choice metadata through the persisted event codec", () => {
    const event = {
      schemaVersion: 1 as const, eventId: "event-1", cursor: "source-1:1", sourceId: "source-1",
      agentKind: "traex" as const, sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-07T00:00:00Z",
      payload: {
        type: "message" as const, messageId: "answer-1", channel: "final", text: "Clean answer", truncated: false,
        completionChoice: { version: 2 as const, intent: "human_review" as const, question: "Continue?", default: "continue", options: [{ id: "continue", label: "Continue", message: "default" }] }
      }
    };
    expect(decodePersistedAgentEvent(encodePersistedAgentEvent(event))).toEqual(event);
  });

  it("round-trips bounded Subagent activity content through the persisted event codec", () => {
    const event = {
      schemaVersion: 1 as const, eventId: "event-agent", cursor: "source-1:2", sourceId: "source-1",
      agentKind: "traex" as const, sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-07T00:00:01Z",
      payload: {
        type: "agent_activity" as const, agentId: "reviewer", displayName: "Reviewer", model: "GPT-5.6-Sol",
        state: "completed" as const, resultHandoff: "delivered_to_parent" as const,
        content: "Verified the fix.", contentTruncated: false
      }
    };
    expect(decodePersistedAgentEvent(encodePersistedAgentEvent(event))).toEqual(event);
  });

  it("rejects malformed Subagent activity content metadata", async () => {
    const missingContent = new HerdrEventsAdapter({ run: async () => coreEventResponse({
      type: "agent_events_batch",
      events: [agentEvent("source-1:1", "turn-1", "2026-10-07T00:00:00Z", {
        type: "agent_activity", agent_id: "reviewer", state: "completed", content_truncated: true
      })],
      next_cursor: "source-1:1", earliest_cursor: "source-1:1", latest_cursor: "source-1:1"
    }) }, "herdr");
    await expect(missingContent.read("source-1", "start")).rejects.toThrow();

    for (const payload of [
      { type: "agent_activity", agent_id: "reviewer", state: "completed", result_handoff: "future_value" },
      { type: "agent_activity", agent_id: "reviewer", state: "failed", result_handoff: "delivered_to_parent" }
    ]) {
      const invalidHandoff = new HerdrEventsAdapter({ run: async () => coreEventResponse({
        type: "agent_events_batch",
        events: [agentEvent("source-1:2", "turn-1", "2026-10-07T00:00:01Z", payload)],
        next_cursor: "source-1:2", earliest_cursor: "source-1:2", latest_cursor: "source-1:2"
      }) }, "herdr");
      await expect(invalidHandoff.read("source-1", "start")).rejects.toThrow();
    }
  });

  it("fails closed for malformed or non-final structured completion Choice metadata", async () => {
    const malformed = new HerdrEventsAdapter({ run: async () => coreEventResponse({
      type: "agent_events_batch", events: [agentEvent("source-1:1", "turn-1", "2026-10-07T00:00:00Z", {
        type: "message", message_id: "answer-1", channel: "final", text: "Clean answer", truncated: false,
        completion_choice: { version: 2, intent: "human_review", question: "Continue?", default: "continue", options: [] }
      })], next_cursor: "source-1:1", earliest_cursor: "source-1:1", latest_cursor: "source-1:1"
    }) }, "herdr");
    const nonFinal = new HerdrEventsAdapter({ run: async () => coreEventResponse({
      type: "agent_events_batch", events: [agentEvent("source-1:1", "turn-1", "2026-10-07T00:00:00Z", {
        type: "message", message_id: "answer-1", channel: "assistant", text: "Progress", truncated: false,
        completion_choice: { version: 2, intent: "human_review", question: "Continue?", default: "continue", options: [{ id: "continue", label: "Continue", message: "default" }] }
      })], next_cursor: "source-1:1", earliest_cursor: "source-1:1", latest_cursor: "source-1:1"
    }) }, "herdr");

    await expect(malformed.read("source-1", "start")).rejects.toThrow();
    await expect(nonFinal.read("source-1", "start")).rejects.toThrow();
  });

  it("rejects semantically invalid structured completion Choice metadata", async () => {
    const invalid = new HerdrEventsAdapter({ run: async () => coreEventResponse({
      type: "agent_events_batch", events: [agentEvent("source-1:1", "turn-1", "2026-10-07T00:00:00Z", {
        type: "message", message_id: "answer-1", channel: "final", text: "Clean answer", truncated: false,
        completion_choice: {
          version: 2, intent: "human_review", question: "Continue?", default: "missing",
          options: [{ id: "ignore", label: "Ignore", message: "default" }, { id: "ignore", label: "Again", message: "again" }]
        }
      })], next_cursor: "source-1:1", earliest_cursor: "source-1:1", latest_cursor: "source-1:1"
    }) }, "herdr");

    await expect(invalid.read("source-1", "start")).rejects.toThrow();
  });

  it("fails closed for an unknown message role or a non-assistant final completion choice", async () => {
    const invalidRole = new HerdrEventsAdapter({ run: async () => coreEventResponse({
      type: "agent_events_batch", events: [agentEvent("source-1:1", "turn-1", "2026-10-22T00:00:00Z", {
        type: "message", message_id: "answer-1", role: "reviewer", channel: "final", text: "Clean answer", truncated: false
      })], next_cursor: "source-1:1", earliest_cursor: "source-1:1", latest_cursor: "source-1:1"
    }) }, "herdr");
    const developerChoice = new HerdrEventsAdapter({ run: async () => coreEventResponse({
      type: "agent_events_batch", events: [agentEvent("source-1:2", "turn-1", "2026-10-22T00:00:01Z", {
        type: "message", message_id: "answer-2", role: "developer", channel: "final", text: "Internal guidance", truncated: false,
        completion_choice: {
          version: 2, intent: "human_review", question: "Continue?", default: "continue",
          options: [{ id: "continue", label: "Continue", message: "default" }]
        }
      })], next_cursor: "source-1:2", earliest_cursor: "source-1:2", latest_cursor: "source-1:2"
    }) }, "herdr");

    await expect(invalidRole.read("source-1", "start")).rejects.toThrow();
    await expect(developerChoice.read("source-1", "start")).rejects.toThrow();
  });

  it("advertises Pane-visible reasoning and defaults older Core responses safely", async () => {
    const current = new HerdrEventsAdapter({ run: async () => coreEventResponse({
      type: "agent_events_capabilities",
      exact_turn_recovery_v1: true,
      historical_turn_index_recovery_v1: true,
      session_turn_enumeration_v1: true,
      visible_reasoning_v1: true
    }) }, "herdr");
    const legacy = new HerdrEventsAdapter({ run: async () => coreEventResponse({
      type: "agent_events_capabilities",
      exact_turn_recovery_v1: true,
      historical_turn_index_recovery_v1: true,
      session_turn_enumeration_v1: true
    }) }, "herdr");

    await expect(current.capabilities()).resolves.toMatchObject({ visibleReasoning: true });
    await expect(legacy.capabilities()).resolves.toMatchObject({ visibleReasoning: false });
  });

  it("negotiates and reads the stable Session Event Ring v2 transport", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => coreEventResponse({
      type: "agent_events_capabilities",
      exact_turn_recovery_v1: true,
      historical_turn_index_recovery_v1: true,
      session_turn_enumeration_v1: true,
      session_event_ring_v2: true
    }));
    const rpc = {
      request: vi.fn(async (method: string) => method === "ping"
        ? { type: "pong", capabilities: { session_event_stream_v1: true } }
        : method === "session.events.open.v2"
          ? { type: "session_event_ring_opened_v2", ring_id: "ring-1", epoch: "epoch-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: "session-1", earliest_cursor: "ring-1:epoch-1:1", latest_cursor: "ring-1:epoch-1:1" }
          : { type: "session_event_ring_batch_v2", ring_id: "ring-1", epoch: "epoch-1", events: [{ schema_version: 1, event_id: "event-1", cursor: "ring-1:epoch-1:1", source_id: "source-1", agent_kind: "traex", session_id: "session-1", turn_id: null, occurred_at: "2026-10-05T00:00:00Z", payload: { type: "turn_started" } }], next_cursor: "ring-1:epoch-1:1", earliest_cursor: "ring-1:epoch-1:1", latest_cursor: "ring-1:epoch-1:1" })
    };
    const adapter = new HerdrEventsAdapter({ run }, "herdr", rpc);

    await expect(adapter.supportsSessionEventRingV2()).resolves.toBe(true);
    await expect(adapter.openSessionRing("w1:p1")).resolves.toMatchObject({ ringId: "ring-1", epoch: "epoch-1", sessionId: "session-1" });
    await expect(adapter.readSessionRing("ring-1", "start")).resolves.toMatchObject({
      outcome: "batch", batch: { ringId: "ring-1", epoch: "epoch-1", events: [{ eventId: "event-1" }] }
    });
    expect(rpc.request).toHaveBeenNthCalledWith(2, "session.events.open.v2", { pane_id: "w1:p1" }, 5_000);
    expect(rpc.request).toHaveBeenNthCalledWith(3, "session.events.read.v2", { ring_id: "ring-1", after: "start", limit: 128 }, 5_000);
  });
});
