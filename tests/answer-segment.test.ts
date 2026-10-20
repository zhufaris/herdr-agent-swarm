import { describe, expect, it } from "vitest";
import { findUnmaterializedHumanBoundaries, itemsForAnswerSegment, type AnswerSegment } from "../src/domain/answer-segment.js";
import type { AnswerTimelineItem } from "../src/domain/answer-timeline.js";

describe("Answer segmentation", () => {
  it("finds each subsequent human message as an ordered segment boundary", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "human_message", id: "human:initial", sequence: 10, markdown: "first request" },
      { kind: "agent_message", id: "agent:one", sequence: 11, markdown: "ack" },
      { kind: "human_message", id: "human:a", sequence: 20, markdown: "followup A" },
      { kind: "human_message", id: "human:b", sequence: 20, markdown: "followup B" },
      { kind: "agent_message", id: "agent:two", sequence: 21, markdown: "reply" }
    ];

    expect(findUnmaterializedHumanBoundaries(items, new Set(), 10)).toEqual([
      { sourceHumanItemId: "human:a", requestText: "followup A", sequence: 20 },
      { sourceHumanItemId: "human:b", requestText: "followup B", sequence: 20 }
    ]);
  });

  it("does not return an already materialized human boundary", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "human_message", id: "human:initial", sequence: 10, markdown: "first request" },
      { kind: "human_message", id: "human:two", sequence: 12, markdown: "second request" },
      { kind: "human_message", id: "human:three", sequence: 13, markdown: "third request" }
    ];

    expect(findUnmaterializedHumanBoundaries(items, new Set(["human:two"]), 10)).toEqual([
      { sourceHumanItemId: "human:three", requestText: "third request", sequence: 13 }
    ]);
  });

  it("keeps consecutive human messages as distinct empty segments", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "human_message", id: "human:initial", sequence: 10, markdown: "first request" },
      { kind: "human_message", id: "human:two", sequence: 20, markdown: "second request" },
      { kind: "human_message", id: "human:three", sequence: 21, markdown: "third request" }
    ];

    expect(findUnmaterializedHumanBoundaries(items, new Set(), 10)).toEqual([
      { sourceHumanItemId: "human:two", requestText: "second request", sequence: 20 },
      { sourceHumanItemId: "human:three", requestText: "third request", sequence: 21 }
    ]);

    const segment: AnswerSegment = {
      aggregateKind: "primary-run",
      aggregateId: "prompt:one",
      segmentIndex: 1,
      sourceHumanItemId: "human:two",
      requestText: "second request",
      startAfterSequence: 20,
      endBeforeSequence: 21,
      endBeforeItemId: "human:three",
      state: "closed"
    };
    expect(itemsForAnswerSegment(items, segment)).toEqual([]);
  });

  it("selects only items inside one segment while excluding the human body item", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "human_message", id: "human:initial", sequence: 10, markdown: "first request" },
      { kind: "agent_message", id: "agent:before", sequence: 11, markdown: "old answer" },
      { kind: "human_message", id: "human:two", sequence: 20, markdown: "second request" },
      { kind: "agent_message", id: "agent:after", sequence: 21, markdown: "new answer" },
      { kind: "thinking", id: "think:after", sequence: 22, label: "plan" },
      { kind: "final_answer", id: "final:after", sequence: 23, markdown: "done" },
      { kind: "human_message", id: "human:three", sequence: 30, markdown: "third request" }
    ];

    const segment: AnswerSegment = {
      aggregateKind: "primary-run",
      aggregateId: "prompt:one",
      segmentIndex: 1,
      sourceHumanItemId: "human:two",
      requestText: "second request",
      startAfterSequence: 20,
      endBeforeSequence: 30,
      endBeforeItemId: "human:three",
      state: "closed"
    };

    expect(itemsForAnswerSegment(items, segment)).toEqual([
      { kind: "agent_message", id: "agent:after", sequence: 21, markdown: "new answer" },
      { kind: "thinking", id: "think:after", sequence: 22, label: "plan" },
      { kind: "final_answer", id: "final:after", sequence: 23, markdown: "done" }
    ]);
  });

  it("respects canonical (sequence,id) ordering at start and end boundaries", () => {
    const items: AnswerTimelineItem[] = [
      { kind: "human_message", id: "human:initial", sequence: 10, markdown: "first request" },

      { kind: "agent_message", id: "agent:old", sequence: 19, markdown: "old" },

      // Start boundary: human:two @ (20, human:two). Items with the same sequence but lower ids belong to the previous segment.
      { kind: "agent_message", id: "agent:before", sequence: 20, markdown: "should be excluded" },
      { kind: "human_message", id: "human:two", sequence: 20, markdown: "second request" },
      { kind: "thinking", id: "think:after", sequence: 20, label: "should be included" },

      // End boundary: human:three @ (30, human:three). Items with the same sequence but lower ids are still inside this segment.
      { kind: "agent_message", id: "agent:inside-end", sequence: 30, markdown: "should be included" },
      { kind: "human_message", id: "human:three", sequence: 30, markdown: "third request" },
      { kind: "final_answer", id: "z:after-end", sequence: 30, markdown: "should be excluded" }
    ];

    const segment: AnswerSegment = {
      aggregateKind: "primary-run",
      aggregateId: "prompt:one",
      segmentIndex: 1,
      sourceHumanItemId: "human:two",
      requestText: "second request",
      startAfterSequence: 20,
      endBeforeSequence: 30,
      endBeforeItemId: "human:three",
      state: "closed"
    };

    expect(itemsForAnswerSegment(items, segment)).toEqual([
      { kind: "thinking", id: "think:after", sequence: 20, label: "should be included" },
      { kind: "agent_message", id: "agent:inside-end", sequence: 30, markdown: "should be included" }
    ]);
  });
});
