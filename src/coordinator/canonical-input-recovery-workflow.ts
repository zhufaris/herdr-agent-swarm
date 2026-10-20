import type { Logger } from "pino";
import type { CanonicalInputRecoveryOutcome, CanonicalInputRecoveryPage, CanonicalInputRecoverySummary } from "../domain/ports/agent-input.js";
import type { CoreSubmissionReceipt, SubmissionIntentAgentKind, SubmissionIntentOwner } from "../domain/submission-intent.js";
import { safeLogError } from "../runtime/safe-error.js";

export interface CanonicalInputRecoveryCandidate {
  submissionId: string;
  owner: SubmissionIntentOwner;
  paneId: string;
  terminalId: string;
  expectedAgentKind: SubmissionIntentAgentKind;
  receipt: CoreSubmissionReceipt | null;
}

interface ExactCanonicalReceipt extends CoreSubmissionReceipt {
  turnId: string;
  startedAt: string;
}

interface CanonicalInputRecoveryStore {
  claimPendingCanonicalRecoveryPage(input: { limit: number; currentTime: string }): CanonicalInputRecoveryPage;
  completeCanonicalRecoveryPage(input: { page: CanonicalInputRecoveryPage; outcomes: ReadonlyArray<{ submissionId: string; outcome: CanonicalInputRecoveryOutcome }>; occurredAt: string }): void;
  getCanonicalRecoverySummary(): CanonicalInputRecoverySummary;
}

export async function recoverPendingCanonicalTurns(options: {
  store: CanonicalInputRecoveryStore;
  recover(candidate: CanonicalInputRecoveryCandidate, receipt: ExactCanonicalReceipt): Promise<CanonicalInputRecoveryOutcome>;
  logger?: Pick<Logger, "warn">;
  limit?: number;
  now?: () => string;
}): Promise<CanonicalInputRecoverySummary> {
  const now = options.now ?? (() => new Date().toISOString());
  const occurredAt = now();
  const page = options.store.claimPendingCanonicalRecoveryPage({ limit: options.limit ?? 16, currentTime: occurredAt });
  const outcomes: Array<{ submissionId: string; outcome: CanonicalInputRecoveryOutcome }> = [];
  for (const candidate of page.items) {
    const receipt = exactReceipt(candidate.receipt);
    let outcome: CanonicalInputRecoveryOutcome;
    try {
      outcome = receipt ? await options.recover(candidate, receipt) : "unavailable";
    } catch (error) {
      outcome = "unavailable";
      options.logger?.warn({
        event: "canonical-input-recovery-failed", submissionId: candidate.submissionId,
        ownerKind: candidate.owner.kind, ownerId: candidate.owner.id,
        err: safeLogError(error), outcome: "auto_closed"
      }, "auto-closed malformed canonical Input recovery candidate without replay");
    }
    outcomes.push({ submissionId: candidate.submissionId, outcome });
  }
  options.store.completeCanonicalRecoveryPage({ page, outcomes, occurredAt });
  return { ...options.store.getCanonicalRecoverySummary(), hasMore: page.hasMore };
}

function exactReceipt(receipt: CoreSubmissionReceipt | null): ExactCanonicalReceipt | null {
  return receipt?.turnId && receipt.startedAt ? receipt as ExactCanonicalReceipt : null;
}
