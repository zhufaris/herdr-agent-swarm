import type { Logger } from "pino";

interface OutboxRetentionStore {
  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number;
}

export class OutboxRetentionMaintainer {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: OutboxRetentionStore,
    private readonly options: { retentionDays: number; batchSize: number; intervalMs?: number },
    private readonly logger: Pick<Logger, "info" | "error">
  ) {}

  start(): void {
    if (this.timer) return;
    this.run();
    this.timer = setInterval(() => this.run(), this.options.intervalMs ?? 3_600_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  run(): number {
    try {
      const cutoff = new Date(Date.now() - this.options.retentionDays * 86_400_000).toISOString();
      const removed = this.store.pruneDeliveredOutboundReplies(cutoff, this.options.batchSize);
      if (removed > 0) this.logger.info({ event: "outbox-retention-pruned", removed, cutoff, limit: this.options.batchSize, outcome: "pruned" }, "pruned retained Lark outbox history");
      return removed;
    } catch (error) {
      this.logger.error({ event: "outbox-retention-failed", err: error, outcome: "failed" }, "failed to prune retained Lark outbox history");
      return 0;
    }
  }
}
