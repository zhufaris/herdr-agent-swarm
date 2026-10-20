import { describe, expect, it } from "vitest";
import { parseHerdrAgentEvent } from "../src/adapters/herdr-events-adapter.js";
import { HerdrEventCursor } from "../src/runtime/herdr-events/event-cursor.js";
import { agentEvent, MemoryCoreEventInbox } from "./helpers/herdr-events.js";

describe("HerdrEventCursor", () => {
  it("persists a batch before observation and gates the next event on acknowledgement", async () => {
    const inbox = new MemoryCoreEventInbox();
    const events = [
      parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", { type: "turn_started" })),
      parseHerdrAgentEvent(agentEvent("source-1:2", "turn-1", "2026-09-30T00:00:01Z", { type: "turn_completed" }))
    ];
    const cursor = new HerdrEventCursor(async () => ({ events, nextCursor: "source-1:2", latestCursor: "source-1:2" }), "start", [], {
      store: inbox,
      laneId: "lane-1",
      sourceId: "source-1",
      agentKind: "traex",
      sessionId: "session-1",
      owner: { kind: "binding", id: "binding-1" }
    });

    await expect(cursor.readObservation()).resolves.toMatchObject({ freshTurnStart: true });
    expect(inbox.pending.get("lane-1")?.map((event) => event.eventId)).toEqual(["source-1:1", "source-1:2"]);
    await expect(cursor.readObservation()).rejects.toThrow("must be acknowledged");
    await cursor.acknowledge("projected");
    await expect(cursor.readObservation()).resolves.toMatchObject({ turnLifecycle: { state: "completed" } });
  });

  it("restores projector state when a durable quarantine attempt remains pending", async () => {
    const inbox = new MemoryCoreEventInbox();
    const events = [parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
      type: "message", message_id: "retry", channel: "final", text: "retry", truncated: false
    }))];
    const cursor = new HerdrEventCursor(async () => ({ events, nextCursor: "source-1:1", latestCursor: "source-1:1" }), "start", [], {
      store: inbox,
      laneId: "lane-1",
      sourceId: "source-1",
      agentKind: "traex",
      sessionId: "session-1",
      owner: { kind: "binding", id: "binding-1" }
    });

    await expect(cursor.readObservation()).resolves.toMatchObject({ timelineDeltas: [expect.objectContaining({ sequence: 1 })] });
    await cursor.acknowledge("quarantined", "projection failed");
    await expect(cursor.readObservation()).resolves.toMatchObject({ timelineDeltas: [expect.objectContaining({ sequence: 1 })] });
  });

  it("rebases a stale reader onto the durable lane checkpoint after ingestion", async () => {
    class ConcurrentInbox extends MemoryCoreEventInbox {
      override ingestBatch(): void {}
    }
    const inbox = new ConcurrentInbox();
    inbox.checkpoints.set("lane-1", {
      sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
      readCursor: "source-1:2", latestCursor: "source-1:2"
    });
    const reads: string[] = [];
    const cursor = new HerdrEventCursor(async (after) => {
      reads.push(after);
      return { events: [], nextCursor: after === "start" ? "source-1:1" : "source-1:3", latestCursor: "source-1:3" };
    }, "start", [], {
      store: inbox,
      laneId: "lane-1",
      sourceId: "source-1",
      agentKind: "traex",
      sessionId: "session-1",
      owner: { kind: "binding", id: "binding-1" }
    });

    await cursor.readObservation();
    await cursor.readObservation();

    expect(reads).toEqual(["start", "source-1:2"]);
  });

  it("immediately rereads an unseen stale tail from the durable checkpoint", async () => {
    class ConcurrentInbox extends MemoryCoreEventInbox {
      private stale = true;
      override ingestBatch(batch: Parameters<MemoryCoreEventInbox["ingestBatch"]>[0]) {
        if (this.stale) {
          this.stale = false;
          return "stale_rebase" as const;
        }
        return super.ingestBatch(batch);
      }
    }
    const inbox = new ConcurrentInbox();
    inbox.checkpoints.set("lane-1", {
      sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
      readCursor: "source-1:2", latestCursor: "source-1:2"
    });
    const stalePrefix = parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
      type: "message", message_id: "old", channel: "final", text: "old", truncated: false
    }));
    const missing = parseHerdrAgentEvent(agentEvent("source-1:3", "turn-1", "2026-09-30T00:00:02Z", {
      type: "message", message_id: "missing", channel: "final", text: "historical gap", truncated: false
    }));
    const reads: string[] = [];
    const cursor = new HerdrEventCursor(async (after) => {
      reads.push(after);
      if (after === "start") {
        return { events: [stalePrefix, missing], nextCursor: "source-1:3", latestCursor: "source-1:3", complete: true };
      }
      return { events: [missing], nextCursor: "source-1:3", latestCursor: "source-1:3", complete: true };
    }, "start", [], {
      store: inbox,
      laneId: "lane-1",
      sourceId: "source-1",
      agentKind: "traex",
      sessionId: "session-1",
      owner: { kind: "binding", id: "binding-1" }
    });

    await expect(cursor.readObservation()).resolves.toMatchObject({
      timelineDeltas: [expect.objectContaining({ markdown: "historical gap" })]
    });
    expect(reads).toEqual(["start", "source-1:2"]);
    expect(inbox.checkpoints.get("lane-1")?.readCursor).toBe("source-1:3");
  });

  it("retries a ring head after an inbox commit failure without rereading or advancing Core", async () => {
    class FailingInbox extends MemoryCoreEventInbox {
      fail = true;
      override ingestBatch(batch: Parameters<MemoryCoreEventInbox["ingestBatch"]>[0]) {
        if (this.fail) throw new Error("commit failed");
        return super.ingestBatch(batch);
      }
    }
    const inbox = new FailingInbox();
    const item = parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", { type: "turn_started" }));
    let reads = 0;
    const cursor = new HerdrEventCursor(async () => {
      reads += 1;
      return { events: [item], nextCursor: "source-1:1", latestCursor: "source-1:1", complete: true };
    }, "start", [], {
      store: inbox, laneId: "lane-1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
      owner: { kind: "binding", id: "binding-1" }
    });

    await expect(cursor.readObservation()).rejects.toThrow("commit failed");
    expect(reads).toBe(1);
    expect(inbox.getCheckpoint("lane-1")).toBeNull();
    inbox.fail = false;
    await expect(cursor.readObservation()).resolves.toMatchObject({ freshTurnStart: true });
    expect(reads).toBe(1);
    expect(inbox.getCheckpoint("lane-1")).toMatchObject({ readCursor: "source-1:1" });
  });
});
