import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { LeaseStore } from "../domain/ports.js";
import type { InstanceLeaseStatus } from "../domain/types.js";
import { safeLogError } from "./safe-error.js";

export class InstanceLeaseController {
  private readonly ownerId: string;
  private timer: NodeJS.Timeout | null = null;
  private status: InstanceLeaseStatus;
  private onLost: (() => void | Promise<void>) | null = null;

  constructor(
    private readonly store: LeaseStore,
    private readonly options: { ttlMs: number; heartbeatMs: number },
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
    this.onLost = onLost;
    this.timer = setInterval(() => void this.renewNow(), this.options.heartbeatMs);
    this.timer.unref();
  }

  renewNow(): boolean {
    if (!this.status.held || this.status.fencingToken === null) return false;
    try {
      const timestamp = this.clock();
      const lease = this.store.renewInstanceLease(this.ownerId, this.status.fencingToken, iso(timestamp), iso(timestamp + this.options.ttlMs));
      if (!lease) return this.lose("Lease ownership or fencing token changed");
      this.status = { ...this.status, expiresAt: lease.expiresAt, lastRenewedAt: lease.updatedAt, error: null };
      return true;
    } catch (error) {
      this.logger.error({ event: "instance-lease-renewal-failed", err: safeLogError(error), ownerSuffix: this.status.ownerSuffix, fencingToken: this.status.fencingToken, outcome: "lost" }, "bridge instance lease renewal failed");
      return this.lose(error instanceof Error ? error.message : String(error));
    }
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
}

function iso(value: number): string { return new Date(value).toISOString(); }
