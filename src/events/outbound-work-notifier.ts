import type { Logger } from "pino";
import { deliveryScopeKey, type DeliveryScope } from "../domain/delivery-scope.js";
import { safeLogError } from "../runtime/safe-error.js";

export type OutboundWorkHint =
  | { kind: "scope"; scope: DeliveryScope }
  | { kind: "recovery" };

type OutboundWorkListener = (hint?: OutboundWorkHint) => void | Promise<void>;

export interface OutboundWorkNotifier {
  subscribe(listener: OutboundWorkListener): () => void;
  wake(hint?: OutboundWorkHint): void;
}

/** Best-effort process-local hint. Durable outbox rows remain authoritative. */
export class InProcessOutboundWorkNotifier implements OutboundWorkNotifier {
  private readonly listeners = new Set<OutboundWorkListener>();
  private readonly pendingScopes = new Map<string, DeliveryScope>();
  private flushScheduled = false;
  private recoveryPending = false;

  constructor(private readonly logger?: Pick<Logger, "error">) {}

  subscribe(listener: OutboundWorkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wake(hint: OutboundWorkHint = { kind: "recovery" }): void {
    if (hint.kind === "recovery") this.recoveryPending = true;
    else this.pendingScopes.set(deliveryScopeKey(hint.scope), hint.scope);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    // An exact post-commit scope handoff supersedes a coalesced generic wake.
    // Truly unknown work with no exact handoff still takes the recovery path;
    // periodic safety scans remain the convergence path for dropped hints.
    const hints: OutboundWorkHint[] = this.pendingScopes.size > 0
      ? [...this.pendingScopes.values()].map((scope) => ({ kind: "scope", scope }))
      : this.recoveryPending ? [{ kind: "recovery" }] : [];
    this.recoveryPending = false;
    this.pendingScopes.clear();
    for (const hint of hints) {
      for (const listener of [...this.listeners]) {
        try {
          void Promise.resolve(listener(hint)).catch((error) => this.report(error));
        } catch (error) {
          this.report(error);
        }
      }
    }
  }

  private report(error: unknown): void {
    this.logger?.error({ event: "outbound-work-listener-failed", err: safeLogError(error), outcome: "deferred_to_safety_scan" }, "outbound work listener failed");
  }
}
