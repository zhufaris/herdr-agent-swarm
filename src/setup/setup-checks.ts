import type { SetupCheck, SetupCheckPolicy } from "./setup-types.js";

export function evaluateSetupChecks(checks: readonly SetupCheck[]): SetupCheckPolicy {
  const hasFailures = checks.some((check) => check.status === "fail");
  const hasSkipped = checks.some((check) => check.status === "skipped");
  return {
    canSave: !hasFailures,
    canStart: !hasFailures && !hasSkipped,
    hasWarnings: checks.some((check) => check.status === "warning"),
    hasSkipped
  };
}
