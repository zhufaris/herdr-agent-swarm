import type { DeliveryFailureMetadata, LarkDeliveryCooldownSummary } from "../../domain/types.js";
import { redactSecrets } from "../../runtime/redact-secrets.js";
import type { SqliteContext } from "./context.js";

interface CooldownRow { blocked_until: string; trigger_count: number; last_http_status: number | null; last_lark_error_code: string | null; last_reason: string }

/** Durable application-wide gate for Lark delivery quota responses. */
export class SqliteLarkDeliveryCooldownStore {
  constructor(private readonly context: SqliteContext) {}

  activeUntil(at = now()): string | null {
    const row = this.row();
    return row && row.blocked_until > at ? row.blocked_until : null;
  }

  extend(blockedUntil: string, reason: string, metadata: DeliveryFailureMetadata, timestamp = now()): void {
    this.context.database.prepare(`
      INSERT INTO lark_delivery_cooldowns(scope, blocked_until, trigger_count, last_http_status, last_lark_error_code, last_reason, created_at, updated_at)
      VALUES ('app', ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        blocked_until = MAX(lark_delivery_cooldowns.blocked_until, excluded.blocked_until),
        trigger_count = lark_delivery_cooldowns.trigger_count + 1,
        last_http_status = excluded.last_http_status,
        last_lark_error_code = excluded.last_lark_error_code,
        last_reason = excluded.last_reason,
        updated_at = excluded.updated_at
    `).run(blockedUntil, metadata.httpStatus, metadata.larkErrorCode, boundedReason(reason), timestamp, timestamp);
  }

  snapshot(at = now()): LarkDeliveryCooldownSummary {
    const row = this.row();
    if (!row) return { active: false, blockedUntil: null, remainingMs: 0, triggerCount: 0, lastHttpStatus: null, lastLarkErrorCode: null, lastReason: null };
    const remainingMs = Math.max(0, Date.parse(row.blocked_until) - Date.parse(at));
    return { active: remainingMs > 0, blockedUntil: row.blocked_until, remainingMs, triggerCount: Number(row.trigger_count), lastHttpStatus: row.last_http_status, lastLarkErrorCode: row.last_lark_error_code, lastReason: row.last_reason };
  }

  private row(): CooldownRow | null {
    return this.context.database.prepare("SELECT blocked_until, trigger_count, last_http_status, last_lark_error_code, last_reason FROM lark_delivery_cooldowns WHERE scope = 'app'").get() as CooldownRow | undefined ?? null;
  }
}

function boundedReason(value: string): string { return redactSecrets(value).slice(0, 500); }
function now(): string { return new Date().toISOString(); }
