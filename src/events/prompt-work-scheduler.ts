import type { Logger } from "pino";
import type { PromptWorkHint } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";

export type { PromptWorkHint } from "../domain/types.js";

type PromptWorkListener = (event: PromptWorkHint) => void | Promise<void>;

export interface PromptWorkScheduler {
  subscribe(listener: PromptWorkListener): () => void;
  wake(event: PromptWorkHint): void;
}

/** Best-effort process-local hints. Durable SQLite state remains authoritative. */
export class InProcessPromptWorkScheduler implements PromptWorkScheduler {
  private readonly listeners = new Set<PromptWorkListener>();
  private readonly pending = new Map<string, PromptWorkHint>();
  private flushScheduled = false;

  constructor(private readonly logger?: Pick<Logger, "error">) {}

  subscribe(listener: PromptWorkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wake(event: PromptWorkHint): void {
    this.pending.set(wakeupKey(event), event);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const event of events) for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(event)).catch((error) => this.report(error, event));
      } catch (error) {
        this.report(error, event);
      }
    }
  }

  private report(error: unknown, event: PromptWorkHint): void {
    this.logger?.error({ event: "workflow-wakeup-listener-failed", err: safeLogError(error), wakeup: event.kind, bindingId: event.bindingId, outcome: "deferred_to_reconciliation" }, "workflow wake-up listener failed");
  }
}

function wakeupKey(event: PromptWorkHint): string {
  if (event.kind === "detached-observer-ready") return `${event.kind}:${event.bindingId}:${event.promptId}`;
  return `${event.kind}:${event.bindingId}`;
}
