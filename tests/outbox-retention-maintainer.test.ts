import { describe, expect, it } from "vitest";
import { OutboxRetentionMaintainer } from "../src/runtime/outbox-retention-maintainer.js";

describe("outbox retention maintainer", () => {
  it("uses the configured window and logs only non-empty pruning", () => {
    const cutoffs: Array<{ cutoff: string; limit: number }> = [];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({ pruneDeliveredOutboundReplies(cutoff, limit) { cutoffs.push({ cutoff, limit }); return 3; } }, { retentionDays: 14, batchSize: 500 }, { info(value) { infos.push(value); }, error() {} });

    const removed = maintainer.run();

    expect(removed).toBe(3);
    expect(cutoffs[0]!.limit).toBe(500);
    expect(Date.parse(cutoffs[0]!.cutoff)).toBeLessThanOrEqual(Date.now() - 14 * 86_400_000 + 1_000);
    expect(infos).toEqual([expect.objectContaining({ event: "outbox-retention-pruned", removed: 3, limit: 500 })]);
  });
});
