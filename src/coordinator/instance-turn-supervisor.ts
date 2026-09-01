import type { Logger } from "pino";
import { matchesHerdrAgentKind } from "../domain/agent-instance.js";
import type { InstanceStore } from "../domain/ports.js";
import type { PaneHost } from "../runtime/herdr/pane-host.js";
import { safeLogError } from "../runtime/safe-error.js";
import { FailureLogGate } from "../runtime/failure-log-gate.js";
import { renderWorkerTurnCard } from "../cards/worker-turn-card.js";
import type { WorkerTurnCardChange } from "../domain/worker-turn-card-view.js";
import type { WorkerTurnObserver } from "./worker-turn-observer.js";

interface Options { store: InstanceStore; paneHost: PaneHost; observer?: WorkerTurnObserver; wake(instanceId: string): void; wakeOutbound?: () => void; logger?: Pick<Logger, "info" | "warn"> }

export class InstanceTurnSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private recovered = false;
  private lastScanAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;
  private readonly failureLogs = new FailureLogGate();

  constructor(private readonly options: Options) {}

  prepareRecovery(): void {
    if (this.recovered) return;
    const result = this.options.store.recoverInterruptedInstanceTurns();
    this.recovered = true;
    if (result.requeuedTurnIds.length > 0) this.options.logger?.info({ event: "instance-turns-requeued-after-restart", count: result.requeuedTurnIds.length, outcome: "awaiting_runtime_reconciliation" }, "requeued pre-dispatch instance turns");
  }

  reconcile(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    const run = this.reconcileOnce(); this.running = run;
    return run.finally(() => { if (this.running === run) this.running = null; });
  }

  async requestObservationByPane(paneIds: readonly string[]): Promise<void> {
    if (this.stopping || paneIds.length === 0) return;
    if (this.running) await this.running;
    if (this.stopping) return;
    const run = this.observeTurns(this.options.store.listObservableInstanceTurnsByPaneIds(paneIds), null);
    this.running = run;
    try { await run; }
    finally { if (this.running === run) this.running = null; }
  }

  start(intervalMs: number): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => { void this.reconcile().catch((error) => this.recordScanFailure(error)); }, intervalMs); this.timer.unref();
  }

  async stop(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.running; }

  snapshot(): { activeObservers: number; queuedTurns: number; activeTurns: number; uncertainTurns: number; lastScanAt: string | null; lastFailureAt: string | null; lastFailure: string | null } {
    return { activeObservers: this.running ? 1 : 0, ...this.options.store.getInstanceTurnDiagnostics(), lastScanAt: this.lastScanAt, lastFailureAt: this.lastFailureAt, lastFailure: this.lastFailure };
  }

  private async reconcileOnce(): Promise<void> {
    const turns = this.options.store.listObservableInstanceTurns();
    let panesById: Map<string, Awaited<ReturnType<PaneHost["inspectPane"]>>> | null = null;
    if (this.options.paneHost.snapshotPanes) {
      try { panesById = new Map((await this.options.paneHost.snapshotPanes()).map((pane) => [pane.paneId, pane])); }
      catch { /* Older or degraded Herdr paths retain targeted observation. */ }
    }
    await this.observeTurns(turns, panesById);
    this.lastScanAt = new Date().toISOString();
  }

  private recordScanFailure(error: unknown): void {
    const safe = safeLogError(error);
    this.lastFailureAt = new Date().toISOString();
    this.lastFailure = safe.message;
    const decision = this.failureLogs.fail("supervisor-scan", safe.message);
    if (decision.kind !== "suppressed") this.options.logger?.warn({ event: decision.kind === "summary" ? "instance-turn-scan-failure-summary" : "instance-turn-scan-failed", err: safe, repeatCount: decision.count, firstFailureAt: decision.firstFailureAt, outcome: "retry_later" }, "instance turn scan failed");
  }

  private async observeTurns(turns: ReturnType<InstanceStore["listObservableInstanceTurns"]>, panesById: Map<string, Awaited<ReturnType<PaneHost["inspectPane"]>>> | null): Promise<void> {
    for (const turn of turns) {
      try {
        await this.observe(turn.id, panesById);
        const recovery = this.failureLogs.recover(turn.instanceId);
        if (recovery) this.options.logger?.info({ event: "instance-turn-observation-recovered", instanceId: turn.instanceId, turnId: turn.id, ...recovery, outcome: "recovered" }, "instance turn observation recovered");
      }
      catch (error) {
        this.lastFailureAt = new Date().toISOString(); this.lastFailure = safeLogError(error).message;
        const safe = safeLogError(error);
        const decision = this.failureLogs.fail(turn.instanceId, safe.message);
        if (decision.kind !== "suppressed") this.options.logger?.warn({ event: decision.kind === "summary" ? "instance-turn-observation-failure-summary" : "instance-turn-observation-failed", err: safe, instanceId: turn.instanceId, turnId: turn.id, repeatCount: decision.count, firstFailureAt: decision.firstFailureAt, outcome: "retry_later" }, "instance turn observation failed");
      }
    }
  }

  private async observe(turnId: string, panesById: Map<string, Awaited<ReturnType<PaneHost["inspectPane"]>>> | null): Promise<void> {
    const turn = this.options.store.getInstanceTurn(turnId);
    if (!turn || !["dispatching", "running", "blocked", "dispatch-uncertain"].includes(turn.state)) return;
    const instance = this.options.store.getAgentInstance(turn.instanceId);
    if (!instance || instance.generation !== turn.instanceGeneration || !instance.runtimeRef) return;
    const workspace = this.options.store.getWorkspaceLease(instance.workspaceLeaseId);
    const pane = panesById ? panesById.get(instance.runtimeRef.paneId) ?? null : await this.options.paneHost.inspectPane(instance.runtimeRef.paneId);
    if (!pane || pane.workspaceId !== instance.runtimeRef.herdrWorkspaceId || pane.cwd !== workspace?.cwd || !pane.agentKind || !matchesHerdrAgentKind(instance.agentKind, pane.agentKind)) {
      this.options.store.detachAgentInstanceRuntime({ instanceId: instance.id, expectedGeneration: instance.generation, reason: `Herdr pane ${instance.runtimeRef.paneId} is missing or mismatched during turn recovery` });
      return;
    }
    if (turn.runtimeTurnId && turn.runtimeTurnStartedAt && this.options.observer) {
      await this.options.observer.recover(turn.id);
      const recovered = this.options.store.getInstanceTurn(turn.id);
      if (!recovered || ["completed", "failed", "cancelled"].includes(recovered.state)) {
        this.options.store.updateAgentInstanceObservation({ instanceId: instance.id, expectedGeneration: instance.generation, observedState: "idle" });
        this.options.wake(instance.id);
        return;
      }
      if (pane.agentState === "idle" || pane.agentState === "done") return;
    }
    if (pane.agentState === "working") {
      this.transition(turnId, turn.instanceGeneration, "running", "turn.running", { type: "running", occurredAt: new Date().toISOString() }); return;
    }
    if (pane.agentState === "blocked") {
      this.transition(turnId, turn.instanceGeneration, "blocked", "turn.blocked", { type: "blocked", occurredAt: new Date().toISOString(), notice: "Worker 正在等待 Herdr 中的本地操作。" }); return;
    }
    if (pane.agentState === "idle" || pane.agentState === "done") {
      if (turn.state === "running" || turn.state === "blocked") {
        this.transition(turnId, turn.instanceGeneration, "completed", "turn.completed", { type: "completed-without-output", occurredAt: new Date().toISOString(), notice: "任务已结束，但无法从当前恢复路径确认可信的结构化输出。" }, null, "");
        this.options.store.updateAgentInstanceObservation({ instanceId: instance.id, expectedGeneration: instance.generation, observedState: "idle" });
        this.options.wake(instance.id);
        this.options.logger?.info({ event: "instance-turn-recovered", instanceId: instance.id, turnId, outcome: "observed_without_replay" }, "observed recovered instance turn completion");
      } else {
        const notice = "Agent is idle but dispatch completion was never proven; prompt was not replayed";
        this.transition(turnId, turn.instanceGeneration, "dispatch-uncertain", "turn.dispatch-uncertain", { type: "dispatch-uncertain", occurredAt: new Date().toISOString(), notice }, notice);
      }
    }
  }

  private transition(turnId: string, generation: number, state: Parameters<InstanceStore["updateInstanceTurn"]>[0]["state"], eventKind: string, change: WorkerTurnCardChange, error: string | null = null, result: string | null = null): void {
    if (this.options.store.loadWorkerTurnCard(turnId)) {
      const projected = this.options.store.transitionInstanceTurnWithProjection({ turnId, expectedGeneration: generation, state, result, error, eventKind, change, render: renderWorkerTurnCard });
      if (projected) this.options.wakeOutbound?.();
    } else this.options.store.updateInstanceTurn({ turnId, expectedGeneration: generation, state, result, error, eventKind });
  }
}
