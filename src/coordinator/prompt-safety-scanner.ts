import type { Logger } from "pino";
import type { PromptRunStore } from "../domain/ports/prompt-run.js";
import type { PromptWorkerDiagnostics } from "../domain/types.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { decidePromptSafetyScan, decidePromptSafetyScanFailure } from "./prompt-safety-scan-policy.js";

type SafetyScanDiagnostics = Pick<PromptWorkerDiagnostics,
  "currentSafetyScanDelayMs" | "nextSafetyScanAt" | "lastScanAt" | "lastScanOutcome" | "lastDiscovered" | "lastScanFailureAt"
>;

interface PromptSafetyScannerOptions {
  store: Pick<PromptRunStore, "scanDurablePromptWork" | "listStaleUndispatchedPromptClaims" | "requeueStaleUndispatchedPromptClaim">;
  scheduler: Pick<PromptWorkScheduler, "wake">;
  logger: Logger;
  intervalMs: number;
  staleClaimGraceMs: number;
  isBindingOwned(bindingId: string): boolean;
  maintainObserverCaches(): void;
}

export class PromptSafetyScanner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private consecutiveIdleScans = 0;
  private nextDelayMs: number | null = null;
  private diagnostics: SafetyScanDiagnostics = {
    currentSafetyScanDelayMs: null, nextSafetyScanAt: null, lastScanAt: null, lastScanOutcome: null,
    lastDiscovered: { turns: 0, detached: 0, recoveredClaims: 0, cancelled: 0, failedDetached: 0 },
    lastScanFailureAt: null
  };

  constructor(private readonly options: PromptSafetyScannerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.request();
  }

  request(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.diagnostics.currentSafetyScanDelayMs = null;
    this.diagnostics.nextSafetyScanAt = null;
    try {
      const staleCutoff = new Date(Date.now() - this.options.staleClaimGraceMs).toISOString();
      let recoveredClaims = 0;
      const recoveredBindings = new Set<string>();
      const staleClaims = this.options.store.listStaleUndispatchedPromptClaims?.(staleCutoff, 100) ?? [];
      for (const candidate of staleClaims) {
        if (this.options.isBindingOwned(candidate.bindingId)) continue;
        if (!this.options.store.requeueStaleUndispatchedPromptClaim?.(candidate)) continue;
        recoveredClaims += 1;
        recoveredBindings.add(candidate.bindingId);
        this.options.logger.warn({
          event: "orphaned-prompt-claim-requeued", bindingId: candidate.bindingId, promptId: candidate.promptId,
          ageMs: Math.max(0, Date.now() - Date.parse(candidate.updatedAt)), outcome: "requeued_before_dispatch"
        }, "requeued an unowned prompt claim with no durable dispatch evidence");
      }
      const result = this.options.store.scanDurablePromptWork();
      this.options.maintainObserverCaches();
      const decision = decidePromptSafetyScan(result, this.consecutiveIdleScans, this.options.intervalMs, recoveredClaims);
      for (const hint of result.hints) this.options.scheduler.wake(hint);
      for (const bindingId of recoveredBindings) this.options.scheduler.wake({ kind: "prompt-ready", bindingId });
      this.diagnostics.lastDiscovered = decision.discovered;
      this.diagnostics.lastScanOutcome = decision.outcome;
      this.consecutiveIdleScans = decision.consecutiveIdleScans;
      this.nextDelayMs = decision.nextDelayMs;
      if (result.cancelled > 0 || result.failedDetached > 0) this.options.logger.info({
        event: "prompt-backlog-converged", cancelled: result.cancelled, failedDetached: result.failedDetached, outcome: "terminalized"
      }, "converged prompt work whose bindings can no longer dispatch or observe");
    } catch (error) {
      this.diagnostics.lastDiscovered = { turns: 0, detached: 0, recoveredClaims: 0, cancelled: 0, failedDetached: 0 };
      this.diagnostics.lastScanOutcome = "failed";
      const decision = decidePromptSafetyScanFailure(this.options.intervalMs);
      this.consecutiveIdleScans = decision.consecutiveIdleScans;
      this.nextDelayMs = decision.nextDelayMs;
      this.diagnostics.lastScanFailureAt = new Date().toISOString();
      this.options.logger.error({ event: "prompt-safety-scan-failed", err: safeLogError(error), outcome: "deferred_to_next_scan" }, "durable prompt safety scan failed");
    } finally {
      this.diagnostics.lastScanAt = new Date().toISOString();
      if (this.running) this.arm(this.nextDelayMs ?? this.options.intervalMs);
    }
  }

  resetCadence(): void {
    this.consecutiveIdleScans = 0;
    this.arm(this.options.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.diagnostics.currentSafetyScanDelayMs = null;
    this.diagnostics.nextSafetyScanAt = null;
  }

  snapshot(): SafetyScanDiagnostics {
    return { ...this.diagnostics, lastDiscovered: { ...this.diagnostics.lastDiscovered } };
  }

  private arm(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.diagnostics.currentSafetyScanDelayMs = delayMs;
    this.diagnostics.nextSafetyScanAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.diagnostics.currentSafetyScanDelayMs = null;
      this.diagnostics.nextSafetyScanAt = null;
      this.request();
    }, delayMs);
    this.timer.unref?.();
  }
}
