import { describe, expect, it, vi } from "vitest";
import { DeliveryLatencyTrace } from "../src/domain/delivery-trace.js";

describe("Delivery latency trace", () => {
  it("correlates input to settlement with bounded metric labels and monotonic durations", () => {
    const metrics: unknown[] = [];
    const trace = new DeliveryLatencyTrace({ onMetric: (metric) => { metrics.push(metric); } });

    trace.observe({ stage: "ingress_accepted", monotonicAtMs: 100, correlation: { eventId: "event-1", messageId: "message-1" } });
    trace.observe({ stage: "submission_admitted", monotonicAtMs: 120, correlation: { eventId: "event-1", submissionId: "submission-1" } });
    trace.observe({ stage: "core_projected", monotonicAtMs: 170, correlation: { submissionId: "submission-1", coreEventId: "core-1", segmentId: "segment-1" } });
    trace.observe({ stage: "outbox_committed", monotonicAtMs: 190, correlation: { segmentId: "segment-1", replyId: "reply-1" } });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 230, correlation: { replyId: "reply-1", attemptId: "attempt-1" } });
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 300, correlation: { attemptId: "attempt-1", receiptId: "receipt-1" } });
    trace.observe({ stage: "settled", monotonicAtMs: 320, outcome: "succeeded", correlation: { attemptId: "attempt-1", receiptId: "receipt-1" } });

    expect(trace.snapshot()).toMatchObject({
      traces: 1,
      completed: 1,
      lastCompletedDurationMs: 220,
      stageDurationsMs: {
        ingressToSubmission: 20,
        submissionToCore: 50,
        coreToOutbox: 20,
        outboxToRing: 40,
        ringToGatewayAck: 70,
        gatewayAckToSettlement: 20
      }
    });
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "input_to_settlement", outcome: "succeeded", durationMs: 220, correlation: expect.objectContaining({ segmentId: "segment-1" }) }),
      expect.objectContaining({ stage: "core_to_visible_ack", outcome: "succeeded", durationMs: 130, correlation: expect.objectContaining({ segmentId: "segment-1" }) })
    ]));
    for (const metric of metrics as Array<Record<string, unknown>>) {
      expect(Object.keys(metric).sort()).toEqual(["correlation", "durationMs", "outcome", "stage"]);
      expect(Object.values(metric.correlation as Record<string, unknown>).every((value) => typeof value === "string" && value.length <= 256)).toBe(true);
    }
  });

  it("deduplicates repeated stages, tolerates missing optional stages, and never retains payload", () => {
    const onMetric = vi.fn();
    const trace = new DeliveryLatencyTrace({ onMetric });
    const canary = "CANARY_PRIVATE_MESSAGE_CARD_JSON_TOKEN";

    trace.observe({ stage: "ingress_accepted", monotonicAtMs: 500, correlation: { eventId: "event-2", messageId: "message-2" } });
    trace.observe({ stage: "ingress_accepted", monotonicAtMs: 501, correlation: { eventId: "event-2", messageId: "message-2" } });
    trace.observe({ stage: "submission_admitted", monotonicAtMs: 520, correlation: { eventId: "event-2", submissionId: "submission-2" } });
    trace.observe({ stage: "outbox_committed", monotonicAtMs: 560, correlation: { submissionId: "submission-2", replyId: "reply-2" } });
    trace.observe({ stage: "settled", monotonicAtMs: 610, outcome: "failed", correlation: { replyId: "reply-2", attemptId: "attempt-2" } });

    const serialized = JSON.stringify(trace.snapshot());
    expect(trace.snapshot()).toMatchObject({ traces: 1, completed: 1, lastCompletedDurationMs: null, firstVisibleCompleted: 0, lastFirstVisibleDurationMs: null });
    expect(onMetric).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "input_to_settlement" }));
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toMatch(/event-2|message-2|submission-2|reply-2|attempt-2/);
  });

  it("attributes multiple card updates independently and ignores stale attempts", () => {
    const metrics: unknown[] = [];
    const trace = new DeliveryLatencyTrace({ onMetric: (metric) => { metrics.push(metric); } });
    trace.observe({ stage: "ingress_accepted", monotonicAtMs: 10, correlation: { eventId: "event", messageId: "message" } });
    trace.observe({ stage: "submission_admitted", monotonicAtMs: 20, correlation: { eventId: "event", submissionId: "submission" } });
    trace.observe({ stage: "core_projected", monotonicAtMs: 30, correlation: { submissionId: "submission", coreEventId: "core", segmentId: "segment" } });

    trace.observe({ stage: "outbox_committed", monotonicAtMs: 40, correlation: { segmentId: "segment", replyId: "reply-a" } });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 50, correlation: { replyId: "reply-a", attemptId: "stale-attempt" } });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 60, correlation: { replyId: "reply-a", attemptId: "current-attempt" } });
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 70, correlation: { attemptId: "stale-attempt", receiptId: "stale-receipt" } });
    trace.observe({ stage: "settled", monotonicAtMs: 75, outcome: "succeeded", correlation: { attemptId: "stale-attempt", receiptId: "stale-receipt" } });
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 80, correlation: { attemptId: "current-attempt", receiptId: "receipt-a" } });
    trace.observe({ stage: "settled", monotonicAtMs: 90, outcome: "succeeded", correlation: { attemptId: "current-attempt", receiptId: "receipt-a" } });

    trace.observe({ stage: "outbox_committed", monotonicAtMs: 100, correlation: { segmentId: "segment", replyId: "reply-b" } });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 110, correlation: { replyId: "reply-b", attemptId: "attempt-b" } });
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 120, correlation: { attemptId: "attempt-b", receiptId: "receipt-b" } });
    trace.observe({ stage: "settled", monotonicAtMs: 130, outcome: "succeeded", correlation: { attemptId: "attempt-b", receiptId: "receipt-b" } });

    expect(trace.snapshot()).toMatchObject({ traces: 1, completed: 2, lastCompletedDurationMs: 80, firstVisibleCompleted: 1 });
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "ring_to_gateway_ack", outcome: "succeeded", durationMs: 20 }),
      expect.objectContaining({ stage: "ring_to_gateway_ack", outcome: "succeeded", durationMs: 10 })
    ]));
  });

  it("emits first-visible latency once while keeping later updates path-local", () => {
    const metrics: Array<{ stage:string; durationMs:number }> = [];
    const trace = new DeliveryLatencyTrace({ onMetric: (metric) => { metrics.push(metric); } });
    trace.observe({ stage: "ingress_accepted", monotonicAtMs: 10, correlation: { eventId: "event-first", messageId: "message-first" } });
    trace.observe({ stage: "submission_admitted", monotonicAtMs: 20, correlation: { eventId: "event-first", submissionId: "submission-first" } });
    trace.observe({ stage: "core_projected", monotonicAtMs: 30, correlation: { submissionId: "submission-first", coreEventId: "core-first", segmentId: "segment-first" } });

    for (const [replyId, attemptId, outboxAt, gatewayAt, settledAt] of [
      ["reply-first", "attempt-first", 40, 80, 90],
      ["reply-update", "attempt-update", 100, 120, 130]
    ] as const) {
      trace.observe({ stage: "outbox_committed", monotonicAtMs: outboxAt, correlation: { segmentId: "segment-first", replyId } });
      trace.observe({ stage: "ring_granted", monotonicAtMs: outboxAt + 10, correlation: { replyId, attemptId } });
      trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: gatewayAt, correlation: { attemptId, receiptId: `receipt:${replyId}` } });
      trace.observe({ stage: "settled", monotonicAtMs: settledAt, outcome: "succeeded", correlation: { attemptId, receiptId: `receipt:${replyId}` } });
    }

    const count = (stage: string) => metrics.filter((metric) => metric.stage === stage).length;
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "input_to_first_visible_ack", durationMs: 70 }),
      expect.objectContaining({ stage: "core_to_first_visible_ack", durationMs: 50 })
    ]));
    expect(count("input_to_first_visible_ack")).toBe(1);
    expect(count("core_to_first_visible_ack")).toBe(1);
    expect(count("input_to_settlement")).toBe(1);
    expect(count("core_to_visible_ack")).toBe(1);
    expect(count("ingress_to_submission")).toBe(1);
    expect(count("submission_to_core")).toBe(1);
    expect(count("core_to_outbox")).toBe(1);
    expect(count("outbox_to_ring")).toBe(2);
    expect(count("ring_to_gateway_ack")).toBe(2);
    expect(count("gateway_ack_to_settlement")).toBe(2);
    expect(trace.snapshot()).toMatchObject({
      completed: 2,
      firstVisibleCompleted: 1,
      lastFirstVisibleDurationMs: 70,
      lastCompletedDurationMs: 80
    });
  });

  it("keeps the first Gateway ACK as first-visible when local settlement later fails", () => {
    const metrics: Array<{ stage:string; outcome:string }> = [];
    const trace = new DeliveryLatencyTrace({ onMetric: (metric) => { metrics.push(metric); } });
    trace.observe({ stage: "ingress_accepted", monotonicAtMs: 10, correlation: { eventId: "event-recovery", messageId: "message-recovery" } });
    trace.observe({ stage: "submission_admitted", monotonicAtMs: 20, correlation: { eventId: "event-recovery", submissionId: "submission-recovery" } });
    trace.observe({ stage: "core_projected", monotonicAtMs: 30, correlation: { submissionId: "submission-recovery", coreEventId: "core-recovery", segmentId: "segment-recovery" } });

    trace.observe({ stage: "outbox_committed", monotonicAtMs: 40, correlation: { segmentId: "segment-recovery", replyId: "reply-failed" } });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 50, correlation: { replyId: "reply-failed", attemptId: "attempt-failed" } });
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 60, correlation: { attemptId: "attempt-failed", receiptId: "receipt-failed" } });
    expect(trace.snapshot()).toMatchObject({ completed: 0, firstVisibleCompleted: 1, lastFirstVisibleDurationMs: 50 });
    trace.observe({ stage: "settled", monotonicAtMs: 70, outcome: "failed", correlation: { attemptId: "attempt-failed", receiptId: "receipt-failed" } });
    expect(trace.snapshot()).toMatchObject({ completed: 1, firstVisibleCompleted: 1, lastFirstVisibleDurationMs: 50 });

    trace.observe({ stage: "outbox_committed", monotonicAtMs: 80, correlation: { segmentId: "segment-recovery", replyId: "reply-recovered" } });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 90, correlation: { replyId: "reply-recovered", attemptId: "attempt-recovered" } });
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 100, correlation: { attemptId: "attempt-recovered", receiptId: "receipt-recovered" } });
    trace.observe({ stage: "settled", monotonicAtMs: 110, outcome: "succeeded", correlation: { attemptId: "attempt-recovered", receiptId: "receipt-recovered" } });

    expect(trace.snapshot()).toMatchObject({ completed: 2, firstVisibleCompleted: 1, lastFirstVisibleDurationMs: 50 });
    expect(metrics.filter(({ stage }) => stage === "input_to_first_visible_ack")).toEqual([
      expect.objectContaining({ stage: "input_to_first_visible_ack", outcome: "succeeded" })
    ]);
  });

  it.each(["retry", "yielded"] as const)("records first-visible before a %s settlement outcome", (outcome) => {
    const metrics: Array<{ stage:string }> = [];
    const trace = new DeliveryLatencyTrace({ onMetric: (metric) => { metrics.push(metric); } });
    trace.observe({ stage: "ingress_accepted", monotonicAtMs: 10, correlation: { eventId: `event-${outcome}` } });
    trace.observe({ stage: "core_projected", monotonicAtMs: 20, correlation: { eventId: `event-${outcome}`, segmentId: `segment-${outcome}` } });
    trace.observe({ stage: "outbox_committed", monotonicAtMs: 30, correlation: { segmentId: `segment-${outcome}`, replyId: `reply-${outcome}` } });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 40, correlation: { replyId: `reply-${outcome}`, attemptId: `attempt-${outcome}` } });
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 50, correlation: { attemptId: `attempt-${outcome}`, receiptId: `receipt-${outcome}` } });
    trace.observe({ stage: "settled", monotonicAtMs: 60, outcome, correlation: { attemptId: `attempt-${outcome}`, receiptId: `receipt-${outcome}` } });

    expect(trace.snapshot()).toMatchObject({ completed: 0, firstVisibleCompleted: 1, lastFirstVisibleDurationMs: 40 });
    expect(metrics.filter(({ stage }) => stage === "input_to_first_visible_ack")).toHaveLength(1);
  });

  it("retains bounded first-visible ownership after root eviction and reattachment", () => {
    const metrics: Array<{ stage:string }> = [];
    const trace = new DeliveryLatencyTrace({ maxTraces: 1, onMetric: (metric) => { metrics.push(metric); } });
    const complete = (key: string, base: number) => {
      trace.observe({ stage: "ingress_accepted", monotonicAtMs: base, correlation: { eventId: `event-${key}` } });
      trace.observe({ stage: "core_projected", monotonicAtMs: base + 1, correlation: { eventId: `event-${key}`, segmentId: `segment-${key}` } });
      trace.observe({ stage: "outbox_committed", monotonicAtMs: base + 2, correlation: { segmentId: `segment-${key}`, replyId: `reply-${key}` } });
      trace.observe({ stage: "ring_granted", monotonicAtMs: base + 3, correlation: { replyId: `reply-${key}`, attemptId: `attempt-${key}` } });
      trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: base + 4, correlation: { attemptId: `attempt-${key}` } });
      trace.observe({ stage: "settled", monotonicAtMs: base + 5, outcome: "succeeded", correlation: { attemptId: `attempt-${key}` } });
    };
    complete("a", 10);
    complete("b", 30);
    trace.observe({ stage: "outbox_committed", monotonicAtMs: 50, correlation: { segmentId: "segment-a", replyId: "reply-a-late" } });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 51, correlation: { replyId: "reply-a-late", attemptId: "attempt-a-late" } });
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 52, correlation: { attemptId: "attempt-a-late" } });
    trace.observe({ stage: "settled", monotonicAtMs: 53, outcome: "succeeded", correlation: { attemptId: "attempt-a-late" } });

    expect(trace.snapshot()).toMatchObject({ traces: 1, firstVisibleCompleted: 2 });
    expect(metrics.filter(({ stage }) => stage === "input_to_first_visible_ack")).toHaveLength(2);
  });

  it("expires the oldest first-visible tombstone at the trace bound", () => {
    const metrics: Array<{ stage:string }> = [];
    const trace = new DeliveryLatencyTrace({ maxTraces: 1, onMetric: (metric) => { metrics.push(metric); } });
    const acknowledge = (key: string, base: number) => {
      trace.observe({ stage: "ingress_accepted", monotonicAtMs: base, correlation: { eventId: `event-${key}` } });
      trace.observe({ stage: "core_projected", monotonicAtMs: base + 1, correlation: { eventId: `event-${key}`, segmentId: `segment-${key}` } });
      trace.observe({ stage: "outbox_committed", monotonicAtMs: base + 2, correlation: { segmentId: `segment-${key}`, replyId: `reply-${key}` } });
      trace.observe({ stage: "ring_granted", monotonicAtMs: base + 3, correlation: { replyId: `reply-${key}`, attemptId: `attempt-${key}` } });
      trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: base + 4, correlation: { attemptId: `attempt-${key}` } });
    };
    acknowledge("a", 10);
    acknowledge("b", 20);
    acknowledge("c", 30);
    trace.observe({ stage: "outbox_committed", monotonicAtMs: 50, correlation: { segmentId: "segment-a", replyId: "reply-a-returned" } });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 51, correlation: { replyId: "reply-a-returned", attemptId: "attempt-a-returned" } });
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 52, correlation: { attemptId: "attempt-a-returned" } });

    expect(trace.snapshot().firstVisibleCompleted).toBe(4);
    expect(metrics.filter(({ stage }) => stage === "input_to_first_visible_ack")).toHaveLength(3);
  });

  it("refuses a late merge after two roots have emitted first-visible metrics", () => {
    const metrics: Array<{ stage:string }> = [];
    const trace = new DeliveryLatencyTrace({ onMetric: (metric) => { metrics.push(metric); } });
    const complete = (key: string, base: number, visibleDelay: number) => {
      trace.observe({ stage: "ingress_accepted", monotonicAtMs: base, correlation: { eventId: `event-${key}` } });
      trace.observe({ stage: "core_projected", monotonicAtMs: base + 1, correlation: { eventId: `event-${key}`, coreEventId: `core-${key}`, segmentId: `segment-${key}` } });
      trace.observe({ stage: "outbox_committed", monotonicAtMs: base + 2, correlation: { segmentId: `segment-${key}`, replyId: `reply-${key}` } });
      trace.observe({ stage: "ring_granted", monotonicAtMs: base + 3, correlation: { replyId: `reply-${key}`, attemptId: `attempt-${key}` } });
      trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: base + visibleDelay, correlation: { attemptId: `attempt-${key}` } });
      trace.observe({ stage: "settled", monotonicAtMs: base + visibleDelay + 1, outcome: "succeeded", correlation: { attemptId: `attempt-${key}` } });
    };
    complete("a", 10, 10);
    complete("b", 30, 70);
    expect(trace.snapshot()).toMatchObject({ traces: 2, firstVisibleCompleted: 2, lastFirstVisibleDurationMs: 70 });

    trace.observe({
      stage: "core_projected", monotonicAtMs: 50,
      correlation: { coreEventId: "core-a", segmentId: "segment-b" }
    });

    expect(trace.snapshot()).toMatchObject({
      traces: 2,
      firstVisibleCompleted: 2,
      lastFirstVisibleDurationMs: 70,
      metrics: {
        input_to_first_visible_ack: { succeeded: 2 },
        core_to_first_visible_ack: { succeeded: 2 }
      },
      diagnostics: { pathRefusals: 1 }
    });
    expect(metrics.filter(({ stage }) => stage === "input_to_first_visible_ack")).toHaveLength(2);
  });

  it("attributes each reply path to the latest Core projection without cumulative turn age", () => {
    const metrics: Array<{ stage:string; durationMs:number; correlation:Record<string,string> }> = [];
    const trace = new DeliveryLatencyTrace({ onMetric: (metric) => { metrics.push(metric as typeof metrics[number]); } });
    trace.observe({ stage: "core_projected", monotonicAtMs: 100, correlation: { coreEventId: "core-1", segmentId: "segment-1" } });
    trace.observe({ stage: "outbox_committed", monotonicAtMs: 110, correlation: { segmentId: "segment-1", replyId: "reply-1" } });
    trace.observe({ stage: "core_projected", monotonicAtMs: 1_000, correlation: { coreEventId: "core-2", segmentId: "segment-1" } });
    trace.observe({ stage: "outbox_committed", monotonicAtMs: 1_015, correlation: { segmentId: "segment-1", replyId: "reply-2" } });
    for (const [replyId, attemptId, start] of [["reply-1", "attempt-1", 120], ["reply-2", "attempt-2", 1_020]] as const) {
      trace.observe({ stage: "ring_granted", monotonicAtMs: start, correlation: { replyId, attemptId } });
      trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: start + 5, correlation: { replyId, attemptId } });
      trace.observe({ stage: "settled", monotonicAtMs: start + 6, outcome: "succeeded", correlation: { replyId, attemptId } });
    }

    const coreMetrics = metrics.filter(({ stage }) => stage === "core_to_outbox");
    expect(coreMetrics.map(({ durationMs }) => durationMs)).toEqual([10]);
    expect(coreMetrics.map(({ correlation }) => correlation.coreEventId)).toEqual(["core-1"]);
    expect(metrics.filter(({ stage }) => stage === "outbox_to_ring").map(({ durationMs }) => durationMs)).toEqual([10, 5]);
  });

  it("bounds output paths and correlation bindings independently per input", () => {
    const trace = new DeliveryLatencyTrace({ maxPathsPerRoot: 2 });
    trace.observe({ stage: "ingress_accepted", monotonicAtMs: 10, correlation: { eventId: "event-bounded", messageId: "message-bounded" } });
    trace.observe({ stage: "submission_admitted", monotonicAtMs: 20, correlation: { eventId: "event-bounded", submissionId: "submission-bounded" } });
    trace.observe({ stage: "core_projected", monotonicAtMs: 30, correlation: { submissionId: "submission-bounded", coreEventId: "core-bounded", segmentId: "segment-bounded" } });

    for (let index = 0; index < 5; index += 1) {
      const replyId = `reply-private-${index}`;
      const attemptId = `attempt-private-${index}`;
      const receiptId = `receipt-private-${index}`;
      trace.observe({ stage: "outbox_committed", monotonicAtMs: 40 + index * 10, correlation: { segmentId: "segment-bounded", replyId } });
      trace.observe({ stage: "ring_granted", monotonicAtMs: 41 + index * 10, correlation: { replyId, attemptId } });
      trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 42 + index * 10, correlation: { attemptId, receiptId } });
      trace.observe({ stage: "settled", monotonicAtMs: 43 + index * 10, outcome: "succeeded", correlation: { attemptId, receiptId } });
    }

    const snapshot = trace.snapshot();
    expect(snapshot).toMatchObject({
      traces: 1,
      completed: 5,
      activePaths: 2,
      activeBindings: 11,
      diagnostics: { pathEvictions: 3, pathRefusals: 0 }
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/bounded|private/);
  });

  it("refuses an additional path when every bounded path is still active", () => {
    const trace = new DeliveryLatencyTrace({ maxPathsPerRoot: 2 });
    trace.observe({ stage: "core_projected", monotonicAtMs: 10, correlation: { coreEventId: "core-active", segmentId: "segment-active" } });
    for (let index = 0; index < 10; index += 1) {
      trace.observe({
        stage: "outbox_committed", monotonicAtMs: 20 + index,
        correlation: { segmentId: "segment-active", replyId: `reply-active-or-refused-${index}` }
      });
    }

    expect(trace.snapshot()).toMatchObject({
      traces: 1,
      activePaths: 2,
      activeBindings: 6,
      diagnostics: { pathEvictions: 0, pathRefusals: 8 }
    });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 50, correlation: { replyId: "reply-active-or-refused-9", attemptId: "attempt-refused" } });
    expect(trace.snapshot()).toMatchObject({ traces: 1, activePaths: 2, activeBindings: 6, diagnostics: { pathRefusals: 8 } });
  });

  it("refuses a late root bridge rather than evicting either active path", () => {
    const trace = new DeliveryLatencyTrace({ maxPathsPerRoot: 1 });
    trace.observe({
      stage: "core_projected", monotonicAtMs: 10,
      correlation: { coreEventId: "core-private-a", segmentId: "segment-private-a" }
    });
    trace.observe({
      stage: "outbox_committed", monotonicAtMs: 20,
      correlation: { segmentId: "segment-private-a", replyId: "reply-private-a" }
    });
    trace.observe({
      stage: "core_projected", monotonicAtMs: 30,
      correlation: { coreEventId: "core-private-b", segmentId: "segment-private-b" }
    });
    trace.observe({
      stage: "outbox_committed", monotonicAtMs: 40,
      correlation: { segmentId: "segment-private-b", replyId: "reply-private-b" }
    });

    trace.observe({
      stage: "core_projected", monotonicAtMs: 50,
      correlation: {
        submissionId: "submission-private-refused-bridge",
        coreEventId: "core-private-a",
        segmentId: "segment-private-b"
      }
    });
    expect(trace.snapshot()).toMatchObject({
      traces: 2,
      activePaths: 2,
      activeBindings: 7,
      diagnostics: { pathEvictions: 0, pathRefusals: 1 }
    });

    trace.observe({
      stage: "outbox_committed", monotonicAtMs: 60,
      correlation: { submissionId: "submission-private-refused-bridge", replyId: "reply-private-overflow" }
    });
    trace.observe({
      stage: "ring_granted", monotonicAtMs: 70,
      correlation: { replyId: "reply-private-a", attemptId: "attempt-private-a" }
    });
    trace.observe({
      stage: "ring_granted", monotonicAtMs: 80,
      correlation: { replyId: "reply-private-b", attemptId: "attempt-private-b" }
    });
    trace.observe({
      stage: "gateway_acknowledged", monotonicAtMs: 90,
      correlation: { attemptId: "attempt-private-a", receiptId: "receipt-private-a" }
    });
    trace.observe({
      stage: "settled", monotonicAtMs: 100, outcome: "succeeded",
      correlation: { attemptId: "attempt-private-a", receiptId: "receipt-private-a" }
    });
    trace.observe({
      stage: "gateway_acknowledged", monotonicAtMs: 110,
      correlation: { attemptId: "attempt-private-b", receiptId: "receipt-private-b" }
    });
    trace.observe({
      stage: "settled", monotonicAtMs: 120, outcome: "succeeded",
      correlation: { attemptId: "attempt-private-b", receiptId: "receipt-private-b" }
    });

    const snapshot = trace.snapshot();
    expect(snapshot).toMatchObject({
      traces: 2,
      activePaths: 2,
      activeBindings: 11,
      completed: 2,
      diagnostics: { pathEvictions: 0, pathRefusals: 1 }
    });
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  it("omits negative durations when a wall clock rolls back and never fabricates zero", () => {
    const metrics: unknown[] = [];
    const trace = new DeliveryLatencyTrace({ onMetric: (metric) => { metrics.push(metric); } });
    trace.observe({ stage: "ingress_accepted", monotonicAtMs: 200, correlation: { eventId: "event", messageId: "message" } });
    trace.observe({ stage: "submission_admitted", monotonicAtMs: 190, correlation: { eventId: "event", submissionId: "submission" } });
    trace.observe({ stage: "settled", monotonicAtMs: 180, outcome: "failed", correlation: { submissionId: "submission", replyId: "reply", attemptId: "attempt" } });

    expect(trace.snapshot()).toMatchObject({ traces: 1, completed: 1, lastCompletedDurationMs: null, stageDurationsMs: {} });
    expect(metrics).toEqual([]);
  });

  it("attributes a direct Worker card after restart without inventing ingress stages", () => {
    const metrics: unknown[] = [];
    const trace = new DeliveryLatencyTrace({ onMetric: (metric) => { metrics.push(metric); } });
    trace.observe({ stage: "core_projected", monotonicAtMs: 10, correlation: { coreEventId: "worker-core", segmentId: "worker-turn:reviewer:1" } });
    trace.observe({ stage: "outbox_committed", monotonicAtMs: 30, correlation: { segmentId: "worker-turn:reviewer:1", replyId: "worker-reply" } });
    trace.observe({ stage: "ring_granted", monotonicAtMs: 40, correlation: { replyId: "worker-reply", attemptId: "worker-attempt" } });
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 55, correlation: { attemptId: "worker-attempt", receiptId: "worker-receipt" } });
    trace.observe({ stage: "settled", monotonicAtMs: 60, outcome: "succeeded", correlation: { attemptId: "worker-attempt", receiptId: "worker-receipt" } });

    expect(trace.snapshot()).toMatchObject({ traces: 1, completed: 1, lastCompletedDurationMs: null });
    expect(metrics).toContainEqual(expect.objectContaining({ stage: "core_to_visible_ack", outcome: "succeeded", durationMs: 45 }));
    expect(metrics).not.toEqual(expect.arrayContaining([expect.objectContaining({ stage: "input_to_settlement" })]));
  });
});
