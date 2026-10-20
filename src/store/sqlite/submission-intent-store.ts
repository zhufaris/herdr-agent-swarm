import { randomUUID } from "node:crypto";
import { canAdoptCoreReceipt, type AdmitSubmissionIntentInput, type AdmitSubmissionIntentResult, type CoreSubmissionReceipt, type LegacyAgentInputMigrationSummary, type SubmissionCancellation, type SubmissionIntent, type SubmissionIntentActor, type SubmissionIntentAgentKind, type SubmissionIntentOwnerKind, type SubmissionIntentState, type SubmissionUncertainty } from "../../domain/submission-intent.js";
import { canonicalHumanInputJson, humanInputMessage, type HumanInputMessageV2 } from "../../domain/inbound.js";
import type { AgentInputRecoveryOutcome, AgentInputRecoveryPage, AgentInputStore, CanonicalInputRecoveryOutcome, CanonicalInputRecoveryPage, CanonicalInputRecoverySummary } from "../../domain/ports/agent-input.js";
import type { InputCardReservation, PendingTurnCardReservation } from "../../domain/input-card-view.js";
import type { ConversationSegmentStore } from "../../domain/ports/conversation-segment.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import type { SqliteContext } from "./context.js";

interface SubmissionIntentRow {
  submission_id: string;
  ingress_source: string;
  source_message_key: string;
  actor_json: string;
  input_json: string;
  text: string;
  owner_kind: SubmissionIntentOwnerKind;
  owner_id: string;
  owner_generation: number;
  pane_id: string;
  terminal_id: string;
  expected_agent_kind: SubmissionIntentAgentKind;
  expected_session_id: string | null;
  state: SubmissionIntentState;
  receipt_json: string | null;
  uncertainty_json: string | null;
  cancellation_json: string | null;
  attempted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacyPromptInputMigrationRow {
  id: string;
  binding_id: string;
  binding_generation: number;
  ingress_source: string;
  source_message_key: string;
  actor_open_id: string;
  body: string;
  root_message_id: string | null;
  batch_id: string | null;
  gateway_id: string;
  chat_id: string;
  topic_id: string | null;
  pane_id: string;
  terminal_id: string;
  agent_kind: SubmissionIntentAgentKind;
  expected_session_id: string | null;
}

export class SqliteSubmissionIntentStore implements AgentInputStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(private readonly context: SqliteContext, private readonly dependencies?: { enqueue(input: EnqueueOutboundReplyInput): unknown; conversationSegments?: ConversationSegmentStore }) {}
  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void { this.preparedDeliveryReservation = reservation; this.preparedDeliveryConsumer = consumer; }

  admit(input: AdmitSubmissionIntentInput): AdmitSubmissionIntentResult {
    return this.admitInternal(input);
  }

  /** Compatibility-only writer for historical Pending-first fixtures and migrations. */
  admitLegacyPendingCard(input: AdmitSubmissionIntentInput, card: PendingTurnCardReservation | InputCardReservation): AdmitSubmissionIntentResult {
    return this.admitInternal(input, card);
  }

  private admitInternal(input: AdmitSubmissionIntentInput, legacyCard?: PendingTurnCardReservation | InputCardReservation): AdmitSubmissionIntentResult {
    return this.context.transaction("sqlite.submission-intent-store.write", () => {
      const sourceMatch = this.findBySource(input.ingressSource, input.sourceMessageKey);
      if (sourceMatch) {
        return { outcome: matchesImmutableIdentity(sourceMatch, input) ? "duplicate" : "conflict", intent: sourceMatch };
      }
      const submissionMatch = this.get(input.submissionId);
      if (submissionMatch) return { outcome: "conflict", intent: submissionMatch };
      this.context.database.prepare(`
        INSERT INTO submission_intents(
          submission_id, ingress_source, source_message_key, actor_json, input_json, text,
          owner_kind, owner_id, owner_generation, pane_id, terminal_id,
          expected_agent_kind, expected_session_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)
      `).run(
        input.submissionId, input.ingressSource, input.sourceMessageKey, JSON.stringify(normalizeActor(input.actor)), canonicalHumanInputJson(normalizeHumanInput(input)), input.text,
        input.owner.kind, input.owner.id, input.owner.generation, input.paneId, input.terminalId,
        input.expectedAgentKind, input.expectedSessionId, input.recordedAt, input.recordedAt
      );
      const intent = this.get(input.submissionId);
      if (!intent) throw new Error(`Submission Intent insertion was not observable: ${input.submissionId}`);
      if (legacyCard) {
        if ("segmentId" in legacyCard) this.reserveLegacyPendingTurnCard(intent, legacyCard);
        else this.reserveLegacyInputCard(intent, legacyCard);
      }
      return { outcome: "accepted", intent };
    });
  }

  private reserveLegacyPendingTurnCard(intent: SubmissionIntent, card: PendingTurnCardReservation): void {
    const segments = this.dependencies?.conversationSegments;
    if (!this.dependencies || !segments) throw new Error("Conversation Segment outbox is not connected");
    segments.admitLegacyPending({
      segmentId: card.segmentId, submissionId: intent.submissionId, producerKey: intent.ingressSource,
      owner: intent.owner, agentKind: intent.expectedAgentKind, expectedSessionId: intent.expectedSessionId,
      requestText: intent.text, rootMessageId: card.rootMessageId, card: card.card, occurredAt: intent.createdAt,
      gatewayId: intent.actor.gatewayId
    });
  }

