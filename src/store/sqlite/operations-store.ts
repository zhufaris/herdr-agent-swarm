import type { AttachmentState, SessionLifecycle } from "../../domain/pane-thread-lifecycle.js";
import type { BindingState, DeliveryFailureClass, OperationalSummary, OutboundReply, OutboundReplyState, OutboxLaneClass, PromptState, RetiredPaneCleanupState, SessionOperationState, SqliteIntegrityInspection } from "../../domain/types.js";
import { inspectSqliteIntegrity } from "../sqlite-integrity.js";
import type { SqliteContext } from "./context.js";

export class SqliteOperationsStore {
  constructor(private readonly context: SqliteContext) {}

  inspectIntegrity(limit: number): SqliteIntegrityInspection {
    return inspectSqliteIntegrity(this.context.database, limit);
  }

  getOperationalSummary(): OperationalSummary {
    const promptLatencyWindowSize = 100;
    const observedAt = now();
    const stalledBefore = new Date(Date.parse(observedAt) - 300_000).toISOString();
    const groupedCounts = <T extends string>(table: string, column: string, values: readonly T[]): Record<T, number> => {
      const result = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
      const rows = this.context.database.prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all() as Array<{ value: T; count: number }>;
      for (const row of rows) result[row.value] = Number(row.count);
      return result;
    };
    const recentFailedPrompt = this.context.database.prepare("SELECT id, binding_id, updated_at, error FROM prompt_jobs WHERE state = 'failed' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as { id: string; binding_id: string; updated_at: string; error: string | null } | undefined;
    const inboundStates = groupedCounts<"received" | "processing" | "accepted">("inbound_messages", "state", ["received", "processing", "accepted"]);
    const inboundPending = this.context.database.prepare("SELECT MIN(created_at) AS oldest_pending_at, SUM(CASE WHEN state = 'received' AND error IS NOT NULL THEN 1 ELSE 0 END) AS retryable FROM inbound_messages WHERE state IN ('received', 'processing')").get() as { oldest_pending_at: string | null; retryable: number | null };
    const recentInboundFailure = this.context.database.prepare("SELECT event_id, updated_at, error FROM inbound_messages WHERE error IS NOT NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as { event_id: string; updated_at: string; error: string } | undefined;
    const sessionOperationStates = groupedCounts<SessionOperationState>("session_operations", "state", ["accepted", "running", "succeeded", "rejected", "failed", "uncertain"]);
    const oldestAcceptedSessionOperation = this.context.database.prepare("SELECT MIN(created_at) AS value FROM session_operations WHERE state = 'accepted'").get() as { value: string | null };
    const unresolvedDeadLetter = "o.state = 'dead_letter' AND NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery WHERE recovery.failed_reply_id = o.id AND recovery.state IN ('recovered', 'dismissed'))";
    const recentDeadLetter = this.context.database.prepare(`SELECT o.id, o.binding_id, o.prompt_id, o.attempt_count, o.updated_at, o.error FROM outbound_replies o WHERE ${unresolvedDeadLetter} ORDER BY o.updated_at DESC, o.rowid DESC LIMIT 1`).get() as { id: string; binding_id: string | null; prompt_id: string | null; attempt_count: number; updated_at: string; error: string | null } | undefined;
    const promptLatency = this.context.database.prepare(`
      WITH recent AS (
        SELECT p.created_at, r.started_at, r.finished_at, (
          SELECT MIN(o.updated_at) FROM outbound_replies o
          WHERE o.prompt_id = p.id AND o.kind = 'stream_finish' AND o.state = 'delivered' AND o.updated_at >= r.finished_at
        ) AS delivered_at
        FROM prompt_jobs p JOIN run_cards r ON r.prompt_id = p.id
        WHERE p.state IN ('delivered', 'failed', 'cancelled') AND r.finished_at IS NOT NULL
        ORDER BY r.finished_at DESC, p.rowid DESC LIMIT ${promptLatencyWindowSize}
      )
      SELECT COUNT(*) AS sample_count,
        COUNT(started_at) AS queue_count, ROUND(AVG(MAX(0, (julianday(started_at) - julianday(created_at)) * 86400000))) AS queue_average_ms, ROUND(MAX(MAX(0, (julianday(started_at) - julianday(created_at)) * 86400000))) AS queue_max_ms,
        COUNT(CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL THEN 1 END) AS execution_count, ROUND(AVG(CASE WHEN started_at IS NOT NULL THEN MAX(0, (julianday(finished_at) - julianday(started_at)) * 86400000) END)) AS execution_average_ms, ROUND(MAX(CASE WHEN started_at IS NOT NULL THEN MAX(0, (julianday(finished_at) - julianday(started_at)) * 86400000) END)) AS execution_max_ms,
        COUNT(delivered_at) AS delivery_count, ROUND(AVG(CASE WHEN delivered_at IS NOT NULL THEN MAX(0, (julianday(delivered_at) - julianday(finished_at)) * 86400000) END)) AS delivery_average_ms, ROUND(MAX(CASE WHEN delivered_at IS NOT NULL THEN MAX(0, (julianday(delivered_at) - julianday(finished_at)) * 86400000) END)) AS delivery_max_ms
      FROM recent
    `).get() as Record<string, number | null>;
    const latencyPhase = (prefix: "queue" | "execution" | "delivery") => ({
      sampleCount: Number(promptLatency[`${prefix}_count`] ?? 0),
      averageMs: promptLatency[`${prefix}_average_ms`] === null ? null : Number(promptLatency[`${prefix}_average_ms`]),
      maxMs: promptLatency[`${prefix}_max_ms`] === null ? null : Number(promptLatency[`${prefix}_max_ms`])
    });
    const oldestPending = this.context.database.prepare("SELECT MIN(created_at) AS value FROM outbound_replies WHERE state = 'pending'").get() as { value: string | null };
    const laneHealth = this.context.database.prepare(`
      SELECT COUNT(*) AS pending,
        SUM(CASE WHEN h.next_attempt_at <= ? THEN 1 ELSE 0 END) AS eligible,
        SUM(CASE WHEN o.error IS NOT NULL OR h.next_attempt_at > ? THEN 1 ELSE 0 END) AS blocked,
        MIN(CASE WHEN h.next_attempt_at > ? THEN h.next_attempt_at END) AS next_attempt_at,
        MIN(h.created_at) AS oldest_head_at,
        SUM(CASE WHEN h.next_attempt_at <= ? AND h.created_at <= ? THEN 1 ELSE 0 END) AS stalled,
        MIN(CASE WHEN h.next_attempt_at <= ? AND h.created_at <= ? THEN h.created_at END) AS oldest_stalled_at
      FROM outbox_lane_heads h
      JOIN outbound_replies o ON o.id = h.reply_id
    `).get(observedAt, observedAt, observedAt, observedAt, stalledBefore, observedAt, stalledBefore) as { pending: number; eligible: number | null; blocked: number | null; next_attempt_at: string | null; oldest_head_at: string | null; stalled: number | null; oldest_stalled_at: string | null };
    const outbound = groupedCounts<OutboundReplyState>("outbound_replies", "state", ["pending", "delivered", "dead_letter", "dismissed"]);
    const deadLettersByClass = { transient: 0, permanent: 0, unknown: 0, legacy: 0 };
    const failureRows = this.context.database.prepare("SELECT failure_class, COUNT(*) AS count FROM outbound_replies WHERE state = 'dead_letter' GROUP BY failure_class").all() as Array<{ failure_class: DeliveryFailureClass | null; count: number }>;
    for (const row of failureRows) deadLettersByClass[row.failure_class ?? "legacy"] = Number(row.count);
    const unresolvedDeadLettersByClass = { transient: 0, permanent: 0, unknown: 0, legacy: 0 };
    const unresolvedFailureRows = this.context.database.prepare(`SELECT o.failure_class, COUNT(*) AS count FROM outbound_replies o WHERE ${unresolvedDeadLetter} GROUP BY o.failure_class`).all() as Array<{ failure_class: DeliveryFailureClass | null; count: number }>;
    for (const row of unresolvedFailureRows) unresolvedDeadLettersByClass[row.failure_class ?? "legacy"] = Number(row.count);
    const unresolvedDeadLetters = unresolvedFailureRows.reduce((total, row) => total + Number(row.count), 0);
    const eligibleRecoveries = this.context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE state = 'dead_letter' AND failure_class = 'transient' AND auto_recovery_count = 0 AND dead_lettered_at IS NOT NULL AND dead_lettered_at <= ?").get(new Date(Date.parse(observedAt) - 300_000).toISOString()) as { count: number };
    const quarantineStates = groupedCounts<"active" | "released">("outbox_lane_quarantines", "state", ["active", "released"]);
    const quarantinesByLaneClass = groupedCounts<OutboxLaneClass>("outbox_lane_quarantines", "lane_class", ["answer_stream", "main_card", "replaceable_card", "immutable"]);
    const quarantinesByFailureClass = groupedCounts<DeliveryFailureClass>("outbox_lane_quarantines", "failure_class", ["transient", "permanent", "unknown"]);
    const latestQuarantine = this.context.database.prepare(`SELECT q.failed_reply_id, o.kind AS reply_kind, q.lane_class, q.failure_class, q.action, q.reason, q.created_at, q.released_at
      FROM outbox_lane_quarantines q JOIN outbound_replies o ON o.id = q.failed_reply_id ORDER BY q.updated_at DESC LIMIT 1`).get() as { failed_reply_id: string; reply_kind: OutboundReply["kind"]; lane_class: OutboxLaneClass; failure_class: DeliveryFailureClass; action: string; reason: string; created_at: string; released_at: string | null } | undefined;
    const oldestInactive = this.context.database.prepare("SELECT MIN(last_activity_at) AS value FROM bindings WHERE lifecycle != 'active' OR attachment != 'attached'").get() as { value: string | null };
    const recoverableProvisioning = this.context.database.prepare("SELECT COUNT(*) AS count FROM project_selections WHERE state = 'processing' AND binding_id IS NOT NULL").get() as { count: number };
    const archivedPanesPresent = this.context.database.prepare("SELECT COUNT(*) AS count FROM bindings WHERE lifecycle = 'archived' AND pane_id IS NOT NULL").get() as { count: number };
    const cleanupCandidates = this.context.database.prepare("SELECT COUNT(*) AS count FROM bindings WHERE lifecycle = 'archived' AND pane_id IS NOT NULL AND archived_at <= datetime('now', '-30 days')").get() as { count: number };
    const oldestActiveCleanup = this.context.database.prepare("SELECT MIN(created_at) AS value FROM retired_pane_cleanup_operations WHERE state IN ('pending','waiting_busy','executing')").get() as { value: string | null };
    const latestCleanup = this.context.database.prepare("SELECT id, state, updated_at, detail FROM retired_pane_cleanup_operations ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as { id: string; state: RetiredPaneCleanupState; updated_at: string; detail: string | null } | undefined;
    const queueFeedback = this.context.database.prepare(`
      SELECT
        SUM(CASE WHEN c.queue_feedback_json IS NOT NULL AND json_extract(c.queue_feedback_json, '$.estimateLowerSeconds') IS NOT NULL AND json_extract(c.queue_feedback_json, '$.estimateUpperSeconds') IS NOT NULL THEN 1 ELSE 0 END) AS with_estimate,
        SUM(CASE WHEN c.queue_feedback_json IS NULL OR json_extract(c.queue_feedback_json, '$.estimateLowerSeconds') IS NULL OR json_extract(c.queue_feedback_json, '$.estimateUpperSeconds') IS NULL THEN 1 ELSE 0 END) AS without_estimate
      FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
      WHERE p.state = 'queued' AND c.phase = 'queued'
    `).get() as { with_estimate: number | null; without_estimate: number | null };
    return {
      bindings: groupedCounts<BindingState>("bindings", "state", ["pending", "active", "archived", "orphaned", "failed"]),
      prompts: groupedCounts<PromptState>("prompt_jobs", "state", ["queued", "running", "delivered", "failed", "cancelled"]),
      queueFeedback: { withEstimate: Number(queueFeedback.with_estimate ?? 0), withoutEstimate: Number(queueFeedback.without_estimate ?? 0) },
      promptLatency: { windowSize: promptLatencyWindowSize, sampleCount: Number(promptLatency.sample_count ?? 0), queue: latencyPhase("queue"), execution: latencyPhase("execution"), delivery: latencyPhase("delivery") },
      inbound: {
        states: inboundStates, retryable: Number(inboundPending.retryable ?? 0), oldestPendingAt: inboundPending.oldest_pending_at,
        oldestPendingAgeSeconds: inboundPending.oldest_pending_at === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(inboundPending.oldest_pending_at)) / 1_000)),
        recentFailure: recentInboundFailure ? { eventId: recentInboundFailure.event_id, updatedAt: recentInboundFailure.updated_at, error: boundedError(recentInboundFailure.error) } : null
      },
      sessionOperations: {
        states: sessionOperationStates, oldestAcceptedAt: oldestAcceptedSessionOperation.value,
        oldestAcceptedAgeSeconds: oldestAcceptedSessionOperation.value === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(oldestAcceptedSessionOperation.value)) / 1_000))
      },
      workerThreads: groupedCounts("worker_session_threads", "state", ["legacy-unpublished", "reserving", "active", "stale"]),
      outbound, pendingOutbox: outbound.pending, deadLetters: outbound.dead_letter, deadLettersByClass, unresolvedDeadLetters, unresolvedDeadLettersByClass, eligibleDeadLetterRecoveries: Number(eligibleRecoveries.count), oldestPendingAt: oldestPending.value,
      deliveryRecoveries: groupedCounts("delivery_recoveries", "state", ["unresolved", "replacement_pending", "recovered", "dismissed"]),
      outboxLanes: {
        pending: Number(laneHealth.pending), eligible: Number(laneHealth.eligible ?? 0), blocked: Number(laneHealth.blocked ?? 0),
        nextAttemptAt: laneHealth.next_attempt_at, oldestHeadAt: laneHealth.oldest_head_at,
        oldestHeadAgeSeconds: laneHealth.oldest_head_at === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(laneHealth.oldest_head_at)) / 1_000)),
        stalled: Number(laneHealth.stalled ?? 0),
        oldestStalledAgeSeconds: laneHealth.oldest_stalled_at === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(laneHealth.oldest_stalled_at)) / 1_000))
      },
      outboxQuarantines: {
        active: quarantineStates.active, released: quarantineStates.released, byLaneClass: quarantinesByLaneClass, byFailureClass: quarantinesByFailureClass,
        latest: latestQuarantine ? { replyId: latestQuarantine.failed_reply_id, replyKind: latestQuarantine.reply_kind, laneClass: latestQuarantine.lane_class, failureClass: latestQuarantine.failure_class, action: latestQuarantine.action, reason: boundedError(latestQuarantine.reason), createdAt: latestQuarantine.created_at, releasedAt: latestQuarantine.released_at } : null
      },
      lifecycle: groupedCounts<SessionLifecycle>("bindings", "lifecycle", ["provisioning", "active", "draining", "archived", "closed", "failed"]),
      attachment: groupedCounts<AttachmentState>("bindings", "attachment", ["unattached", "attached", "degraded", "orphaned"]),
      recoverableProvisioning: Number(recoverableProvisioning.count), archivedPanesPresent: Number(archivedPanesPresent.count),
      cleanupCandidates: Number(cleanupCandidates.count), oldestInactiveAt: oldestInactive.value,
      retiredPaneCleanup: {
        states: groupedCounts<RetiredPaneCleanupState>("retired_pane_cleanup_operations", "state", ["pending", "waiting_busy", "executing", "succeeded", "retained"]),
        oldestActiveAt: oldestActiveCleanup.value,
        oldestActiveAgeSeconds: oldestActiveCleanup.value === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(oldestActiveCleanup.value)) / 1_000)),
        latestOutcome: latestCleanup ? { operationId: latestCleanup.id, state: latestCleanup.state, updatedAt: latestCleanup.updated_at, detail: latestCleanup.detail } : null
      },
      recentFailedPrompt: recentFailedPrompt ? { promptId: recentFailedPrompt.id, bindingId: recentFailedPrompt.binding_id, updatedAt: recentFailedPrompt.updated_at, error: boundedError(recentFailedPrompt.error) } : null,
      recentDeadLetter: recentDeadLetter ? { replyId: recentDeadLetter.id, bindingId: recentDeadLetter.binding_id, promptId: recentDeadLetter.prompt_id, attemptCount: Number(recentDeadLetter.attempt_count), updatedAt: recentDeadLetter.updated_at, error: boundedError(recentDeadLetter.error) } : null
    };
  }

  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void {
    this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.actorOpenId, input.action, input.target, input.outcome, now());
  }

  recoverLegacyElementIdDeadLetters(canonicalize: (timestamp: string) => void): number {
    const timestamp = now();
    return this.context.transaction(() => {
      canonicalize(timestamp);
      const result = this.context.database.prepare(`UPDATE outbound_replies SET state = 'pending', attempt_count = 0, error = NULL, next_attempt_at = ?, updated_at = ? WHERE state = 'dead_letter' AND kind = 'stream_card_create' AND card_role = 'answer' AND error LIKE '%elementID format error%' AND prompt_id IN (SELECT p.id FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id WHERE p.state = 'queued' AND c.answer_message_id IS NULL AND c.answer_card_id IS NULL)` ).run(timestamp, timestamp);
      return Number(result.changes);
    });
  }
}

function now(): string { return new Date().toISOString(); }
function boundedError(value: string | null): string { return (value ?? "Unknown failure").slice(0, 500); }
