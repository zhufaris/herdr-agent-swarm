import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { HerdrPort } from "../domain/ports/external.js";
import type { PaneRetentionStore } from "../domain/ports/workflow.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { PanePresentation } from "../domain/ports/presentation.js";
import { evaluatePaneClosureSafety, evaluatePaneRetention } from "../domain/pane-retention-policy.js";
import type { ProjectConfig } from "../domain/types.js";
import { PeriodicWorkflowRunner } from "../runtime/periodic-workflow-runner.js";

interface Options { projects: readonly ProjectConfig[]; store: PaneRetentionStore; herdr: Pick<HerdrPort, "listAllPanes" | "getPane" | "closePane">; outbound: Pick<OutboundIntentPort, "enqueueCard">; presentation: Pick<PanePresentation, "paneRetentionWarning">; isBindingBusy(bindingId: string): boolean; logger: Pick<Logger, "info" | "warn">; }
export interface PaneRetentionWorkflowPort { start(intervalMs: number): void; stop(): Promise<void>; scan(): Promise<void>; }

export class PaneRetentionWorkflow implements PaneRetentionWorkflowPort {
  private readonly runner: PeriodicWorkflowRunner;
  private readonly projects: ReadonlyMap<string, ProjectConfig>;
  constructor(private readonly options: Options) {
    this.projects = new Map(options.projects.map((project) => [project.id, project]));
    this.runner = new PeriodicWorkflowRunner({ run: () => this.scanOnce(), onError: (error) => this.options.logger.warn({ event: "pane-retention-scan-failed", error: error instanceof Error ? error.message : String(error) }, "Pane retention scan failed") });
  }

  start(intervalMs: number): void {
    this.runner.start(intervalMs);
  }

  async stop(): Promise<void> { await this.runner.stop(); }

  scan(): Promise<void> { return this.runner.request(); }

  private async scanOnce(): Promise<void> {
    const now = new Date().toISOString();
    const unresolved = new Set(this.options.store.listUnresolvedPaneCloseOperations().map((operation) => operation.bindingId));
    const snapshot = this.options.herdr.listAllPanes ? await this.options.herdr.listAllPanes({ forceRefresh: true }) : null;
    const panesById = snapshot ? new Map(snapshot.map((pane) => [pane.paneId, pane])) : null;
    for (const binding of this.options.store.listBindings()) {
      if (this.runner.isStopping || !binding.paneId || !binding.projectId || unresolved.has(binding.id)) continue;
      const policy = this.projects.get(binding.projectId)?.paneRetention;
      if (policy?.mode !== "ephemeral") continue;
      const pane = panesById ? panesById.get(binding.paneId) ?? null : await this.options.herdr.getPane(binding.paneId);
      const decision = evaluatePaneRetention({ binding, now, enabled: true, pendingWork: this.options.store.countPendingPrompts(binding.id) > 0, unresolvedTurn: this.options.isBindingBusy(binding.id), runtimeState: pane?.agentState ?? null, ...(policy.idleAfterMs !== undefined ? { idleAfterMs: policy.idleAfterMs } : {}), ...(policy.graceMs !== undefined ? { graceMs: policy.graceMs } : {}) });
      if (decision.status === "warning" && binding.rootMessageId) {
        await this.options.outbound.enqueueCard(binding.rootMessageId, `pane-retention-warning:${binding.id}:${decision.warningAt}`, this.options.presentation.paneRetentionWarning({ paneId: pane?.paneId ?? binding.paneId, warningAt: decision.warningAt, closeAt: decision.closeAt }), binding.id, "operation_result");
        continue;
      }
      if (decision.status !== "eligible" || !pane) continue;
      const current = this.options.store.getBinding(binding.id);
      if (!current || current.generation !== binding.generation || current.paneId !== pane.paneId) continue;
      const freshPane = await this.options.herdr.getPane(pane.paneId);
      if (!freshPane) continue;
      const safety = evaluatePaneClosureSafety({ binding: current, pane: freshPane, pendingWork: this.options.store.countPendingPrompts(current.id) > 0, busy: this.options.isBindingBusy(current.id), expectedPaneId: pane.paneId });
      if (!safety.allowed) {
        this.options.logger.info({ event: "pane-auto-close-blocked", bindingId: current.id, paneId: pane.paneId, reason: safety.reason }, "Automatic pane close was blocked by closure safety policy");
        continue;
      }
      const operationId = randomUUID();
      this.options.store.createAutomaticPaneCloseOperation({ id: operationId, bindingId: binding.id, paneId: freshPane.paneId, now });
      unresolved.add(binding.id);
      try {
        await this.options.herdr.closePane(freshPane.paneId);
        const after = await this.options.herdr.getPane(freshPane.paneId);
        if (after) { this.options.store.finishPaneCloseRequest(operationId, "uncertain", "automatic close was not verified"); continue; }
        let closed = this.options.store.transitionBinding(binding.id, { type: "archive_requested", hasActiveTurn: false });
        closed = this.options.store.transitionBinding(closed.id, { type: "closed" });
        this.options.store.finishPaneCloseRequest(operationId, "succeeded", "automatic retention close completed");
        this.options.logger.info({ event: "pane-auto-close-completed", bindingId: closed.id, paneId: freshPane.paneId, operationId, outcome: "closed" }, "Automatically closed an idle ephemeral pane");
      } catch (error) {
        this.options.store.finishPaneCloseRequest(operationId, "uncertain", error instanceof Error ? error.message : String(error));
        this.options.logger.warn({ event: "pane-auto-close-uncertain", bindingId: binding.id, paneId: freshPane.paneId, operationId, outcome: "uncertain" }, "Automatic pane close became uncertain; it will not be replayed");
      }
    }
  }
}
