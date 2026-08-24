import type { Logger } from "pino";
import { safeLogError } from "../runtime/safe-error.js";

export type WorkflowWakeup =
  | { kind: "prompt-ready"; bindingId: string }
  | { kind: "steering-ready"; bindingId: string; parentPromptId: string }
  | { kind: "detached-observer-ready"; bindingId: string; promptId: string }
  | { kind: "binding-runtime-changed"; bindingId: string };

type WorkflowWakeupListener = (event: WorkflowWakeup) => void | Promise<void>;

/** Best-effort process-local hints. Durable SQLite state remains authoritative. */
export class WorkflowWakeupBus {
  private readonly listeners = new Set<WorkflowWakeupListener>();
  private readonly pending = new Map<string, WorkflowWakeup>();
  private flushScheduled = false;

  constructor(private readonly logger?: Pick<Logger, "error">) {}

  subscribe(listener: WorkflowWakeupListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: WorkflowWakeup): void {
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

  private report(error: unknown, event: WorkflowWakeup): void {
    this.logger?.error({ event: "workflow-wakeup-listener-failed", err: safeLogError(error), wakeup: event.kind, bindingId: event.bindingId, outcome: "deferred_to_reconciliation" }, "workflow wake-up listener failed");
  }
}

function wakeupKey(event: WorkflowWakeup): string {
  if (event.kind === "steering-ready") return `${event.kind}:${event.bindingId}:${event.parentPromptId}`;
  if (event.kind === "detached-observer-ready") return `${event.kind}:${event.bindingId}:${event.promptId}`;
  return `${event.kind}:${event.bindingId}`;
}
