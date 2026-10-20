import type { Logger } from "pino";
import type { PreparedDeliveryProjectionRecoveryHint } from "../domain/ports/prepared-delivery.js";
import type { AnswerPageConvergencePort } from "../domain/ports/card-convergence.js";
import type { WorkerTurnCardConvergencePort } from "../domain/ports/card-convergence.js";
import { PeriodicWorkflowRunner } from "../runtime/periodic-workflow-runner.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { TurnCardWorkflow } from "./turn-card-workflow.js";

export interface ProjectionDeliveryRecoveryStore {
  listRecoverablePrimaryAnswerPromptIds(limit: number): readonly string[];
  listRecoverableWorkerTurnIds(limit: number): readonly string[];
  listRecoverableConversationSegmentIds?(limit: number): readonly string[];
}

export interface ProjectionDeliveryRecoveryWatchdogPort {
  start(intervalMs: number): void;
  scan(): Promise<void>;
  requestPrompt(promptId: string): Promise<void>;
  requestWorkerTurn(turnId: string): Promise<void>;
  requestTurnCard(segmentId: string): Promise<void>;
  requestRecoveryHint(hint: Exclude<PreparedDeliveryProjectionRecoveryHint, { kind: "card-context" }>): Promise<void>;
  stop(): Promise<void>;
}

interface Options {
  store: ProjectionDeliveryRecoveryStore;
  answerPages: AnswerPageConvergencePort;
  workerTurns: WorkerTurnCardConvergencePort;
  turnCards?: Pick<TurnCardWorkflow, "converge">;
  logger: Pick<Logger, "warn" | "debug">;
}

export class ProjectionDeliveryRecoveryWatchdog implements ProjectionDeliveryRecoveryWatchdogPort {
  private readonly runner: PeriodicWorkflowRunner;
  private pendingPromptIds: Set<string> | null | undefined;
  private pendingWorkerTurnIds: Set<string> | null | undefined;
  private pendingSegmentIds: Set<string> | null | undefined;
  private readonly activePromptIds = new Set<string>();
  private readonly activeWorkerTurnIds = new Set<string>();

  constructor(private readonly options: Options) {
    this.runner = new PeriodicWorkflowRunner({
      run: () => this.runScheduled(),
      onError: (error) => this.options.logger.warn({
        event: "projection-delivery-recovery-scan-failed",
        err: safeLogError(error),
        outcome: "retry"
      }, "Projection delivery recovery scan failed")
    });
  }

  start(intervalMs: number): void { this.runner.start(intervalMs); }

  scan(): Promise<void> {
    if (this.runner.isStopping) return Promise.resolve();
    this.pendingPromptIds = null;
    this.pendingWorkerTurnIds = null;
    this.pendingSegmentIds = null;
    return this.runner.request();
  }

  requestPrompt(promptId: string): Promise<void> {
    if (this.runner.isStopping || this.activePromptIds.has(promptId)) return this.runner.request();
    if (this.pendingPromptIds !== null) {
      this.pendingPromptIds ??= new Set<string>();
      this.pendingPromptIds.add(promptId);
    }
    return this.runner.request();
  }

  requestWorkerTurn(turnId: string): Promise<void> {
    if (this.runner.isStopping || this.activeWorkerTurnIds.has(turnId)) return this.runner.request();
    if (this.pendingWorkerTurnIds !== null) {
      this.pendingWorkerTurnIds ??= new Set<string>();
      this.pendingWorkerTurnIds.add(turnId);
    }
    return this.runner.request();
  }
  requestTurnCard(segmentId: string): Promise<void> {
    if (this.runner.isStopping || !this.options.turnCards) return this.runner.request();
    if (this.pendingSegmentIds !== null) { this.pendingSegmentIds ??= new Set<string>(); this.pendingSegmentIds.add(segmentId); }
    return this.runner.request();
  }

  requestRecoveryHint(hint: Exclude<PreparedDeliveryProjectionRecoveryHint, { kind: "card-context" }>): Promise<void> {
    if (hint.kind === "primary-answer") return this.requestPrompt(hint.promptId);
    if (hint.kind === "worker-turn") return this.requestWorkerTurn(hint.turnId);
    return this.requestTurnCard(hint.segmentId);
  }

