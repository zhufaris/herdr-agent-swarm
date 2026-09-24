import type { Logger } from "pino";
import type { OutboundScanStore } from "../domain/ports/outbox.js";
import type { OutboundReply } from "../domain/types.js";
import { DeliveryCheckpointError, type OutboundDeliveryResult } from "./outbound-delivery-executor.js";

type ActiveDeliveryCompletion =
  | { reply: OutboundReply; result: OutboundDeliveryResult; error?: never }
  | { reply: OutboundReply; result?: never; error: unknown };
type ScanMetrics = {
  startedAt: number; attempted: number; delivered: number; failed: number;
  externalDurationMs: number; checkpointDurationMs: number;
  maxExternalDurationMs: number; maxCheckpointDurationMs: number;
};
export interface OutboundLaneDrainResult {
  outcome: "idle" | "delivered" | "failed"; attempted: number; delivered: number; failed: number;
  lastDeliveryAt: string | null; lastDeliveryFailureAt: string | null;
}
interface Options {
  store: Pick<OutboundScanStore, "listOutboundLaneHeads">;
  delivery: { deliver(reply: OutboundReply, dueAt: string | null): Promise<OutboundDeliveryResult> };
  logger: Pick<Logger, "debug">;
}
interface DrainContext { isStopping(): boolean; track<T>(work: Promise<T>): Promise<T>; }

export class OutboundLaneDrain {
  private static readonly MAX_CONCURRENT_DELIVERIES = 4;
  private static readonly MAX_DELIVERIES_PER_SCAN = 100;
  private revision = 0;
  private wake: (() => void) | null = null;
  constructor(private readonly options: Options) {}

  notifyRequest(): void { this.revision += 1; this.wake?.(); }

  async drain(force: boolean, context: DrainContext): Promise<OutboundLaneDrainResult> {
    const metrics: ScanMetrics = { startedAt: Date.now(), attempted: 0, delivered: 0, failed: 0, externalDurationMs: 0, checkpointDurationMs: 0, maxExternalDurationMs: 0, maxCheckpointDurationMs: 0 };
    const blockedLanes = new Set<string>();
    const attemptedReplyIds = new Set<string>();
    const active = new Map<string, Promise<ActiveDeliveryCompletion>>();
    let dispatchOrdinal = 0;
    let outcome: OutboundLaneDrainResult["outcome"] = "idle";
    let observedRevision = this.revision;
    let fatalError: unknown;
    let fatal = false;
    let lastDeliveryAt: string | null = null;
    let lastDeliveryFailureAt: string | null = null;
    while (true) {
      if (context.isStopping() && active.size === 0) return this.finish(metrics, fatal, fatalError, outcome, lastDeliveryAt, lastDeliveryFailureAt);
      const available = Math.min(fatal || context.isStopping() ? 0 : OutboundLaneDrain.MAX_CONCURRENT_DELIVERIES - active.size, OutboundLaneDrain.MAX_DELIVERIES_PER_SCAN - metrics.attempted);
      if (available > 0) {
        const dueAt = force ? null : new Date().toISOString();
        const excluded = [...blockedLanes, ...active.keys()];
        const selected = this.select(available, dueAt, excluded, dispatchOrdinal);
        dispatchOrdinal += selected.length;
        for (const reply of selected) {
          if (attemptedReplyIds.has(reply.id)) { blockedLanes.add(reply.laneKey); continue; }
          attemptedReplyIds.add(reply.id); metrics.attempted += 1;
          active.set(reply.laneKey, context.track(this.options.delivery.deliver(reply, dueAt)).then(
            (result): ActiveDeliveryCompletion => ({ reply, result }),
            (error): ActiveDeliveryCompletion => ({ reply, error })
          ));
        }
        if (selected.length > 0) continue;
      }
      if (active.size === 0) {
        if (metrics.attempted >= OutboundLaneDrain.MAX_DELIVERIES_PER_SCAN) await new Promise<void>((resolve) => setImmediate(resolve));
        return this.finish(metrics, fatal, fatalError, outcome, lastDeliveryAt, lastDeliveryFailureAt);
      }
      if (this.revision !== observedRevision) { observedRevision = this.revision; continue; }
      let wake!: () => void;
      const wakeSignal = new Promise<null>((resolve) => { wake = () => resolve(null); });
      this.wake = wake;
      if (this.revision !== observedRevision) wake();
      let completed: ActiveDeliveryCompletion | null;
      try { completed = await Promise.race([...active.values(), wakeSignal]); }
      finally { if (this.wake === wake) this.wake = null; }
      if (!completed) { observedRevision = this.revision; continue; }
      active.delete(completed.reply.laneKey);
      if ("error" in completed) {
        metrics.failed += 1;
        if (completed.error instanceof DeliveryCheckpointError) this.addTiming(metrics, completed.error.timing);
        outcome = "failed"; fatal = true; fatalError = completed.error; continue;
      }
      const completedAt = new Date().toISOString();
      this.addTiming(metrics, completed.result);
      if (completed.result.outcome === "failed") { metrics.failed += 1; blockedLanes.add(completed.reply.laneKey); lastDeliveryFailureAt = completedAt; outcome = "failed"; }
      else { metrics.delivered += 1; lastDeliveryAt = completedAt; if (outcome === "idle") outcome = "delivered"; }
    }
  }

