import { describe, expect, it } from "vitest";
import {
  closeConversationSegment,
  compareSegmentPosition,
  terminalConversationSegment,
  workingConversationSegment
} from "../src/domain/conversation-segment.js";
import type { ConversationSegment } from "../src/domain/conversation-segment.js";

function createSegment(overrides: Partial<ConversationSegment> = {}): ConversationSegment {
  return {
    id: "segment-1",
    producerKey: "producer-1",
    ownerKind: "primary",
    ownerId: "binding-1",
    ownerGeneration: 2,
    submissionId: "submission-1",
    humanEventId: "event-1",
    agentKind: "traex",
    sessionId: "session-1",
    requestText: "Please summarize the rollout state.",
    startAt: { laneSequence: 10, itemOrdinal: 0 },
    endBefore: null,
    state: "pending",
    viewVersion: 4,
    rootMessageId: "om_root",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides
  };
}

describe("conversation-segment", () => {
  it("closes the old segment before the next canonical Human position", () => {
    const openSegment = createSegment({ state: "working", endBefore: null });

    const closed = closeConversationSegment(openSegment, { laneSequence: 12, itemOrdinal: 0 }, "2026-10-04T00:01:00.000Z");

    expect(closed).toMatchObject({
      state: "closed",
      endBefore: { laneSequence: 12, itemOrdinal: 0 },
      updatedAt: "2026-10-04T00:01:00.000Z"
    });
  });

  it("does not use event IDs to break canonical position ties", () => {
    expect(compareSegmentPosition({ laneSequence: 4, itemOrdinal: 0 }, { laneSequence: 4, itemOrdinal: 1 })).toBeLessThan(0);
  });

  it("advances a pending segment into working without changing ownership", () => {
    const pending = createSegment({
      state: "pending",
      humanEventId: null,
      startAt: null,
      endBefore: null,
      updatedAt: "2026-10-04T00:00:00.000Z"
    });

    const working = workingConversationSegment(
      pending,
      {
        humanEventId: "event-2",
        startAt: { laneSequence: 11, itemOrdinal: 0 }
      },
      "2026-10-04T00:02:00.000Z"
    );

    expect(working).toMatchObject({
      id: "segment-1",
      producerKey: "producer-1",
      ownerKind: "primary",
      ownerId: "binding-1",
      ownerGeneration: 2,
      submissionId: "submission-1",
      humanEventId: "event-2",
      startAt: { laneSequence: 11, itemOrdinal: 0 },
      endBefore: null,
      state: "working",
      updatedAt: "2026-10-04T00:02:00.000Z"
    });
  });

  it("rejects backward start positions when a segment begins working", () => {
    const pending = createSegment({
      state: "pending",
      humanEventId: null,
      startAt: { laneSequence: 8, itemOrdinal: 1 }
    });

    expect(() => workingConversationSegment(
      pending,
      {
        humanEventId: "event-3",
        startAt: { laneSequence: 8, itemOrdinal: 0 }
      },
      "2026-10-04T00:03:00.000Z"
    )).toThrow(/backward/i);
  });

  it("rejects reopening a closed segment", () => {
    const closed = createSegment({
      state: "closed",
      endBefore: { laneSequence: 12, itemOrdinal: 0 }
    });

    expect(() => workingConversationSegment(
      closed,
      {
        humanEventId: "event-4",
        startAt: { laneSequence: 12, itemOrdinal: 1 }
      },
      "2026-10-04T00:04:00.000Z"
    )).toThrow(/closed/i);
  });

  it("marks a working segment terminal without clearing canonical bounds", () => {
    const working = createSegment({
      state: "working",
      humanEventId: "event-5",
      startAt: { laneSequence: 13, itemOrdinal: 0 },
      endBefore: { laneSequence: 14, itemOrdinal: 0 }
    });

    const completed = terminalConversationSegment(working, "completed", "2026-10-04T00:05:00.000Z");

    expect(completed).toMatchObject({
      state: "completed",
      humanEventId: "event-5",
      startAt: { laneSequence: 13, itemOrdinal: 0 },
      endBefore: { laneSequence: 14, itemOrdinal: 0 },
      updatedAt: "2026-10-04T00:05:00.000Z"
    });
  });

  it("rejects non-terminal target states", () => {
    expect(() => terminalConversationSegment(
      createSegment({ state: "working" }),
      "working",
      "2026-10-04T00:06:00.000Z"
    )).toThrow(/terminal/i);
  });
});
