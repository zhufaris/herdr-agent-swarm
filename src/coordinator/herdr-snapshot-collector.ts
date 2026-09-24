import type { Logger } from "pino";
import type { HerdrPort } from "../domain/ports/external.js";
import type { HerdrPane } from "../domain/types.js";
import type { ReconciliationFailure } from "../domain/diagnostics.js";
import { FailureLogGate } from "../runtime/failure-log-gate.js";
import { mapWithConcurrency } from "../runtime/map-with-concurrency.js";
import { safeLogError } from "../runtime/safe-error.js";

const WORKSPACE_DISCOVERY_CONCURRENCY = 4;

export class HerdrSnapshotCollector {
  private readonly workspaceFailureLogs = new FailureLogGate();
  private readonly snapshotFailureLogs = new FailureLogGate();
  constructor(private readonly herdr: HerdrPort, private readonly logger: Logger) {}

  async allOrConfigured(workspaceIds: readonly string[]): Promise<HerdrPane[]> {
    return this.herdr.listAllPanes ? this.herdr.listAllPanes() : (await mapWithConcurrency(workspaceIds, WORKSPACE_DISCOVERY_CONCURRENCY, (id) => this.herdr.listPanes(id))).flat();
  }

  async collect(workspaceIds: readonly string[]): Promise<{ panesByWorkspace: Map<string, HerdrPane[]>; failures: ReconciliationFailure[] }> {
    const result = new Map<string, HerdrPane[]>();
    if (this.herdr.listAllPanes) {
      try {
        const requested = new Set(workspaceIds);
        const snapshot = await this.herdr.listAllPanes();
        const recovery = this.snapshotFailureLogs.recover("all");
        if (recovery) this.logger.info({ event: "herdr-snapshot-recovered", ...recovery, outcome: "recovered" }, "Herdr snapshot recovered");
        for (const workspaceId of workspaceIds) result.set(workspaceId, []);
        for (const pane of snapshot) if (requested.has(pane.workspaceId)) result.get(pane.workspaceId)!.push(pane);
        return { panesByWorkspace: result, failures: [] };
      } catch (error) {
        const safe = safeLogError(error);
        const decision = this.snapshotFailureLogs.fail("all", safe.message);
        if (decision.kind !== "suppressed") this.logger.warn({ event: decision.kind === "summary" ? "herdr-snapshot-failure-summary" : "herdr-snapshot-fallback", err: safe, workspaceIds, repeatCount: decision.count, firstFailureAt: decision.firstFailureAt, outcome: "fallback" }, "Herdr snapshot unavailable; falling back to workspace pane discovery");
      }
    }
    const failures: ReconciliationFailure[] = [];
    await mapWithConcurrency(workspaceIds, WORKSPACE_DISCOVERY_CONCURRENCY, async (workspaceId) => {
      try {
        result.set(workspaceId, await this.herdr.listPanes(workspaceId, { skipAllWorkspaceSnapshot: true }));
        const recovery = this.workspaceFailureLogs.recover(workspaceId);
        if (recovery) this.logger.info({ event: "workspace-reconciliation-recovered", workspaceId, ...recovery, outcome: "recovered" }, "workspace reconciliation recovered");
      } catch (error) {
        const safe = safeLogError(error);
        failures.push({ workspaceId, message: safe.message.slice(0, 500) });
        const decision = this.workspaceFailureLogs.fail(workspaceId, safe.message);
        if (decision.kind !== "suppressed") this.logger.warn({ event: decision.kind === "summary" ? "workspace-reconciliation-failure-summary" : "workspace-reconciliation-failed", err: safe, workspaceId, repeatCount: decision.count, firstFailureAt: decision.firstFailureAt, outcome: "failed" }, "workspace reconciliation failed");
      }
    });
    return { panesByWorkspace: result, failures };
  }
}
