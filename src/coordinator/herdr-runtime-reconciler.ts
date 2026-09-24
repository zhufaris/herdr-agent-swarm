import type { ReconciliationDiagnostics, ReconciliationPassResult } from "../domain/types.js";
import { PriorityReconciliationRunner, type PriorityReconciliationScope } from "../runtime/priority-reconciliation-runner.js";
import { BindingReconciliationPass, type BindingReconciliationPassOptions } from "./binding-reconciliation-pass.js";
import { reconciliationCooldownCovers } from "./reconciliation-scope-policy.js";

const EVENT_RECONCILIATION_COOLDOWN_MS = 1_000;

type ReconciliationPhaseDiagnostics = Pick<ReconciliationDiagnostics,
  "snapshotDurationMs" | "missingPaneDurationMs" | "existingBindingDurationMs" | "discoveryDurationMs" |
  "existingBindingCount" | "discoveryCandidateCount">;

export interface HerdrRuntimeReconcilerPort {
  captureBaselines(): Promise<void>;
  reconcile(workspaceIds?: readonly string[]): Promise<void>;
  requestReconciliation(workspaceIds?: readonly string[]): Promise<void>;
  requestPaneReconciliation(paneIds: readonly string[]): Promise<void>;
  snapshot(): ReconciliationDiagnostics;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

export class HerdrRuntimeReconciler implements HerdrRuntimeReconcilerPort {
  private readonly configuredWorkspaceIds: ReadonlySet<string>;
  private readonly reconciliationRunner: PriorityReconciliationRunner;
  private readonly lastReconciledAt = new Map<string, number>();
  private readonly pass: BindingReconciliationPass;
  private phaseDiagnostics: ReconciliationPhaseDiagnostics = {
    snapshotDurationMs: null, missingPaneDurationMs: null, existingBindingDurationMs: null, discoveryDurationMs: null,
    existingBindingCount: null, discoveryCandidateCount: null
  };

  constructor(options: BindingReconciliationPassOptions) {
    this.configuredWorkspaceIds = new Set(options.projects.map((project) => project.workspaceId));
    this.pass = new BindingReconciliationPass(options);
    this.reconciliationRunner = new PriorityReconciliationRunner({ execute: (scope) => this.execute(scope) });
  }

  captureBaselines(): Promise<void> {
    return this.pass.captureBaselines();
  }

  async reconcile(workspaceIds?: readonly string[]): Promise<void> {
    return this.reconciliationRunner.request(scopeForWorkspaces(workspaceIds), { allowActiveCoverage: true });
  }

  async requestReconciliation(workspaceIds?: readonly string[]): Promise<void> {
    if (reconciliationCooldownCovers({ ...(workspaceIds ? { requestedWorkspaceIds: workspaceIds } : {}), configuredWorkspaceIds: this.configuredWorkspaceIds, lastReconciledAt: this.lastReconciledAt, now: performance.now(), cooldownMs: EVENT_RECONCILIATION_COOLDOWN_MS })) {
      this.reconciliationRunner.markCoalesced();
      return;
    }
    return this.reconciliationRunner.request(scopeForWorkspaces(workspaceIds), { allowActiveCoverage: workspaceIds !== undefined });
  }

  async requestPaneReconciliation(paneIds: readonly string[]): Promise<void> {
    return this.reconciliationRunner.request({ kind: "panes", ids: paneIds });
  }

  snapshot(): ReconciliationDiagnostics {
    return { ...this.reconciliationRunner.snapshot(), ...this.phaseDiagnostics };
  }

  start(intervalMs: number): void {
    this.reconciliationRunner.start(intervalMs);
  }

  async stop(): Promise<void> {
    await this.reconciliationRunner.stop();
  }

  private async execute(scope: PriorityReconciliationScope): Promise<ReconciliationPassResult | void> {
    const result = await this.pass.execute(scope);
    if (!result) return;
    const {
      reconciledWorkspaceIds, failures, snapshotDurationMs, missingPaneDurationMs,
      existingBindingDurationMs, discoveryDurationMs, existingBindingCount, discoveryCandidateCount
    } = result;
    this.phaseDiagnostics = {
      snapshotDurationMs, missingPaneDurationMs, existingBindingDurationMs, discoveryDurationMs,
      existingBindingCount, discoveryCandidateCount
    };
    const completedAt = performance.now();
    for (const workspaceId of reconciledWorkspaceIds) this.lastReconciledAt.set(workspaceId, completedAt);
    return { reconciledWorkspaceIds, failures };
  }
}

function scopeForWorkspaces(workspaceIds?: readonly string[]): PriorityReconciliationScope {
  return workspaceIds === undefined ? { kind: "all" } : { kind: "workspaces", ids: workspaceIds };
}
