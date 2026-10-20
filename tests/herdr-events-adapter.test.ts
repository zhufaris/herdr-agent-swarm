import { describe, expect, it } from "vitest";
import { parseHerdrAgentEvent } from "../src/adapters/herdr-events-adapter.js";
import { MAX_FREEFORM_EVENT_TEXT_BYTES } from "../src/domain/herdr-event-payload-schema.js";
import { agentEvent } from "./helpers/herdr-events.js";

describe("Herdr Human Message adapter", () => {
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
});
