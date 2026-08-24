import type { Logger } from "pino";
import { safeLogError } from "../runtime/safe-error.js";

type OutboundWorkListener = () => void | Promise<void>;

export interface OutboundWorkNotifier {
  subscribe(listener: OutboundWorkListener): () => void;
  wake(): void;
}

/** Best-effort process-local hint. Durable outbox rows remain authoritative. */
export class InProcessOutboundWorkNotifier implements OutboundWorkNotifier {
  private readonly listeners = new Set<OutboundWorkListener>();
  private flushScheduled = false;

  constructor(private readonly logger?: Pick<Logger, "error">) {}

  subscribe(listener: OutboundWorkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wake(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    for (const listener of [...this.listeners]) {
      try {
        void Promise.resolve(listener()).catch((error) => this.report(error));
      } catch (error) {
        this.report(error);
      }
    }
  }

  private report(error: unknown): void {
    this.logger?.error({ event: "outbound-work-listener-failed", err: safeLogError(error), outcome: "deferred_to_safety_scan" }, "outbound work listener failed");
  }
}
