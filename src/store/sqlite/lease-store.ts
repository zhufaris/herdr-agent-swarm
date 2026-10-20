import type { InstanceLease } from "../../domain/types.js";
import { mapInstanceLease } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import { hasLeaseExpiryMilliseconds, leaseExpiryMs, parseLeaseTimestampMs, SQLITE_NOW_MS } from "./lease-time.js";
import { LEASE_FENCED_TABLES } from "./schema-manifest.js";
import { deliveryDegradationBudget } from "../../domain/delivery-conflict.js";

export const STALE_DELIVERY_CLAIM_BATCH_LIMIT = 100;
export interface StaleDeliveryClaimCursor { afterId: string; highWaterId: string }
export interface StaleDeliveryClaimBatchResult {
  recoveredCount: number;
  next: StaleDeliveryClaimCursor | null;
  hasMore: boolean;
}

export class SqliteLeaseStore {
  constructor(private readonly context: SqliteContext, private readonly clock: () => number = Date.now) {}

  activateWriteFence(ownerId: string, fencingToken: number): void {
    this.deactivateWriteFence();
    try {
      this.context.database.exec("CREATE TEMP TABLE bridge_write_fence(owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL)");
      this.context.database.prepare("INSERT INTO temp.bridge_write_fence(owner_id, fencing_token) VALUES (?, ?)").run(ownerId, fencingToken);
      for (const { name: table } of LEASE_FENCED_TABLES) for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
        const trigger = `bridge_fence_${table}_${operation.toLowerCase()}`;
        this.context.database.exec(`
          CREATE TEMP TRIGGER ${trigger} BEFORE ${operation} ON main.${table}
          BEGIN
            SELECT CASE WHEN NOT EXISTS (
              SELECT 1 FROM main.instance_lease AS lease, temp.bridge_write_fence AS fence
              WHERE lease.singleton_id = 1 AND lease.owner_id = fence.owner_id
                AND lease.fencing_token = fence.fencing_token
                AND lease.expires_at_ms > ${SQLITE_NOW_MS}
            ) THEN RAISE(ABORT, 'stale_instance_lease') END;
          END;
        `);
      }
      this.assertWriteFence();
      return;
    } catch (error) {
      this.deactivateWriteFence();
      throw error;
    }
  }

  recoverPriorOwnerClaimsBatch(
    ownerId: string,
    fencingToken: number,
    after: StaleDeliveryClaimCursor | null,
    limit = STALE_DELIVERY_CLAIM_BATCH_LIMIT,
    occurredAt = new Date(this.clock()).toISOString()
  ): StaleDeliveryClaimBatchResult {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    return this.context.transaction("sqlite.lease.recover-stale-claims", () => {
      this.assertWriteFence();
      const activeFence = this.context.database.prepare("SELECT owner_id,fencing_token FROM temp.bridge_write_fence").get() as {
        owner_id: string; fencing_token: number;
      } | undefined;
      if (!activeFence || activeFence.owner_id !== ownerId || Number(activeFence.fencing_token) !== fencingToken) {
        throw new Error("stale_instance_lease");
      }
      const highWaterId = after?.highWaterId ?? (this.context.database.prepare(`SELECT MAX(id) AS id
        FROM outbound_replies INDEXED BY outbound_replies_active_claim_id
        WHERE claim_attempt_id IS NOT NULL AND (claimed_owner_id IS NOT ? OR claimed_fence IS NOT ?)`)
        .get(ownerId, fencingToken) as { id: string | null }).id;
      if (!highWaterId) return { recoveredCount: 0, next: after, hasMore: false };
      const candidates = this.context.database.prepare(`SELECT id,lane_key,conflict_key,claim_attempt_id
        FROM outbound_replies INDEXED BY outbound_replies_active_claim_id
        WHERE claim_attempt_id IS NOT NULL
          AND (claimed_owner_id IS NOT ? OR claimed_fence IS NOT ?)
          AND id>?
          AND id<=?
        ORDER BY id LIMIT ?`).all(ownerId, fencingToken, after?.afterId ?? "", highWaterId, boundedLimit + 1) as Array<{
          id: string; lane_key: string; conflict_key: string; claim_attempt_id: string;
        }>;
      const page = candidates.slice(0, boundedLimit);
      for (const claim of page) {
        const changed = this.context.database.prepare(`UPDATE outbound_replies SET
          state='dead_letter',claim_attempt_id=NULL,claimed_owner_id=NULL,claimed_fence=NULL,claimed_at=NULL,claim_expires_at=NULL,
          failure_class='unknown',effect_certainty='uncertain',error='Delivery outcome uncertain after owner loss; inspect before manual retry',
          dead_lettered_at=?,updated_at=?
          WHERE id=? AND claim_attempt_id=? AND (claimed_owner_id IS NOT ? OR claimed_fence IS NOT ?)`)
          .run(occurredAt, occurredAt, claim.id, claim.claim_attempt_id, ownerId, fencingToken);
        if (changed.changes !== 1) throw new Error("stale_delivery_claim_changed_during_recovery");
        const budget = deliveryDegradationBudget({ failureClass: "unknown", effectCertainty: "uncertain", firstFailedAt: occurredAt });
        this.context.database.prepare(`INSERT INTO outbox_lane_quarantines(
          lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at,
          conflict_key,phase,first_failed_at,grace_deadline_at,budget_attempt_limit,budget_duration_ms
        ) VALUES (?,?,'immutable','unknown','active','blocked','Delivery outcome uncertain after owner loss',?,?,?,'grace_blocking',?,?,?,?)
        ON CONFLICT(lane_key) DO UPDATE SET failed_reply_id=excluded.failed_reply_id,lane_class='immutable',failure_class='unknown',
          state='active',action='blocked',reason=excluded.reason,updated_at=excluded.updated_at,released_at=NULL,
          conflict_key=excluded.conflict_key,phase='grace_blocking',first_failed_at=excluded.first_failed_at,
          grace_deadline_at=excluded.grace_deadline_at,degraded_at=NULL,budget_attempt_limit=excluded.budget_attempt_limit,
          budget_duration_ms=excluded.budget_duration_ms`)
          .run(claim.lane_key, claim.id, occurredAt, occurredAt, claim.conflict_key, occurredAt, budget.deadlineAt, budget.attemptLimit, budget.durationMs);
      }
      return {
        recoveredCount: page.length,
        next: page.length > 0 ? { afterId: page.at(-1)!.id, highWaterId } : after,
        hasMore: candidates.length > boundedLimit
      };
    });
  }

  deactivateWriteFence(): void {
    for (const { name: table } of LEASE_FENCED_TABLES) for (const operation of ["insert", "update", "delete"] as const) {
      this.context.database.exec(`DROP TRIGGER IF EXISTS temp.bridge_fence_${table}_${operation}`);
    }
    this.context.database.exec("DROP TABLE IF EXISTS temp.bridge_write_fence");
  }

  acquireInstanceLease(ownerId: string, currentTime: string, expiresAt: string): InstanceLease | null {
    return this.context.transaction("sqlite.lease.acquire", () => {
      const currentTimeMs = parseLeaseTimestampMs(currentTime, "currentTime");
      const expiresAtMs = parseLeaseTimestampMs(expiresAt, "expiresAt");
      const hasExpiryMs = this.hasLeaseExpiryMs();
      const row = this.context.database.prepare(`SELECT owner_id,fencing_token,expires_at,updated_at${hasExpiryMs ? ",expires_at_ms" : ""}
        FROM instance_lease WHERE singleton_id = 1`).get() as LeaseRow | undefined;
      if (row) leaseExpiryMs(row);
      if (!row) {
        if (hasExpiryMs) this.context.database.prepare("INSERT INTO instance_lease(singleton_id,owner_id,fencing_token,expires_at,expires_at_ms,updated_at) VALUES (1,?,1,?,?,?)")
          .run(ownerId, expiresAt, expiresAtMs, currentTime);
        else this.context.database.prepare("INSERT INTO instance_lease(singleton_id,owner_id,fencing_token,expires_at,updated_at) VALUES (1,?,1,?,?)")
          .run(ownerId, expiresAt, currentTime);
      } else if (row.owner_id === ownerId) {
        const sql = hasExpiryMs
          ? "UPDATE instance_lease SET expires_at=?,expires_at_ms=?,updated_at=? WHERE singleton_id=1 AND owner_id=? AND fencing_token=?"
          : "UPDATE instance_lease SET expires_at=?,updated_at=? WHERE singleton_id=1 AND owner_id=? AND fencing_token=?";
        this.context.database.prepare(sql).run(...(hasExpiryMs
          ? [expiresAt, expiresAtMs, currentTime, ownerId, row.fencing_token]
          : [expiresAt, currentTime, ownerId, row.fencing_token]));
      } else if (leaseExpiryMs(row) <= currentTimeMs) {
        const sql = hasExpiryMs
          ? "UPDATE instance_lease SET owner_id=?,fencing_token=fencing_token+1,expires_at=?,expires_at_ms=?,updated_at=? WHERE singleton_id=1 AND fencing_token=? AND expires_at=? AND expires_at_ms=?"
          : "UPDATE instance_lease SET owner_id=?,fencing_token=fencing_token+1,expires_at=?,updated_at=? WHERE singleton_id=1 AND fencing_token=? AND expires_at=?";
        this.context.database.prepare(sql).run(...(hasExpiryMs
          ? [ownerId, expiresAt, expiresAtMs, currentTime, row.fencing_token, row.expires_at, row.expires_at_ms!]
          : [ownerId, expiresAt, currentTime, row.fencing_token, row.expires_at]));
      } else {
        return null;
      }
      const acquired = this.context.database.prepare("SELECT owner_id,fencing_token,expires_at,updated_at FROM instance_lease WHERE singleton_id=1 AND owner_id=?").get(ownerId) as LeaseRow | undefined;
      return acquired ? mapInstanceLease(acquired) : null;
    });
  }

  renewInstanceLease(ownerId: string, fencingToken: number, ttlMs: number): InstanceLease | null {
    return this.context.transaction("sqlite.lease.renew", () => {
      const timestamp = this.clock();
      const currentTime = new Date(timestamp).toISOString();
      const expiresAt = new Date(timestamp + ttlMs).toISOString();
      const expiresAtMs = timestamp + ttlMs;
      const hasExpiryMs = this.hasLeaseExpiryMs();
      const existing = this.context.database.prepare(`SELECT expires_at${hasExpiryMs ? ",expires_at_ms" : ""} FROM instance_lease
        WHERE singleton_id=1 AND owner_id=? AND fencing_token=?`).get(ownerId, fencingToken) as LeaseExpiryRow | undefined;
      if (!existing || leaseExpiryMs(existing) <= timestamp) return null;
      const sql = hasExpiryMs
        ? "UPDATE instance_lease SET expires_at=?,expires_at_ms=?,updated_at=? WHERE singleton_id=1 AND owner_id=? AND fencing_token=? AND expires_at=? AND expires_at_ms=?"
        : "UPDATE instance_lease SET expires_at=?,updated_at=? WHERE singleton_id=1 AND owner_id=? AND fencing_token=? AND expires_at=?";
      const result = this.context.database.prepare(sql).run(...(hasExpiryMs
        ? [expiresAt, expiresAtMs, currentTime, ownerId, fencingToken, existing.expires_at, existing.expires_at_ms!]
        : [expiresAt, currentTime, ownerId, fencingToken, existing.expires_at]));
      if (result.changes !== 1) return null;
      const row = this.context.database.prepare("SELECT owner_id, fencing_token, expires_at, updated_at FROM instance_lease WHERE singleton_id = 1").get() as { owner_id: string; fencing_token: number; expires_at: string; updated_at: string };
      return mapInstanceLease(row);
    });
  }

  releaseInstanceLease(ownerId: string, fencingToken: number): boolean {
    return this.context.transaction("sqlite.lease.release", () =>
      this.context.database.prepare("DELETE FROM instance_lease WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ?").run(ownerId, fencingToken).changes === 1
    );
  }

  private assertWriteFence(): void {
    const valid = this.context.database.prepare(`
      SELECT 1 FROM main.instance_lease AS lease, temp.bridge_write_fence AS fence
      WHERE lease.singleton_id = 1 AND lease.owner_id = fence.owner_id
        AND lease.fencing_token = fence.fencing_token
        AND lease.expires_at_ms > ${SQLITE_NOW_MS}
    `).get();
    if (!valid) throw new Error("stale_instance_lease");
  }

  private hasLeaseExpiryMs(): boolean {
    return hasLeaseExpiryMilliseconds(this.context.database);
  }
}

interface LeaseExpiryRow {
  expires_at: string;
  expires_at_ms?: number;
}

interface LeaseRow extends LeaseExpiryRow {
  owner_id: string;
  fencing_token: number;
  updated_at: string;
}
