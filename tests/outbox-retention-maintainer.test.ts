import { describe, expect, it } from "vitest";
import { OutboxRetentionMaintainer } from "../src/runtime/outbox-retention-maintainer.js";

describe("outbox retention maintainer", () => {
  it("uses the configured window and logs only non-empty pruning", async () => {
    const cutoffs: Array<{ cutoff: string; limit: number }> = [];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({ pruneDeliveredOutboundReplies(cutoff, limit) { cutoffs.push({ cutoff, limit }); return 3; } }, { retentionDays: 14, batchSize: 500 }, { info(value) { infos.push(value); }, error() {} });

    const removed = await maintainer.run();

    expect(removed).toBe(3);
    expect(cutoffs[0]!.limit).toBe(500);
    expect(Date.parse(cutoffs[0]!.cutoff)).toBeLessThanOrEqual(Date.now() - 14 * 86_400_000 + 1_000);
    expect(infos).toEqual([expect.objectContaining({ event: "outbox-retention-pruned", removed: 3, limit: 500 })]);
  });

  it("catches up in bounded batches and yields between full batches", async () => {
    const limits: number[] = [];
    const results = [500, 500, 100];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({ pruneDeliveredOutboundReplies(_cutoff, limit) { limits.push(limit); return results.shift() ?? 0; } }, { retentionDays: 14, batchSize: 500, maxBatches: 2 }, { info(value) { infos.push(value); }, error() {} });

    await expect(maintainer.run()).resolves.toBe(1_000);

    expect(limits).toEqual([500, 500]);
    expect(infos).toEqual([expect.objectContaining({ event: "outbox-retention-pruned", removed: 1_000, batches: 2, maxBatches: 2 })]);
  });
});
