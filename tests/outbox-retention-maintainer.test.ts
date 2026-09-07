import { describe, expect, it } from "vitest";
import { OutboxRetentionMaintainer } from "../src/runtime/outbox-retention-maintainer.js";

describe("outbox retention maintainer", () => {
  it("uses the configured window and logs only non-empty pruning", async () => {
    const cutoffs: Array<{ cutoff: string; limit: number }> = [];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({ pruneDeliveredOutboundReplies(cutoff, limit) { cutoffs.push({ cutoff, limit }); return 3; }, pruneAcceptedInboundMessages() { return 2; }, pruneTerminalSessionOperations() { return 1; } }, { retentionDays: 14, batchSize: 500 }, { info(value) { infos.push(value); }, error() {} });

    const removed = await maintainer.run();

    expect(removed).toBe(6);
    expect(cutoffs[0]!.limit).toBe(500);
    expect(Date.parse(cutoffs[0]!.cutoff)).toBeLessThanOrEqual(Date.now() - 14 * 86_400_000 + 1_000);
    expect(infos).toEqual([expect.objectContaining({ event: "durable-history-pruned", removed: 6, outboundRemoved: 3, inboundRemoved: 2, sessionOperationRemoved: 1, limit: 500 })]);
  });

  it("catches up in bounded batches and yields between full batches", async () => {
    const limits: number[] = [];
    const results = [500, 500, 100];
    const infos: object[] = [];
    const inboundResults = [500, 500];
    const sessionResults = [500, 100];
    const maintainer = new OutboxRetentionMaintainer({ pruneDeliveredOutboundReplies(_cutoff, limit) { limits.push(limit); return results.shift() ?? 0; }, pruneAcceptedInboundMessages(_cutoff, limit) { limits.push(limit); return inboundResults.shift() ?? 0; }, pruneTerminalSessionOperations(_cutoff, limit) { limits.push(limit); return sessionResults.shift() ?? 0; } }, { retentionDays: 14, batchSize: 500, maxBatches: 2 }, { info(value) { infos.push(value); }, error() {} });

    await expect(maintainer.run()).resolves.toBe(2_600);

    expect(limits).toEqual([500, 500, 500, 500, 500, 500]);
    expect(infos).toEqual([expect.objectContaining({ event: "durable-history-pruned", removed: 2_600, outboundRemoved: 1_000, inboundRemoved: 1_000, sessionOperationRemoved: 600, maxBatches: 2 })]);
  });

  it("waits for the active prune before stop settles", async () => {
    const maintainer = new OutboxRetentionMaintainer({
      pruneDeliveredOutboundReplies() { return 500; },
      pruneAcceptedInboundMessages() { return 0; },
      pruneTerminalSessionOperations() { return 0; }
    }, { retentionDays: 14, batchSize: 500 }, { info() {}, error() {} });

    const running = maintainer.run();
    const stopped = maintainer.stop();

    expect(stopped).toBeInstanceOf(Promise);
    await expect(stopped).resolves.toBeUndefined();
    await expect(running).resolves.toBe(500);
  });

  it("does not begin another retention kind after stop is requested", async () => {
    const calls: string[] = [];
    let maintainer!: OutboxRetentionMaintainer;
    maintainer = new OutboxRetentionMaintainer({
      pruneDeliveredOutboundReplies() { calls.push("outbound"); void maintainer.stop(); return 500; },
      pruneAcceptedInboundMessages() { calls.push("inbound"); return 0; },
      pruneTerminalSessionOperations() { calls.push("session"); return 0; }
    }, { retentionDays: 14, batchSize: 500 }, { info() {}, error() {} });

    await expect(maintainer.run()).resolves.toBe(500);

    expect(calls).toEqual(["outbound"]);
  });
});