  stop(): Promise<void> { return this.runner.stop(); }

  private async runScheduled(): Promise<void> {
    const startedAt = Date.now();
    let primaryAnswerCount = 0;
    let workerTaskCount = 0;
    let unifiedTurnCardCount = 0;
    if (this.pendingPromptIds === undefined && this.pendingWorkerTurnIds === undefined && this.pendingSegmentIds === undefined) {
      this.pendingPromptIds = null;
      this.pendingWorkerTurnIds = null;
      this.pendingSegmentIds = null;
    }
    while ((this.pendingPromptIds !== undefined || this.pendingWorkerTurnIds !== undefined || this.pendingSegmentIds !== undefined) && !this.runner.isStopping) {
      const requestedPrompts = this.pendingPromptIds;
      const requestedWorkerTurns = this.pendingWorkerTurnIds;
      const requestedSegments = this.pendingSegmentIds;
      this.pendingPromptIds = undefined;
      this.pendingWorkerTurnIds = undefined;
      this.pendingSegmentIds = undefined;
      const promptIds = requestedPrompts === null
        ? this.options.store.listRecoverablePrimaryAnswerPromptIds(100)
        : [...requestedPrompts ?? []];
      for (const promptId of new Set(promptIds)) {
        if (this.runner.isStopping || this.activePromptIds.has(promptId)) continue;
        primaryAnswerCount += 1;
        this.activePromptIds.add(promptId);
        try {
          await this.options.answerPages.converge(promptId, "history");
          this.options.logger.debug({ event: "projection-delivery-recovery-converged", recoveryId: `primary-answer:${promptId}`, promptId, projectionKind: "primary_answer", outcome: "converged" }, "Converged a recoverable Primary Answer projection");
        } catch (error) {
          this.options.logger.warn({ event: "projection-delivery-recovery-item-failed", err: safeLogError(error), recoveryId: `primary-answer:${promptId}`, promptId, projectionKind: "primary_answer", outcome: "deferred" }, "Deferred one Primary Answer recovery");
        } finally {
          this.activePromptIds.delete(promptId);
        }
      }
      const workerTurnIds = requestedWorkerTurns === null
        ? this.options.store.listRecoverableWorkerTurnIds(100)
        : [...requestedWorkerTurns ?? []];
      for (const turnId of new Set(workerTurnIds)) {
        if (this.runner.isStopping || this.activeWorkerTurnIds.has(turnId)) continue;
        workerTaskCount += 1;
        this.activeWorkerTurnIds.add(turnId);
        try {
          await this.options.workerTurns.converge(turnId);
          this.options.logger.debug({ event: "projection-delivery-recovery-converged", recoveryId: `worker-task:${turnId}`, turnId, projectionKind: "worker_task", outcome: "converged" }, "Converged a recoverable Worker Task projection");
        } catch (error) {
          this.options.logger.warn({ event: "projection-delivery-recovery-item-failed", err: safeLogError(error), recoveryId: `worker-task:${turnId}`, turnId, projectionKind: "worker_task", outcome: "deferred" }, "Deferred one Worker Task recovery");
        } finally {
          this.activeWorkerTurnIds.delete(turnId);
        }
      }
      const segmentIds = requestedSegments === null ? this.options.store.listRecoverableConversationSegmentIds?.(100) ?? [] : [...requestedSegments ?? []];
      for (const segmentId of new Set(segmentIds)) {
        unifiedTurnCardCount += 1;
        try { await this.options.turnCards?.converge(segmentId); }
        catch (error) { this.options.logger.warn({ event: "projection-delivery-recovery-item-failed", err: safeLogError(error), recoveryId: `turn-card:${segmentId}`, segmentId, projectionKind: "turn_card", outcome: "deferred" }, "Deferred one unified Turn Card recovery"); }
      }
    }
    this.options.logger.debug({
      event: "projection-delivery-recovery-scan-completed",
      primaryAnswerCount,
      workerTaskCount,
      unifiedTurnCardCount,
      candidateCount: primaryAnswerCount + workerTaskCount + unifiedTurnCardCount,
      durationMs: Date.now() - startedAt,
      outcome: "completed"
    }, "Projection delivery recovery scan completed");
  }
}
