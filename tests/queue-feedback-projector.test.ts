import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { createQueuedRunCard, type RunCardView } from "../src/domain/run-card-view.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { QueueFeedbackProjector } from "../src/events/queue-feedback-projector.js";

function event(type: "PromptQueued" | "TurnStarted" | "TurnCompleted" | "TurnFailed" | "PromptCancelled" | "RunQueuePositionChanged", bindingId = "b1") {
  const payload = type === "PromptQueued" ? { promptId: "p1", queueDepth: 1, actorOpenId: "u1" }
    : type === "TurnCompleted" ? { promptId: "active", answer: "done", queueDepth: 1 }
      : type === "TurnFailed" ? { promptId: "active", error: "failed", queueDepth: 1 }
        : type === "PromptCancelled" ? { promptId: "p1", reason: "cancelled" }
          : type === "RunQueuePositionChanged" ? { promptId: "p1", queuePosition: 1 }
            : { promptId: "active", queueDepth: 1 };
  return { eventId: `${type}-1`, bindingId, type, origin: "bridge" as const, occurredAt: "2026-08-29T12:00:00.000Z", payload } as never;
}

describe("QueueFeedbackProjector", () => {
  it("does not rescan the binding for a per-card queue position event", async () => {
    const store = {
      listBindings: () => [],
      loadQueueFeedbackInputs: vi.fn(() => ({ activeStartedAt: null, queued: [], durationsMs: [] })),
      projectQueueFeedback: vi.fn()
    };
    const bus = new BridgeEventBus();
    const projector = new QueueFeedbackProjector({ store: store as never, outboundWork: { wake: vi.fn() }, logger: pino({ enabled: false }) });
    projector.start(bus);

    await bus.publish(event("RunQueuePositionChanged"));

    expect(store.loadQueueFeedbackInputs).not.toHaveBeenCalled();
    expect(store.projectQueueFeedback).not.toHaveBeenCalled();
    await projector.stop();
  });

  it("refreshes lifecycle changes, persists only changed queued cards, and coalesces elapsed buckets", async () => {
    let clock = "2026-08-29T12:00:20.000Z";
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    queued.answerMessageId = "answer-1";
    const terminal = { ...createQueuedRunCard({ promptId: "done", bindingId: "b1", title: "Done", workspaceId: "w1", paneId: "w1:p1", requestText: "done", queuePosition: 0, occurredAt: "start" }), phase: "completed" as const };
    const cards = new Map<string, RunCardView>([[queued.promptId, queued], [terminal.promptId, terminal]]);
    const store = {
      listBindings: () => [{ id: "b1" }],
      loadQueueFeedbackInputs: vi.fn(() => ({ activeStartedAt: "2026-08-29T12:00:00.000Z", queued: [...cards.values()], durationsMs: [60_000, 60_000, 60_000] })),
      projectQueueFeedback: vi.fn(({ view, card }: { view: RunCardView; card: object | null }) => { cards.set(view.promptId, view); return { outcome: "projected" as const, view, outboxReserved: card !== null }; })
    };
    const outboundWork = { wake: vi.fn() };
    const timers: Array<() => void> = [];
    const interval = { unref: vi.fn() };
    const setIntervalFn = vi.fn((callback: () => void) => { timers.push(callback); return interval; });
    const clearIntervalFn = vi.fn();
    const bus = new BridgeEventBus();
    const projector = new QueueFeedbackProjector({ store: store as never, outboundWork: outboundWork as never, logger: pino({ enabled: false }), now: () => clock, intervalMs: 30_000, setIntervalFn: setIntervalFn as never, clearIntervalFn: clearIntervalFn as never });
    projector.start(bus);

    for (const type of ["PromptQueued", "TurnStarted", "TurnCompleted", "TurnFailed", "PromptCancelled", "RunQueuePositionChanged"] as const) await bus.publish(event(type));
    expect(store.projectQueueFeedback).toHaveBeenCalledTimes(1);
    expect(outboundWork.wake).toHaveBeenCalledTimes(1);
    expect(cards.get("done")!.queueFeedback).toBeNull();
    expect(setIntervalFn).toHaveBeenCalledOnce();
    expect(interval.unref).toHaveBeenCalledOnce();

    clock = "2026-08-29T12:00:29.000Z";
    timers[0]!(); await projector.settle();
    expect(store.projectQueueFeedback).toHaveBeenCalledTimes(1);
    clock = "2026-08-29T12:00:31.000Z";
    timers[0]!(); await projector.settle();
    expect(store.projectQueueFeedback).toHaveBeenCalledTimes(2);

    await projector.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(interval);
  });

  it("converges durable queued cards after restart without prompt workflow wake-up and stops scheduling when empty", async () => {
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    const queuedRows: RunCardView[] = [queued];
    const store = { listBindings: () => [{ id: "b1" }], loadQueueFeedbackInputs: () => ({ activeStartedAt: null, queued: [...queuedRows], durationsMs: [] }), projectQueueFeedback: vi.fn(({ view }: { view: RunCardView }) => ({ outcome: "projected" as const, view, outboxReserved: false })) };
    const outboundWork = { wake: vi.fn() };
    const promptWake = vi.fn();
    const interval = { unref: vi.fn() };
    const clearIntervalFn = vi.fn();
    const projector = new QueueFeedbackProjector({ store: store as never, outboundWork: outboundWork as never, logger: pino({ enabled: false }), now: () => "2026-08-29T12:00:00.000Z", intervalMs: 30_000, setIntervalFn: (() => interval) as never, clearIntervalFn: clearIntervalFn as never });

    await projector.converge();
    expect(store.projectQueueFeedback).toHaveBeenCalledOnce();
    expect(promptWake).not.toHaveBeenCalled();

    queuedRows.length = 0;
    await projector.refresh("b1");
    expect(clearIntervalFn).toHaveBeenCalledWith(interval);
    await projector.stop();
  });
});
