import type { DurablePromptWorkScan, PromptWorkerDiagnostics } from "../domain/types.js";

export interface PromptSafetyScanDecision {
  outcome: "idle" | "work_found";
  consecutiveIdleScans: number;
  nextDelayMs: number;
  discovered: PromptWorkerDiagnostics["lastDiscovered"];
}

/**
 * Translates a durable-work scan into aggregate diagnostics and the next
 * polling delay. It owns neither the scan nor dispatch: callers must persist
 * and schedule work independently of this best-effort timing policy.
 */
export function decidePromptSafetyScan(
  scan: DurablePromptWorkScan,
  previousConsecutiveIdleScans: number,
  baseDelayMs: number,
  recoveredClaims = 0
): PromptSafetyScanDecision {
  const discovered = { turns: 0, detached: 0, recoveredClaims, cancelled: scan.cancelled, failedDetached: scan.failedDetached };
  for (const hint of scan.hints) {
    if (hint.kind === "prompt-ready") discovered.turns += 1;
    else if (hint.kind === "detached-observer-ready") discovered.detached += 1;
  }
  const outcome = scan.hints.length > 0 || recoveredClaims > 0 || scan.cancelled > 0 || scan.failedDetached > 0 ? "work_found" : "idle";
  const consecutiveIdleScans = outcome === "idle" ? previousConsecutiveIdleScans + 1 : 0;
  const nextDelayMs = outcome === "idle"
    ? baseDelayMs * Math.min(2 ** Math.max(0, consecutiveIdleScans - 1), 6)
    : baseDelayMs;
  return { outcome, consecutiveIdleScans, nextDelayMs, discovered };
}

/** A failed scan resumes from the base cadence rather than extending idle backoff. */
export function decidePromptSafetyScanFailure(baseDelayMs: number): Pick<PromptSafetyScanDecision, "consecutiveIdleScans" | "nextDelayMs"> {
  return { consecutiveIdleScans: 0, nextDelayMs: baseDelayMs };
}
