import type { HistoricalRecoverySliceResult } from "../domain/historical-recovery.js";
import type { HistoricalMissingCardRecovery, HistoricalRecoveryStore } from "../domain/ports/historical-recovery.js";

export interface HistoricalRecoveryWorkflowOptions {
  maxEvents?: number;
  maxDurationMs?: number;
  maxCards?: number;
  cards?: HistoricalMissingCardRecovery;
  wakeOutbound?: () => void;
  now?: () => number;
  observedAt?: () => string;
  yieldNow?: () => Promise<void>;
}

export class HistoricalRecoveryWorkflow {
  private readonly maxEvents: number;
  private readonly maxDurationMs: number;
  private readonly maxCards: number;
  private readonly now: () => number;
  private readonly observedAt: () => string;
  private readonly yieldNow: () => Promise<void>;
  private readonly cards: HistoricalMissingCardRecovery | undefined;
  private readonly wakeOutbound: (() => void) | undefined;

  constructor(private readonly store: HistoricalRecoveryStore, options: HistoricalRecoveryWorkflowOptions = {}) {
    this.maxEvents = boundedPositive(options.maxEvents ?? 32, 128);
    this.maxDurationMs = boundedPositive(options.maxDurationMs ?? 5_000, 60_000);
    this.maxCards = boundedPositive(options.maxCards ?? 8, 32);
    this.now = options.now ?? (() => performance.now());
    this.observedAt = options.observedAt ?? (() => new Date().toISOString());
    this.yieldNow = options.yieldNow ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    this.cards = options.cards;
    this.wakeOutbound = options.wakeOutbound;
  }

  async recoverSlice(): Promise<HistoricalRecoverySliceResult> {
    const startedAt = this.now();
    let projected = 0;
    let retried = 0;
    let quarantined = 0;
    let stale = 0;
    let processed = 0;
    let oldestEligibleAt: string | null = null;
    for (; processed < this.maxEvents && this.now() - startedAt < this.maxDurationMs; processed += 1) {
      const candidate = this.store.listHistoricalRecoveryCandidates({ limit: 1 })[0];
      if (!candidate) break;
      oldestEligibleAt ??= candidate.oldestPendingAt;
      const result = this.store.reprojectHistoricalCandidate(candidate, this.observedAt());
      if (result.outcome === "projected") projected += 1;
      else if (result.outcome === "retry") retried += 1;
      else if (result.outcome === "quarantined") quarantined += 1;
      else stale += 1;
      await this.yieldNow();
    }
    let cardsReserved = 0;
    let cardsStale = 0;
    let cardsRemaining = false;
    if (this.cards) {
      let exhaustedBudget = true;
      for (let card = 0; card < this.maxCards && (card === 0 || this.now() - startedAt < this.maxDurationMs); card += 1) {
        const outcome = await this.cards.recoverNextHistoricalMissingCard();
        if (outcome === "none") { exhaustedBudget = false; break; }
        if (outcome === "reserved") { cardsReserved += 1; this.wakeOutbound?.(); }
        else cardsStale += 1;
        await this.yieldNow();
      }
      cardsRemaining = exhaustedBudget;
    }
    const remaining = this.store.listHistoricalRecoveryCandidates({ limit: 1 }).length > 0;
    const backlog = this.store.summarizeHistoricalRecoveryBacklog?.() ?? null;
    return {
      projected, retried, quarantined, stale, processed,
      cardsReserved, cardsStale, cardsRemaining,
      remaining, oldestEligibleAt, durationMs: Math.max(0, this.now() - startedAt), backlog
    };
  }
}

function boundedPositive(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}
