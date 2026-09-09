import type { InstanceLifecycleStore, InstanceTurnStore } from "../domain/ports/instance.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { Logger } from "pino";
import type { ShutdownContext } from "../runtime/shutdown-context.js";
import type { WorkerPresentation } from "../domain/ports/presentation.js";
import type { WorkerTurnCardChange } from "../domain/worker-turn-card-view.js";
import type { WorkerTurnObserver, WorkerTurnWatch } from "../coordinator/worker-turn-observer.js";

export class InstanceWorkScheduler {
  private readonly active = new Set<string>();
  private readonly drains = new Set<Promise<void>>();
  private readonly inFlight = new Map<string, { turnId: string; generation: number }>();
  private readonly detachedWatches = new Set<WorkerTurnWatch>();
  private readonly detachedTurns = new Set<string>();
  private stopping = false;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;
  constructor(private readonly options: { store: InstanceLifecycleStore & InstanceTurnStore; drivers: AgentDriverRegistry; observer?: WorkerTurnObserver; wakeOutbound?: () => void; presentation: Pick<WorkerPresentation, "workerTurn">; logger?: Pick<Logger, "error"> }) {}

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
        if (!driver) { this.transition(turn.id, turn.instanceGeneration, "failed", "turn.failed", { type: "failed", occurredAt: new Date().toISOString(), notice: "Agent adapter unavailable" }, "Agent adapter unavailable"); continue; }
        this.transition(turn.id, turn.instanceGeneration, "dispatching", "turn.dispatching", { type: "preparing", occurredAt: new Date().toISOString() });
        this.inFlight.set(instanceId, { turnId: turn.id, generation: turn.instanceGeneration });
        let receipt;
        let watch: WorkerTurnWatch | null = null;
        try {
          if (driver.describe().structuredEvents) watch = await this.options.observer?.watch(turn.id) ?? null;
          receipt = await driver.submit(instance.runtimeRef, turn.text, {
            onDispatched: () => {
              if (this.detachedTurns.has(turn.id)) return;
              this.transition(turn.id, turn.instanceGeneration, "running", "turn.running", { type: "running", occurredAt: new Date().toISOString() });
            },
            onObservation: async () => { /* Runtime state is reconciled separately; trusted output comes from the exact transcript. */ }
          });
        } catch (error) {
          if (this.detachedTurns.has(turn.id)) { await watch?.stop(); return; }
          await watch?.flush();
          const observed = this.options.store.getInstanceTurn(turn.id);
          if (!observed || ["completed", "failed", "cancelled"].includes(observed.state)) { await watch?.stop(); continue; }
          if (observed.runtimeTurnId && observed.runtimeTurnStartedAt) { this.detachWatch(watch); return; }
          await watch?.stop();
          const message = safeLogError(error).message;
          this.transition(turn.id, turn.instanceGeneration, "dispatch-uncertain", "turn.dispatch-uncertain", { type: "dispatch-uncertain", occurredAt: new Date().toISOString(), notice: message }, message);
          this.recordFailure(error, instanceId, turn.id);
          return;
        }
        if (this.detachedTurns.has(turn.id)) { await watch?.stop(); return; }
        await watch?.flush();
        const observed = this.options.store.getInstanceTurn(turn.id);
        if (!observed || ["completed", "failed", "cancelled"].includes(observed.state)) { await watch?.stop(); continue; }
        if (observed.runtimeTurnId && observed.runtimeTurnStartedAt) { this.detachWatch(watch); return; }
        await watch?.stop();
        if (receipt.status === "confirmed-delivered") {
          if (driver.describe().structuredEvents) return;
          this.transition(turn.id, turn.instanceGeneration, "completed", "turn.completed", { type: "completed-without-output", occurredAt: new Date().toISOString(), notice: "该 Worker 不支持结构化输出捕获；请前往对应 Herdr Pane 查看本地会话。" }, null, "");
          this.options.store.updateAgentInstanceLifecycle({ instanceId: instance.id, expectedGeneration: instance.generation, desiredState: "running", observedState: "idle" });
          continue;
        }
        else if (receipt.status === "delivery-uncertain") {
          const notice = dispatchUncertainNotice(receipt.reason);
          this.transition(turn.id, turn.instanceGeneration, "dispatch-uncertain", "turn.dispatch-uncertain", { type: "dispatch-uncertain", occurredAt: new Date().toISOString(), notice }, receipt.reason);
        }
        else if (!observed.runtimeTurnId || !observed.runtimeTurnStartedAt) {
          this.transition(turn.id, turn.instanceGeneration, "failed", "turn.failed", { type: "failed", occurredAt: new Date().toISOString(), notice: receipt.reason }, receipt.reason);
        }
        return;
      }
    } catch (error) { this.recordFailure(error, instanceId, this.inFlight.get(instanceId)?.turnId); }
    finally { this.active.delete(instanceId); this.inFlight.delete(instanceId); }
  }
  private transition(turnId: string, generation: number, state: Parameters<InstanceTurnStore["updateInstanceTurn"]>[0]["state"], eventKind: Parameters<InstanceTurnStore["updateInstanceTurn"]>[0]["eventKind"], change: WorkerTurnCardChange, error: string | null = null, result: string | null = null): void {
    if (this.options.store.loadWorkerTurnCard(turnId)) {
      const projected = this.options.store.transitionInstanceTurnWithProjection({ turnId, expectedGeneration: generation, state, result, error, eventKind, change, render: this.options.presentation.workerTurn });
      if (projected) this.options.wakeOutbound?.();
    } else this.options.store.updateInstanceTurn({ turnId, expectedGeneration: generation, state, result, error, eventKind });
  }
  snapshot(): { state: "idle" | "running" | "stopping"; activeDispatchWorkers: number; lastFailureAt: string | null; lastFailure: string | null } {
    return { state: this.stopping ? "stopping" : this.active.size > 0 ? "running" : "idle", activeDispatchWorkers: this.active.size, lastFailureAt: this.lastFailureAt, lastFailure: this.lastFailure };
  }
  async stop(context?: ShutdownContext): Promise<void> {
    this.stopping = true;
    const settled = Promise.allSettled([...this.drains]);
    if (!context) { await settled; await this.stopDetachedWatches(); return; }
    if (context.remainingMs() > 0 && !context.signal.aborted && await settlesWithin(settled, context.remainingMs(), context.signal)) { await this.stopDetachedWatches(); return; }
    for (const { turnId, generation } of this.inFlight.values()) {
      this.detachedTurns.add(turnId);
      const current = this.options.store.getInstanceTurn(turnId);
      if (!current || ["completed", "failed", "cancelled"].includes(current.state)) continue;
      const notice = "Bridge stopped observing an in-flight instance turn; prompt was not replayed";
      this.transition(turnId, generation, "dispatch-uncertain", "turn.dispatch-uncertain", { type: "dispatch-uncertain", occurredAt: new Date().toISOString(), notice }, notice);
    }
    await this.stopDetachedWatches();
  }
  private detachWatch(watch: WorkerTurnWatch | null): void {
    if (!watch) return;
    this.detachedWatches.add(watch);
    void watch.detach().finally(() => this.detachedWatches.delete(watch));
  }
  private async stopDetachedWatches(): Promise<void> {
    const watches = [...this.detachedWatches];
    await Promise.allSettled(watches.map((watch) => watch.stop()));
    for (const watch of watches) this.detachedWatches.delete(watch);
  }
  private recordFailure(error: unknown, instanceId: string, turnId?: string): void {
    this.lastFailureAt = new Date().toISOString(); this.lastFailure = safeLogError(error).message;
    this.options.logger?.error({ event: "instance-turn-dispatch-failed", err: safeLogError(error), instanceId, ...(turnId ? { turnId } : {}), outcome: "dispatch_uncertain" }, "instance turn dispatch failed");
  }
}

function dispatchUncertainNotice(reason: string): string {
  return reason.includes("agent_prompt_stalled")
    ? "正在确认 Worker 是否已接收任务；系统不会自动重放。"
    : "Worker 指令的投递状态仍在确认中；系统不会自动重放。";
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
