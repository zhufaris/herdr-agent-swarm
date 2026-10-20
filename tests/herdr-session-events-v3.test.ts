import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  HerdrEventsAdapter,
  normalizeSessionEventMultiplexAck,
  normalizeSessionEventMultiplexFrame
} from "../src/adapters/herdr-events-adapter.js";
import type { CoreSessionEventMultiplexFrame } from "../src/domain/herdr-events.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/herdr-session-events-v3.json", import.meta.url), "utf8")) as {
  capability: object;
  ack: object;
  batchFrame: object;
  gapFrames: object[];
};

describe("Herdr session event multiplex v3 consumer contract", () => {
  it("gates multiplex and global status capabilities independently", async () => {
    const request = vi.fn(async () => fixture.capability);
    const adapter = new HerdrEventsAdapter({ run: vi.fn() }, "herdr", { request });

    await expect(adapter.supportsSessionEventMultiplex()).resolves.toBe(true);
    await expect(adapter.supportsPaneAgentStatusAll()).resolves.toBe(false);

    const legacy = new HerdrEventsAdapter({ run: vi.fn() }, "herdr", {
      request: vi.fn(async () => ({
        type: "pong",
        capabilities: { session_event_stream_v1: true }
      }))
    });
    await expect(legacy.supportsSessionEventMultiplex()).resolves.toBe(false);
    await expect(legacy.supportsPaneAgentStatusAll()).resolves.toBe(false);
  });

  it("normalizes the frozen acknowledgement, batch, and typed gaps", () => {
    expect(normalizeSessionEventMultiplexAck(fixture.ack)).toEqual({ targetCount: 1 });

    const batch: CoreSessionEventMultiplexFrame = normalizeSessionEventMultiplexFrame(fixture.batchFrame);
    expect(batch).toMatchObject({
      outcome: "batch",
      batch: {
        ringId: "session-ring-v2:ring-1",
        epoch: "epoch-1",
        nextCursor: "session-ring-v2:ring-1:epoch-1:10"
      }
    });
    expect(batch.outcome === "batch" && batch.batch.events).toHaveLength(1);

    expect(fixture.gapFrames.map(normalizeSessionEventMultiplexFrame)).toEqual([
      {
        outcome: "gap",
        gap: {
          ringId: "session-ring-v2:ring-1",
          epoch: "epoch-1",
          code: "cursor_expired",
          resumeCursor: "session-ring-v2:ring-1:epoch-1:4",
          earliestCursor: "session-ring-v2:ring-1:epoch-1:5",
          latestCursor: "session-ring-v2:ring-1:epoch-1:10"
        }
      },
      {
        outcome: "gap",
        gap: {
          ringId: "session-ring-v2:ring-1",
          epoch: "epoch-1",
          code: "epoch_changed",
          currentEpoch: "epoch-2"
        }
      },
      { outcome: "gap", gap: { ringId: "session-ring-v2:ring-1", epoch: "epoch-1", code: "missing" } },
      { outcome: "gap", gap: { ringId: "session-ring-v2:ring-1", epoch: "epoch-1", code: "unavailable" } }
    ]);
  });

  it("rejects unknown or malformed frames instead of inventing progress", () => {
    expect(() => normalizeSessionEventMultiplexAck({ type: "other", target_count: 1 })).toThrow();
    expect(() => normalizeSessionEventMultiplexFrame({ event: "session.events.batch.v3", data: { ring_id: "ring" } })).toThrow();
    expect(() => normalizeSessionEventMultiplexFrame({ event: "session.events.unknown.v3", data: {} })).toThrow();
  });
});
