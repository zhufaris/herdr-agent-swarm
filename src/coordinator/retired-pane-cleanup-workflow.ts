import type { Logger } from "pino";
import type { HerdrPort } from "../domain/ports/external.js";
import type { RetiredPaneCleanupStore } from "../domain/ports/binding.js";
import type { RetiredPaneCleanupOperation, RuntimeObservation } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { PeriodicWorkflowRunner } from "../runtime/periodic-workflow-runner.js";

export interface RetiredPaneCleanupWorkflowPort {
  recover(): Promise<void>;
  requestScan(): Promise<void>;
  requestPanes(paneIds: readonly string[]): Promise<void>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

interface Options {
  store: RetiredPaneCleanupStore;
  herdr: Pick<HerdrPort, "observeRuntime" | "closePane">;
  logger: Logger;
}

export class RetiredPaneCleanupWorkflow implements RetiredPaneCleanupWorkflowPort {
  private pendingPaneIds: Set<string> | null | undefined;
  private readonly runner: PeriodicWorkflowRunner;

  constructor(private readonly options: Options) {
    this.runner = new PeriodicWorkflowRunner({ run: () => this.drain(), onError: (error) => this.logFailure(error) });
  }

  recover(): Promise<void> { return this.requestScan(); }

  requestScan(): Promise<void> { return this.request(); }

  requestPanes(paneIds: readonly string[]): Promise<void> {
    if (paneIds.length === 0) return Promise.resolve();
    return this.request(paneIds);
  }

  private request(paneIds?: readonly string[]): Promise<void> {
    if (this.runner.isStopping) return Promise.resolve();
    this.enqueue(paneIds);
    return this.runner.request();
  }

  start(intervalMs: number): void {
    this.runner.start(intervalMs);
  }

  async stop(): Promise<void> {
    await this.runner.stop();
  }

  private async drain(): Promise<void> {
    while (this.pendingPaneIds !== undefined && !this.runner.isStopping) {
      const requestedPaneIds = this.pendingPaneIds;
      this.pendingPaneIds = undefined;
      const operations = this.options.store.listRetiredPaneCleanupOperations();
      for (const operation of requestedPaneIds === null ? operations : operations.filter(({ paneId }) => requestedPaneIds.has(paneId))) {
        if (this.runner.isStopping) return;
        try { await this.process(operation); }
        catch (error) { this.logFailure(error, operation); }
      }
    }
  }

  private enqueue(paneIds?: readonly string[]): void {
    if (paneIds === undefined || this.pendingPaneIds === null) { this.pendingPaneIds = null; return; }
    this.pendingPaneIds ??= new Set<string>();
    for (const paneId of paneIds) this.pendingPaneIds.add(paneId);
  }

  private async process(operation: RetiredPaneCleanupOperation): Promise<void> {
    const { store, herdr, logger } = this.options;
    const oldBinding = store.getBinding(operation.oldBindingId);
    const replacement = store.getBinding(operation.replacementBindingId);
    if (!oldBinding || oldBinding.lifecycle !== "archived" || oldBinding.paneId !== operation.paneId || oldBinding.projectId !== operation.expectedProjectId ||
      !replacement || replacement.lifecycle !== "active" || replacement.replacesBindingId !== oldBinding.id ||
      replacement.topicId !== replacement.reservedTopicId || replacement.rootMessageId !== replacement.reservedRootMessageId) {
      this.retain(operation, "Persisted reset binding identity no longer matches cleanup intent");
      return;
    }

    let observation: RuntimeObservation;
    try { observation = await herdr.observeRuntime(operation.paneId); }
    catch (error) { this.retain(operation, `Unable to observe retired pane safely: ${errorMessage(error)}`); return; }
    if (!observation.pane) {
      const claimed = operation.state === "executing" ? operation : store.claimRetiredPaneCleanup(operation.id);
      if (claimed) { store.completeRetiredPaneCleanup(operation.id); this.logOutcome(operation, "succeeded_absent"); }
      return;
    }
    const pane = observation.pane;
    if (pane.paneId !== operation.paneId || pane.workspaceId !== operation.expectedWorkspaceId ||
      pane.cwd !== operation.expectedCwd || pane.terminalId !== operation.expectedTerminalId || !observation.traexProcess) {
      this.retain(operation, "Retired pane identity or TraeX process could not be verified");
      return;
    }
    if (store.countPendingPrompts(oldBinding.id) > 0 || pane.agentState === "working" || pane.agentState === "blocked") {
      store.updateRetiredPaneCleanup(operation.id, "waiting_busy", "Retired pane or durable prompt state is still busy");
      this.logOutcome(operation, "waiting_busy");
      return;
    }
    if (pane.agentState !== "idle" && pane.agentState !== "done") {
      this.retain(operation, `Retired pane state ${pane.agentState} is not safe for automatic close`);
      return;
    }

    const claimed = operation.state === "executing" ? operation : store.claimRetiredPaneCleanup(operation.id);
    if (!claimed) return;
    logger.info(cleanupLog(operation, "executing"), "closing verified idle retired pane");
    try { await herdr.closePane(operation.paneId); }
    catch (error) {
      store.updateRetiredPaneCleanup(operation.id, "executing", `Herdr pane close failed or was uncertain: ${errorMessage(error)}`);
      logger.warn({ ...cleanupLog(operation, "uncertain"), err: safeLogError(error) }, "retired pane close result is uncertain; a later scan will observe before deciding");
      return;
    }
    let after: RuntimeObservation;
    try { after = await herdr.observeRuntime(operation.paneId); }
    catch (error) { this.retain(operation, `Unable to verify retired pane absence after close: ${errorMessage(error)}`); return; }
    if (!after.pane) { store.completeRetiredPaneCleanup(operation.id); this.logOutcome(operation, "succeeded"); return; }
    if (after.pane.agentState === "working" || after.pane.agentState === "blocked") {
      store.updateRetiredPaneCleanup(operation.id, "waiting_busy", "Pane remained present and became busy after close request");
      this.logOutcome(operation, "waiting_busy_after_close");
      return;
    }
    this.retain(operation, "Pane remained present after close request");
  }

  private retain(operation: RetiredPaneCleanupOperation, detail: string): void {
    this.options.store.updateRetiredPaneCleanup(operation.id, "retained", detail);
    this.options.logger.warn({ ...cleanupLog(operation, "retained"), detail }, "retained old pane because automatic cleanup safety was not proven");
  }

  private logOutcome(operation: RetiredPaneCleanupOperation, outcome: string): void {
    this.options.logger.info(cleanupLog(operation, outcome), "processed retired pane cleanup");
  }

  private logFailure(error: unknown, operation?: RetiredPaneCleanupOperation): void {
    this.options.logger.error({ err: safeLogError(error), ...(operation ? cleanupLog(operation, "failed") : { event: "retired-pane-cleanup-failed", outcome: "failed" }) }, "retired pane cleanup scan failed");
  }
}

function cleanupLog(operation: RetiredPaneCleanupOperation, outcome: string) {
  return { event: "retired-pane-cleanup", cleanupOperationId: operation.id, oldBindingId: operation.oldBindingId, replacementBindingId: operation.replacementBindingId, paneId: operation.paneId, outcome };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
