import type { Logger } from "pino";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { CardContextInvalidation } from "../domain/card-context-invalidation.js";
import type { CardContextProjectionStore } from "../domain/ports/card-context.js";
import { safeLogError } from "../runtime/safe-error.js";
import { CoalescingDrain } from "../runtime/coalescing-drain.js";
import type { OutboundWorkNotifier } from "./outbound-work-notifier.js";
import type { PreparedDeliveryProjectionRecoveryHint } from "../domain/ports/prepared-delivery.js";

type CardContextRecoveryHint = Extract<PreparedDeliveryProjectionRecoveryHint, { kind: "card-context" }>;
type InvalidatingCardContextProjectionStore = CardContextProjectionStore & {
  invalidateCardContexts?: (targets: ReadonlyArray<CardContextRecoveryHint & { reason: string }>) => unknown;
};

export class CardContextRebuilder {
  private static readonly batchSize = 100;
  private readonly drain = new CoalescingDrain({ drain: () => this.scan(), onError: () => {} });
  private started = false;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly store: InvalidatingCardContextProjectionStore, private readonly wakeOutbound: () => void, private readonly logger: Pick<Logger, "debug" | "error">, private readonly presentation: Pick<ApplicationPresentation, "workerMain" | "workerThreadEntryReady" | "workerTurn" | "mainCard" | "paneEntryCard" | "answerCard">, private readonly work?: OutboundWorkNotifier) {}

  start(intervalMs: number): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.unsubscribe = this.work?.subscribe(() => this.drain.wake()) ?? null;
    this.drain.start(intervalMs);
  }

  requestScan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.started ? this.drain.request() : this.scan();
  }

  requestProjectionRecovery(hint: CardContextRecoveryHint): Promise<void> {
    if (!this.store.invalidateCardContexts) return Promise.reject(new Error("Card Context invalidation is unavailable"));
    this.store.invalidateCardContexts([{ ...hint, reason: "delivery.invalid-owner-retired" }]);
    return this.requestScan();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.drain.stop();
    this.started = false;
  }

  private async scan(): Promise<void> {
    let reserved = false;
    let activeInvalidation: CardContextInvalidation | null = null;
    try {
      let previousFullBatch = "";
      for (;;) {
        const invalidations = this.store.listPendingCardContextInvalidations(CardContextRebuilder.batchSize);
        if (invalidations.length === 0) break;
        const batchIdentity = invalidations.map(({ targetKind, targetId, targetGeneration, requestedDependencyRevision }) => `${targetKind}:${targetId}:${targetGeneration}:${requestedDependencyRevision}`).join("\n");
        if (batchIdentity === previousFullBatch) break;
        for (const invalidation of invalidations) {
          activeInvalidation = invalidation;
          reserved = this.project(invalidation) || reserved;
          activeInvalidation = null;
        }
        if (invalidations.length < CardContextRebuilder.batchSize) break;
        previousFullBatch = batchIdentity;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (reserved) this.wakeOutbound();
    } catch (error) {
      this.logger.error({
        event: "card-context-rebuild-failed", err: safeLogError(error), outcome: "retry",
        ...(activeInvalidation ? {
          targetKind: activeInvalidation.targetKind, targetId: activeInvalidation.targetId,
          targetGeneration: activeInvalidation.targetGeneration,
          dependencyRevision: activeInvalidation.requestedDependencyRevision
        } : {})
      }, "card context rebuild failed; durable invalidation retained");
      throw error;
    }
  }

  private project(invalidation: CardContextInvalidation): boolean {
    const renderers = { workerMain: this.presentation.workerMain, workerThreadEntryReady: this.presentation.workerThreadEntryReady, workerTask: this.presentation.workerTurn, primaryMain: this.presentation.mainCard, primaryPaneEntry: this.presentation.paneEntryCard, primaryAnswer: this.presentation.answerCard };
    const outcome = this.store.projectCardContext(invalidation, renderers);
    this.logger.debug({ event: "card-context-rebuilt", targetKind: invalidation.targetKind, targetId: invalidation.targetId, targetGeneration: invalidation.targetGeneration, dependencyRevision: invalidation.requestedDependencyRevision, outcome }, "rebuilt card context projection");
    return outcome === "reserved";
  }
}
