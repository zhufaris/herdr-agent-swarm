import type { Logger } from "pino";
import { renderRequestAnswerCard } from "../cards/run-card.js";
import type { BridgeEvent } from "../domain/events.js";
import type { QueueFeedbackStore } from "../domain/ports.js";
import { estimateQueueWait } from "../domain/queue-wait-estimate.js";
import { reduceRunCard } from "../domain/run-card-view.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { LifecycleEventSubscriber } from "./bridge-event-bus.js";
import type { OutboundWorkNotifier } from "./outbound-work-notifier.js";

type IntervalHandle = ReturnType<typeof setInterval>;
type SetIntervalFn = (callback: () => void, intervalMs: number) => IntervalHandle;
type ClearIntervalFn = (handle: IntervalHandle) => void;

const REFRESH_EVENTS = new Set<BridgeEvent["type"]>([
  "PromptQueued", "TurnStarted", "TurnCompleted", "TurnFailed"
]);

export class QueueFeedbackProjector {
  private readonly bindingTails = new Map<string, Promise<void>>();
  private readonly queuedBindings = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private timer: IntervalHandle | null = null;
  private stopping = false;

  constructor(private readonly options: {
    store: QueueFeedbackStore; outboundWork: Pick<OutboundWorkNotifier, "wake">; logger: Logger;
    now?: () => string; intervalMs?: number; setIntervalFn?: SetIntervalFn; clearIntervalFn?: ClearIntervalFn;
  }) {}

  start(bus: LifecycleEventSubscriber): () => void {
    this.unsubscribe = bus.onBridgeEvent("queue-feedback-projector", (event) => {
      if (REFRESH_EVENTS.has(event.type)) return this.refresh(event.bindingId);
    });
    return () => { this.unsubscribe?.(); this.unsubscribe = null; };
  }

  async converge(): Promise<void> {
    await Promise.all(this.options.store.listBindings().map((binding) => this.refresh(binding.id)));
  }

  refresh(bindingId: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const previous = this.bindingTails.get(bindingId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.projectBinding(bindingId));
    const tail = work.catch(() => undefined);
    this.bindingTails.set(bindingId, tail);
    void tail.then(() => { if (this.bindingTails.get(bindingId) === tail) this.bindingTails.delete(bindingId); });
    return work;
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.bindingTails.values()]);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
    await this.settle();
  }

  private async projectBinding(bindingId: string): Promise<void> {
    if (this.stopping) return;
    const snapshot = this.options.store.loadQueueFeedbackInputs(bindingId);
    const occurredAt = (this.options.now ?? (() => new Date().toISOString()))();
    const queued = snapshot.queued.filter((view) => view.phase === "queued");
    if (queued.length > 0) this.queuedBindings.add(bindingId);
    else this.queuedBindings.delete(bindingId);
    this.syncTimer();
    const projections = [];
    for (const [index, view] of queued.entries()) {
      const queuePosition = index + 1;
      const feedback = estimateQueueWait({ queuePosition, activeStartedAt: snapshot.activeStartedAt, now: occurredAt, completedDurationsMs: snapshot.durationsMs });
      const positioned = reduceRunCard(view, { type: "queue-position", occurredAt, queuePosition });
      const current = positioned.queueFeedback;
      const feedbackChanged = !current || current.aheadCount !== feedback.aheadCount || current.elapsedBucket !== feedback.elapsedBucket
        || current.estimateLowerSeconds !== feedback.estimateLowerSeconds || current.estimateUpperSeconds !== feedback.estimateUpperSeconds
        || current.sampleCount !== feedback.sampleCount;
      const reduced = feedbackChanged ? reduceRunCard(positioned, { type: "queue-feedback", occurredAt, feedback }) : positioned;
      const next = reduced === view ? view : { ...reduced, viewVersion: view.viewVersion + 1 };
      if (next === view) continue;
      projections.push({ expectedViewVersion: view.viewVersion, view: next, card: next.answerMessageId ? renderRequestAnswerCard(next) : null });
    }
    if (projections.length === 0) return;
    const result = this.options.store.projectQueuedRunCards({ bindingId, projections });
    this.options.logger.info({ event: "queued-run-cards-projected", bindingId, candidateCount: projections.length, projectedCount: result.projected.length, staleCount: result.stalePromptIds.length, outboxReserved: result.outboxReserved }, "projected queued run cards");
    if (result.outboxReserved) this.options.outboundWork.wake();
  }

  private syncTimer(): void {
    if (this.stopping || this.queuedBindings.size === 0) { this.clearTimer(); return; }
    if (this.timer) return;
    const setIntervalFn = this.options.setIntervalFn ?? setInterval;
    this.timer = setIntervalFn(() => {
      void Promise.all([...this.queuedBindings].map((bindingId) => this.refresh(bindingId))).catch((error) => this.options.logger.error({ event: "queue-feedback-convergence-failed", err: safeLogError(error), outcome: "deferred_to_next_refresh" }, "failed to converge queue feedback"));
    }, this.options.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    (this.options.clearIntervalFn ?? clearInterval)(this.timer);
    this.timer = null;
  }
}