  observeCanonicalHumanMessage(input: {
    submissionId: string;
    eventId: string;
    agentKind: SubmissionIntentAgentKind;
    sessionId: string;
    observedAt: string;
  }): "working" | "duplicate" | "ignored" {
    return this.context.transaction("sqlite.submission-intent-store.write", () => {
      const intent = this.get(input.submissionId);
      if (!intent || intent.expectedAgentKind !== input.agentKind
        || intent.expectedSessionId !== null && intent.expectedSessionId !== input.sessionId) return "ignored";
      // Unified Turn Cards own all new admissions.  Canonical observation is
      // already projected into the segment store by Core event ingestion; in
      // that case advance only the durable Input Intent and never create or
      // mutate a legacy input_card_views row.  The legacy branch below remains
      // for historical rows that predate the cutover.
      const legacyInputCard = this.context.database.prepare("SELECT 1 FROM input_card_views WHERE submission_id = ?").get(input.submissionId);
      const segment = this.context.database.prepare(`SELECT human_event_id
        FROM conversation_segments WHERE submission_id = ?`).get(input.submissionId) as { human_event_id: string | null } | undefined;
      if (segment && !legacyInputCard) {
        if (segment.human_event_id && segment.human_event_id !== input.eventId) return "ignored";
        const wasObserved = intent.state === "observed";
        this.context.database.prepare(`UPDATE submission_intents SET state = 'observed', updated_at = ?
          WHERE submission_id = ? AND state IN ('attempting','prepared','uncertain','observed')`).run(input.observedAt, input.submissionId);
        this.clearActiveCanonicalRecoveryInTransaction(input.submissionId);
        return segment.human_event_id === input.eventId && wasObserved ? "duplicate" : "working";
      }
      const view = this.context.database.prepare(`SELECT state, observed_event_id, message_id, working_card_json, revision
        FROM input_card_views WHERE submission_id = ?`).get(input.submissionId) as {
          state: "pending" | "working"; observed_event_id: string | null; message_id: string | null;
          working_card_json: string; revision: number;
        } | undefined;
      if (!view) return "ignored";
      if (view.state === "working") {
        if (view.observed_event_id !== input.eventId) return "ignored";
        this.clearActiveCanonicalRecoveryInTransaction(input.submissionId);
        return "duplicate";
      }
      const nextRevision = Number(view.revision) + 1;
      const changed = this.context.database.prepare(`UPDATE input_card_views
        SET state = 'working', card_json = working_card_json, observed_event_id = ?, revision = ?, updated_at = ?
        WHERE submission_id = ? AND state = 'pending' AND observed_event_id IS NULL`).run(
        input.eventId, nextRevision, input.observedAt, input.submissionId
      );
      if (changed.changes !== 1) return "ignored";
      this.context.database.prepare(`UPDATE submission_intents SET state = 'observed', updated_at = ?
        WHERE submission_id = ? AND state IN ('attempting','prepared','uncertain')`).run(input.observedAt, input.submissionId);
      this.clearActiveCanonicalRecoveryInTransaction(input.submissionId);
      if (view.message_id) this.enqueueInputCardUpdate(intent, view.message_id, view.working_card_json, nextRevision);
      return "working";
    });
  }

  get(submissionId: string): SubmissionIntent | null {
    const row = this.context.database.prepare("SELECT * FROM submission_intents WHERE submission_id = ?").get(submissionId) as SubmissionIntentRow | undefined;
    return row ? mapSubmissionIntent(row) : null;
  }

  claimRecorded(submissionId: string, attemptedAt: string): SubmissionIntent | null {
    return this.context.transaction("sqlite.submission-intent-store.write", () => {
      const changed = this.context.database.prepare(`
        UPDATE submission_intents
        SET state = 'attempting', attempted_at = ?, updated_at = ?
        WHERE submission_id = ? AND (
          state = 'recorded'
          OR state = 'uncertain' AND json_extract(uncertainty_json, '$.code') = 'agent_input_typed_message_v1_unavailable'
        )
      `).run(attemptedAt, attemptedAt, submissionId);
      return changed.changes === 1 ? this.get(submissionId) : null;
    });
  }

  recordReceipt(submissionId: string, receipt: CoreSubmissionReceipt): SubmissionIntent | null {
    return this.context.transaction("sqlite.submission-intent-store.write", () => {
      const current = this.get(submissionId);
      if (!current || !canAdoptCoreReceipt(current, receipt)) return null;
      if (current.state === receipt.state && current.receipt && JSON.stringify(current.receipt) === JSON.stringify(receipt)) return current;
      const updatedAt = new Date(receipt.updatedAt).toISOString();
      const changed = this.context.database.prepare(`
        UPDATE submission_intents
        SET state = ?, receipt_json = ?, uncertainty_json = NULL, updated_at = ?
        WHERE submission_id = ? AND state = ?
      `).run(receipt.state, JSON.stringify(receipt), updatedAt, submissionId, current.state);
      return changed.changes === 1 ? this.get(submissionId) : null;
    });
  }

  recordUncertain(submissionId: string, uncertainty: SubmissionUncertainty): SubmissionIntent | null {
    return this.context.transaction("sqlite.submission-intent-store.write", () => {
      const changed = this.context.database.prepare(`
        UPDATE submission_intents
        SET state = 'uncertain', uncertainty_json = ?, updated_at = ?
        WHERE submission_id = ? AND state IN ('attempting','uncertain')
      `).run(JSON.stringify(uncertainty), uncertainty.recordedAt, submissionId);
      return changed.changes === 1 ? this.get(submissionId) : null;
    });
  }

