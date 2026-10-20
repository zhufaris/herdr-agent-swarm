import { describe, expect, it } from "vitest";
import { OutboxRetentionMaintainer } from "../src/runtime/outbox-retention-maintainer.js";

describe("outbox retention maintainer", () => {
  it("drives Core discriminator normalization in bounded yielding batches before retention", async () => {
    const calls: string[] = [];
    const pages = [
      { state: "backfilling" as const, processed: 2, remaining: true },
      { state: "complete" as const, processed: 1, remaining: false }
    ];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({
      backfillCoreEventDiscriminators(limit) { calls.push(`core:${limit}`); return pages.shift()!; },
      pruneDeliveredOutboundReplies() { calls.push("outbound"); return 0; },
      pruneAcceptedInboundMessages() { calls.push("inbound"); return 0; },
      pruneTerminalSessionOperations() { calls.push("sessions"); return 0; }
    }, { retentionDays: 14, batchSize: 2, maxBatches: 3 }, { info(value) { infos.push(value); }, error() {} });

    await expect(maintainer.run()).resolves.toBe(0);
    expect(calls).toEqual(["core:2", "core:2", "inbound", "sessions"]);
    expect(infos).toEqual([expect.objectContaining({
      event: "core-event-discriminator-backfill", processed: 3, batches: 2, complete: true
    })]);
  });

  it("compacts delivery intents in bounded yielding batches before pruning", async () => {
    const results = [500, 2];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({
      compactDeliveryIntents(limit) { expect(limit).toBe(500); return results.shift() ?? 0; },
      pruneDeliveredOutboundReplies() { return 0; }, pruneAcceptedInboundMessages() { return 0; }, pruneTerminalSessionOperations() { return 0; }
    }, { retentionDays: 14, batchSize: 500 }, { info(value) { infos.push(value); }, error() {} });

    expect(await maintainer.run()).toBe(0);
    expect(infos).toEqual([expect.objectContaining({ deliveryIntentsCompacted: 502, compactionBatches: 2 })]);
  });

  it("uses the configured window and logs only non-empty pruning", async () => {
    const cutoffs: Array<{ cutoff: string; limit: number }> = [];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({ pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); }, pruneAcceptedInboundMessages(cutoff, limit) { cutoffs.push({ cutoff, limit }); return 2; }, pruneTerminalSessionOperations() { return 1; } }, { retentionDays: 14, batchSize: 500 }, { info(value) { infos.push(value); }, error() {} });

    const removed = await maintainer.run();

    expect(removed).toBe(3);
    expect(cutoffs[0]!.limit).toBe(500);
    expect(Date.parse(cutoffs[0]!.cutoff)).toBeLessThanOrEqual(Date.now() - 14 * 86_400_000 + 1_000);
    expect(infos).toEqual([expect.objectContaining({ event: "durable-history-pruned", removed: 3, inboundRemoved: 2, sessionOperationRemoved: 1, limit: 500 })]);
  });

  it("prunes compensated projection gaps in the same bounded retention cycle", async () => {
    const calls: string[] = [];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({
      pruneCompensatedProjectionGaps(_cutoff, limit) { calls.push(`gaps:${limit}`); return 2; },
      pruneDeliveredOutboundReplies() { calls.push("outbound"); return 0; },
      pruneAcceptedInboundMessages() { calls.push("inbound"); return 0; },
      pruneTerminalSessionOperations() { calls.push("sessions"); return 0; }
    }, { retentionDays: 14, batchSize: 500 }, { info(value) { infos.push(value); }, error() {} });

    await expect(maintainer.run()).resolves.toBe(2);
    expect(calls).toEqual(["gaps:500", "inbound", "sessions"]);
    expect(infos).toEqual([expect.objectContaining({ projectionGapsRemoved: 2, projectionGapBatches: 1, removed: 2 })]);
  });

  it("classifies historical delivery debt in bounded batches before pruning evidence", async () => {
    const calls: string[] = [];
    const results = [
      { settledProjectionGaps: 1, releasedQuarantines: 0, classifiedDeliveryRecoveries: 2, classifiedProjectionGaps: 1 },
      { settledProjectionGaps: 0, releasedQuarantines: 0, classifiedDeliveryRecoveries: 0, classifiedProjectionGaps: 0 }
    ];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({
      classifyHistoricalDeliveryDebt(_cutoff, limit) { calls.push(`debt:${limit}`); return results.shift()!; },
      pruneDeliveredOutboundReplies() { calls.push("outbound"); return 0; },
      pruneAcceptedInboundMessages() { calls.push("inbound"); return 0; },
      pruneTerminalSessionOperations() { calls.push("sessions"); return 0; }
    }, { retentionDays: 14, batchSize: 3 }, { info(value) { infos.push(value); }, error() {} });

    await expect(maintainer.run()).resolves.toBe(1);
    expect(calls).toEqual(["debt:3", "debt:3", "inbound", "sessions"]);
    expect(infos).toEqual([expect.objectContaining({
      event: "durable-history-pruned", deliveryDebtSettled: 1,
      deliveryRecoveriesClassified: 2, projectionGapsClassified: 1, deliveryDebtBatches: 2
    })]);
  });

  it("catches up in bounded batches and yields between full batches", async () => {
    const limits: number[] = [];
    const results = [500, 500, 100];
    const infos: object[] = [];
    const inboundResults = [500, 500];
    const sessionResults = [500, 100];
    const maintainer = new OutboxRetentionMaintainer({ pruneDeliveredOutboundReplies(_cutoff, limit) { limits.push(limit); return results.shift() ?? 0; }, pruneAcceptedInboundMessages(_cutoff, limit) { limits.push(limit); return inboundResults.shift() ?? 0; }, pruneTerminalSessionOperations(_cutoff, limit) { limits.push(limit); return sessionResults.shift() ?? 0; } }, { retentionDays: 14, batchSize: 500, maxBatches: 2 }, { info(value) { infos.push(value); }, error() {} });

    await expect(maintainer.run()).resolves.toBe(1_600);

    expect(limits).toEqual([500, 500, 500, 500]);
    expect(infos).toEqual([expect.objectContaining({ event: "durable-history-pruned", removed: 1_600, inboundRemoved: 1_000, sessionOperationRemoved: 600, maxBatches: 2 })]);
  });

  it("waits for the active prune before stop settles", async () => {
    let releaseYield!: () => void;
    const blockedYield = new Promise<void>((resolve) => { releaseYield = resolve; });
    let enteredYield!: () => void;
    const yieldEntered = new Promise<void>((resolve) => { enteredYield = resolve; });
    const maintainer = new OutboxRetentionMaintainer({
      compactPage(input) {
        return { source: input.kind, scanned: 1, compacted: 1, alreadyCompacted: 0, refusals: {}, cursor: {}, cycleComplete: false };
      },
      pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); },
      pruneAcceptedInboundMessages() { return 0; },
      pruneTerminalSessionOperations() { return 0; }
    }, {
      retentionDays: 14, batchSize: 500, payloadCompactionEnabled: true, monotonicNow: () => 0,
      yieldNow: async () => { enteredYield(); await blockedYield; }
    }, { info() {}, error() {} });

    const running = maintainer.run();
    await yieldEntered;
    const stopped = maintainer.stop();
    let stopSettled = false;
    void stopped.then(() => { stopSettled = true; });
    await Promise.resolve();

    expect(stopped).toBeInstanceOf(Promise);
    expect(stopSettled).toBe(false);
    releaseYield();
    await expect(stopped).resolves.toBeUndefined();
    await expect(running).resolves.toBe(0);
  });

  it("does not begin another retention kind after stop is requested", async () => {
    const calls: string[] = [];
    let maintainer!: OutboxRetentionMaintainer;
    maintainer = new OutboxRetentionMaintainer({
      pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); },
      pruneAcceptedInboundMessages() { calls.push("inbound"); void maintainer.stop(); return 500; },
      pruneTerminalSessionOperations() { calls.push("session"); return 0; }
    }, { retentionDays: 14, batchSize: 500 }, { info() {}, error() {} });

    await expect(maintainer.run()).resolves.toBe(500);

    expect(calls).toEqual(["inbound"]);
  });

  it("round-robins all payload sources, yields between pages, and never invokes legacy outbound deletion", async () => {
    const calls: string[] = [];
    let yields = 0;
    const maintainer = new OutboxRetentionMaintainer({
      compactPage(input) {
        calls.push(input.kind);
        return { source: input.kind, scanned: 1, compacted: 1, alreadyCompacted: 0, refusals: {}, cursor: {}, cycleComplete: true };
      },
      pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); },
      pruneAcceptedInboundMessages() { return 0; }, pruneTerminalSessionOperations() { return 0; }
    }, { retentionDays: 14, batchSize: 2, payloadCompactionEnabled: true, timeBudgetMs: 1_000, monotonicNow: () => 0, yieldNow: async () => { yields += 1; } }, { info() {}, error() {} });

    await expect(maintainer.run()).resolves.toBe(0);
    expect(calls).toEqual(["answer_timeline_item", "conversation_segment_item", "delivery"]);
    expect(yields).toBe(2);
  });

  it("stops payload compaction at the monotonic time budget before starting another page", async () => {
    const calls: string[] = [];
    const ticks = [0, 0, 10];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({
      compactPage(input) {
        calls.push(input.kind);
        return { source: input.kind, scanned: 1, compacted: 1, alreadyCompacted: 0, refusals: {}, cursor: {}, cycleComplete: false };
      },
      pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); },
      pruneAcceptedInboundMessages() { return 0; }, pruneTerminalSessionOperations() { return 0; }
    }, {
      retentionDays: 14, batchSize: 1, payloadCompactionEnabled: true, timeBudgetMs: 10,
      monotonicNow: () => ticks.shift() ?? 10, yieldNow: async () => {}
    }, { info(value) { infos.push(value); }, error() {} });

    await expect(maintainer.run()).resolves.toBe(0);
    expect(calls).toEqual(["answer_timeline_item"]);
    expect(infos).toEqual([expect.objectContaining({
      payloadsCompacted: 1, payloadCompactionPages: 1, payloadCompactionDeadlineExhausted: true
    })]);
  });

  it("keeps payload compaction disabled until the rollout gate enables it", async () => {
    let calls = 0;
    const maintainer = new OutboxRetentionMaintainer({
      compactPage() { calls += 1; throw new Error("disabled compaction must not run"); },
      pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); },
      pruneAcceptedInboundMessages() { return 0; }, pruneTerminalSessionOperations() { return 0; }
    }, { retentionDays: 14, batchSize: 500 }, { info() {}, error() {} });

    await expect(maintainer.run()).resolves.toBe(0);
    expect(calls).toBe(0);
  });

  it("keeps Core-event retention off independently from generic payload compaction", async () => {
    let coreCalls = 0;
    const maintainer = new OutboxRetentionMaintainer({
      auditPage() { coreCalls += 1; throw new Error("Core audit must stay off"); },
      compactPage(input) {
        if (input.kind === "core_event") coreCalls += 1;
        return { source: input.kind, scanned: 1, compacted: 0, alreadyCompacted: 0, refusals: {}, cursor: {}, cycleComplete: true };
      },
      pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); },
      pruneAcceptedInboundMessages() { return 0; }, pruneTerminalSessionOperations() { return 0; }
    }, {
      retentionDays: 14, batchSize: 64, payloadCompactionEnabled: true,
      coreEventMode: "off", coreEventRetentionMs: 24 * 60 * 60 * 1_000,
      timeBudgetMs: 1_000, monotonicNow: () => 0, yieldNow: async () => {}
    }, { info() {}, error() {} });

    await expect(maintainer.run()).resolves.toBe(0);
    expect(coreCalls).toBe(0);
  });

  it("audits Core-event retention independently without clearing payloads", async () => {
    const calls: object[] = [];
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({
      auditPage(input) {
        calls.push(input);
        return {
          source: "core_event", scanned: 3, eligible: 2, alreadyVerified: 1, eligibleBytes: 512,
          refusals: { human_input_retained: 1 }, cursor: { eventId: "secret-id" }, cycleComplete: true
        };
      },
      compactPage() { throw new Error("audit mode must not compact"); },
      pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); },
      pruneAcceptedInboundMessages() { return 0; }, pruneTerminalSessionOperations() { return 0; }
    }, {
      retentionDays: 14, batchSize: 64, coreEventMode: "audit", coreEventRetentionMs: 86_400_000,
      timeBudgetMs: 1_000, monotonicNow: () => 0, yieldNow: async () => {}
    }, { info(value) { infos.push(value); }, error() {} });

    await expect(maintainer.run()).resolves.toBe(0);
    expect(calls).toEqual([{ kind: "core_event", evaluatedAt: expect.any(String), retentionWindowMs: 86_400_000, limit: 64 }]);
    expect(infos).toContainEqual(expect.objectContaining({
      event: "core-event-retention-maintenance", mode: "audit", pages: 1, scanned: 3,
      eligible: 2, alreadyVerified: 1, eligibleBytes: 512, refusals: { human_input_retained: 1 }
    }));
    expect(JSON.stringify(infos)).not.toContain("secret-id");
  });

  it("compacts Core events only in explicit compact mode and isolates its failure", async () => {
    const compactCalls: object[] = [];
    const errors: object[] = [];
    let fail = false;
    const maintainer = new OutboxRetentionMaintainer({
      auditPage() { throw new Error("compact mode must not audit"); },
      compactPage(input) {
        if (input.kind !== "core_event") throw new Error("generic compaction is disabled");
        compactCalls.push(input);
        if (fail) throw new Error("injected Core retention failure");
        return { source: input.kind, scanned: 2, compacted: 1, alreadyCompacted: 0, refusals: {}, cursor: {}, cycleComplete: true };
      },
      pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); },
      pruneAcceptedInboundMessages() { return 2; }, pruneTerminalSessionOperations() { return 0; }
    }, {
      retentionDays: 14, batchSize: 64, coreEventMode: "compact", coreEventRetentionMs: 86_400_000,
      timeBudgetMs: 1_000, monotonicNow: () => 0, yieldNow: async () => {}
    }, { info() {}, error(value) { errors.push(value); } });

    await expect(maintainer.run()).resolves.toBe(2);
    expect(compactCalls).toEqual([{
      kind: "core_event", evaluatedAt: expect.any(String), retentionWindowMs: 86_400_000, limit: 64
    }]);
    fail = true;
    await expect(maintainer.run()).resolves.toBe(2);
    expect(errors).toContainEqual(expect.objectContaining({ event: "core-event-retention-failed", mode: "compact" }));
  });

  it("rotates the first payload source after repeated deadline exhaustion and clamps the compaction page", async () => {
    const calls: Array<{ source: string; limit: number }> = [];
    let tick = 0;
    const maintainer = new OutboxRetentionMaintainer({
      compactPage(input) {
        calls.push({ source: input.kind, limit: input.limit });
        return { source: input.kind, scanned: 1, compacted: 1, alreadyCompacted: 0, refusals: {}, cursor: {}, cycleComplete: false };
      },
      pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); },
      pruneAcceptedInboundMessages() { return 0; }, pruneTerminalSessionOperations() { return 0; }
    }, {
      retentionDays: 14, batchSize: 10_000, payloadCompactionEnabled: true, timeBudgetMs: 10,
      monotonicNow: () => tick++ % 3 === 2 ? 10 : 0, yieldNow: async () => {}
    }, { info() {}, error() {} });

    for (let run = 0; run < 4; run += 1) await maintainer.run();
    expect(calls).toEqual([
      { source: "answer_timeline_item", limit: 64 },
      { source: "conversation_segment_item", limit: 64 },
      { source: "delivery", limit: 64 },
      { source: "answer_timeline_item", limit: 64 }
    ]);
  });

  it("logs refusal-only payload maintenance cycles without exposing payloads", async () => {
    const infos: object[] = [];
    const maintainer = new OutboxRetentionMaintainer({
      compactPage(input) {
        return { source: input.kind, scanned: 1, compacted: 0, alreadyCompacted: 0,
          refusals: { referenced: 1 }, cursor: { id: `secret-content:${input.kind}` }, cycleComplete: true };
      },
      pruneDeliveredOutboundReplies() { throw new Error("legacy outbound pruning must stay disabled"); },
      pruneAcceptedInboundMessages() { return 0; }, pruneTerminalSessionOperations() { return 0; }
    }, {
      retentionDays: 14, batchSize: 64, payloadCompactionEnabled: true,
      timeBudgetMs: 1_000, monotonicNow: () => 0, yieldNow: async () => {}
    }, { info(value) { infos.push(value); }, error() {} });

    await expect(maintainer.run()).resolves.toBe(0);
    expect(infos).toEqual([expect.objectContaining({
      event: "retention-payload-maintenance", payloadsCompacted: 0,
      payloadCompactionPages: 3, payloadCompactionRefusals: { referenced: 3 }
    })]);
    expect(JSON.stringify(infos)).not.toContain("secret-content");
  });
});
