import { describe, expect, it } from "vitest";
import { parseHerdrAgentEvent } from "../src/adapters/herdr-events-adapter.js";
import { MAX_FREEFORM_EVENT_TEXT_BYTES } from "../src/domain/herdr-event-payload-schema.js";
import { agentEvent } from "./helpers/herdr-events.js";

describe("Herdr Human Message adapter", () => {
  it("preserves allowlisted context snapshots from Core", () => {
    const event = parseHerdrAgentEvent(agentEvent(
      "source-1:context-snapshot",
      "turn-1",
      "2026-10-22T00:00:00.000Z",
      {
        type: "context_snapshot",
        model: "GPT-5.6-Sol",
        provider: "trae",
        cwd: "/repo",
        collaboration_mode: "default",
        permission_mode: "managed",
        current_date: "2026-10-22",
        timezone: "Etc/UTC",
        worktree_path: "/repo/.worktrees/task",
        worktree_state: "clean",
        model_context_window: 4_000,
        auto_compact_limit: 3_000
      }
    ));

    expect(event.payload).toEqual({
      type: "context_snapshot",
      model: "GPT-5.6-Sol",
      provider: "trae",
      cwd: "/repo",
      collaborationMode: "default",
      permissionMode: "managed",
      currentDate: "2026-10-22",
      timezone: "Etc/UTC",
      worktreePath: "/repo/.worktrees/task",
      worktreeState: "clean",
      modelContextWindow: 4_000,
      autoCompactLimit: 3_000
    });
  });

  it("preserves normalized token usage from Core", () => {
    const event = parseHerdrAgentEvent(agentEvent(
      "source-1:token-usage",
      "turn-1",
      "2026-10-22T00:00:00.000Z",
      {
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
        turn: {
          input_tokens: 120,
          cached_input_tokens: 10,
          cache_creation_input_tokens: 0,
          output_tokens: 25,
          reasoning_output_tokens: 5,
          total_tokens: 150
        },
        thread: {
          input_tokens: 800,
          cached_input_tokens: 100,
          cache_creation_input_tokens: 0,
          output_tokens: 200,
          reasoning_output_tokens: 50,
          total_tokens: 1_050
        },
        model_context_window: 4_000,
        auto_compact_limit: 3_000
      }
    ));

    expect(event.payload).toEqual({
      type: "token_usage",
      responseId: "response-1",
      response: {
        inputTokens: 80,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 105
      },
      turn: {
        inputTokens: 120,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 0,
        outputTokens: 25,
        reasoningOutputTokens: 5,
        totalTokens: 150
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
    });
  });

  it("preserves an explicit developer message role from Core", () => {
    const event = parseHerdrAgentEvent(agentEvent(
      "source-1:role",
      "turn-1",
      "2026-10-22T00:00:00.000Z",
      {
        type: "message",
        message_id: "message-1",
        role: "developer",
        channel: "commentary",
        text: "Use the repository contract.",
        truncated: false
      }
    ));

    expect(event.payload).toEqual({
      type: "message",
      messageId: "message-1",
      role: "developer",
      channel: "commentary",
      text: "Use the repository contract.",
      truncated: false
    });
  });

  it("fails closed for malformed context snapshots from Core", () => {
    expect(() => parseHerdrAgentEvent(agentEvent(
      "source-1:context-empty",
      "turn-1",
      "2026-10-22T00:00:00.000Z",
      { type: "context_snapshot" }
    ))).toThrow();
    expect(() => parseHerdrAgentEvent(agentEvent(
      "source-1:context-private",
      "turn-1",
      "2026-10-22T00:00:01.000Z",
      { type: "context_snapshot", model: "GPT-5.6-Sol", raw_context: "secret" }
    ))).toThrow();
  });

  it("preserves the selected choice reference from Core", () => {
    const event = parseHerdrAgentEvent(agentEvent(
      "source-1:1",
      "turn-1",
      "2026-10-16T00:00:00.000Z",
      {
        type: "human_message",
        message_id: "message-1",
        text: "continue",
        truncated: false,
        submission_id: "submission-1",
        choice: {
          actionSetId: "actions-1",
          optionId: "approve",
          sourceMessageId: "review-1"
        }
      }
    ));

    expect(event.payload).toEqual({
      type: "human_message",
      messageId: "message-1",
      text: "continue",
      truncated: false,
      submissionId: "submission-1",
      choice: {
        actionSetId: "actions-1",
        optionId: "approve",
        sourceMessageId: "review-1"
      }
    });
  });

  it("rejects an oversized known tool-result payload before normalization", () => {
    expect(() => parseHerdrAgentEvent(agentEvent(
      "source-1:2",
      "turn-1",
      "2026-10-16T00:00:01.000Z",
      {
        type: "tool_result",
        call_id: "call-1",
        text: "x".repeat(MAX_FREEFORM_EVENT_TEXT_BYTES + 1),
        is_error: false,
        truncated: true
      }
    ))).toThrow();
  });

  it("rejects a developer message completion choice before normalization", () => {
    expect(() => parseHerdrAgentEvent(agentEvent(
      "source-1:role-choice",
      "turn-1",
      "2026-10-22T00:00:01.000Z",
      {
        type: "message",
        message_id: "message-choice",
        role: "developer",
        channel: "final",
        text: "Repository-only instruction.",
        truncated: false,
        completion_choice: {
          version: 2,
          intent: "human_review",
          question: "Continue?",
          default: "continue",
          options: [{ id: "continue", label: "Continue", message: "default" }]
        }
      }
    ))).toThrow();
  });

  it("rejects malformed token usage bounds and unknown fields before normalization", () => {
    expect(() => parseHerdrAgentEvent(agentEvent(
      "source-1:bad-token-negative",
      "turn-1",
      "2026-10-22T00:00:02.000Z",
      {
        type: "token_usage",
        response_id: "response-1",
        response: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          total_tokens: -1
        }
      }
    ))).toThrow();

    expect(() => parseHerdrAgentEvent(agentEvent(
      "source-1:bad-token-unknown",
      "turn-1",
      "2026-10-22T00:00:03.000Z",
      {
        type: "token_usage",
        response_id: "response-1",
        response: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          total_tokens: 2,
          mystery_tokens: 9
        }
      }
    ))).toThrow();
  });
});
