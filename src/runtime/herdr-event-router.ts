import type { Logger } from "pino";
import { mergeHerdrRuntimeHints, type HerdrRuntimeHint } from "./herdr-event-hint.js";
import { safeLogError } from "./safe-error.js";

export interface HerdrEventRouterOptions {
  invalidateAll(): void;
  invalidateWorkspace(workspaceId: string): void;
  invalidatePanes(paneIds: readonly string[]): void;
  reconcileBindings(scope?: { paneIds?: readonly string[]; workspaceIds?: readonly string[] }): Promise<void>;
  reconcileInstances(scope?: { paneIds?: readonly string[]; workspaceIds?: readonly string[] }): Promise<void>;
  observePrimaryTurns(paneIds?: readonly string[]): Promise<void>;
  observeInstanceTurns(paneIds?: readonly string[]): Promise<void>;
  retryRetiredPanes(paneIds?: readonly string[]): Promise<void>;
  logger: Pick<Logger, "warn" | "debug">;
}

export interface HerdrEventRouterDiagnostics {
  paneHints: number;
  workspaceHints: number;
  fullHints: number;
  coalescedHints: number;
  handlerFailures: number;
}

export class HerdrEventRouter {
  private paneHints = 0;
  private workspaceHints = 0;
  private fullHints = 0;
  private coalescedHints = 0;
  private handlerFailures = 0;
  private pendingHint: HerdrRuntimeHint | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: HerdrEventRouterOptions) {}

  async handle(hint: HerdrRuntimeHint): Promise<void> {
    this.pendingHint = mergeHerdrRuntimeHints(this.pendingHint, hint);
    if (this.running) {
      this.coalescedHints += 1;
      return this.running;
    }
    const run = this.drain();
    this.running = run;
    try { await run; }
    finally { if (this.running === run) this.running = null; }
  }

  private async drain(): Promise<void> {
    while (this.pendingHint) {
      const hint = this.pendingHint;
      this.pendingHint = null;
      await this.route(hint);
    }
  }

  private async route(hint: HerdrRuntimeHint): Promise<void> {
    if (hint.scope === "panes") {
      this.paneHints += 1;
      this.options.invalidatePanes(hint.paneIds);
      await this.run(hint, [
        this.options.reconcileBindings({ paneIds: hint.paneIds }).then(() => this.options.observePrimaryTurns(hint.paneIds)),
        this.options.reconcileInstances({ paneIds: hint.paneIds }),
        this.options.observeInstanceTurns(hint.paneIds),
        this.options.retryRetiredPanes(hint.paneIds)
      ]);
      return;
    }
    if (hint.scope === "workspaces") {
      this.workspaceHints += 1;
      for (const workspaceId of hint.workspaceIds) this.options.invalidateWorkspace(workspaceId);
      const primary = this.options.reconcileBindings({ workspaceIds: hint.workspaceIds })
        .then(() => hint.paneIds.length > 0 ? this.options.observePrimaryTurns(hint.paneIds) : undefined);
      const work: Promise<void>[] = [
        primary,
        this.options.reconcileInstances({ workspaceIds: hint.workspaceIds })
      ];
      if (hint.paneIds.length > 0) {
        work.push(
          this.options.observeInstanceTurns(hint.paneIds),
          this.options.retryRetiredPanes(hint.paneIds)
        );
      }
      await this.run(hint, work);
      return;
    }
    this.fullHints += 1;
    this.options.invalidateAll();
    await this.run(hint, [
      this.options.reconcileBindings().then(() => this.options.observePrimaryTurns()),
      this.options.reconcileInstances(),
      this.options.observeInstanceTurns(),
      this.options.retryRetiredPanes()
    ]);
  }

  snapshot(): HerdrEventRouterDiagnostics {
    return { paneHints: this.paneHints, workspaceHints: this.workspaceHints, fullHints: this.fullHints, coalescedHints: this.coalescedHints, handlerFailures: this.handlerFailures };
  }

  private async run(hint: HerdrRuntimeHint, work: readonly Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(work);
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      this.handlerFailures += 1;
      this.options.logger.warn({ event: "herdr-event-route-handler-failed", err: safeLogError(result.reason), sourceEvent: hint.kind, scope: hint.scope, workspaceIds: hint.workspaceIds, paneIds: hint.paneIds, outcome: "periodic_reconciliation_fallback" }, "Herdr event target failed; periodic reconciliation remains available");
    }
  }
}
