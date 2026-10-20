import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { LeaseStore } from "../domain/ports/health.js";
import type { InstanceLeaseStatus } from "../domain/types.js";
import { safeLogError } from "./safe-error.js";

export class InstanceLeaseController {
  private readonly ownerId: string;
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryWake: ((continueRetry: boolean) => void) | null = null;
  private renewalPromise: Promise<boolean> | null = null;
  private status: InstanceLeaseStatus;
  private onLost: (() => void | Promise<void>) | null = null;

  constructor(
    private readonly store: LeaseStore,
    private readonly options: {
      ttlMs: number;
      heartbeatMs: number;
      sqliteBusyTimeoutMs?: number;
      sqliteBusyRetryBudgetMs?: number;
      classifySqliteFailure?(error: unknown): "busy" | "locked" | "other";
      random?: () => number;
    },
    private readonly logger: Pick<Logger, "info" | "warn" | "error">,
    private readonly clock: () => number = Date.now,
    ownerId = randomUUID()
  ) {
    this.ownerId = ownerId;
    this.status = { held: false, ownerSuffix: ownerId.slice(-8), fencingToken: null, expiresAt: null, lastRenewedAt: null, error: null };
  }

  acquire(): void {
    const timestamp = this.clock();
    const lease = this.store.acquireInstanceLease(this.ownerId, iso(timestamp), iso(timestamp + this.options.ttlMs));
    if (!lease) {
      this.status = { ...this.status, held: false, error: "Lease is held by another bridge instance" };
      this.logger.warn({ event: "instance-lease-contended", ownerSuffix: this.status.ownerSuffix, outcome: "rejected" }, "another bridge instance owns the database lease");
      throw new Error("Bridge database lease is held by another live instance");
    }
    this.status = { held: true, ownerSuffix: this.status.ownerSuffix, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt, lastRenewedAt: lease.updatedAt, error: null };
    this.logger.info({ event: "instance-lease-acquired", ownerSuffix: this.status.ownerSuffix, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt, outcome: "acquired" }, "bridge instance lease acquired");
  }

  start(onLost: () => void | Promise<void>): void {
    if (!this.status.held) throw new Error("Cannot start lease heartbeat before acquisition");
    if (this.timer) return;
    this.onLost = onLost;
    this.timer = setInterval(() => void this.renewNow(), this.options.heartbeatMs);
    this.timer.unref();
  }

  renewNow(): Promise<boolean> {
    if (!this.status.held || this.status.fencingToken === null) return Promise.resolve(false);
    if (this.renewalPromise) return this.renewalPromise;
    const renewal = this.performRenewal().finally(() => {
      if (this.renewalPromise === renewal) this.renewalPromise = null;
    });
    this.renewalPromise = renewal;
    return renewal;
  }

