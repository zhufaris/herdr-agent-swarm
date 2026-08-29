import type { Logger } from "pino";
import { matchesHerdrAgentKind } from "../domain/agent-instance.js";
import type { InstanceStore } from "../domain/ports.js";
import type { PaneHost } from "../runtime/herdr/pane-host.js";
import { safeLogError } from "../runtime/safe-error.js";

interface Options { store: InstanceStore; paneHost: PaneHost; wake(instanceId: string): void; logger?: Pick<Logger, "info" | "warn"> }

export class InstanceTurnSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private recovered = false;
  private lastScanAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;

  constructor(private readonly options: Options) {}

  prepareRecovery(): void {
    if (this.recovered) return;
    const result = this.options.store.recoverInterruptedInstanceTurns();
    this.recovered = true;
    for (const turnId of result.requeuedTurnIds) {
      const turn = this.options.store.getInstanceTurn(turnId);
      if (turn) this.options.wake(turn.instanceId);
    }
  }

  reconcile(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    const run = this.reconcileOnce(); this.running = run;
    return run.finally(() => { if (this.running === run) this.running = null; });
  }

  start(intervalMs: number): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => { void this.reconcile().catch(() => undefined); }, intervalMs); this.timer.unref();
  }

  async stop(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.running; }

  snapshot(): { activeObservers: number; observableTurns: number; lastScanAt: string | null; lastFailureAt: string | null; lastFailure: string | null } {
    return { activeObservers: this.running ? 1 : 0, observableTurns: this.options.store.listObservableInstanceTurns().length, lastScanAt: this.lastScanAt, lastFailureAt: this.lastFailureAt, lastFailure: this.lastFailure };
  }

  private async reconcileOnce(): Promise<void> {
    const turns = this.options.store.listObservableInstanceTurns();
    for (const turn of turns) {
      try { await this.observe(turn.id); }
      catch (error) {
        this.lastFailureAt = new Date().toISOString(); this.lastFailure = safeLogError(error).message;
        this.options.logger?.warn({ event: "instance-turn-observation-failed", err: safeLogError(error), instanceId: turn.instanceId, turnId: turn.id, outcome: "retry_later" }, "instance turn observation failed");
      }
    }
    this.lastScanAt = new Date().toISOString();
  }

  private async observe(turnId: string): Promise<void> {
    const turn = this.options.store.getInstanceTurn(turnId);
    if (!turn || !["dispatching", "running", "blocked", "dispatch-uncertain"].includes(turn.state)) return;
    const instance = this.options.store.getAgentInstance(turn.instanceId);
    if (!instance || instance.generation !== turn.instanceGeneration || !instance.runtimeRef) return;
    const workspace = this.options.store.getWorkspaceLease(instance.workspaceLeaseId);
    const pane = await this.options.paneHost.inspectPane(instance.runtimeRef.paneId);
    if (!pane || pane.workspaceId !== instance.runtimeRef.herdrWorkspaceId || pane.cwd !== workspace?.cwd || !pane.agentKind || !matchesHerdrAgentKind(instance.agentKind, pane.agentKind)) {
      this.options.store.detachAgentInstanceRuntime({ instanceId: instance.id, expectedGeneration: instance.generation, reason: `Herdr pane ${instance.runtimeRef.paneId} is missing or mismatched during turn recovery` });
      return;
    }
    if (pane.agentState === "working") {
      this.options.store.updateInstanceTurn({ turnId, expectedGeneration: turn.instanceGeneration, state: "running", eventKind: "turn.running" }); return;
    }
    if (pane.agentState === "blocked") {
      this.options.store.updateInstanceTurn({ turnId, expectedGeneration: turn.instanceGeneration, state: "blocked", eventKind: "turn.blocked" }); return;
    }
    if (pane.agentState === "idle" || pane.agentState === "done") {
      if (turn.state === "running" || turn.state === "blocked") {
        this.options.store.completeInstanceTurn({ turnId, expectedGeneration: turn.instanceGeneration, result: `observed:${pane.agentState}` });
        this.options.store.updateAgentInstanceLifecycle({ instanceId: instance.id, expectedGeneration: instance.generation, desiredState: instance.desiredState, observedState: "idle" });
        this.options.wake(instance.id);
        this.options.logger?.info({ event: "instance-turn-recovered", instanceId: instance.id, turnId, outcome: "observed_without_replay" }, "observed recovered instance turn completion");
      } else this.options.store.updateInstanceTurn({ turnId, expectedGeneration: turn.instanceGeneration, state: "dispatch-uncertain", error: "Agent is idle but dispatch completion was never proven; prompt was not replayed", eventKind: "turn.dispatch-uncertain" });
    }
  }
}
