import type { Logger } from "pino";
import type { RetentionStore } from "../domain/ports/retention.js";

export class OutboxRetentionMaintainer {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private stopping = false;

  constructor(
    private readonly store: RetentionStore,
    private readonly options: { retentionDays: number; batchSize: number; maxBatches?: number; intervalMs?: number },
    private readonly logger: Pick<Logger, "info" | "error">
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    void this.run();
    this.timer = setInterval(() => this.run(), this.options.intervalMs ?? 3_600_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const running = this.running;
    if (running) await running;
  }

  run(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.pruneBatches().finally(() => { this.running = null; });
    return this.running;
  }

  private async pruneBatches(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - this.options.retentionDays * 86_400_000).toISOString();
      const maxBatches = this.options.maxBatches ?? 20;
      const compacted = this.store.compactDeliveryIntents
        ? await this.pruneKind((limit) => this.store.compactDeliveryIntents!(limit), maxBatches)
        : { removed: 0, batches: 0 };
      const outbound = await this.pruneKind((limit) => this.store.pruneDeliveredOutboundReplies(cutoff, limit), maxBatches);
      const inbound = await this.pruneKind((limit) => this.store.pruneAcceptedInboundMessages(cutoff, limit), maxBatches);
      const sessionOperations = await this.pruneKind((limit) => this.store.pruneTerminalSessionOperations(cutoff, limit), maxBatches);
      const removed = outbound.removed + inbound.removed + sessionOperations.removed;
      if (removed > 0 || compacted.removed > 0) this.logger.info({ event: "durable-history-pruned", removed, deliveryIntentsCompacted: compacted.removed, outboundRemoved: outbound.removed, inboundRemoved: inbound.removed, sessionOperationRemoved: sessionOperations.removed, compactionBatches: compacted.batches, outboundBatches: outbound.batches, inboundBatches: inbound.batches, sessionOperationBatches: sessionOperations.batches, cutoff, limit: this.options.batchSize, maxBatches, outcome: "pruned" }, "compacted delivery intents and pruned retained Gateway, inbound, and Session operation history");
      return removed;
    } catch (error) {
      this.logger.error({ event: "outbox-retention-failed", err: error, outcome: "failed" }, "failed to prune retained Lark outbox history");
      return 0;
    }
  }

  private async pruneKind(prune: (limit: number) => number, maxBatches: number): Promise<{ removed: number; batches: number }> {
    let removed = 0;
    let batches = 0;
    while (!this.stopping && batches < maxBatches) {
      const batch = prune(this.options.batchSize);
      removed += batch;
      batches += 1;
      if (batch < this.options.batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { removed, batches };
  }
}
