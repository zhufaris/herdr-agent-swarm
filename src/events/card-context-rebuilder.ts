import type { Logger } from "pino";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { CardContextInvalidation } from "../domain/card-context-invalidation.js";
import type { CardContextProjectionStore } from "../domain/ports/card-context.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { OutboundWorkNotifier } from "./outbound-work-notifier.js";

export class CardContextRebuilder {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly store: CardContextProjectionStore, private readonly wakeOutbound: () => void, private readonly logger: Pick<Logger, "debug" | "error">, private readonly presentation: Pick<ApplicationPresentation, "workerMain" | "workerThreadEntryReady" | "workerTurn" | "mainCard" | "paneEntryCard" | "answerCard">, private readonly work?: OutboundWorkNotifier) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.stopping = false;
    this.unsubscribe = this.work?.subscribe(() => this.wake()) ?? null;
    this.timer = setInterval(() => this.wake(), intervalMs);
    this.timer.unref?.();
    this.wake();
  }

  requestScan(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.scan().finally(() => { this.running = null; });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private wake(): void {
    void this.requestScan().catch(() => {});
  }

  private async scan(): Promise<void> {
    let reserved = false;
    try {
      for (const invalidation of this.store.listPendingCardContextInvalidations(100)) reserved = this.project(invalidation) || reserved;
      if (reserved) this.wakeOutbound();
    } catch (error) {
      this.logger.error({ event: "card-context-rebuild-failed", err: safeLogError(error), outcome: "retry" }, "card context rebuild failed; durable invalidation retained");
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
