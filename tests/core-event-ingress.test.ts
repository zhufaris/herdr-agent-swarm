import { describe, expect, it } from "vitest";
import type { CoreEventInboxBatch } from "../src/domain/core-event-inbox.js";
import type { AgentEvent } from "../src/domain/herdr-events.js";
import { CoreEventIngress } from "../src/runtime/herdr-events/core-event-ingress.js";
import { MemoryCoreEventInbox } from "./helpers/herdr-events.js";

function event(sequence: number): AgentEvent {
  return {
    schemaVersion: 1, eventId: `stream-1:${sequence}`, cursor: `cursor-${sequence}`, sourceId: "stream-1",
    agentKind: "traex", sessionId: "session-1", turnId: "turn-1",
    occurredAt: `2026-10-02T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    payload: { type: "message", messageId: `message-${sequence}`, channel: "assistant", text: `answer-${sequence}`, truncated: false }
  };
}

function batch(afterCursor: string, events: CoreEventEnvelope[]): Omit<CoreEventInboxBatch, "laneId" | "sourceId" | "agentKind" | "sessionId" | "ingestedAt"> {
  return {
    afterCursor,
    nextCursor: events.at(-1)?.cursor ?? afterCursor,
    latestCursor: events.at(-1)?.cursor ?? afterCursor,
    events
  };
}

describe("CoreEventIngress", () => {
  it("applies bounded backpressure without overwriting queued events", () => {
    const inbox = new MemoryCoreEventInbox();
    const ingress = new CoreEventIngress({
      streamId: "stream-1", laneId: "lane-1", sourceId: "stream-1", agentKind: "traex", sessionId: "session-1", store: inbox
    }, 3);

    expect(ingress.enqueue({ streamId: "stream-1", ...batch("start", [event(1), event(2)]) })).toBe("accepted");
    expect(ingress.enqueue({ streamId: "stream-1", ...batch("cursor-2", [event(3)]) })).toBe("accepted");
    expect(ingress.enqueue({ streamId: "stream-1", ...batch("cursor-3", [event(4)]) })).toBe("full");
    expect(ingress.pendingEventCount).toBe(3);
    expect(inbox.getCheckpoint("lane-1")).toBeNull();

    expect(ingress.drainOne()).toBe("accepted");
    expect(inbox.getCheckpoint("lane-1")).toMatchObject({ readCursor: "cursor-2" });
    expect(inbox.pending.get("lane-1")?.[0]?.payload).toEqual({
      type: "message", message_id: "message-1", channel: "assistant", text: "answer-1", truncated: false
    });
    expect(ingress.enqueue({ streamId: "stream-1", ...batch("cursor-3", [event(4)]) })).toBe("accepted");
    expect(ingress.drainAll()).toEqual(["accepted", "accepted"]);
    expect(inbox.loadPending("lane-1").eventIds).toEqual(["stream-1:1", "stream-1:2", "stream-1:3", "stream-1:4"]);
  });

  it("retains the head and durable cursor when inbox commit fails, then retries idempotently", () => {
    class FailingInbox extends MemoryCoreEventInbox {
      fail = true;
      override ingestBatch(input: CoreEventInboxBatch) {
        if (this.fail) throw new Error("simulated commit failure");
        return super.ingestBatch(input);
      }
    }
    const inbox = new FailingInbox();
    const ingress = new CoreEventIngress({
      streamId: "stream-1", laneId: "lane-1", sourceId: "stream-1", agentKind: "traex", sessionId: "session-1", store: inbox
    });
    ingress.enqueue({ streamId: "stream-1", ...batch("start", [event(1)]) });

    expect(() => ingress.drainOne()).toThrow("simulated commit failure");
    expect(ingress.pendingEventCount).toBe(1);
    expect(inbox.getCheckpoint("lane-1")).toBeNull();
    inbox.fail = false;
    expect(ingress.drainOne()).toBe("accepted");
    expect(inbox.getCheckpoint("lane-1")).toMatchObject({ readCursor: "cursor-1" });
  });

  it("fences one ordered producer to its stream epoch and recovers lost volatile work from the durable cursor", () => {
    const inbox = new MemoryCoreEventInbox();
    const beforeCrash = new CoreEventIngress({
      streamId: "stream-1", laneId: "lane-1", sourceId: "stream-1", agentKind: "traex", sessionId: "session-1", store: inbox
    });
    beforeCrash.enqueue({ streamId: "stream-1", ...batch("start", [event(1)]) });
    expect(() => beforeCrash.enqueue({ streamId: "other-epoch", ...batch("cursor-1", [event(2)]) })).toThrow("stream epoch mismatch");
    expect(inbox.getCheckpoint("lane-1")).toBeNull();

    const afterCrash = new CoreEventIngress({
      streamId: "stream-1", laneId: "lane-1", sourceId: "stream-1", agentKind: "traex", sessionId: "session-1", store: inbox
    });
    expect(afterCrash.resumeCursor).toBe("start");
    afterCrash.enqueue({ streamId: "stream-1", ...batch(afterCrash.resumeCursor, [event(1)]) });
    expect(afterCrash.drainOne()).toBe("accepted");
    expect(inbox.getCheckpoint("lane-1")).toMatchObject({ readCursor: "cursor-1" });
  });
});
