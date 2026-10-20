import type { Logger } from "pino";
import { PeriodicWorkflowRunner } from "../runtime/periodic-workflow-runner.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { RecoveryBindingResult, RecoveryDurableEvidence, RecoverySupervisorDiagnostics } from "../domain/recovery.js";
import type { HistoricalRecoverySliceResult } from "../domain/historical-recovery.js";

export interface ConversationProjectionCatchUpPort { catchUp(bindingId: string): Promise<void>; }

export interface BindingDeliveryRecoveryDebtPort {
  listPromptIds(bindingId: string, limit: number): readonly string[];
  listWorkerTurnIds(bindingId: string, limit: number): readonly string[];
  getBindingStage(bindingId: string): RecoveryBindingResult["stage"] | null;
}

export interface ProjectionDeliveryRecoveryExecutorPort {
  scan(): Promise<void>;
  requestPrompt(promptId: string): Promise<void>;
  requestWorkerTurn(turnId: string): Promise<void>;
  stop(): Promise<void>;
}

export interface RecoverySupervisorPort {
  start(intervalMs: number): void;
  repairDeliveryBeforePublisher(): Promise<void>;
  recoverBinding(bindingId: string): Promise<RecoveryBindingResult>;
  scan(): Promise<void>;
  requestHistoricalRecovery(): Promise<void>;
  requestPrompt(promptId: string): Promise<void>;
  requestWorkerTurn(turnId: string): Promise<void>;
  snapshot(): RecoverySupervisorDiagnostics;
  stop(): Promise<void>;
}

interface Options {
  conversationProjection: ConversationProjectionCatchUpPort;
  deliveryDebt: BindingDeliveryRecoveryDebtPort;
  diagnostics: { snapshot(): RecoveryDurableEvidence };
  delivery: ProjectionDeliveryRecoveryExecutorPort;
  historical?: { recoverSlice(): Promise<HistoricalRecoverySliceResult> };
  logger: Pick<Logger, "warn" | "debug">;
}

export class RecoverySupervisor implements RecoverySupervisorPort {
  private readonly runner: PeriodicWorkflowRunner;
  private fullScanPending = false;
  private historicalScanPending = false;
  private readonly pendingPromptIds = new Set<string>();
  private readonly pendingWorkerTurnIds = new Set<string>();
  private readonly activePromptIds = new Set<string>();
  private readonly activeWorkerTurnIds = new Set<string>();
  private state: RecoverySupervisorDiagnostics["state"] = "idle";
  private version = 0;
  private lastPassAt: string | null = null;
  private lastPassOutcome: RecoverySupervisorDiagnostics["lastPassOutcome"] = null;
  private lastFailure: string | null = null;
  private historicalRunCount = 0;
  private lastHistoricalSliceAt: string | null = null;
  private lastHistoricalResult: HistoricalRecoverySliceResult | null = null;

  constructor(private readonly options: Options) {
    this.runner = new PeriodicWorkflowRunner({
      run: () => this.runScheduled(),
      onInterval: () => { this.fullScanPending = true; this.historicalScanPending = this.options.historical !== undefined; },
      onError: (error) => {
        this.options.logger.warn({
          event: "recovery-supervisor-scan-failed",
          err: safeLogError(error),
          outcome: "retry"
        }, "Recovery supervisor scan failed");
      }
    });
  }

  start(intervalMs: number): void {
    this.runner.start(intervalMs);
  }

  repairDeliveryBeforePublisher(): Promise<void> {
    if (this.runner.isStopping) return Promise.resolve();
    return this.runStandalonePass(() => this.options.delivery.scan());
  }

  async recoverBinding(bindingId: string): Promise<RecoveryBindingResult> {
    await this.options.conversationProjection.catchUp(bindingId);
    return this.recoverDownstream(bindingId, 0, "rebuilding_projection");
  }

