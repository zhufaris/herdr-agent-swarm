import type { Logger } from "pino";
import type { AgentInputCorePort, AgentInputRecoveryOutcome, AgentInputStore } from "../domain/ports/agent-input.js";
import type { SubmissionIntent } from "../domain/submission-intent.js";
import { safeLogError } from "../runtime/safe-error.js";
import { mapWithConcurrency } from "../runtime/map-with-concurrency.js";

const RECOVERY_RETRY_INITIAL_MS = 250;
const RECOVERY_RETRY_MAX_MS = 30_000;

export interface AgentInputDrainerOptions {
  store: AgentInputStore;
  core: AgentInputCorePort;
  now?: () => string;
  recoveryBatchLimit?: number;
  recoveryConcurrency?: number;
  recoveryRetryInitialMs?: number;
  recoveryRetryMaxMs?: number;
  logger?: Pick<Logger, "warn">;
}

export class AgentInputDrainer {
  private readonly now: () => string;
  private continuation: Promise<void> | null = null;
  private activePage: Promise<boolean> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveRetry: (() => void) | null = null;
  private stopping = false;

  constructor(private readonly options: AgentInputDrainerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async drain(submissionId: string): Promise<SubmissionIntent | null> {
    const claimed = this.options.store.claimRecorded(submissionId, this.now());
    if (!claimed) return this.options.store.get(submissionId);
    const capabilityFailure = await this.typedInputCapabilityFailure(claimed);
    if (capabilityFailure) {
      if (capabilityFailure.definite) {
        return this.options.store.recordDefiniteRejection(claimed.submissionId, {
          code: capabilityFailure.code, detail: capabilityFailure.detail, recordedAt: this.now()
        });
      }
      return this.markUncertain(claimed.submissionId, capabilityFailure.code, capabilityFailure.detail);
    }
    try {
      const result = await this.options.core.submit({
        submissionId: claimed.submissionId,
        paneId: claimed.paneId,
        terminalId: claimed.terminalId,
        agentKind: claimed.expectedAgentKind,
        sessionId: claimed.expectedSessionId,
        text: claimed.text,
        input: claimed.input
      });
      if (result.outcome === "receipt") {
        return this.options.store.recordReceipt(claimed.submissionId, result.receipt)
          ?? this.markUncertain(claimed.submissionId, "receipt_not_adopted", "Core receipt did not match the immutable Submission Intent");
      }
      if (result.outcome === "rejected") {
        return this.options.store.recordDefiniteRejection(claimed.submissionId, {
          ...result.failure,
          recordedAt: this.now()
        });
      }
      return this.markUncertain(claimed.submissionId, result.failure.code, result.failure.detail);
    } catch {
      return this.markUncertain(claimed.submissionId, "core_submission_failure", null);
    }
  }

  async recover(): Promise<Array<SubmissionIntent | null>> {
    const page = this.options.store.claimRecoveryWorkPage({ limit: this.options.recoveryBatchLimit ?? 16, attemptedAt: this.now() });
    const outcomes = await mapWithConcurrency(page.items, this.options.recoveryConcurrency ?? 4, ({ action, intent }) =>
      action === "submit" ? this.submitRecovery(intent) : this.queryRecovery(intent)
    );
    this.options.store.completeRecoveryWorkPage({ page, outcomes, completedAt: this.now() });
    return outcomes.map(({ submissionId }) => this.options.store.get(submissionId));
  }

  async startRecovery(): Promise<void> {
    if (this.continuation || this.activePage) return;
    this.stopping = false;
    type RecoveryPage = ReturnType<AgentInputStore["claimRecoveryWorkPage"]>;
    const run = async (page: RecoveryPage): Promise<boolean> => {
      const outcomes = await mapWithConcurrency(page.items, this.options.recoveryConcurrency ?? 4, ({ action, intent }) =>
        action === "submit" ? this.submitRecovery(intent) : this.queryRecovery(intent)
      );
      this.options.store.completeRecoveryWorkPage({ page, outcomes, completedAt: this.now() });
      return page.hasMore;
    };
    const continueRecovery = (initialFailure?: unknown) => (async () => {
      let more = true;
      let retryAttempt = 0;
      if (initialFailure !== undefined) {
        const delayMs = this.recoveryRetryDelay(retryAttempt);
        retryAttempt += 1;
        this.options.logger?.warn({
          event: "agent-input-startup-recovery-failed", err: safeLogError(initialFailure), attempt: retryAttempt, delayMs, outcome: "retry"
        }, "Agent Input startup recovery page failed; durable scan retained for retry");
        await this.waitForRetry(delayMs);
      }
      while (more && !this.stopping) {
        await yieldToEventLoop();
        if (this.stopping) break;
        try {
          const page = this.options.store.claimRecoveryWorkPage({ limit: this.options.recoveryBatchLimit ?? 16, attemptedAt: this.now() });
          const activePage = run(page);
          this.activePage = activePage;
          more = await activePage.finally(() => { if (this.activePage === activePage) this.activePage = null; });
          retryAttempt = 0;
        } catch (error) {
          if (this.stopping) break;
          const delayMs = this.recoveryRetryDelay(retryAttempt);
          retryAttempt += 1;
          this.options.logger?.warn({
            event: "agent-input-startup-recovery-failed", err: safeLogError(error), attempt: retryAttempt, delayMs, outcome: "retry"
          }, "Agent Input startup recovery page failed; durable scan retained for retry");
          await this.waitForRetry(delayMs);
        }
      }
    })();
    const attachContinuation = (continuation: Promise<void>): void => {
      this.continuation = continuation.catch((error) => {
        this.options.logger?.warn({
          event: "agent-input-startup-recovery-stopped", err: safeLogError(error), outcome: "stopped"
        }, "Agent Input startup recovery continuation stopped unexpectedly");
      }).finally(() => { this.continuation = null; });
    };
    let first: ReturnType<AgentInputStore["claimRecoveryWorkPage"]>;
    try {
      first = this.options.store.claimRecoveryWorkPage({ limit: this.options.recoveryBatchLimit ?? 16, attemptedAt: this.now() });
    } catch (error) {
      attachContinuation(continueRecovery(error));
      return;
    }
    const firstPage = run(first);
    this.activePage = firstPage;
    let hasMore: boolean;
    try {
      hasMore = await firstPage;
    } catch (error) {
      if (this.activePage === firstPage) this.activePage = null;
      if (this.stopping) return;
      attachContinuation(continueRecovery(error));
      return;
    }
    if (this.activePage === firstPage) this.activePage = null;
    if (!hasMore || this.stopping) return;
    attachContinuation(continueRecovery());
  }

  async stopRecovery(): Promise<void> {
    this.stopping = true;
    this.clearRetry();
    await Promise.allSettled([...(this.activePage ? [this.activePage] : []), ...(this.continuation ? [this.continuation] : [])]);
  }

  private recoveryRetryDelay(attempt: number): number {
    const initial = Math.max(0, Math.floor(this.options.recoveryRetryInitialMs ?? RECOVERY_RETRY_INITIAL_MS));
    const maximum = Math.max(initial, Math.floor(this.options.recoveryRetryMaxMs ?? RECOVERY_RETRY_MAX_MS));
    return Math.min(initial * (2 ** Math.min(attempt, 16)), maximum);
  }

  private waitForRetry(delayMs: number): Promise<void> {
    if (this.stopping || delayMs === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.resolveRetry = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.resolveRetry = null;
        resolve();
      }, delayMs);
      this.retryTimer.unref?.();
    });
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const resolve = this.resolveRetry;
    this.resolveRetry = null;
    resolve?.();
  }

  private async submitRecovery(intent: SubmissionIntent): Promise<AgentInputRecoveryOutcome> {
    try {
      const capabilityFailure = await this.typedInputCapabilityFailure(intent);
      if (capabilityFailure) {
        if (capabilityFailure.definite) return {
          submissionId: intent.submissionId,
          kind: "rejected",
          cancellation: { code: capabilityFailure.code, detail: capabilityFailure.detail, recordedAt: this.now() }
        };
        return {
          submissionId: intent.submissionId,
          kind: "uncertain",
          uncertainty: { code: capabilityFailure.code, detail: capabilityFailure.detail, recordedAt: this.now() }
        };
      }
      const result = await this.options.core.submit({
        submissionId: intent.submissionId, paneId: intent.paneId, terminalId: intent.terminalId,
        agentKind: intent.expectedAgentKind, sessionId: intent.expectedSessionId, text: intent.text, input: intent.input
      });
      if (result.outcome === "receipt") return { submissionId: intent.submissionId, kind: "receipt", receipt: result.receipt };
      if (result.outcome === "rejected") return { submissionId: intent.submissionId, kind: "rejected", cancellation: { ...result.failure, recordedAt: this.now() } };
      return { submissionId: intent.submissionId, kind: "uncertain", uncertainty: { ...result.failure, recordedAt: this.now() } };
    } catch {
      return { submissionId: intent.submissionId, kind: "uncertain", uncertainty: { code: "core_submission_failure", detail: null, recordedAt: this.now() } };
    }
  }

  private async queryRecovery(intent: SubmissionIntent): Promise<AgentInputRecoveryOutcome> {
    try {
      const result = await this.options.core.queryReceipt(intent.submissionId);
      if (result.outcome === "receipt") return { submissionId: intent.submissionId, kind: "receipt", receipt: result.receipt };
      const failure = result.outcome === "absent" ? { code: "receipt_not_found", detail: "Core has no conclusive receipt" } : result.failure;
      return { submissionId: intent.submissionId, kind: "uncertain", uncertainty: { ...failure, recordedAt: this.now() } };
    } catch {
      return { submissionId: intent.submissionId, kind: "uncertain", uncertainty: { code: "core_receipt_query_failure", detail: null, recordedAt: this.now() } };
    }
  }

  private async query(submissionId: string): Promise<SubmissionIntent | null> {
    try {
      const result = await this.options.core.queryReceipt(submissionId);
      if (result.outcome === "receipt") {
        return this.options.store.recordReceipt(submissionId, result.receipt)
          ?? this.options.store.get(submissionId);
      }
      if (result.outcome === "absent") {
        return this.markUncertain(submissionId, "receipt_not_found", "Core has no conclusive receipt")
          ?? this.options.store.get(submissionId);
      }
      return this.markUncertain(submissionId, result.failure.code, result.failure.detail)
        ?? this.options.store.get(submissionId);
    } catch {
      return this.markUncertain(submissionId, "core_receipt_query_failure", null)
        ?? this.options.store.get(submissionId);
    }
  }

  private markUncertain(submissionId: string, code: string, detail: string | null): SubmissionIntent | null {
    return this.options.store.recordUncertain(submissionId, { code, detail, recordedAt: this.now() });
  }

  private async typedInputCapabilityFailure(intent: SubmissionIntent): Promise<{ code: string; detail: string; definite: boolean } | null> {
    if (!intent.input.choice) return null;
    if (intent.expectedSessionId === null) {
      return { code: "typed_input_session_required", detail: "Typed Agent Input requires an expected session identity", definite: true };
    }
    try {
      const capabilities = await this.options.core.capabilities();
      if (capabilities.agentInputTypedMessageV1 === true) return null;
      return {
        code: "agent_input_typed_message_v1_unavailable",
        detail: "Herdr Core does not advertise agent_input_typed_message_v1",
        definite: false
      };
    } catch {
      return {
        code: "agent_input_typed_message_v1_unavailable",
        detail: "Herdr Core typed Agent Input capability detection failed",
        definite: false
      };
    }
  }
}

function yieldToEventLoop(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
