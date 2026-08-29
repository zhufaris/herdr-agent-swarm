import type { Logger } from "pino";
import type { DatabaseIntegrityStore } from "../domain/ports.js";
import type { SqliteIntegrityDiagnostics } from "../domain/types.js";
import { safeLogError } from "./safe-error.js";
import type { ShutdownContext } from "./shutdown-context.js";

export class SqliteIntegrityAuditor {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private inspectionAbort: AbortController | null = null;
  private diagnostics: SqliteIntegrityDiagnostics = {
    state: "idle", quickCheck: "ok", issues: [], truncated: false,
    startedAt: null, completedAt: null, durationMs: null, error: null
  };

  constructor(
    private readonly store: DatabaseIntegrityStore,
    private readonly options: { intervalMs: number; issueLimit: number },
    private readonly logger: Pick<Logger, "info" | "error">,
    private readonly clock: () => number = Date.now
  ) {}

  start(): void {
    if (this.timer) return;
    void this.run();
    this.timer = setInterval(() => { void this.run(); }, this.options.intervalMs);
    this.timer.unref?.();
  }

  async stop(context?: ShutdownContext): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const running = this.running;
    if (!running) return;
    if (!context) { await running; return; }
    const abortInspection = () => this.inspectionAbort?.abort(context.signal.reason);
    if (context.signal.aborted) abortInspection();
    else context.signal.addEventListener("abort", abortInspection, { once: true });
    try { await settlesWithin(running, context.remainingMs()); }
    finally { context.signal.removeEventListener("abort", abortInspection); }
  }

  run(): Promise<void> {
    if (this.running) return this.running;
    const startedAtMs = this.clock();
    const inspectionAbort = new AbortController();
    this.inspectionAbort = inspectionAbort;
    const previous = this.diagnostics;
    this.diagnostics = { ...previous, state: "running", startedAt: new Date(startedAtMs).toISOString() };
    this.running = Promise.resolve().then(() => this.store.inspectIntegrity(this.options.issueLimit, inspectionAbort.signal)).then((inspection) => {
      const completedAtMs = this.clock();
      const degraded = inspection.quickCheck !== "ok" || inspection.issues.length > 0;
      this.diagnostics = { ...inspection, state: degraded ? "degraded" : "healthy", startedAt: new Date(startedAtMs).toISOString(), completedAt: new Date(completedAtMs).toISOString(), durationMs: Math.max(0, completedAtMs - startedAtMs), error: null };
      const record = { event: "sqlite-integrity-audit-completed", state: this.diagnostics.state, quickCheck: inspection.quickCheck, issueCount: inspection.issues.length, rules: inspection.issues.map((issue) => issue.rule), truncated: inspection.truncated, durationMs: this.diagnostics.durationMs, outcome: degraded ? "degraded" : "healthy" };
      if (degraded) this.logger.error(record, "SQLite integrity audit found inconsistencies");
      else this.logger.info(record, "SQLite integrity audit completed");
    }).catch((error) => {
      const completedAtMs = this.clock();
      this.diagnostics = { state: "degraded", quickCheck: "failed", issues: [], truncated: false, startedAt: new Date(startedAtMs).toISOString(), completedAt: new Date(completedAtMs).toISOString(), durationMs: Math.max(0, completedAtMs - startedAtMs), error: safeLogError(error).message.slice(0, 240) };
      this.logger.error({ event: "sqlite-integrity-audit-failed", error: this.diagnostics.error, durationMs: this.diagnostics.durationMs, outcome: "failed" }, "SQLite integrity audit failed");
    }).finally(() => {
      if (this.inspectionAbort === inspectionAbort) this.inspectionAbort = null;
      this.running = null;
    });
    return this.running;
  }

  snapshot(): SqliteIntegrityDiagnostics {
    return { ...this.diagnostics, issues: this.diagnostics.issues.map((issue) => ({ ...issue })) };
  }
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    void promise.finally(() => { clearTimeout(timer); resolve(); });
  });
}