  private async performRenewal(): Promise<boolean> {
    const firstAttemptStartedAt = this.clock();
    let deadlineMs: number | null = null;
    let attempt = 0;
    while (this.status.held && this.status.fencingToken !== null) {
      if (deadlineMs !== null && !this.hasAttemptRoom(deadlineMs)) return this.lose("SQLite lock retry deadline exhausted before lease renewal");
      try {
        const lease = this.store.renewInstanceLease(this.ownerId, this.status.fencingToken, this.options.ttlMs);
        if (!lease) return this.lose("Lease ownership, fencing token, or expiry changed");
        this.status = { ...this.status, expiresAt: lease.expiresAt, lastRenewedAt: lease.updatedAt, error: null };
        return true;
      } catch (error) {
        const failureClass = this.options.classifySqliteFailure?.(error) ?? "other";
        if (failureClass !== "busy" && failureClass !== "locked") {
          this.logger.error({ event: "instance-lease-renewal-failed", err: safeLogError(error), ownerSuffix: this.status.ownerSuffix, fencingToken: this.status.fencingToken, outcome: "lost" }, "bridge instance lease renewal failed");
          return this.lose(error instanceof Error ? error.message : String(error));
        }
        if ((this.options.sqliteBusyRetryBudgetMs ?? 0) <= 0) return this.lose(`SQLite ${failureClass} prevented lease renewal`);
        if (deadlineMs === null) deadlineMs = this.renewalDeadline(firstAttemptStartedAt);
        if (!this.hasAttemptRoom(deadlineMs)) return this.lose("SQLite lock retry deadline exhausted before lease renewal");
        attempt += 1;
        const delayMs = this.retryDelay(attempt, deadlineMs);
        this.logger.warn({
          event: "instance-lease-renewal-retry-scheduled",
          failureClass,
          attempt,
          delayMs,
          remainingBudgetMs: Math.max(0, deadlineMs - this.clock()),
          outcome: "retry_scheduled"
        }, "SQLite lock contention delayed the instance lease heartbeat");
        if (!await this.waitForRetry(delayMs)) return false;
        // This execution-time check is authoritative; a delayed timer never enters SQLite.
        if (!this.hasAttemptRoom(deadlineMs)) return this.lose("SQLite lock retry deadline exhausted before lease renewal");
      }
    }
    return false;
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelRetryWait();
    if (!this.status.held || this.status.fencingToken === null) return;
    const released = this.store.releaseInstanceLease(this.ownerId, this.status.fencingToken);
    this.logger.info({ event: "instance-lease-released", ownerSuffix: this.status.ownerSuffix, fencingToken: this.status.fencingToken, outcome: released ? "released" : "already_lost" }, "bridge instance lease released");
    this.status = { ...this.status, held: false, expiresAt: null };
  }

  snapshot(): InstanceLeaseStatus { return { ...this.status }; }

  writeFence(): { ownerId: string; fencingToken: number } {
    if (!this.status.held || this.status.fencingToken === null) throw new Error("Cannot activate write fence without a held lease");
    return { ownerId: this.ownerId, fencingToken: this.status.fencingToken };
  }

  private lose(reason: string): false {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelRetryWait();
    this.status = { ...this.status, held: false, error: reason };
    this.logger.error({ event: "instance-lease-lost", ownerSuffix: this.status.ownerSuffix, fencingToken: this.status.fencingToken, reason, outcome: "shutdown" }, "bridge instance lease lost");
    const onLost = this.onLost;
    if (onLost) {
      void Promise.resolve().then(onLost).catch((error) => {
        this.logger.error({ event: "instance-lease-shutdown-failed", err: safeLogError(error), ownerSuffix: this.status.ownerSuffix, fencingToken: this.status.fencingToken, outcome: "failed" }, "bridge shutdown failed after instance lease loss");
      });
    }
    return false;
  }

  private retryDelay(attempt: number, deadlineMs: number): number {
    const roomForAttemptMs = deadlineMs - this.clock() - (this.options.sqliteBusyTimeoutMs ?? 0);
    const jitterCapMs = Math.max(1, Math.min(roomForAttemptMs, 25 * (2 ** Math.min(attempt - 1, 3))));
    const random = this.options.random ?? Math.random;
    return Math.max(1, Math.floor(random() * jitterCapMs));
  }

  private renewalDeadline(attemptStartedAt: number): number {
    const busyTimeoutMs = this.options.sqliteBusyTimeoutMs ?? 0;
    const retryBudgetMs = this.options.sqliteBusyRetryBudgetMs ?? 0;
    const leaseExpiryMs = this.status.expiresAt ? Date.parse(this.status.expiresAt) : Number.POSITIVE_INFINITY;
    return Math.min(attemptStartedAt + busyTimeoutMs + retryBudgetMs, leaseExpiryMs);
  }

  private hasAttemptRoom(deadlineMs: number): boolean {
    return this.clock() + (this.options.sqliteBusyTimeoutMs ?? 0) <= deadlineMs;
  }

  private waitForRetry(delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.retryWake = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retryWake = null;
        resolve(true);
      }, delayMs);
      this.retryTimer.unref();
    });
  }

  private cancelRetryWait(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const wake = this.retryWake;
    this.retryWake = null;
    wake?.(false);
  }
}

function iso(value: number): string { return new Date(value).toISOString(); }
