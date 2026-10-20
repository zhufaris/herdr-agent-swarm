import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import type { OrchestratorIdentityMigration } from "../domain/orchestrator-identity.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { OrchestratorIdentityMigrationStore } from "../domain/ports/orchestrator-identity.js";
import { safeLogError } from "../runtime/safe-error.js";

interface Options {
  config: BridgeConfig;
  store: OrchestratorIdentityMigrationStore;
  herdr: Pick<HerdrPort, "listWorkspaces" | "supportsPaneIdentityReconcileV1" | "reconcilePaneIdentityV1">;
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

export class OrchestratorIdentityMigrationWorkflow {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly options: Options) {}

  reconcile(): Promise<void> {
    if (this.running) return this.running;
    const work = this.reconcileOnce().finally(() => { if (this.running === work) this.running = null; });
    this.running = work;
    return work;
  }

  start(intervalMs: number): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => { void this.reconcile().catch((error) => this.logFailure(error)); }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => undefined);
  }

  private async reconcileOnce(): Promise<void> {
    const recoverable = this.options.store.listRecoverable();
    for (const operation of recoverable) await this.dispatch(operation);
    if (recoverable.length > 0) return;
    const binding = this.options.store.findOrchestratorBinding(this.options.config.gateway.id, this.options.config.lark.chatId);
    if (!binding || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return;
    if (this.options.store.hasActiveMigration(binding.id) || this.options.store.hasActivePrompt(binding.id)) return;
    if (!binding.paneId || !binding.traexSessionId || !binding.paneToken) return;
    const target = await this.resolveTarget();
    if (binding.workspaceId === target.workspaceId && binding.paneToken === "orch") return;
    const accepted = this.options.store.accept({
      id: randomUUID(), bindingId: binding.id, bindingGeneration: binding.generation,
      expected: { workspaceId: binding.workspaceId, paneId: binding.paneId, terminalId: binding.traexSessionId, token: binding.paneToken },
      target: { workspaceId: target.workspaceId, expectedWorkspaceLabel: "herdr", token: "orch" }
    });
    if (["accepted", "applying", "uncertain"].includes(accepted.operation.state)) await this.dispatch(accepted.operation);
  }

  private async resolveTarget(): Promise<{ workspaceId: string }> {
    const { herdr } = this.options;
    if (!herdr.listWorkspaces) throw new Error("Herdr does not support fresh Workspace discovery");
    if (!herdr.supportsPaneIdentityReconcileV1 || !herdr.reconcilePaneIdentityV1 || !await herdr.supportsPaneIdentityReconcileV1()) throw new Error("Herdr does not support pane.identity_reconcile.v1");
    const matches = (await herdr.listWorkspaces()).filter((workspace) => workspace.label === "herdr");
    if (matches.length !== 1) throw new Error(`Expected exactly one Herdr Space labeled 'herdr', found ${matches.length}`);
    return { workspaceId: matches[0]!.workspaceId };
  }

  private async dispatch(candidate: OrchestratorIdentityMigration): Promise<void> {
    const operation = candidate.state === "accepted" || candidate.state === "uncertain" ? this.options.store.claim(candidate.id) : candidate;
    if (!operation || operation.state !== "applying") return;
    try {
      const { herdr } = this.options;
      if (!herdr.supportsPaneIdentityReconcileV1 || !herdr.reconcilePaneIdentityV1 || !await herdr.supportsPaneIdentityReconcileV1()) {
        this.options.store.finish(operation.id, "rejected", "Herdr does not support pane.identity_reconcile.v1"); return;
      }
      const result = await herdr.reconcilePaneIdentityV1({ operationId: operation.id, expected: operation.expected, target: operation.target });
      if ("receipt" in result) {
        const applied = this.options.store.applyReceipt({ operationId: operation.id, receipt: result.receipt });
        if (!applied) this.options.store.finish(operation.id, "rejected", "Binding identity changed before the Core receipt was committed");
        else this.options.logger?.info({ event: "orchestrator-identity-converged", operationId: operation.id, bindingId: operation.bindingId, paneId: applied.binding.paneId, workspaceId: applied.binding.workspaceId, outcome: result.outcome }, "Orchestrator Pane identity converged in place");
        return;
      }
      if (result.outcome === "uncertain" || result.outcome === "malformed-response") {
        this.options.store.markUncertain(operation.id, result.reason); return;
      }
      if ("reason" in result) this.options.store.finish(operation.id, "rejected", result.reason);
      else this.options.store.finish(operation.id, "failed", "Herdr returned an unsupported identity reconciliation outcome");
    } catch (error) {
      this.options.store.markUncertain(operation.id, safeLogError(error).message);
      this.logFailure(error, operation);
    }
  }

  private logFailure(error: unknown, operation?: OrchestratorIdentityMigration): void {
    this.options.logger?.error({ event: "orchestrator-identity-reconcile-failed", err: safeLogError(error), operationId: operation?.id, bindingId: operation?.bindingId, outcome: "uncertain" }, "Orchestrator identity recovery remains pending");
  }
}
