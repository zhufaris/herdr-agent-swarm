import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { CardUpdateScheduler } from "../src/events/card-update-scheduler.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";

afterEach(() => vi.useRealTimers());

describe("card update scheduler", () => {
  it("does not replace ConversationViewProjector subscriptions when started twice", async () => {
    const onBridgeEvent = vi.fn(() => vi.fn());
    const answerCheckpoint = vi.fn(() => vi.fn());
    const mainCheckpoint = vi.fn(() => vi.fn());
    const projector = new ConversationViewProjector(
      { onBridgeEvent } as never,
      {} as never,
      {} as never,
      { onAnswerCheckpoint: answerCheckpoint, onMainCardCheckpoint: mainCheckpoint } as never,
      pino({ enabled: false }), {} as never,
      { converge: async () => undefined }, { converge: async () => undefined }
    );

    const firstStop = projector.start();
    const secondStop = projector.start();
    expect(secondStop).toBe(firstStop);
    expect(onBridgeEvent).toHaveBeenCalledOnce();
    expect(answerCheckpoint).toHaveBeenCalledOnce();
    expect(mainCheckpoint).toHaveBeenCalledOnce();
    firstStop();
    await projector.stop();
  });

  it("uses a true trailing window for ordinary updates", async () => {
    vi.useFakeTimers();
    const delivered: number[] = [];
    const scheduler = new CardUpdateScheduler(async (_cardKey, version) => { delivered.push(version); }, 250);

    scheduler.schedule("segment:s1", 1);
    await vi.advanceTimersByTimeAsync(200);
    scheduler.schedule("segment:s1", 2);
    await vi.advanceTimersByTimeAsync(249);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(delivered).toEqual([2]);
    await scheduler.stop();
  });

  it("keeps trailing windows independent across card keys", async () => {
    vi.useFakeTimers();
    const delivered: Array<[string, number]> = [];
    const scheduler = new CardUpdateScheduler(async (cardKey, version) => { delivered.push([cardKey, version]); }, 250);

    scheduler.schedule("segment:first", 1);
    scheduler.schedule("segment:second", 1);
    await vi.advanceTimersByTimeAsync(200);
    scheduler.schedule("segment:first", 2);
    await vi.advanceTimersByTimeAsync(50);
    expect(delivered).toEqual([["segment:second", 1]]);
    await vi.advanceTimersByTimeAsync(200);
    expect(delivered).toEqual([["segment:second", 1], ["segment:first", 2]]);
    await scheduler.stop();
  });

  it("schedules Conversation Segments and legacy Answer cards through one keyed scheduler", async () => {
    vi.useFakeTimers();
    let answerCheckpoint!: (promptId: string, viewVersion: number) => void;
    const answerConverge = vi.fn(async () => undefined);
    const segmentConverge = vi.fn(async () => undefined);
    const projector = new ConversationViewProjector(
      { onBridgeEvent: () => () => {} } as never,
      { loadRunCard: () => null } as never,
      {} as never,
      { onAnswerCheckpoint(listener: typeof answerCheckpoint) { answerCheckpoint = listener; return () => {}; } } as never,
      pino({ enabled: false }),
      {} as never,
      { converge: answerConverge },
      { converge: async () => undefined } as never,
      { cardUpdateDebounceMs: 250, turnCards: { converge: segmentConverge } }
    );
    projector.start();

    projector.scheduleTurnCard({ segmentId: "segment-1", viewVersion: 2, urgency: "trailing" });
    answerCheckpoint("prompt-1", 3);
    await Promise.resolve();
    expect(answerConverge).toHaveBeenCalledWith("prompt-1");
    expect(segmentConverge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(segmentConverge).toHaveBeenCalledWith("segment-1");

    await projector.stop();
  });

  it("flushes interactive Answer updates on the low-latency path", async () => {
    vi.useFakeTimers();
    const delivered: number[] = [];
    const scheduler = new CardUpdateScheduler(async (_cardKey, version) => { delivered.push(version); }, 250);
    scheduler.schedule("answer:p1", 1, { priority: "interactive", delayMs: 120 });
    await vi.advanceTimersByTimeAsync(119);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([1]);
    scheduler.stop();
  });

  it("coalesces ordinary updates briefly and flushes terminal updates immediately", async () => {
    vi.useFakeTimers();
    const delivered: number[] = [];
    const scheduler = new CardUpdateScheduler(async (_promptId, version) => { delivered.push(version); }, 1_500);
    scheduler.schedule("p1", 2, false);
    scheduler.schedule("p1", 3, false);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([3]);
    scheduler.schedule("p1", 4, true);
    await Promise.resolve();
    expect(delivered).toEqual([3, 4]);
    scheduler.stop();
  });

  it("promotes a delayed update to an earlier per-request budget and reports bounded diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00Z"));
    const delivered: Array<[string, number]> = [];
    const flushes: object[] = [];
    const scheduler = new CardUpdateScheduler(async (key, version) => { delivered.push([key, version]); }, 2_500, undefined, (result) => flushes.push(result));

    scheduler.schedule("main:b1", 1, { priority: "normal", delayMs: 2_500 });
    await vi.advanceTimersByTimeAsync(500);
    scheduler.schedule("main:b1", 2, { priority: "interactive", delayMs: 1_000 });

    expect(scheduler.diagnostics()).toMatchObject({ pending: 1, pendingByFamily: { answer: 0, main: 1, unknown: 0 }, inFlight: 0, coalesced: 1, failures: 0, oldestPendingAgeMs: 500 });
    await vi.advanceTimersByTimeAsync(999);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([["main:b1", 2]]);
    expect(scheduler.diagnostics()).toMatchObject({ pending: 0, coalesced: 1, failures: 0 });
    expect(scheduler.diagnostics().lastSuccessfulFlushAt).not.toBeNull();
    expect(flushes).toEqual([{ cardKey: "main:b1", desiredVersion: 2, priority: "interactive", latencyMs: 0, outcome: "succeeded" }]);
    scheduler.stop();
  });

  it("sends a newer version after an in-flight update", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered: number[] = [];
    const scheduler = new CardUpdateScheduler(async (_promptId, version) => { delivered.push(version); if (version === 1) await gate; }, 0);
    scheduler.schedule("p1", 1, true);
    await Promise.resolve();
    scheduler.schedule("p1", 2, true);
    expect(delivered).toEqual([1]);
    release();
    await vi.waitFor(() => expect(delivered).toEqual([1, 2]));
    scheduler.stop();
  });

  it("runs a same-version checkpoint requested during an in-flight delivery", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered: number[] = [];
    const scheduler = new CardUpdateScheduler(async (_cardKey, version) => {
      delivered.push(version);
      if (delivered.length === 1) await gate;
    }, 100);

    scheduler.schedule("answer:p1", 3, true);
    await Promise.resolve();
    scheduler.schedule("answer:p1", 3, true);
    release();

    await vi.waitFor(() => expect(delivered).toEqual([3, 3]));
    scheduler.stop();
  });

  it("coalesces an ordinary same-version request during an in-flight delivery", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered: number[] = [];
    const scheduler = new CardUpdateScheduler(async (_cardKey, version) => {
      delivered.push(version);
      await gate;
    }, 100);

    scheduler.schedule("main:b1", 3, true);
    await vi.waitFor(() => expect(delivered).toEqual([3]));
    scheduler.schedule("main:b1", 3, false);
    release();
    await vi.waitFor(() => expect(scheduler.diagnostics().pending).toBe(0));

    expect(delivered).toEqual([3]);
    scheduler.stop();
  });

  it("reports a failed flush and retries the latest desired version", async () => {
    vi.useFakeTimers();
    const delivered: number[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const scheduler = new CardUpdateScheduler(async (_promptId, version) => {
      delivered.push(version);
      if (fail) { fail = false; throw new Error("Lark unavailable"); }
    }, 100, (error) => errors.push(error));

    scheduler.schedule("p1", 1, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    scheduler.schedule("p1", 2, false);
    await vi.advanceTimersByTimeAsync(99);
    expect(delivered).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(delivered).toEqual([1, 2]));
    scheduler.stop();
  });

  it("cancels a pending retry when stopped", async () => {
    vi.useFakeTimers();
    const delivered = vi.fn(async () => { throw new Error("Lark unavailable"); });
    const scheduler = new CardUpdateScheduler(delivered, 100, () => undefined);

    scheduler.schedule("p1", 1, true);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(delivered).toHaveBeenCalledOnce();
  });

  it("waits for an active flush and does not launch queued follow-up work after stop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered: number[] = [];
    const scheduler = new CardUpdateScheduler(async (_cardKey, version) => { delivered.push(version); await gate; }, 0);
    scheduler.schedule("answer:p1", 1, true);
    await vi.waitFor(() => expect(delivered).toEqual([1]));
    scheduler.schedule("answer:p1", 2, true);

    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(delivered).toEqual([1]);
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });
});