  private async recoverDownstream(bindingId: string, recoveredTurns: number, selectedStage: "observing_execution" | "rebuilding_projection"): Promise<RecoveryBindingResult> {
    const promptIds = this.options.deliveryDebt.listPromptIds(bindingId, 100);
    const workerTurnIds = this.options.deliveryDebt.listWorkerTurnIds(bindingId, 100);
    if (promptIds.length === 0 && workerTurnIds.length === 0) {
      const stage = this.bindingStage(bindingId);
      if (stage === "needs_human") return { outcome: "needs_human", selectedStage, stage, reason: "downstream_recovery_needs_human", recoveredTurns, promptCount: 0, workerTurnCount: 0 };
      if (stage && stage !== "recovered") return { outcome: "requested", selectedStage, stage, recoveredTurns, promptCount: 0, workerTurnCount: 0 };
      return {
        outcome: recoveredTurns > 0 ? "recovered" : "none",
        selectedStage: recoveredTurns > 0 ? selectedStage : "recovered",
        stage: stage ?? "recovered",
        reason: "no_recovery_debt",
        recoveredTurns,
        promptCount: 0,
        workerTurnCount: 0
      };
    }
    await Promise.all([
      ...promptIds.map((promptId) => this.requestPrompt(promptId)),
      ...workerTurnIds.map((turnId) => this.requestWorkerTurn(turnId))
    ]);
    const stage = this.bindingStage(bindingId) ?? "rebuilding_projection";
    if (stage === "needs_human") return {
      outcome: "needs_human", selectedStage, stage, reason: "downstream_recovery_needs_human",
      recoveredTurns, promptCount: promptIds.length, workerTurnCount: workerTurnIds.length
    };
    return {
      outcome: "requested",
      selectedStage,
      stage,
      recoveredTurns,
      promptCount: promptIds.length,
      workerTurnCount: workerTurnIds.length
    };
  }

  private bindingStage(bindingId: string): RecoveryBindingResult["stage"] | null {
    return this.options.deliveryDebt.getBindingStage(bindingId);
  }

  scan(): Promise<void> {
    if (this.runner.isStopping) return Promise.resolve();
    this.fullScanPending = true;
    return this.runner.request();
  }

  requestHistoricalRecovery(): Promise<void> {
    if (this.runner.isStopping || !this.options.historical) return Promise.resolve();
    this.historicalScanPending = true;
    return this.runner.request();
  }

  requestPrompt(promptId: string): Promise<void> {
    if (this.runner.isStopping) return Promise.resolve();
    this.pendingPromptIds.add(promptId);
    return this.runner.request();
  }

  requestWorkerTurn(turnId: string): Promise<void> {
    if (this.runner.isStopping) return Promise.resolve();
    this.pendingWorkerTurnIds.add(turnId);
    return this.runner.request();
  }

  async stop(): Promise<void> {
    this.state = "stopping";
    await this.runner.stop();
    await this.options.delivery.stop();
  }

  snapshot(): RecoverySupervisorDiagnostics {
    const evidence = this.options.diagnostics.snapshot();
    return {
      version: this.version,
      state: this.state,
      lastPassAt: this.lastPassAt,
      lastPassOutcome: this.lastPassOutcome,
      stageCounts: {
        observing_execution: evidence.observingExecution,
        rebuilding_projection: evidence.rebuildingProjection,
        delivering: evidence.delivering,
        awaiting_ack: evidence.awaitingAck,
        recovered: evidence.recovered,
        needs_human: evidence.uncertainExecution + evidence.needsHumanDelivery
      },
      oldestPendingAt: evidence.oldestPendingAt,
      oldestPendingAgeSeconds: evidence.oldestPendingAgeSeconds,
      lastFailure: this.lastFailure,
      items: evidence.items,
      historical: {
        runCount: this.historicalRunCount,
        lastSliceAt: this.lastHistoricalSliceAt,
        lastResult: this.lastHistoricalResult
      }
    };
  }