  recordDefiniteRejection(submissionId: string, cancellation: SubmissionCancellation): SubmissionIntent | null {
    return this.context.transaction("sqlite.submission-intent-store.write", () => {
      const changed = this.context.database.prepare(`
        UPDATE submission_intents
        SET state = 'cancelled', cancellation_json = ?, uncertainty_json = NULL, updated_at = ?
        WHERE submission_id = ? AND state = 'attempting'
      `).run(JSON.stringify(cancellation), cancellation.recordedAt, submissionId);
      return changed.changes === 1 ? this.get(submissionId) : null;
    });
  }

  listRecoveryWork(): { submit: SubmissionIntent[]; query: SubmissionIntent[] } {
    const page = this.listRecoveryWorkPage({ limit: 500, cursor: null, scanCutoff: "9999-12-31T23:59:59.999Z" });
    return {
      submit: page.items.filter(({ action }) => action === "submit").map(({ intent }) => intent),
      query: page.items.filter(({ action }) => action === "query").map(({ intent }) => intent)
    };
  }

  listRecoveryWorkPage(input: { limit: number; cursor: { createdAt: string; submissionId: string } | null; scanCutoff: string }): AgentInputRecoveryPage {
    const limit = Math.max(1, Math.min(128, Math.floor(input.limit)));
    const rows = this.context.database.prepare(`SELECT * FROM submission_intents
      WHERE state IN ('recorded','attempting','prepared','uncertain')
        AND created_at<=?
        AND (created_at>? OR (created_at=? AND submission_id>?))
      ORDER BY created_at,submission_id LIMIT ?`).all(
      input.scanCutoff, input.cursor?.createdAt ?? "", input.cursor?.createdAt ?? "", input.cursor?.submissionId ?? "", limit + 1
    ) as unknown as SubmissionIntentRow[];
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => {
        const intent = mapSubmissionIntent(row);
        const action = (row.state === "recorded" && row.attempted_at === null) || canSafelyRetryTypedCapabilityMismatch(row)
          ? "submit"
          : "query";
        return { action, intent };
      }),
      nextCursor: page.length ? { createdAt: page.at(-1)!.created_at, submissionId: page.at(-1)!.submission_id } : input.cursor,
      hasMore: rows.length > limit,
      scanCutoff: input.scanCutoff
    };
  }

  claimRecoveryWorkPage(input: { limit: number; attemptedAt: string }): AgentInputRecoveryPage {
    return this.context.transaction("sqlite.agent-input.startup-recovery-claim", () => {
      const scan = this.context.database.prepare(`SELECT scan_cutoff,after_created_at,after_submission_id
        FROM agent_input_recovery_scan WHERE singleton_id=1`).get() as {
        scan_cutoff: string; after_created_at: string; after_submission_id: string;
      } | undefined;
      const scanCutoff = scan?.scan_cutoff ?? input.attemptedAt;
      const cursor = scan ? { createdAt: scan.after_created_at, submissionId: scan.after_submission_id } : null;
      const page = this.listRecoveryWorkPage({ limit: input.limit, cursor, scanCutoff });
      for (const item of page.items) {
        if (item.action !== "submit") continue;
        const changed = this.context.database.prepare(`UPDATE submission_intents SET state='attempting',attempted_at=?,updated_at=?
          WHERE submission_id=? AND (
            state='recorded' AND attempted_at IS NULL
            OR state='uncertain' AND json_extract(uncertainty_json, '$.code') = 'agent_input_typed_message_v1_unavailable'
          )`).run(input.attemptedAt, input.attemptedAt, item.intent.submissionId);
        if (changed.changes !== 1) throw new Error("agent_input_recovery_claim_changed");
      }
      this.context.database.prepare(`INSERT INTO agent_input_recovery_scan(
        singleton_id,scan_cutoff,after_created_at,after_submission_id,updated_at
      ) VALUES (1,?,'','',?) ON CONFLICT(singleton_id) DO NOTHING`).run(scanCutoff, input.attemptedAt);
      return {
        ...page,
        scanCutoff,
        items: page.items.map((item) => ({ ...item, intent: this.get(item.intent.submissionId)! }))
      };
    });
  }

  completeRecoveryWorkPage(input: { page: AgentInputRecoveryPage; outcomes: readonly AgentInputRecoveryOutcome[]; completedAt: string }): void {
    this.context.transaction("sqlite.agent-input.startup-recovery-outcome", () => {
      if (input.outcomes.length !== input.page.items.length) throw new Error("agent_input_recovery_outcome_count_mismatch");
      const expected = new Set(input.page.items.map(({ intent }) => intent.submissionId));
      for (const outcome of input.outcomes) {
        if (!expected.delete(outcome.submissionId)) throw new Error("agent_input_recovery_outcome_identity_mismatch");
        const current = this.get(outcome.submissionId);
        if (!current) throw new Error("agent_input_recovery_intent_missing");
        if (outcome.kind === "receipt") {
          if (!canAdoptCoreReceipt(current, outcome.receipt)) throw new Error("agent_input_recovery_receipt_conflict");
          const changed = this.context.database.prepare(`UPDATE submission_intents SET state=?,receipt_json=?,uncertainty_json=NULL,updated_at=?
            WHERE submission_id=? AND state=?`).run(outcome.receipt.state, JSON.stringify(outcome.receipt), new Date(outcome.receipt.updatedAt).toISOString(), outcome.submissionId, current.state);
          if (changed.changes !== 1) throw new Error("agent_input_recovery_outcome_changed");
        } else if (outcome.kind === "rejected") {
          const changed = this.context.database.prepare(`UPDATE submission_intents SET state='cancelled',cancellation_json=?,uncertainty_json=NULL,updated_at=?
            WHERE submission_id=? AND state='attempting'`).run(JSON.stringify(outcome.cancellation), outcome.cancellation.recordedAt, outcome.submissionId);
          if (changed.changes !== 1) throw new Error("agent_input_recovery_outcome_changed");
        } else {
          const changed = this.context.database.prepare(`UPDATE submission_intents SET state='uncertain',uncertainty_json=?,updated_at=?
            WHERE submission_id=? AND state IN ('attempting','prepared','uncertain')`).run(JSON.stringify(outcome.uncertainty), outcome.uncertainty.recordedAt, outcome.submissionId);
          if (changed.changes !== 1) throw new Error("agent_input_recovery_outcome_changed");
        }
      }
      if (input.page.hasMore) {
        if (!input.page.nextCursor) throw new Error("agent_input_recovery_cursor_missing");
        const changed = this.context.database.prepare(`UPDATE agent_input_recovery_scan SET
          after_created_at=?,after_submission_id=?,updated_at=? WHERE singleton_id=1 AND scan_cutoff=?`).run(
          input.page.nextCursor.createdAt, input.page.nextCursor.submissionId, input.completedAt, input.page.scanCutoff
        );
        if (changed.changes !== 1) throw new Error("agent_input_recovery_cursor_changed");
      } else {
        this.context.database.prepare("DELETE FROM agent_input_recovery_scan WHERE singleton_id=1 AND scan_cutoff=?").run(input.page.scanCutoff);
      }
    });
  }

  reconcileCanonicalHumanMessages(limit = 100): number {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.context.database.prepare(`SELECT canonical.submission_id,canonical.event_id,canonical.agent_kind,canonical.session_id,canonical.observed_at
      FROM canonical_human_message_submissions canonical INDEXED BY canonical_human_message_submissions_observed
      WHERE EXISTS (SELECT 1 FROM input_card_views card
          WHERE card.submission_id=canonical.submission_id AND card.state='pending')
        OR EXISTS (SELECT 1 FROM canonical_input_recovery_attempts recovery
          WHERE recovery.submission_id=canonical.submission_id
            AND recovery.state IN ('retry_wait','needs_human'))
      ORDER BY canonical.observed_at,canonical.submission_id LIMIT ?`).all(boundedLimit) as Array<{
        submission_id: string; event_id: string; agent_kind: SubmissionIntentAgentKind; session_id: string; observed_at: string;
      }>;
    let changed = 0;
    for (const row of rows) {
      if (this.observeCanonicalHumanMessage({ submissionId: row.submission_id, eventId: row.event_id, agentKind: row.agent_kind, sessionId: row.session_id, observedAt: row.observed_at }) === "working") changed += 1;
    }
    return changed;
  }

  listPendingCanonicalRecoveries(limit = 16, currentTime = new Date().toISOString()): SubmissionIntent[] {
    return this.listPendingCanonicalRecoveryPage({ limit, currentTime, cursor: null, scanCutoff: currentTime }).items;
  }

  listPendingCanonicalRecoveryPage(input: { limit: number; currentTime: string; cursor: { createdAt: string; submissionId: string } | null; scanCutoff: string }): CanonicalInputRecoveryPage {
    const boundedLimit = Math.max(1, Math.min(128, Math.floor(input.limit)));
    const rows = this.context.database.prepare(`SELECT intent.* FROM submission_intents intent
      LEFT JOIN canonical_input_recovery_attempts recovery ON recovery.submission_id=intent.submission_id
      WHERE intent.receipt_json IS NOT NULL
        AND json_type(intent.receipt_json,'$.turnId')='text'
        AND json_type(intent.receipt_json,'$.startedAt')='text'
        AND json_type(intent.receipt_json,'$.sessionId')='text'
        AND NOT EXISTS(
          SELECT 1 FROM conversation_segments segment
          WHERE segment.submission_id=intent.submission_id
            AND segment.human_event_id IS NOT NULL
            AND segment.state IN ('completed','cancelled','closed')
        )
        AND (recovery.submission_id IS NULL OR (recovery.state='retry_wait' AND recovery.next_attempt_at<=?))
        AND intent.created_at<=?
        AND (intent.created_at>? OR (intent.created_at=? AND intent.submission_id>?))
      ORDER BY intent.created_at,intent.submission_id LIMIT ?`).all(
      input.currentTime, input.scanCutoff, input.cursor?.createdAt ?? "", input.cursor?.createdAt ?? "", input.cursor?.submissionId ?? "", boundedLimit + 1
    ) as unknown as SubmissionIntentRow[];
    const page = rows.slice(0, boundedLimit);
    return {
      items: page.map(mapSubmissionIntent),
      nextCursor: page.length ? { createdAt: page.at(-1)!.created_at, submissionId: page.at(-1)!.submission_id } : input.cursor,
      hasMore: rows.length > boundedLimit,
      scanCutoff: input.scanCutoff
    };
  }

  claimPendingCanonicalRecoveryPage(input: { limit: number; currentTime: string }): CanonicalInputRecoveryPage {
    return this.context.transaction("sqlite.canonical-input.recovery-claim", () => {
      const scan = this.context.database.prepare(`SELECT scan_cutoff,after_created_at,after_submission_id
        FROM canonical_input_recovery_scan WHERE singleton_id=1`).get() as {
        scan_cutoff: string; after_created_at: string; after_submission_id: string;
      } | undefined;
      const scanCutoff = scan?.scan_cutoff ?? input.currentTime;
      const cursor = scan ? { createdAt: scan.after_created_at, submissionId: scan.after_submission_id } : null;
      const page = this.listPendingCanonicalRecoveryPage({ limit: input.limit, currentTime: scanCutoff, cursor, scanCutoff });
      this.context.database.prepare(`INSERT INTO canonical_input_recovery_scan(
        singleton_id,scan_cutoff,after_created_at,after_submission_id,updated_at
      ) VALUES (1,?,'','',?) ON CONFLICT(singleton_id) DO NOTHING`).run(scanCutoff, input.currentTime);
      return page;
    });
  }

  recordCanonicalRecoveryOutcome(submissionId: string, outcome: CanonicalInputRecoveryOutcome, occurredAt: string): void {
    this.context.transaction("sqlite.submission-intent-store.write", () => {
      this.recordCanonicalRecoveryOutcomeInTransaction(submissionId, outcome, occurredAt);
    });
  }

  recordCanonicalRecoveryOutcomes(outcomes: ReadonlyArray<{ submissionId: string; outcome: CanonicalInputRecoveryOutcome }>, occurredAt: string): void {
    this.context.transaction("sqlite.canonical-input.recovery", () => {
      for (const item of outcomes) this.recordCanonicalRecoveryOutcomeInTransaction(item.submissionId, item.outcome, occurredAt);
    });
  }

  completeCanonicalRecoveryPage(input: { page: CanonicalInputRecoveryPage; outcomes: ReadonlyArray<{ submissionId: string; outcome: CanonicalInputRecoveryOutcome }>; occurredAt: string }): void {
    this.context.transaction("sqlite.canonical-input.recovery", () => {
      if (input.outcomes.length !== input.page.items.length) throw new Error("canonical_input_recovery_outcome_count_mismatch");
      const expected = new Set(input.page.items.map(({ submissionId }) => submissionId));
      for (const item of input.outcomes) {
        if (!expected.delete(item.submissionId)) throw new Error("canonical_input_recovery_outcome_identity_mismatch");
        this.recordCanonicalRecoveryOutcomeInTransaction(item.submissionId, item.outcome, input.occurredAt);
      }
      if (input.page.hasMore) {
        if (!input.page.nextCursor) throw new Error("canonical_input_recovery_cursor_missing");
        const changed = this.context.database.prepare(`UPDATE canonical_input_recovery_scan SET
          after_created_at=?,after_submission_id=?,updated_at=? WHERE singleton_id=1 AND scan_cutoff=?`).run(
          input.page.nextCursor.createdAt, input.page.nextCursor.submissionId, input.occurredAt, input.page.scanCutoff
        );
        if (changed.changes !== 1) throw new Error("canonical_input_recovery_cursor_changed");
      } else {
        const changed = this.context.database.prepare("DELETE FROM canonical_input_recovery_scan WHERE singleton_id=1 AND scan_cutoff=?").run(input.page.scanCutoff);
        if (changed.changes !== 1) throw new Error("canonical_input_recovery_cursor_changed");
      }
    });
  }

  private recordCanonicalRecoveryOutcomeInTransaction(submissionId: string, outcome: CanonicalInputRecoveryOutcome, occurredAt: string): void {
    if (outcome === "recovered") {
      this.context.database.prepare(`INSERT INTO canonical_input_recovery_attempts(
          submission_id,state,failure_code,attempt_count,next_attempt_at,updated_at
        ) VALUES (?,'recovered',NULL,0,NULL,?) ON CONFLICT(submission_id) DO UPDATE SET
          state='recovered',failure_code=NULL,attempt_count=0,next_attempt_at=NULL,updated_at=excluded.updated_at`).run(
        submissionId, occurredAt
      );
      return;
    }
    const existing = this.context.database.prepare("SELECT attempt_count FROM canonical_input_recovery_attempts WHERE submission_id=?")
      .get(submissionId) as { attempt_count: number } | undefined;
    const attemptCount = (existing?.attempt_count ?? 0) + 1;
    const autoClosed = outcome === "not_found" || outcome === "ambiguous" || outcome === "unavailable";
    const occurredAtMs = Date.parse(occurredAt);
    if (!Number.isFinite(occurredAtMs)) throw new Error("Canonical recovery outcome time is invalid");
    const retryDelayMs = Math.min(1_000 * (2 ** Math.min(attemptCount - 1, 5)), 30_000);
    const nextAttemptAt = autoClosed ? null : new Date(occurredAtMs + retryDelayMs).toISOString();
    this.context.database.prepare(`INSERT INTO canonical_input_recovery_attempts(
        submission_id,state,failure_code,attempt_count,next_attempt_at,updated_at
      ) VALUES (?,?,?,?,?,?) ON CONFLICT(submission_id) DO UPDATE SET
        state=excluded.state,failure_code=excluded.failure_code,attempt_count=excluded.attempt_count,
        next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at`).run(
      submissionId, autoClosed ? "auto_closed" : "retry_wait", outcome, attemptCount, nextAttemptAt, occurredAt
    );
  }

  private clearActiveCanonicalRecoveryInTransaction(submissionId: string): void {
    this.context.database.prepare(`DELETE FROM canonical_input_recovery_attempts
      WHERE submission_id=? AND state IN ('retry_wait','needs_human')`).run(submissionId);
  }

  getCanonicalRecoverySummary(): CanonicalInputRecoverySummary {
    const counts = this.context.database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN recovery.state='retry_wait' THEN 1 ELSE 0 END),0) AS indexing,
      COALESCE(SUM(CASE WHEN recovery.state='needs_human' THEN 1 ELSE 0 END),0) AS needs_human
      FROM canonical_input_recovery_attempts recovery
      JOIN submission_intents intent ON intent.submission_id=recovery.submission_id`).get() as { indexing: number; needs_human: number };
    const latest = this.context.database.prepare(`SELECT failure_code FROM canonical_input_recovery_attempts recovery
      JOIN submission_intents intent ON intent.submission_id=recovery.submission_id
      WHERE recovery.state='needs_human' ORDER BY recovery.updated_at DESC,recovery.submission_id DESC LIMIT 1`).get() as { failure_code: "not_found" | "ambiguous" | "unavailable" } | undefined;
    return {
      indexing: Number(counts.indexing), needsHuman: Number(counts.needs_human),
      lastFailureCode: latest ? `recovery_${latest.failure_code}` : null
    };
  }

  hasPendingInputCards(ownerKind: "primary" | "worker", ownerId: string, ownerGeneration: number): boolean {
    return Boolean(this.context.database.prepare(`SELECT 1 FROM submission_intents intent INDEXED BY submission_intents_owner
      JOIN input_card_views card ON card.submission_id=intent.submission_id
      WHERE intent.owner_kind=? AND intent.owner_id=? AND intent.owner_generation=? AND card.state='pending' LIMIT 1`)
      .get(ownerKind, ownerId, ownerGeneration));
  }

  migrateLegacyNeverAttempted(recordedAt: string): LegacyAgentInputMigrationSummary {
    return this.context.transaction("sqlite.submission-intent-store.write", () => {
      const rows = this.listLegacyNeverAttemptedInputs();
      const directPrompts = this.listLegacyNeverAttemptedPrompts();
      const batchIds = new Set<string>();
      const bindingGenerations = new Set<string>();
      let migratedInputs = 0;
      for (const row of rows) {
        const admission = this.admitLegacy(row, recordedAt);
        if (admission.outcome === "conflict") throw new Error(`Legacy Prompt Input conflicts with an existing Submission Intent: ${row.id}`);
        const cancelled = this.context.database.prepare("UPDATE prompt_inputs SET state = 'cancelled', updated_at = ? WHERE id = ? AND state IN ('queued','batched')").run(recordedAt, row.id);
        if (Number(cancelled.changes) !== 1) throw new Error(`Legacy Prompt Input changed during migration: ${row.id}`);
        migratedInputs += 1;
        if (row.batch_id) batchIds.add(row.batch_id);
        bindingGenerations.add(`${row.binding_id}\u0000${row.binding_generation}`);
      }

      let cancelledPromptJobs = 0;
      for (const row of directPrompts) {
        const admission = this.admitLegacy(row, recordedAt);
        if (admission.outcome === "conflict") throw new Error(`Legacy Prompt conflicts with an existing Submission Intent: ${row.id}`);
        const cancelled = this.context.database.prepare(`UPDATE prompt_jobs
          SET state = 'cancelled', observation_state = 'completed', error = ?, updated_at = ?
          WHERE id = ? AND state = 'queued' AND attempt_count = 0
            AND dispatched_at IS NULL AND observation_state = 'not_started'`).run(
          "Legacy input migrated to independent Agent Input.", recordedAt, row.id
        );
        if (Number(cancelled.changes) !== 1) throw new Error(`Legacy Prompt changed during migration: ${row.id}`);
        migratedInputs += 1;
        cancelledPromptJobs += 1;
      }
      let cancelledBatches = 0;
      for (const batchId of batchIds) {
        const prompt = this.context.database.prepare(`
          UPDATE prompt_jobs
          SET state = 'cancelled', observation_state = 'completed', error = ?, updated_at = ?
          WHERE id = ? AND state = 'queued' AND attempt_count = 0 AND dispatched_at IS NULL
        `).run("Legacy input migrated to independent Agent Input.", recordedAt, batchId);
        cancelledPromptJobs += Number(prompt.changes);
        const batch = this.context.database.prepare(`
          UPDATE native_input_batches
          SET state = 'cancelled', combined_body = NULL, execution_prompt_id = NULL, formed_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'formed'
            AND NOT EXISTS (SELECT 1 FROM prompt_inputs WHERE batch_id = ? AND state IN ('queued','batched'))
        `).run(recordedAt, batchId, batchId);
        cancelledBatches += Number(batch.changes);
      }
      for (const key of bindingGenerations) {
        const [bindingId, generation] = key.split("\u0000");
        const batch = this.context.database.prepare(`
          UPDATE native_input_batches
          SET state = 'cancelled', updated_at = ?
          WHERE binding_id = ? AND binding_generation = ? AND state = 'collecting'
            AND NOT EXISTS (
              SELECT 1 FROM prompt_inputs
              WHERE binding_id = ? AND binding_generation = ? AND state = 'queued' AND batch_id IS NULL
            )
        `).run(recordedAt, bindingId!, Number(generation), bindingId!, Number(generation));
        cancelledBatches += Number(batch.changes);
      }
      return {
        migratedInputs,
        cancelledPromptJobs,
        cancelledBatches,
        remainingEligible: this.listLegacyNeverAttemptedInputs().length + this.listLegacyNeverAttemptedPrompts().length,
        preservedPossibleEffect: this.countLegacyPossibleEffect()
      };
    });
  }

  private admitLegacy(row: LegacyPromptInputMigrationRow, recordedAt: string): AdmitSubmissionIntentResult {
    return this.admit({
      submissionId: randomUUID(), ingressSource: row.ingress_source, sourceMessageKey: row.source_message_key,
      actor: {
        kind: "human", id: row.actor_open_id, gatewayId: row.gateway_id, chatId: row.chat_id,
        topicId: row.topic_id, rootMessageId: row.root_message_id
      },
      text: row.body, owner: { kind: "primary", id: row.binding_id, generation: Number(row.binding_generation) },
      paneId: row.pane_id, terminalId: row.terminal_id, expectedAgentKind: row.agent_kind,
      expectedSessionId: row.expected_session_id, recordedAt
    });
  }

  private listLegacyNeverAttemptedInputs(): LegacyPromptInputMigrationRow[] {
    return this.context.database.prepare(`
      SELECT input.id, input.binding_id, input.binding_generation, input.ingress_source,
        input.source_message_key, input.actor_open_id, input.body, input.root_message_id, input.batch_id,
        binding.gateway_id, binding.chat_id, binding.topic_id, binding.pane_id,
        binding.traex_session_id AS terminal_id, binding.agent_kind,
        CASE WHEN binding.agent_session_agent = binding.agent_kind THEN binding.agent_session_value ELSE NULL END AS expected_session_id
      FROM prompt_inputs input
      JOIN bindings binding ON binding.id = input.binding_id AND binding.generation = input.binding_generation
      LEFT JOIN native_input_batches batch ON batch.id = input.batch_id
      LEFT JOIN prompt_jobs prompt ON prompt.id = batch.execution_prompt_id
      WHERE binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
        AND binding.pane_id IS NOT NULL AND binding.traex_session_id IS NOT NULL
        AND binding.agent_kind IN ('traex','pi')
        AND (
          (input.state = 'queued' AND input.batch_id IS NULL)
          OR (
            input.state = 'batched' AND batch.state = 'formed'
            AND prompt.state = 'queued' AND prompt.attempt_count = 0
            AND prompt.dispatched_at IS NULL AND prompt.observation_state = 'not_started'
          )
        )
      ORDER BY input.id
    `).all() as unknown as LegacyPromptInputMigrationRow[];
  }

  private listLegacyNeverAttemptedPrompts(): LegacyPromptInputMigrationRow[] {
    return this.context.database.prepare(`
      SELECT prompt.id, prompt.binding_id, binding.generation AS binding_generation,
        prompt.ingress_source, prompt.source_message_key, prompt.actor_open_id, prompt.body,
        binding.root_message_id, NULL AS batch_id, binding.gateway_id, binding.chat_id, binding.topic_id,
        binding.pane_id, binding.traex_session_id AS terminal_id, binding.agent_kind,
        CASE WHEN binding.agent_session_agent = binding.agent_kind THEN binding.agent_session_value ELSE NULL END AS expected_session_id
      FROM prompt_jobs prompt
      JOIN bindings binding ON binding.id = prompt.binding_id
      WHERE binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
        AND binding.pane_id IS NOT NULL AND binding.traex_session_id IS NOT NULL
        AND binding.agent_kind IN ('traex','pi')
        AND prompt.state = 'queued' AND prompt.attempt_count = 0
        AND prompt.dispatched_at IS NULL AND prompt.observation_state = 'not_started'
        AND prompt.execution_origin = 'bridge' AND prompt.lark_message_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM native_input_batches batch WHERE batch.execution_prompt_id = prompt.id)
      ORDER BY prompt.id
    `).all() as unknown as LegacyPromptInputMigrationRow[];
  }

  private countLegacyPossibleEffect(): number {
    const row = this.context.database.prepare(`
      SELECT COUNT(*) AS count FROM prompt_jobs
      WHERE execution_origin = 'bridge'
        AND state IN ('submitted','running','recovering','uncertain')
        AND (dispatched_at IS NOT NULL OR native_submission_id IS NOT NULL OR attempt_count > 0)
    `).get() as { count: number };
    return Number(row.count);
  }

  private findBySource(ingressSource: string, sourceMessageKey: string): SubmissionIntent | null {
    const row = this.context.database.prepare("SELECT * FROM submission_intents WHERE ingress_source = ? AND source_message_key = ?")
      .get(ingressSource, sourceMessageKey) as SubmissionIntentRow | undefined;
    return row ? mapSubmissionIntent(row) : null;
  }

  private reserveLegacyInputCard(intent: SubmissionIntent, card: InputCardReservation): void {
    if (!this.dependencies) throw new Error("Input Card outbox is not connected");
    this.context.database.prepare(`INSERT INTO input_card_views(
      submission_id, state, root_message_id, card_json, working_card_json, revision, delivered_revision, created_at, updated_at
    ) VALUES (?, 'pending', ?, ?, ?, 1, 0, ?, ?)` ).run(
      intent.submissionId, card.rootMessageId, JSON.stringify(card.pendingCard), JSON.stringify(card.workingCard), intent.createdAt, intent.createdAt
    );
    const projectionKey = inputCardProjectionKey(intent.submissionId);
    const primaryBinding = intent.owner.kind === "primary" && this.hasExactPrimaryBinding(intent.owner.id, intent.owner.generation);
    if (intent.owner.kind === "primary" && !primaryBinding) return;
    this.enqueueLegacyInputCard(intent, {
      id: `${projectionKey}:create`, idempotencyKey: `${projectionKey}:create`, gatewayId: intent.actor.gatewayId,
      bindingId: primaryBinding ? intent.owner.id : null,
      bindingGeneration: primaryBinding ? intent.owner.generation : null,
      targetRole: "operation_result", rootMessageId: card.rootMessageId, kind: "card_reply",
      payload: JSON.stringify(card.pendingCard), projectionKey, snapshotRevision: 1, laneKeyOverride: projectionKey
    });
  }

  private enqueueInputCardUpdate(intent: SubmissionIntent, messageId: string, cardJson: string, revision: number): void {
    if (!this.dependencies) throw new Error("Input Card outbox is not connected");
    const projectionKey = inputCardProjectionKey(intent.submissionId);
    const primaryBinding = intent.owner.kind === "primary" && this.hasExactPrimaryBinding(intent.owner.id, intent.owner.generation);
    if (intent.owner.kind === "primary" && !primaryBinding) return;
    this.enqueueLegacyInputCard(intent, {
      id: `${projectionKey}:update:${revision}`, idempotencyKey: `${projectionKey}:update:${revision}`, gatewayId: intent.actor.gatewayId,
      bindingId: primaryBinding ? intent.owner.id : null,
      bindingGeneration: primaryBinding ? intent.owner.generation : null,
      targetRole: "operation_result", rootMessageId: messageId, kind: "card_update", payload: cardJson,
      projectionKey, snapshotRevision: revision, laneKeyOverride: projectionKey
    });
  }

  private enqueueLegacyInputCard(intent: SubmissionIntent, input: EnqueueOutboundReplyInput): void {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Submission Intent prepared delivery is not connected");
    const worker = intent.owner.kind === "worker"
      ? this.context.database.prepare("SELECT worker_session_generation FROM agent_instances WHERE id=? AND generation=?").get(intent.owner.id, intent.owner.generation) as { worker_session_generation: number } | undefined
      : undefined;
    if (intent.owner.kind === "worker" && !worker) throw new Error("Submission Intent worker delivery owner is not available");
    this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply(intent.owner.kind === "worker"
      ? { ...input, workerId: intent.owner.id, workerSessionGeneration: worker!.worker_session_generation }
      : input));
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void { queueMicrotask(() => { for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery); }); }
  private hasExactPrimaryBinding(id: string, generation: number): boolean {
    return this.context.database.prepare("SELECT 1 FROM bindings WHERE id=? AND generation=? AND state='active' AND lifecycle='active' AND attachment='attached'").get(id, generation) !== undefined;
  }
}

function inputCardProjectionKey(submissionId: string): string { return `input-card:${submissionId}`; }

function mapSubmissionIntent(row: SubmissionIntentRow): SubmissionIntent {
  return {
    submissionId: row.submission_id,
    ingressSource: row.ingress_source,
    sourceMessageKey: row.source_message_key,
    actor: JSON.parse(row.actor_json) as SubmissionIntentActor,
    input: parseHumanInput(row.input_json, row.text),
    text: row.text,
    owner: { kind: row.owner_kind, id: row.owner_id, generation: row.owner_generation },
    paneId: row.pane_id,
    terminalId: row.terminal_id,
    expectedAgentKind: row.expected_agent_kind,
    expectedSessionId: row.expected_session_id,
    state: row.state,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) as CoreSubmissionReceipt : null,
    uncertainty: row.uncertainty_json ? JSON.parse(row.uncertainty_json) as SubmissionUncertainty : null,
    cancellation: row.cancellation_json ? JSON.parse(row.cancellation_json) as SubmissionCancellation : null,
    attemptedAt: row.attempted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function matchesImmutableIdentity(intent: SubmissionIntent, input: AdmitSubmissionIntentInput): boolean {
  return intent.actor.kind === input.actor.kind
    && intent.actor.id === input.actor.id
    && intent.actor.gatewayId === input.actor.gatewayId
    && intent.actor.chatId === input.actor.chatId
    && intent.actor.topicId === input.actor.topicId
    && intent.actor.rootMessageId === input.actor.rootMessageId
    && canonicalHumanInputJson(intent.input) === canonicalHumanInputJson(normalizeHumanInput(input))
    && intent.owner.kind === input.owner.kind
    && intent.owner.id === input.owner.id
    && intent.owner.generation === input.owner.generation
    && intent.paneId === input.paneId
    && intent.terminalId === input.terminalId
    && intent.expectedAgentKind === input.expectedAgentKind
    && intent.expectedSessionId === input.expectedSessionId;
}

function normalizeHumanInput(input: Pick<AdmitSubmissionIntentInput, "input" | "text">): HumanInputMessageV2 {
  if (!input.input) return humanInputMessage(input.text);
  if (input.input.text !== input.text) throw new Error("Submission Intent input text mismatch");
  return humanInputMessage(input.input.text, input.input.choice);
}

function parseHumanInput(inputJson: string, legacyText: string): HumanInputMessageV2 {
  let parsed: HumanInputMessageV2;
  try {
    parsed = JSON.parse(inputJson) as HumanInputMessageV2;
  } catch {
    throw new Error("Submission Intent input JSON is invalid");
  }
  if (parsed.schemaVersion !== 2 || typeof parsed.text !== "string") throw new Error("Submission Intent input JSON is invalid");
  if (parsed.text !== legacyText) throw new Error("Submission Intent input text mismatch");
  return humanInputMessage(parsed.text, parsed.choice);
}

function canSafelyRetryTypedCapabilityMismatch(row: SubmissionIntentRow): boolean {
  if (row.state !== "uncertain" || row.uncertainty_json === null) return false;
  try {
    return (JSON.parse(row.uncertainty_json) as SubmissionUncertainty).code === "agent_input_typed_message_v1_unavailable";
  } catch {
    return false;
  }
}

function normalizeActor(actor: SubmissionIntentActor): SubmissionIntentActor {
  return {
    kind: actor.kind,
    id: actor.id,
    gatewayId: actor.gatewayId,
    chatId: actor.chatId,
    topicId: actor.topicId,
    rootMessageId: actor.rootMessageId
  };
}
