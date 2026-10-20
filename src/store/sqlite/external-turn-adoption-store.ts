import { createHash, randomUUID } from "node:crypto";
import { primaryAnswerCreateIdempotencyKey } from "../../domain/delivery-intent.js";
import { nativeTurnPromptId, nativeTurnSourceKey } from "../../domain/native-turn-identity.js";
import type { AdoptExternalTurnInput } from "../../domain/ports/workflow.js";
import type { ExternalTurnAdoption, ExternalTurnSupersessionFence, PromptJob } from "../../domain/types.js";
import { answerElementId, reduceRunCard } from "../../domain/run-card-view.js";
import { mapPrompt, type BindingRow, type PromptRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import { loadPromptIdentityCorrection, recordPromptIdentityCorrection } from "./prompt-identity-corrections.js";
import type { EnqueueOutboundReplyInput, SqliteOutboxQueueStore } from "./outbox-queue-store.js";
import type { ConversationTurnIdentity, ConversationTurnProjection } from "../../domain/conversation-turn-projection.js";
import type { CoreEventProjectionSettlement } from "../../domain/core-event-inbox.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { initialTopicView, mirrorRunCardToTopic, updateTopicView } from "../../domain/topic-view.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import type { OutboundReply } from "../../domain/types.js";

export class SqliteExternalTurnAdoptionStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly getPrompt: (id: string) => PromptJob | null,
    private readonly enqueueOutboundReply: (input: Parameters<SqliteOutboxQueueStore["enqueue"]>[0]) => unknown
  ) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  getCurrentGoal(bindingId: string) { return this.projections.loadTopicView(bindingId)?.currentGoal ?? null; }

  loadConversationTurnProjection(identity: ConversationTurnIdentity): ConversationTurnProjection | null {
    const row = this.context.database.prepare(`SELECT projection_id, origin, binding_id, binding_generation, pane_id,
        answer_message_id, answer_card_id, delivered_revision, state_json
      FROM conversation_turn_projections
      WHERE agent_kind = ? AND session_id = ? AND turn_id = ? AND started_at = ? AND state_json IS NOT NULL`).get(
      identity.agentKind, identity.sessionId, identity.turnId, identity.startedAt
    ) as {
      projection_id: string; origin: "herdr" | "feishu"; binding_id: string;
      binding_generation: number; pane_id: string; answer_message_id: string | null;
      answer_card_id: string | null; delivered_revision: number; state_json: string;
    } | undefined;
    if (!row) return null;
    const view = JSON.parse(row.state_json) as RunCardView;
    return {
      ...identity,
      projectionId: row.projection_id,
      origin: row.origin,
      bindingId: row.binding_id,
      bindingGeneration: Number(row.binding_generation),
      paneId: row.pane_id,
      view: {
        ...view,
        answerMessageId: row.answer_message_id,
        answerCardId: row.answer_card_id,
        answerDeliveredVersion: Number(row.delivered_revision)
      }
    };
  }

  projectConversationTurn(input: {
    identity: ConversationTurnIdentity;
    origin: "herdr" | "feishu";
    bindingId: string;
    expectedGeneration: number;
    expectedPaneId: string;
    supersede?: ExternalTurnSupersessionFence;
    view: RunCardView;
    settlement?: CoreEventProjectionSettlement;
    answerCardFor(view: RunCardView): object;
    mainCardFor(view: import("../../domain/topic-view.js").TopicViewState): object;
    paneEntryCardFor(view: import("../../domain/topic-view.js").TopicViewState): object;
  }): { outcome: "projected" | "duplicate" | "stale"; projection: ConversationTurnProjection | null; supersededPromptIds: string[]; outboxReserved: boolean } {
    const isNewDirectHerdrTurn = input.origin === "herdr" && !this.getPrompt(input.view.promptId);
    const operation = () => {
      const binding = this.context.database.prepare(`SELECT id, generation, pane_id, root_message_id, state, lifecycle, attachment,
          agent_session_source, agent_session_agent, agent_session_kind, agent_session_value
        FROM bindings WHERE id = ?`).get(input.bindingId) as BindingRow | undefined;
      if (!binding || Number(binding.generation) !== input.expectedGeneration || binding.pane_id !== input.expectedPaneId
        || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached"
        || binding.agent_session_agent !== input.identity.agentKind || binding.agent_session_kind !== "id"
        || binding.agent_session_value !== input.identity.sessionId) {
        return { outcome: "stale" as const, projection: null, supersededPromptIds: [], outboxReserved: false };
      }
      const current = this.loadConversationTurnProjection(input.identity);
      if (current && (current.projectionId !== input.view.promptId || current.bindingId !== input.bindingId
        || current.bindingGeneration !== input.expectedGeneration || current.paneId !== input.expectedPaneId)) {
        return { outcome: "stale" as const, projection: current, supersededPromptIds: [], outboxReserved: false };
      }
      // New direct Herdr turns are owned by the canonical Core conversation
      // segment projector.  Keep the legacy projection path only for
      // historical rows that already have a conversation_turn_projections
      // record; never create a second Primary Answer for a new direct turn.
      if (isNewDirectHerdrTurn && !current) {
        return this.projectDirectHerdrSegment(input, binding);
      }
      if (input.settlement?.eventIds.length) {
        const placeholders = input.settlement.eventIds.map(() => "?").join(", ");
        const alreadyProjected = this.context.database.prepare(`SELECT COUNT(*) AS count,
            SUM(CASE WHEN agent_kind = ? AND session_id = ? AND turn_id = ? AND started_at = ? THEN 1 ELSE 0 END) AS matching_count
          FROM conversation_turn_projection_events WHERE event_id IN (${placeholders})`).get(
          input.identity.agentKind, input.identity.sessionId, input.identity.turnId, input.identity.startedAt,
          ...input.settlement.eventIds
        ) as { count: number; matching_count: number | null };
        if (Number(alreadyProjected.count) === input.settlement.eventIds.length) {
          if (Number(alreadyProjected.matching_count) !== input.settlement.eventIds.length) {
            return { outcome: "stale" as const, projection: current, supersededPromptIds: [], outboxReserved: false };
          }
          if (current) {
            return { outcome: "duplicate" as const, projection: current, supersededPromptIds: [], outboxReserved: false };
          }
        }
      }
      const supersededPromptIds = this.supersedeDetachedPrompt(input.bindingId, input.identity.startedAt, input.supersede, input.view.updatedAt);
      const timestamp = input.view.updatedAt;
      const answerCard = input.answerCardFor(input.view);
      this.context.database.prepare(`INSERT INTO conversation_turn_projections(
          agent_kind, session_id, turn_id, started_at, source_lane_id, projection_id, origin,
          binding_id, binding_generation, pane_id, state_json, answer_card_json,
          answer_message_id, answer_card_id, delivered_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)
        ON CONFLICT(agent_kind, session_id, turn_id, started_at) DO UPDATE SET
          projection_id=excluded.projection_id, origin=excluded.origin, binding_id=excluded.binding_id,
          binding_generation=excluded.binding_generation, pane_id=excluded.pane_id,
          state_json=excluded.state_json, answer_card_json=excluded.answer_card_json, updated_at=excluded.updated_at`).run(
        input.identity.agentKind, input.identity.sessionId, input.identity.turnId, input.identity.startedAt,
        input.settlement?.laneId ?? "observer", input.view.promptId, input.origin, input.bindingId,
        input.expectedGeneration, input.expectedPaneId, JSON.stringify(input.view), JSON.stringify(answerCard), timestamp, timestamp
      );
      const stored = this.context.database.prepare(`SELECT answer_message_id FROM conversation_turn_projections
        WHERE agent_kind = ? AND session_id = ? AND turn_id = ? AND started_at = ?`).get(
        input.identity.agentKind, input.identity.sessionId, input.identity.turnId, input.identity.startedAt
      ) as { answer_message_id: string | null };
      const projectionKey = `conversation-turn:${input.view.promptId}:answer`;
      const targetRejected = stored.answer_message_id !== null && this.context.database.prepare(`
        SELECT 1 FROM outbound_replies
        WHERE projection_key = ? AND kind = 'card_update'
          AND state IN ('dead_letter','dismissed')
          AND failure_class = 'permanent' AND effect_certainty = 'rejected'
          AND error = ?
        LIMIT 1
      `).get(projectionKey, `Answer card message target mismatch for prompt ${input.view.promptId}`) !== undefined;
      if (!targetRejected) {
        this.reservePrimaryAnswer({
          id: randomUUID(),
          idempotencyKey: stored.answer_message_id ? `${projectionKey}:update:${input.view.viewVersion}` : `${projectionKey}:create`,
          bindingId: input.bindingId,
          bindingGeneration: input.expectedGeneration,
          promptId: input.view.promptId,
          cardRole: "answer",
          rootMessageId: stored.answer_message_id ?? binding.root_message_id,
          kind: stored.answer_message_id ? "card_update" : "card_reply",
          payload: JSON.stringify(answerCard),
          projectionKey,
          snapshotRevision: input.view.viewVersion,
          laneKeyOverride: projectionKey
        });
      }
      if (input.view.phase === "completed") {
        this.context.database.prepare(`UPDATE bindings
          SET last_agent_state = 'done', has_completed_turn = 1, last_activity_at = ?, updated_at = ?
          WHERE id = ? AND generation = ? AND pane_id = ?`).run(
          timestamp,
          timestamp,
          input.bindingId,
          input.expectedGeneration,
          input.expectedPaneId
        );
      }
      const currentTopic = this.projections.loadTopicView(input.bindingId) ?? updateTopicView(initialTopicView(input.bindingId), {
        bindingGeneration: input.expectedGeneration,
        title: input.view.title,
        agentKind: input.view.agentKind,
        workspaceId: input.view.workspaceId,
        spaceName: input.view.spaceName,
        paneId: input.expectedPaneId,
        paneToken: input.view.paneToken ?? null,
        phase: "ready"
      });
      const topic = mirrorRunCardToTopic(currentTopic, input.view);
      this.projections.saveTopicView(topic);
      this.projections.reserveMainCardIntent(
        topic,
        binding.root_message_id,
        input.mainCardFor(topic),
        undefined,
        input.paneEntryCardFor(topic)
      );
      return {
        outcome: "projected" as const,
        projection: this.loadConversationTurnProjection(input.identity),
        supersededPromptIds,
        outboxReserved: !targetRejected
      };
    };
    // A direct Herdr turn with no exact canonical segment must remain pending:
    // do not acknowledge its Core inbox events as projected.  The preflight is
    // repeated inside the transaction by projectDirectHerdrSegment, keeping
    // the actual settlement and view updates atomic when it is eligible.
    if (isNewDirectHerdrTurn && !this.loadConversationTurnProjection(input.identity) && input.settlement && !this.hasExactDirectSegment(input)) {
      return this.context.transaction("sqlite.external-turn-adoption-store.write", operation);
    }
    if (!input.settlement) return this.context.transaction("sqlite.external-turn-adoption-store.write", operation);
    const projected = this.projections.projectCoreEvent(
      input.settlement,
      { kind: "prompt", id: input.view.promptId },
      operation
    );
    return projected.outcome === "projected"
      ? projected.value
      : {
          outcome: isNewDirectHerdrTurn ? "projected" : "duplicate",
          projection: this.loadConversationTurnProjection(input.identity),
          supersededPromptIds: [],
          outboxReserved: false
        };
  }

  private hasExactDirectSegment(input: Parameters<SqliteExternalTurnAdoptionStore["projectConversationTurn"]>[0]): boolean {
    const settlement = input.settlement;
    if (!settlement || settlement.laneId.length === 0 || settlement.eventIds.length === 0) return false;
    const row = this.context.database.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_segments s
      JOIN core_event_lane_items li ON li.event_id = s.human_event_id AND li.lane_id = ?
      JOIN core_event_inbox e ON e.event_id = s.human_event_id
      WHERE s.producer_key = ? AND s.agent_kind = ? AND s.session_id = ?
        AND e.agent_kind = ? AND e.session_id = ? AND e.turn_id = ?
    `).get(settlement.laneId, `lane:${settlement.laneId}`, input.identity.agentKind, input.identity.sessionId,
      input.identity.agentKind, input.identity.sessionId, input.identity.turnId) as { count: number };
    return Number(row.count) > 0;
  }

  private projectDirectHerdrSegment(
    input: Parameters<SqliteExternalTurnAdoptionStore["projectConversationTurn"]>[0],
    binding: BindingRow
  ): { outcome: "projected" | "duplicate" | "stale"; projection: null; supersededPromptIds: string[]; outboxReserved: boolean } {
    const settlement = input.settlement;
    if (!settlement || settlement.laneId.length === 0 || settlement.eventIds.length === 0) {
      return { outcome: "stale", projection: null, supersededPromptIds: [], outboxReserved: false };
    }
    // Resolve against the whole canonical lane, not only the current batch:
    // later output/terminal settlements must continue to resolve the same
    // human event and segment after the start event was already settled.
    const exactEventIds = (this.context.database.prepare(`
      SELECT e.event_id
      FROM core_event_lane_items li
      JOIN core_event_inbox e ON e.event_id = li.event_id
      WHERE li.lane_id = ? AND e.agent_kind = ? AND e.session_id = ? AND e.turn_id = ?
    `).all(settlement.laneId, input.identity.agentKind, input.identity.sessionId, input.identity.turnId) as Array<{ event_id: string }>).map((event) => event.event_id);
    if (exactEventIds.length === 0) return { outcome: "stale", projection: null, supersededPromptIds: [], outboxReserved: false };
    const segmentRows = this.context.database.prepare(`
      SELECT id FROM conversation_segments
      WHERE producer_key = ? AND agent_kind = ? AND session_id = ?
        AND human_event_id IN (${exactEventIds.map(() => "?").join(", ")})
    `).all(`lane:${settlement.laneId}`, input.identity.agentKind, input.identity.sessionId, ...exactEventIds) as Array<{ id: string }>;
    if (segmentRows.length === 0) return { outcome: "stale", projection: null, supersededPromptIds: [], outboxReserved: false };
    if (!binding.root_message_id) return { outcome: "stale", projection: null, supersededPromptIds: [], outboxReserved: false };

    const segmentIds = segmentRows.map(({ id }) => id);
    this.context.database.prepare(`UPDATE conversation_segments
      SET owner_kind='primary', owner_id=?, owner_generation=?, root_message_id=?, updated_at=?
      WHERE id IN (${segmentIds.map(() => "?").join(", ")})
        AND producer_key=? AND agent_kind=? AND session_id=?`).run(
      input.bindingId,
      input.expectedGeneration,
      binding.root_message_id,
      input.view.updatedAt,
      ...segmentIds,
      `lane:${settlement.laneId}`,
      input.identity.agentKind,
      input.identity.sessionId
    );

    const supersededPromptIds = this.supersedeDetachedPrompt(input.bindingId, input.identity.startedAt, input.supersede, input.view.updatedAt);
    const timestamp = input.view.updatedAt;
    if (input.view.phase === "completed") {
      this.context.database.prepare(`UPDATE bindings
        SET last_agent_state = 'done', has_completed_turn = 1, last_activity_at = ?, updated_at = ?
        WHERE id = ? AND generation = ? AND pane_id = ?`).run(timestamp, timestamp, input.bindingId, input.expectedGeneration, input.expectedPaneId);
    }
    const currentTopic = this.projections.loadTopicView(input.bindingId) ?? updateTopicView(initialTopicView(input.bindingId), {
      bindingGeneration: input.expectedGeneration,
      title: input.view.title,
      agentKind: input.view.agentKind,
      workspaceId: input.view.workspaceId,
      spaceName: input.view.spaceName,
      paneId: input.expectedPaneId,
      paneToken: input.view.paneToken ?? null,
      phase: "ready"
    });
    const topic = mirrorRunCardToTopic(currentTopic, input.view);
    this.projections.saveTopicView(topic);
    this.projections.reserveMainCardIntent(topic, binding.root_message_id!, input.mainCardFor(topic), undefined, input.paneEntryCardFor(topic));
    return { outcome: "projected", projection: null, supersededPromptIds, outboxReserved: true };
  }

  private supersedeDetachedPrompt(
    bindingId: string,
    newerStartedAt: string,
    supersede: ExternalTurnSupersessionFence | undefined,
    occurredAt: string
  ): string[] {
    if (!supersede || Date.parse(newerStartedAt) <= Date.parse(supersede.startedAt)) return [];
    const changed = this.context.database.prepare(`UPDATE prompt_jobs
      SET state = 'uncertain', observation_state = 'completed', error = ?, updated_at = ?
      WHERE id = ? AND binding_id = ? AND state IN ('submitted','running') AND observation_state = 'detached'
        AND transcript_turn_id = ? AND transcript_turn_started_at = ?`).run(
      "Superseded by a newer external Herdr turn; prior outcome is uncertain",
      occurredAt,
      supersede.promptId,
      bindingId,
      supersede.turnId,
      supersede.startedAt
    );
    if (Number(changed.changes) !== 1) return [];
    this.context.database.prepare(`UPDATE run_cards
      SET phase = 'uncertain', finished_at = ?, notice = ?, queue_position = 0,
        view_version = view_version + 1, updated_at = ?
      WHERE prompt_id = ? AND phase IN ('running','recovering','blocked')`).run(
      newerStartedAt,
      "A newer Herdr turn started while this detached turn had an uncertain outcome.",
      occurredAt,
      supersede.promptId
    );
    return [supersede.promptId];
  }

  getActiveExternalPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    const rows = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id JOIN run_cards r ON r.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state = 'running' AND (p.execution_origin = 'herdr' OR p.native_submission_id IS NOT NULL)
        AND p.transcript_turn_id IS NOT NULL AND p.transcript_turn_started_at IS NOT NULL
        AND b.generation = ? AND r.binding_generation = b.generation AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 2`).all(bindingId, expectedGeneration) as PromptRow[];
    return rows.length === 1 ? mapPrompt(rows[0]!) : null;
  }

  isExternalTurnRecoveryDue(input: { promptId: string; bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: import("../../domain/types.js").HerdrAgentSession; turnId: string; startedAt: string; now: string }): boolean {
    const row = this.context.database.prepare(`
      SELECT r.next_attempt_at FROM external_turn_recovery_attempts r
      JOIN prompt_jobs p ON p.id = r.prompt_id JOIN bindings b ON b.id = p.binding_id
      WHERE r.prompt_id = ? AND r.binding_id = ? AND r.binding_generation = ? AND r.pane_id = ?
        AND r.session_value = ? AND r.turn_id = ? AND r.started_at = ?
        AND p.state = 'running' AND p.transcript_turn_id = r.turn_id AND p.transcript_turn_started_at = r.started_at
        AND b.generation = r.binding_generation AND b.pane_id = r.pane_id AND b.agent_session_value = r.session_value
    `).get(input.promptId, input.bindingId, input.expectedGeneration, input.expectedPaneId, input.expectedSession.value, input.turnId, input.startedAt) as { next_attempt_at: string } | undefined;
    return !row || row.next_attempt_at <= input.now;
  }

  deferExternalTurnRecovery(input: { promptId: string; bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: import("../../domain/types.js").HerdrAgentSession; turnId: string; startedAt: string; failureCode: string; occurredAt: string; runtimeObservedAt?: string | null }): { attemptCount: number; nextAttemptAt: string; recoveryState: "waiting" | "indexing" | "not_found" | "ambiguous" | "transient"; runtimeObservationAdvanced: boolean; shouldLog: boolean } | null {
    return this.context.transaction("sqlite.external-turn-adoption-store.write", () => {
      const recoveryState = input.failureCode === "recovery_indexing" ? "indexing"
        : input.failureCode === "recovery_not_found" ? "not_found"
          : input.failureCode === "recovery_ambiguous" ? "ambiguous" : "transient";
      const current = this.context.database.prepare(`
        SELECT r.attempt_count, r.failure_code, r.recovery_state, r.last_runtime_observed_at FROM external_turn_recovery_attempts r
        JOIN prompt_jobs p ON p.id = r.prompt_id JOIN bindings b ON b.id = p.binding_id
        WHERE r.prompt_id = ? AND r.binding_id = ? AND r.binding_generation = ? AND r.pane_id = ?
          AND r.session_value = ? AND r.turn_id = ? AND r.started_at = ?
          AND p.state = 'running' AND p.transcript_turn_id = r.turn_id AND p.transcript_turn_started_at = r.started_at
          AND b.generation = r.binding_generation AND b.pane_id = r.pane_id AND b.agent_session_value = r.session_value
      `).get(input.promptId, input.bindingId, input.expectedGeneration, input.expectedPaneId, input.expectedSession.value, input.turnId, input.startedAt) as { attempt_count: number; failure_code: string; recovery_state: string; last_runtime_observed_at: string | null } | undefined;
      if (!current) {
        const valid = this.context.database.prepare(`SELECT 1 FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
          WHERE p.id = ? AND p.binding_id = ? AND p.state = 'running' AND p.transcript_turn_id = ? AND p.transcript_turn_started_at = ?
            AND b.generation = ? AND b.pane_id = ? AND b.agent_session_source = ? AND b.agent_session_agent = ? AND b.agent_session_kind = ? AND b.agent_session_value = ?
        `).get(input.promptId, input.bindingId, input.turnId, input.startedAt, input.expectedGeneration, input.expectedPaneId, input.expectedSession.source, input.expectedSession.agent, input.expectedSession.kind, input.expectedSession.value);
        if (!valid) return null;
      }
      const attemptCount = (current?.attempt_count ?? 0) + 1;
      const delayMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(attemptCount - 1, 6));
      const nextAttemptAt = new Date(Date.parse(input.occurredAt) + delayMs).toISOString();
      const failureFingerprint = createHash("sha256").update(input.failureCode).digest("hex");
      const runtimeObservationAdvanced = Boolean(current?.last_runtime_observed_at && input.runtimeObservedAt
        && Date.parse(input.runtimeObservedAt) > Date.parse(current.last_runtime_observed_at));
      const shouldLog = !current || current.failure_code !== input.failureCode || current.recovery_state !== recoveryState || isLogarithmicMilestone(attemptCount);
      this.context.database.prepare(`INSERT INTO external_turn_recovery_attempts(
          prompt_id,binding_id,binding_generation,pane_id,session_value,turn_id,started_at,failure_code,failure_fingerprint,recovery_state,attempt_count,last_runtime_observed_at,last_attempt_at,next_attempt_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(prompt_id) DO UPDATE SET failure_code=excluded.failure_code,failure_fingerprint=excluded.failure_fingerprint,recovery_state=excluded.recovery_state,
          attempt_count=excluded.attempt_count,last_runtime_observed_at=COALESCE(excluded.last_runtime_observed_at,external_turn_recovery_attempts.last_runtime_observed_at),last_attempt_at=excluded.last_attempt_at,next_attempt_at=excluded.next_attempt_at
      `).run(input.promptId, input.bindingId, input.expectedGeneration, input.expectedPaneId, input.expectedSession.value, input.turnId, input.startedAt, input.failureCode, failureFingerprint, recoveryState, attemptCount, input.runtimeObservedAt ?? null, input.occurredAt, nextAttemptAt);
      return { attemptCount, nextAttemptAt, recoveryState, runtimeObservationAdvanced, shouldLog };
    });
  }

  clearExternalTurnRecovery(promptId: string): void {
    this.context.database.prepare("DELETE FROM external_turn_recovery_attempts WHERE prompt_id = ?").run(promptId);
  }

  correctExternalTurnStartedAt(input: { promptId: string; bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: import("../../domain/types.js").HerdrAgentSession; turnId: string; expectedStartedAt: string; canonicalStartedAt: string; occurredAt: string }): { promptId: string } | null {
    return this.context.transaction("sqlite.external-turn-adoption-store.write", () => {
      const existingCorrection = loadPromptIdentityCorrection(this.context, input.promptId);
      if (input.expectedStartedAt === input.canonicalStartedAt) return { promptId: existingCorrection?.canonicalPromptId ?? input.promptId };
      const canonicalPromptId = nativeTurnPromptId({
        bindingId: input.bindingId,
        bindingGeneration: input.expectedGeneration,
        paneId: input.expectedPaneId,
        nativeSessionId: input.expectedSession.value,
        turnId: input.turnId,
        startedAt: input.canonicalStartedAt
      });
      const current = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p
        JOIN bindings b ON b.id = p.binding_id
        WHERE p.id = ? AND p.binding_id = ? AND p.state = 'running'
          AND p.transcript_turn_id = ? AND p.transcript_turn_started_at = ?
          AND b.generation = ? AND b.pane_id = ?
          AND b.agent_session_source = ? AND b.agent_session_agent = ? AND b.agent_session_kind = ? AND b.agent_session_value = ?
      `).get(
        input.promptId,
        input.bindingId,
        input.turnId,
        input.expectedStartedAt,
        input.expectedGeneration,
        input.expectedPaneId,
        input.expectedSession.source,
        input.expectedSession.agent,
        input.expectedSession.kind,
        input.expectedSession.value
      ) as PromptRow | undefined;
      const canonicalSourceKey = nativeTurnSourceKey({
        bindingId: input.bindingId,
        bindingGeneration: input.expectedGeneration,
        paneId: input.expectedPaneId,
        nativeSessionId: input.expectedSession.value,
        turnId: input.turnId,
        startedAt: input.canonicalStartedAt
      });
      if (!current) {
        if (!existingCorrection
          || existingCorrection.canonicalPromptId !== canonicalPromptId
          || existingCorrection.bindingId !== input.bindingId
          || existingCorrection.bindingGeneration !== input.expectedGeneration
          || existingCorrection.paneId !== input.expectedPaneId
          || existingCorrection.nativeSessionId !== input.expectedSession.value
          || existingCorrection.turnId !== input.turnId
          || existingCorrection.legacyStartedAt !== input.expectedStartedAt
          || existingCorrection.canonicalStartedAt !== input.canonicalStartedAt) {
          return null;
        }
        const corrected = this.context.database.prepare(`SELECT 1 FROM prompt_jobs p
          JOIN bindings b ON b.id = p.binding_id
          WHERE p.id = ? AND p.binding_id = ? AND p.state = 'running'
            AND p.transcript_turn_id = ? AND p.transcript_turn_started_at = ?
            AND b.generation = ? AND b.pane_id = ?
            AND b.agent_session_source = ? AND b.agent_session_agent = ? AND b.agent_session_kind = ? AND b.agent_session_value = ?
        `).get(
          existingCorrection.canonicalPromptId,
          input.bindingId,
          input.turnId,
          input.canonicalStartedAt,
          input.expectedGeneration,
          input.expectedPaneId,
          input.expectedSession.source,
          input.expectedSession.agent,
          input.expectedSession.kind,
          input.expectedSession.value
        );
        return corrected ? { promptId: existingCorrection.canonicalPromptId } : null;
      }
      if (current.execution_origin !== "herdr" || current.ingress_source !== "herdr") {
        const changed = this.context.database.prepare(`UPDATE prompt_jobs
          SET transcript_turn_started_at = ?, updated_at = ?
          WHERE id = ? AND binding_id = ? AND state = 'running' AND transcript_turn_id = ? AND transcript_turn_started_at = ?
        `).run(input.canonicalStartedAt, input.occurredAt, input.promptId, input.bindingId, input.turnId, input.expectedStartedAt);
        if (Number(changed.changes) !== 1) return null;
        this.context.database.prepare(`
          INSERT INTO prompt_transcript_turns(
            prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at, chain_id, parent_turn_id, origin, ordinal, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prompt', 0, ?)
          ON CONFLICT(prompt_id, turn_id) DO UPDATE SET
            pane_id = excluded.pane_id,
            native_session_id = excluded.native_session_id,
            started_at = excluded.started_at
        `).run(
          input.promptId,
          input.bindingId,
          input.expectedGeneration,
          input.expectedPaneId,
          input.expectedSession.value,
          input.turnId,
          input.canonicalStartedAt,
          input.turnId,
          input.occurredAt
        );
        this.context.database.prepare(`UPDATE external_turn_recovery_attempts SET started_at = ?
          WHERE prompt_id = ? AND binding_id = ? AND binding_generation = ? AND pane_id = ? AND session_value = ? AND turn_id = ? AND started_at = ?
        `).run(input.canonicalStartedAt, input.promptId, input.bindingId, input.expectedGeneration, input.expectedPaneId, input.expectedSession.value, input.turnId, input.expectedStartedAt);
        this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES ('system:turn-recovery', 'turn.recovery.canonical_start', ?, 'corrected', ?)")
          .run(`binding:${input.bindingId}:prompt:${input.promptId}:turn:${input.turnId}`, input.occurredAt);
        return { promptId: input.promptId };
      }
      const existingCanonical = this.context.database.prepare("SELECT id FROM prompt_jobs WHERE id = ?").get(canonicalPromptId) as { id: string } | undefined;
      if (existingCanonical && existingCanonical.id !== input.promptId) return null;
      if (canonicalPromptId === input.promptId) {
        const changed = this.context.database.prepare(`UPDATE prompt_jobs
          SET source_message_key = ?, transcript_turn_started_at = ?, updated_at = ?
          WHERE id = ? AND binding_id = ? AND state = 'running' AND transcript_turn_id = ? AND transcript_turn_started_at = ?
        `).run(canonicalSourceKey, input.canonicalStartedAt, input.occurredAt, input.promptId, input.bindingId, input.turnId, input.expectedStartedAt);
        if (Number(changed.changes) !== 1) return null;
        this.context.database.prepare(`
          INSERT INTO prompt_transcript_turns(
            prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at, chain_id, parent_turn_id, origin, ordinal, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prompt', 0, ?)
          ON CONFLICT(prompt_id, turn_id) DO UPDATE SET
            pane_id = excluded.pane_id,
            native_session_id = excluded.native_session_id,
            started_at = excluded.started_at
        `).run(
          input.promptId,
          input.bindingId,
          input.expectedGeneration,
          input.expectedPaneId,
          input.expectedSession.value,
          input.turnId,
          input.canonicalStartedAt,
          input.turnId,
          input.occurredAt
        );
        this.context.database.prepare(`UPDATE external_turn_recovery_attempts SET started_at = ?
          WHERE prompt_id = ? AND binding_id = ? AND binding_generation = ? AND pane_id = ? AND session_value = ? AND turn_id = ? AND started_at = ?
        `).run(input.canonicalStartedAt, input.promptId, input.bindingId, input.expectedGeneration, input.expectedPaneId, input.expectedSession.value, input.turnId, input.expectedStartedAt);
        this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES ('system:turn-recovery', 'turn.recovery.canonical_start', ?, 'corrected', ?)")
          .run(`binding:${input.bindingId}:prompt:${input.promptId}:turn:${input.turnId}`, input.occurredAt);
        return { promptId: input.promptId };
      }

      this.context.database.prepare(`
        INSERT INTO prompt_jobs(
          id, binding_id, session_epoch, lark_message_id, ingress_source, source_message_key, actor_open_id, body, parent_prompt_id,
          execution_origin, priority, was_detached, dispatched_at, native_submission_id, transcript_turn_id, transcript_turn_started_at,
          model_name, model_revision, state, observation_state, attempt_count, error, created_at, updated_at
        )
        SELECT ?, binding_id, session_epoch, lark_message_id, ingress_source, ?, actor_open_id, body, parent_prompt_id,
          execution_origin, priority, was_detached, dispatched_at, native_submission_id, transcript_turn_id, ?,
          model_name, model_revision, state, observation_state, attempt_count, error, created_at, ?
        FROM prompt_jobs WHERE id = ?
      `).run(canonicalPromptId, canonicalSourceKey, input.canonicalStartedAt, input.occurredAt, input.promptId);
      recordPromptIdentityCorrection(this.context, {
        aliasPromptId: input.promptId,
        canonicalPromptId,
        bindingId: input.bindingId,
        bindingGeneration: input.expectedGeneration,
        paneId: input.expectedPaneId,
        nativeSessionId: input.expectedSession.value,
        turnId: input.turnId,
        legacyStartedAt: input.expectedStartedAt,
        canonicalStartedAt: input.canonicalStartedAt,
        reason: "canonical_start_correction",
        createdAt: input.occurredAt
      });

      this.context.database.prepare(`
        UPDATE prompt_transcript_turns
        SET prompt_id = ?, pane_id = COALESCE(pane_id, ?), native_session_id = COALESCE(native_session_id, ?),
          started_at = CASE WHEN turn_id = ? AND started_at = ? THEN ? ELSE started_at END
        WHERE prompt_id = ?
      `).run(canonicalPromptId, input.expectedPaneId, input.expectedSession.value, input.turnId, input.expectedStartedAt, input.canonicalStartedAt, input.promptId);
      this.context.database.prepare("UPDATE run_cards SET prompt_id = ? WHERE prompt_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE answer_pages SET prompt_id = ? WHERE prompt_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE answer_timeline_items SET aggregate_id = ? WHERE aggregate_kind = 'primary-run' AND aggregate_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE answer_timeline_page_checkpoints SET aggregate_id = ? WHERE aggregate_kind = 'primary-run' AND aggregate_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE binding_model_preferences SET dispatch_prompt_id = ? WHERE dispatch_prompt_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE primary_human_review_episodes SET prompt_id = ? WHERE prompt_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE worker_card_display_requests SET parent_prompt_id = ? WHERE parent_prompt_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE prompt_jobs SET parent_prompt_id = ? WHERE parent_prompt_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE card_interactions SET parent_prompt_id = ? WHERE parent_prompt_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE card_interactions SET target_prompt_id = ? WHERE target_prompt_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE pane_control_operations SET parent_prompt_id = ? WHERE parent_prompt_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare(`
        UPDATE external_turn_recovery_attempts
        SET prompt_id = ?, started_at = ?
        WHERE prompt_id = ? AND binding_id = ? AND binding_generation = ? AND pane_id = ? AND session_value = ? AND turn_id = ? AND started_at = ?
      `).run(canonicalPromptId, input.canonicalStartedAt, input.promptId, input.bindingId, input.expectedGeneration, input.expectedPaneId, input.expectedSession.value, input.turnId, input.expectedStartedAt);
      this.context.database.prepare("UPDATE detached_prompt_recovery_attempts SET prompt_id = ? WHERE prompt_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare("UPDATE projection_gaps SET owner_id = ? WHERE owner_kind = 'prompt' AND owner_id = ?")
        .run(canonicalPromptId, input.promptId);
      this.context.database.prepare(`
        UPDATE projection_gaps
        SET owner_id = ? || substr(owner_id, length(?) + 1)
        WHERE owner_kind = 'answer_page' AND owner_id LIKE ? ESCAPE '\\'
      `).run(canonicalPromptId, input.promptId, `${escapeLike(input.promptId)}:%`);

      const topic = this.projections.loadTopicView(input.bindingId);
      if (topic?.activePromptId === input.promptId) this.projections.saveTopicView({ ...topic, activePromptId: canonicalPromptId });
      this.context.database.prepare("DELETE FROM prompt_jobs WHERE id = ? AND binding_id = ?").run(input.promptId, input.bindingId);
      this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES ('system:turn-recovery', 'turn.recovery.canonical_start', ?, 'corrected', ?)")
        .run(`binding:${input.bindingId}:legacy_prompt:${input.promptId}:prompt:${canonicalPromptId}:turn:${input.turnId}`, input.occurredAt);
      return { promptId: canonicalPromptId };
    });
  }

  adoptExternalTurn(input: AdoptExternalTurnInput): ExternalTurnAdoption {
    return this.context.transaction("sqlite.external-turn-adoption-store.write", () => {
      const binding = this.context.database.prepare("SELECT * FROM bindings WHERE id = ?").get(input.bindingId) as BindingRow | undefined;
      if (!binding || !binding.root_message_id || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached" || Number(binding.generation) !== input.expectedGeneration || binding.pane_id !== input.expectedPaneId
        || binding.agent_session_source !== input.expectedSession.source || binding.agent_session_agent !== input.expectedSession.agent || binding.agent_session_kind !== input.expectedSession.kind || binding.agent_session_value !== input.expectedSession.value) {
        return { outcome: "stale_binding", prompt: null, supersededPromptIds: [], outboxReserved: false };
      }
      if (this.context.database.prepare(`SELECT 1 FROM orchestrator_clear_operations WHERE binding_id = ? AND state IN ('accepted','rotating','rotation-uncertain') LIMIT 1`).get(input.bindingId)) {
        return { outcome: "stale_binding", prompt: null, supersededPromptIds: [], outboxReserved: false };
      }
      const nativeIdentity = {
        bindingId: input.bindingId,
        bindingGeneration: input.expectedGeneration,
        paneId: input.expectedPaneId,
        nativeSessionId: input.expectedSession.value,
        turnId: input.turnId,
        startedAt: input.startedAt
      };
      const deterministicPromptId = nativeTurnPromptId(nativeIdentity);
      const deterministicSourceKey = nativeTurnSourceKey(nativeIdentity);
      const ownedBySource = this.context.database.prepare(`
        SELECT * FROM prompt_jobs
        WHERE ingress_source = 'herdr' AND source_message_key = ?
        ORDER BY created_at, rowid LIMIT 2
      `).all(deterministicSourceKey) as PromptRow[];
      if (ownedBySource[0]) {
        return { outcome: ownedBySource.length === 1 ? "already_owned" : "conflict", prompt: mapPrompt(ownedBySource[0]!), supersededPromptIds: [], outboxReserved: false };
      }
      const ownedByPromptId = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(deterministicPromptId) as PromptRow | undefined;
      if (ownedByPromptId) return { outcome: "already_owned", prompt: mapPrompt(ownedByPromptId), supersededPromptIds: [], outboxReserved: false };
      const ownedByTurnTuple = this.context.database.prepare(`
        SELECT p.* FROM prompt_jobs p
        JOIN prompt_transcript_turns t ON t.prompt_id = p.id
        WHERE p.binding_id = ? AND t.binding_id = ? AND t.binding_generation = ?
          AND t.pane_id = ? AND t.native_session_id = ? AND t.turn_id = ? AND t.started_at = ?
        ORDER BY p.created_at, p.rowid LIMIT 2
      `).all(input.bindingId, input.bindingId, input.expectedGeneration, input.expectedPaneId, input.expectedSession.value, input.turnId, input.startedAt) as PromptRow[];
      if (ownedByTurnTuple[0]) {
        return { outcome: ownedByTurnTuple.length === 1 ? "already_owned" : "conflict", prompt: mapPrompt(ownedByTurnTuple[0]!), supersededPromptIds: [], outboxReserved: false };
      }
      if (input.requestSubmissionId !== undefined) {
        const candidate = this.context.database.prepare(`
          SELECT p.* FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
          WHERE p.binding_id = ? AND p.id = ? AND p.native_submission_id = p.id AND p.state IN ('submitted','recovering')
            AND p.observation_state = 'detached' AND p.transcript_turn_id IS NULL
            AND c.binding_generation = ? AND c.pane_id = ?
          LIMIT 1
        `).get(input.bindingId, input.requestSubmissionId, input.expectedGeneration, input.expectedPaneId) as PromptRow | undefined;
        if (!candidate) return { outcome: "conflict", prompt: null, supersededPromptIds: [], outboxReserved: false };
        const timestamp = now();
        const changed = this.context.database.prepare(`
          UPDATE prompt_jobs SET state = 'running', observation_state = 'attached', transcript_turn_id = ?, transcript_turn_started_at = ?, error = NULL, updated_at = ?
          WHERE id = ? AND binding_id = ? AND id = ? AND native_submission_id = id AND state IN ('submitted','recovering')
            AND observation_state = 'detached' AND transcript_turn_id IS NULL
        `).run(input.turnId, input.startedAt, timestamp, candidate.id, input.bindingId, input.requestSubmissionId);
        if (Number(changed.changes) !== 1) return { outcome: "conflict", prompt: null, supersededPromptIds: [], outboxReserved: false };
        if (candidate.model_name !== null && candidate.model_revision !== null) {
          const preference = this.context.database.prepare(`
            UPDATE binding_model_preferences
            SET effective_model = desired_model, effective_revision = desired_revision, state = 'effective',
              dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = ?
            WHERE binding_id = ? AND binding_generation = ? AND desired_model = ? AND desired_revision = ?
              AND dispatch_prompt_id = ? AND state = 'applying'
          `).run(timestamp, input.bindingId, input.expectedGeneration, candidate.model_name, candidate.model_revision, candidate.id);
          if (Number(preference.changes) !== 1) throw new Error(`Model prompt ${candidate.id} adoption was not atomically fenced`);
        }
        this.context.database.prepare(`
          INSERT INTO prompt_transcript_turns(prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at, chain_id, parent_turn_id, origin, ordinal, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prompt', 0, ?)
        `).run(candidate.id, input.bindingId, input.expectedGeneration, input.expectedPaneId, input.expectedSession.value, input.turnId, input.startedAt, input.turnId, timestamp);
        const queuedView = this.projections.loadRunCard(candidate.id)!;
        const runningView = reduceRunCard(queuedView, { type: "started", occurredAt: input.startedAt });
        const persistedRunningView = this.projections.saveRunCard(runningView);
        const outboxReserved = Number(this.context.database.prepare("UPDATE outbound_replies SET view_version = ?, updated_at = ? WHERE prompt_id = ? AND card_role = 'answer' AND state = 'pending' AND kind = 'stream_card_create' AND first_claimed_at IS NULL AND attempt_count = 0").run(persistedRunningView.viewVersion, timestamp, candidate.id).changes) > 0;
        const prompt = this.getPrompt(candidate.id);
        if (!prompt) throw new Error(`Prompt not found: ${candidate.id}`);
        return { outcome: "adopted_queued", prompt, supersededPromptIds: [], outboxReserved };
      }
      const active = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE binding_id = ? AND state IN ('submitted','running') ORDER BY created_at, id").all(input.bindingId) as PromptRow[];
      const superseded = input.supersede;
      const supersessionIsFenced = superseded !== undefined
        && active.length === 1
        && active[0]!.id === superseded.promptId
        && active[0]!.observation_state === "detached"
        && active[0]!.transcript_turn_id === superseded.turnId
        && active[0]!.transcript_turn_started_at === superseded.startedAt
        && Date.parse(input.startedAt) > Date.parse(superseded.startedAt);
      if (active.length > 0 && !supersessionIsFenced) return { outcome: "conflict", prompt: null, supersededPromptIds: [], outboxReserved: false };
      const timestamp = now();
      const gatewayId = typeof binding.gateway_id === "string" ? binding.gateway_id : "feishu:primary";
      const supersededPromptIds = active.map((row) => row.id);
      for (const row of active) {
        this.context.database.prepare("UPDATE prompt_jobs SET state = 'uncertain', observation_state = 'completed', error = ?, updated_at = ? WHERE id = ?").run("Superseded by a newer external Herdr turn; prior outcome is uncertain", timestamp, row.id);
        this.context.database.prepare("UPDATE run_cards SET phase = 'uncertain', finished_at = ?, notice = ?, queue_position = 0, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ? AND phase IN ('running','recovering','blocked')").run(input.startedAt, "A newer Herdr turn started while this detached turn had an uncertain outcome.", timestamp, row.id);
      }
      const promptId = deterministicPromptId;
      const outcome: ExternalTurnAdoption["outcome"] = "created_external";
      this.context.database.prepare(`
        INSERT INTO prompt_jobs(
          id, binding_id, session_epoch, lark_message_id, ingress_source, source_message_key, actor_open_id, body,
          execution_origin, state, observation_state, dispatched_at, transcript_turn_id,
          transcript_turn_started_at, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'herdr', ?, 'herdr', ?, 'herdr', 'running', 'attached', ?, ?, ?, 1, ?, ?)
      `).run(promptId, input.bindingId, Number(binding.session_epoch), deterministicSourceKey, input.requestText, input.startedAt, input.turnId, input.startedAt, input.startedAt, timestamp);
      const view = {
        ...input.externalView,
        promptId,
        bindingId: input.bindingId,
        bindingGeneration: input.expectedGeneration,
        paneId: input.expectedPaneId,
        requestText: input.requestText,
        queuePosition: 0
      };
      const runningView = reduceRunCard(view, { type: "started", occurredAt: input.startedAt });
      this.projections.insertRunCard(runningView);
      this.reservePrimaryAnswer({
        id: randomUUID(),
        idempotencyKey: primaryAnswerCreateIdempotencyKey(promptId),
        gatewayId,
        bindingId: input.bindingId,
        bindingGeneration: input.expectedGeneration,
        promptId,
        viewVersion: runningView.viewVersion,
        cardRole: "answer",
        rootMessageId: binding.root_message_id,
        kind: "stream_card_create",
        payload: JSON.stringify(input.answerCardFor(runningView))
      });
      const outboxReserved = true;
      this.context.database.prepare(`INSERT OR IGNORE INTO prompt_transcript_turns(
        prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at, chain_id, parent_turn_id, origin, ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prompt', 0, ?)`)
        .run(promptId, input.bindingId, input.expectedGeneration, input.expectedPaneId, input.expectedSession.value, input.turnId, input.startedAt, input.turnId, timestamp);
      const prompt = this.getPrompt(promptId);
      if (!prompt) throw new Error(`Prompt not found: ${promptId}`);
      return { outcome, prompt, supersededPromptIds, outboxReserved };
    });
  }

  private reservePrimaryAnswer(input: EnqueueOutboundReplyInput): OutboundReply {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("External Turn Adoption prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }
}

function now(): string { return new Date().toISOString(); }
function isLogarithmicMilestone(attemptCount: number): boolean {
  let remaining = attemptCount;
  while (remaining > 1 && remaining % 10 === 0) remaining /= 10;
  return remaining === 1;
}
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, "\\$&"); }