  private async runScheduled(): Promise<void> {
    this.state = "running";
    let succeeded = true;
    let failure: string | null = null;
    if (!this.hasPendingWork()) this.fullScanPending = true;
    // Let same-tick hints form one batch before marking any key active.
    await Promise.resolve();
    try {
      while (this.hasPendingWork() && !this.runner.isStopping) {
        const fullScan = this.fullScanPending;
        const historicalScan = this.historicalScanPending;
        const promptIds = [...this.pendingPromptIds];
        const workerTurnIds = [...this.pendingWorkerTurnIds];
        this.fullScanPending = false;
        this.historicalScanPending = false;
        this.pendingPromptIds.clear();
        this.pendingWorkerTurnIds.clear();

        if (fullScan) {
          const delivery = await this.runStage("projection_delivery", () => this.options.delivery.scan());
          succeeded &&= delivery.ok;
          failure = delivery.error ?? failure;
        }
        if (historicalScan) {
          const historical = await this.runHistoricalSlice();
          succeeded &&= historical.ok;
          failure = historical.error ?? failure;
        }
        if (!fullScan) {
          for (const promptId of promptIds) {
            const result = await this.convergePromptDelivery(promptId);
            succeeded &&= result.ok; failure = result.error ?? failure;
          }
          for (const turnId of workerTurnIds) {
            const result = await this.runWorkerTurn(turnId);
            succeeded &&= result.ok; failure = result.error ?? failure;
          }
        }
      }
    } catch (error) {
      succeeded = false;
      failure = safeLogError(error).message;
      throw error;
    } finally {
      this.finishPass(succeeded, failure);
    }
  }

  private hasPendingWork(): boolean {
    return this.fullScanPending || this.historicalScanPending || this.pendingPromptIds.size > 0 || this.pendingWorkerTurnIds.size > 0;
  }

  private async runHistoricalSlice(): Promise<{ ok: boolean; error: string | null }> {
    if (!this.options.historical) return { ok: true, error: null };
    try {
      this.lastHistoricalResult = await this.options.historical.recoverSlice();
      if ((this.lastHistoricalResult.remaining || this.lastHistoricalResult.cardsRemaining) && !this.runner.isStopping) {
        this.historicalScanPending = true;
      }
      this.historicalRunCount += 1;
      this.lastHistoricalSliceAt = new Date().toISOString();
      this.options.logger.debug({
        event: "historical-recovery-slice-completed",
        ...this.lastHistoricalResult,
        outcome: "succeeded"
      }, "Completed one bounded historical recovery slice");
      return { ok: true, error: null };
    } catch (error) {
      const safeError = safeLogError(error);
      this.options.logger.warn({
        event: "historical-recovery-slice-failed", err: safeError, outcome: "deferred"
      }, "Deferred one historical recovery slice");
      return { ok: false, error: safeError.message };
    }
  }

  private async convergePromptDelivery(promptId: string): Promise<{ ok: boolean; error: string | null }> {
    if (this.activePromptIds.has(promptId)) return { ok: true, error: null };
    this.activePromptIds.add(promptId);
    try { return await this.runStage("projection_delivery", () => this.options.delivery.requestPrompt(promptId), { promptId }); }
    finally { this.activePromptIds.delete(promptId); }
  }

  private async runWorkerTurn(turnId: string): Promise<{ ok: boolean; error: string | null }> {
    if (this.activeWorkerTurnIds.has(turnId)) return { ok: true, error: null };
    this.activeWorkerTurnIds.add(turnId);
    try { return await this.runStage("projection_delivery", () => this.options.delivery.requestWorkerTurn(turnId), { turnId }); }
    finally { this.activeWorkerTurnIds.delete(turnId); }
  }

  private async runStage(stage: "execution_observation" | "projection_delivery", operation: () => void | Promise<void>, identity: { promptId?: string; turnId?: string } = {}): Promise<{ ok: boolean; error: string | null }> {
    try { await operation(); return { ok: true, error: null }; }
    catch (error) {
      const safeError = safeLogError(error);
      this.options.logger.warn({
        event: "recovery-supervisor-stage-failed",
        stage,
        ...identity,
        err: safeError,
        outcome: "deferred"
      }, "Deferred one recovery supervisor stage");
      return { ok: false, error: safeError.message };
    }
  }

  private async runStandalonePass(operation: () => Promise<void>): Promise<void> {
    this.state = "running";
    try { await operation(); this.finishPass(true, null); }
    catch (error) { this.finishPass(false, safeLogError(error).message); throw error; }
  }

  private finishPass(succeeded: boolean, failure: string | null): void {
    this.version += 1;
    this.lastPassAt = new Date().toISOString();
    this.lastPassOutcome = succeeded ? "succeeded" : "failed";
    this.lastFailure = succeeded ? null : failure;
    if (!this.runner.isStopping) this.state = "idle";
  }
}
