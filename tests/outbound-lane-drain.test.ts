import { describe, expect, it, vi } from "vitest";
import { OutboundLaneDrain } from "../src/events/outbound-lane-drain.js";

describe("OutboundLaneDrain", () => {
  it("delivers independent lane heads concurrently and blocks a failed lane for the scan", async () => {
    const replies = [
      { id: "a1", laneKey: "lane-a", kind: "card_update" },
      { id: "b1", laneKey: "lane-b", kind: "card_update" },
      { id: "a2", laneKey: "lane-a", kind: "card_update" }
    ];
    const selected = new Set<string>();
    const listOutboundLaneHeads = vi.fn((_limit: number, _dueAt: string | null, excluded: readonly string[] = [], workClass?: string) => {
      if (workClass === "history") return [];
      const lanes = new Set<string>();
      return replies.filter((reply) => !selected.has(reply.id) && !excluded.includes(reply.laneKey) && !lanes.has(reply.laneKey))
        .slice(0, 2).map((reply) => { selected.add(reply.id); lanes.add(reply.laneKey); return reply; });
    });
    let active = 0;
    let maximumActive = 0;
    const deliver = vi.fn(async (reply: { id: string }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return { outcome: reply.id === "a1" ? "failed" as const : "delivered" as const, externalDurationMs: 0, checkpointDurationMs: 0 };
    });
    const drain = new OutboundLaneDrain({ store: { listOutboundLaneHeads }, delivery: { deliver }, logger: { debug: vi.fn() } } as never);

    const result = await drain.drain(false, { isStopping: () => false, track: (work) => work });

    expect(maximumActive).toBe(2);
    expect(deliver.mock.calls.map(([reply]) => reply.id)).toEqual(["a1", "b1"]);
    expect(result).toMatchObject({ outcome: "failed", attempted: 2, delivered: 1, failed: 1 });
  });
});
