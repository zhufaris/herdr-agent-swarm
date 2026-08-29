import type { InstanceStore } from "../domain/ports.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { Logger } from "pino";
import type { ShutdownContext } from "../runtime/shutdown-context.js";

export class InstanceWorkScheduler {
  private readonly active = new Set<string>();
  private readonly drains = new Set<Promise<void>>();
  private readonly inFlight = new Map<string, { turnId: string; generation: number }>();
  private readonly detachedTurns = new Set<string>();
  private stopping = false;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;
  constructor(private readonly options: { store: InstanceStore; drivers: AgentDriverRegistry; logger?: Pick<Logger, "error"> }) {}

  wake(instanceId: string): void {
    if (this.stopping) return;
    queueMicrotask(() => {
      if (this.stopping) return;
      const drain = this.drain(instanceId);
      this.drains.add(drain);
      void drain.then(() => this.drains.delete(drain), (error) => { this.drains.delete(drain); this.recordFailure(error, instanceId); });
    });
  }
  async drain(instanceId: string): Promise<void> {
    if (this.stopping) return;
    if (this.active.has(instanceId)) return;
    this.active.add(instanceId);
    try {
      while (!this.stopping) {
        const instance = this.options.store.getAgentInstance(instanceId);
        if (!instance?.runtimeRef) return;
        const turn = this.options.store.claimNextInstanceTurn(instance.id, instance.generation);
        if (!turn) return;
        const driver = this.options.drivers.get(instance.agentKind);
        if (!driver) { this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "failed", error: "Agent adapter unavailable", eventKind: "turn.failed" }); continue; }
        this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "dispatching", eventKind: "turn.dispatching" });
        this.inFlight.set(instanceId, { turnId: turn.id, generation: turn.instanceGeneration });
        let receipt;
        try {
          receipt = await driver.submit(instance.runtimeRef, turn.text, () => {
            if (this.detachedTurns.has(turn.id)) return;
            this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "running", eventKind: "turn.running" });
          });
        } catch (error) {
          if (this.detachedTurns.has(turn.id)) return;
          const message = safeLogError(error).message;
          this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "dispatch-uncertain", error: message, eventKind: "turn.dispatch-uncertain" });
          this.recordFailure(error, instanceId, turn.id);
          return;
        }
        if (this.detachedTurns.has(turn.id)) return;
        if (receipt.status === "confirmed-delivered") {
          this.options.store.completeInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, result: receipt.runtimeCursor ?? "" });
          this.options.store.updateAgentInstanceLifecycle({ instanceId: instance.id, expectedGeneration: instance.generation, desiredState: "running", observedState: "idle" });
          continue;
        }
        else if (receipt.status === "delivery-uncertain") this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "dispatch-uncertain", error: receipt.reason, eventKind: "turn.dispatch-uncertain" });
        else this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "failed", error: receipt.reason, eventKind: "turn.failed" });
        return;
      }
    } catch (error) { this.recordFailure(error, instanceId, this.inFlight.get(instanceId)?.turnId); }
    finally { this.active.delete(instanceId); this.inFlight.delete(instanceId); }
  }
  snapshot(): { state: "idle" | "running" | "stopping"; activeDispatchWorkers: number; lastFailureAt: string | null; lastFailure: string | null } {
    return { state: this.stopping ? "stopping" : this.active.size > 0 ? "running" : "idle", activeDispatchWorkers: this.active.size, lastFailureAt: this.lastFailureAt, lastFailure: this.lastFailure };
  }
  async stop(context?: ShutdownContext): Promise<void> {
    this.stopping = true;
    const settled = Promise.allSettled([...this.drains]);
    if (!context) { await settled; return; }
    if (context.remainingMs() > 0 && !context.signal.aborted && await settlesWithin(settled, context.remainingMs(), context.signal)) return;
    for (const { turnId, generation } of this.inFlight.values()) {
      this.detachedTurns.add(turnId);
      this.options.store.updateInstanceTurn({ turnId, expectedGeneration: generation, state: "dispatch-uncertain", error: "Bridge stopped observing an in-flight instance turn; prompt was not replayed", eventKind: "turn.dispatch-uncertain" });
    }
  }
  private recordFailure(error: unknown, instanceId: string, turnId?: string): void {
    this.lastFailureAt = new Date().toISOString(); this.lastFailure = safeLogError(error).message;
    this.options.logger?.error({ event: "instance-turn-dispatch-failed", err: safeLogError(error), instanceId, ...(turnId ? { turnId } : {}), outcome: "dispatch_uncertain" }, "instance turn dispatch failed");
  }
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs); timer.unref?.();
    const onAbort = () => finish(false);
    const finish = (value: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(value); };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => finish(true), () => finish(true));
  });
}
