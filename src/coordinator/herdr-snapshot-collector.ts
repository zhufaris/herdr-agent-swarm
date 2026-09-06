import type { Logger } from "pino";
import type { HerdrPort } from "../domain/ports/external.js";
import type { HerdrPane } from "../domain/types.js";
import { FailureLogGate } from "../runtime/failure-log-gate.js";
import { safeLogError } from "../runtime/safe-error.js";

export class HerdrSnapshotCollector {
  private readonly workspaceFailureLogs = new FailureLogGate();
  constructor(private readonly herdr: HerdrPort, private readonly logger: Logger) {}

  async allOrConfigured(workspaceIds: readonly string[]): Promise<HerdrPane[]> {
    return this.herdr.listAllPanes ? this.herdr.listAllPanes() : (await Promise.all(workspaceIds.map((id) => this.herdr.listPanes(id)))).flat();
  }

  async collect(workspaceIds: readonly string[]): Promise<Map<string, HerdrPane[]>> {
    const result = new Map<string, HerdrPane[]>();
    if (this.herdr.listAllPanes) {
      try {
        const requested = new Set(workspaceIds);
        const snapshot = await this.herdr.listAllPanes();
        for (const workspaceId of workspaceIds) result.set(workspaceId, []);
        for (const pane of snapshot) if (requested.has(pane.workspaceId)) result.get(pane.workspaceId)!.push(pane);
        return result;
      } catch (error) {
        this.logger.warn({ event: "herdr-snapshot-fallback", err: safeLogError(error), workspaceIds, outcome: "fallback" }, "Herdr snapshot unavailable; falling back to workspace pane discovery");
      }
    }
    await Promise.all(workspaceIds.map(async (workspaceId) => {
      try {
        result.set(workspaceId, await this.herdr.listPanes(workspaceId));
        const recovery = this.workspaceFailureLogs.recover(workspaceId);
        if (recovery) this.logger.info({ event: "workspace-reconciliation-recovered", workspaceId, ...recovery, outcome: "recovered" }, "workspace reconciliation recovered");
      } catch (error) {
        const safe = safeLogError(error);
        const decision = this.workspaceFailureLogs.fail(workspaceId, safe.message);
        if (decision.kind !== "suppressed") this.logger.warn({ event: decision.kind === "summary" ? "workspace-reconciliation-failure-summary" : "workspace-reconciliation-failed", err: safe, workspaceId, repeatCount: decision.count, firstFailureAt: decision.firstFailureAt, outcome: "failed" }, "workspace reconciliation failed");
      }
    }));
    return result;
  }
}