  private select(available: number, dueAt: string | null, excluded: readonly string[], ordinal: number): OutboundReply[] {
    if (available === 1) {
      const preferred = ordinal % 4 === 3 ? "history" : "live";
      const reply = this.options.store.listOutboundLaneHeads(1, dueAt, excluded, preferred)[0]
        ?? this.options.store.listOutboundLaneHeads(1, dueAt, excluded, preferred === "live" ? "history" : "live")[0];
      return reply ? [reply] : [];
    }
    const candidates = { live: this.options.store.listOutboundLaneHeads(available, dueAt, excluded, "live"), history: this.options.store.listOutboundLaneHeads(available, dueAt, excluded, "history") };
    const selected: OutboundReply[] = [];
    for (let slot = 0; slot < available; slot += 1) {
      const preferred = (ordinal + slot) % 4 === 3 ? "history" : "live";
      const reply = candidates[preferred].shift() ?? candidates[preferred === "live" ? "history" : "live"].shift();
      if (!reply) break;
      selected.push(reply);
    }
    return selected;
  }
  private finish(metrics: ScanMetrics, fatal: boolean, error: unknown, outcome: OutboundLaneDrainResult["outcome"], lastDeliveryAt: string | null, lastDeliveryFailureAt: string | null): OutboundLaneDrainResult {
    this.logSummary(metrics, fatal ? "failed" : outcome);
    if (fatal) throw error;
    return { outcome, attempted: metrics.attempted, delivered: metrics.delivered, failed: metrics.failed, lastDeliveryAt, lastDeliveryFailureAt };
  }
  private addTiming(metrics: ScanMetrics, result: OutboundDeliveryResult): void {
    metrics.externalDurationMs += result.externalDurationMs; metrics.checkpointDurationMs += result.checkpointDurationMs;
    metrics.maxExternalDurationMs = Math.max(metrics.maxExternalDurationMs, result.externalDurationMs);
    metrics.maxCheckpointDurationMs = Math.max(metrics.maxCheckpointDurationMs, result.checkpointDurationMs);
  }
  private logSummary(metrics: ScanMetrics, outcome: OutboundLaneDrainResult["outcome"]): void {
    if (metrics.attempted === 0) return;
    this.options.logger.debug({ event: "gateway-outbox-scan-completed", attempted: metrics.attempted, delivered: metrics.delivered, failed: metrics.failed, durationMs: Date.now() - metrics.startedAt, externalDurationMs: metrics.externalDurationMs, checkpointDurationMs: metrics.checkpointDurationMs, maxExternalDurationMs: metrics.maxExternalDurationMs, maxCheckpointDurationMs: metrics.maxCheckpointDurationMs, outcome }, "Gateway outbox scan completed");
  }
}
