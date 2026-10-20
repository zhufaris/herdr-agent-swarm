import { createHash, randomUUID } from "node:crypto";
import type {
  AuthoritativeTurnSnapshot,
  AuthoritativeTurnSnapshotIdentity,
  AuthoritativeTurnSnapshotPageInput,
  AuthoritativeTurnSnapshotStageResult,
  AuthoritativeTurnSnapshotStore,
  CoreEventEnvelope
} from "../../domain/core-event-inbox.js";
import type { SqliteContext } from "./context.js";
import { SqliteProjectionGapStore } from "./projection-gap-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqliteOutboxStore } from "./outbox-store.js";
import { answerElementId, type RunCardView } from "../../domain/run-card-view.js";
import { initialTopicView, mirrorRunCardToTopic } from "../../domain/topic-view.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import type { OutboundReply } from "../../domain/types.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import { coreEventDiscriminators } from "./core-event-discriminators.js";
import { coreEventSemanticHash } from "./core-event-identity.js";

const SNAPSHOT_VALIDATION_VERSION = 1;
export const MAX_AUTHORITATIVE_SNAPSHOT_EVENTS = 1_024;
export const MAX_AUTHORITATIVE_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_AUTHORITATIVE_SNAPSHOT_PAGE_BYTES = 2 * 1024 * 1024;

export class SqliteAuthoritativeTurnSnapshotStore implements AuthoritativeTurnSnapshotStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly outbox: SqliteOutboxStore
  ) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  loadAuthoritativeTurnSnapshot(identity: AuthoritativeTurnSnapshotIdentity): AuthoritativeTurnSnapshot | null {
    const row = this.context.database.prepare(`SELECT state, canonical_started_at, next_cursor, complete, failure_code,event_count,payload_bytes
      FROM authoritative_turn_snapshots
      WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=?`).get(...identityParams(identity)) as {
      state: AuthoritativeTurnSnapshot["state"];
      canonical_started_at: string | null;
      next_cursor: string;
      complete: number;
      failure_code: string | null;
      event_count: number;
      payload_bytes: number;
    } | undefined;
    if (!row) return null;
    const events = this.context.database.prepare(`SELECT event_json FROM authoritative_turn_snapshot_events
      WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=? ORDER BY sequence`).all(
      ...identityParams(identity)
    ) as Array<{ event_json: string }>;
    return {
      identity,
      state: row.state,
      canonicalStartedAt: row.canonical_started_at,
      nextCursor: row.next_cursor,
      complete: Boolean(row.complete),
      events: events.map(({ event_json }) => JSON.parse(event_json) as CoreEventEnvelope),
      failureCode: row.failure_code,
      eventCount: Number(row.event_count),
      payloadBytes: Number(row.payload_bytes)
    };
  }

  stageAuthoritativeTurnSnapshotPage(input: AuthoritativeTurnSnapshotPageInput): AuthoritativeTurnSnapshotStageResult {
    return this.context.transaction("sqlite.authoritative-turn-snapshot-store.write", () => this.stageInTransaction(input));
  }

  replaceAuthoritativeTurnSnapshot(input: Parameters<AuthoritativeTurnSnapshotStore["replaceAuthoritativeTurnSnapshot"]>[0]): ReturnType<AuthoritativeTurnSnapshotStore["replaceAuthoritativeTurnSnapshot"]> {
    return this.context.transaction("sqlite.authoritative-turn-snapshot-store.write", () => {
      const applied = this.context.database.prepare(`SELECT applied_projection_id,applied_view_version
        FROM authoritative_turn_snapshots
        WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=? AND applied_at IS NOT NULL`).get(
        ...identityParams(input.identity)
      ) as { applied_projection_id: string; applied_view_version: number } | undefined;
      if (applied) {
        return applied.applied_projection_id === input.projectionId
          ? { outcome: "duplicate", outboxReserved: false }
          : { outcome: "stale", outboxReserved: false };
      }
      const snapshot = this.loadAuthoritativeTurnSnapshot(input.identity);
      if (!snapshot || snapshot.state !== "ready" || !snapshot.complete || !snapshot.canonicalStartedAt) {
        return { outcome: "stale", outboxReserved: false };
      }
      const owner = this.context.database.prepare(`SELECT owner_kind,owner_id FROM authoritative_turn_snapshots
        WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=?`).get(...identityParams(input.identity)) as {
        owner_kind: "binding" | "worker_turn"; owner_id: string;
      };
      if (owner.owner_kind !== "binding" || owner.owner_id !== input.bindingId) return { outcome: "stale", outboxReserved: false };
      const binding = this.context.database.prepare(`SELECT root_message_id,generation,pane_id,state,lifecycle,attachment,
          agent_session_agent,agent_session_kind,agent_session_value
        FROM bindings WHERE id=?`).get(input.bindingId) as {
        root_message_id: string | null; generation: number; pane_id: string | null; state: string; lifecycle: string; attachment: string;
        agent_session_agent: string | null; agent_session_kind: string | null; agent_session_value: string | null;
      } | undefined;
      if (!binding || Number(binding.generation) !== input.expectedGeneration || binding.pane_id !== input.expectedPaneId
        || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached"
        || binding.agent_session_agent !== input.identity.agentKind || binding.agent_session_kind !== "id"
        || binding.agent_session_value !== input.identity.sessionId) {
        return { outcome: "stale", outboxReserved: false };
      }
      if (input.view.promptId !== input.projectionId || input.view.bindingId !== input.bindingId
        || input.view.bindingGeneration !== input.expectedGeneration || input.view.paneId !== input.expectedPaneId) {
        return { outcome: "stale", outboxReserved: false };
      }
      if (input.view.phase !== "completed" && input.view.phase !== "failed") {
        return { outcome: "stale", outboxReserved: false };
      }
      for (const event of snapshot.events) {
        const existing = this.context.database.prepare(`SELECT i.event_json,i.event_type,i.payload_compacted_at,skeleton.payload_hash
          FROM core_event_inbox i LEFT JOIN audit_skeletons skeleton
            ON skeleton.source_kind='core_event' AND skeleton.source_id=i.event_id
          WHERE i.event_id=?`).get(event.eventId) as {
            event_json:string; event_type:string|null; payload_compacted_at:string|null; payload_hash:string|null;
          } | undefined;
        const conflicts = existing && (existing.payload_compacted_at === null
          ? hashEvent(JSON.parse(existing.event_json) as CoreEventEnvelope) !== hashEvent(event)
          : existing.event_type !== payloadType(event.payload) || !matchesCompactedCoreEventHash(event, existing.payload_hash));
        if (conflicts) {
          this.ambiguous({
            identity: input.identity,
            owner: { kind: "binding", id: input.bindingId },
            afterCursor: snapshot.nextCursor,
            batch: { outcome: "ambiguous", nextCursor: snapshot.nextCursor, complete: true, events: [] },
            observedAt: input.occurredAt
          }, "replacement_event_conflict");
          return { outcome: "ambiguous", outboxReserved: false };
        }
      }
      for (const event of snapshot.events) {
        const discriminators = coreEventDiscriminators(event);
        this.context.database.prepare(`INSERT OR IGNORE INTO core_event_inbox(
          event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,
          event_type,submission_id,channel,call_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          event.eventId, event.sourceId, event.agentKind, event.sessionId, event.turnId,
          event.cursor, event.occurredAt, JSON.stringify(event), input.occurredAt,
          discriminators.eventType, discriminators.submissionId, discriminators.channel, discriminators.callId
        );
      }
      const existingProjection = this.context.database.prepare(`SELECT answer_message_id,answer_card_id,delivered_revision,created_at
        FROM conversation_turn_projections
        WHERE agent_kind=? AND session_id=? AND turn_id=? AND started_at=?`).get(
        input.identity.agentKind, input.identity.sessionId, input.identity.turnId, snapshot.canonicalStartedAt
      ) as { answer_message_id: string | null; answer_card_id: string | null; delivered_revision: number; created_at: string } | undefined;
      const answerCard = input.answerCardFor(input.view);
      this.context.database.prepare(`INSERT INTO conversation_turn_projections(
        agent_kind,session_id,turn_id,started_at,source_lane_id,projection_id,origin,binding_id,binding_generation,pane_id,
        state_json,answer_card_json,answer_message_id,answer_card_id,delivered_revision,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_kind,session_id,turn_id,started_at) DO UPDATE SET
        source_lane_id=excluded.source_lane_id,projection_id=excluded.projection_id,origin=excluded.origin,
        binding_id=excluded.binding_id,binding_generation=excluded.binding_generation,pane_id=excluded.pane_id,
        state_json=excluded.state_json,answer_card_json=excluded.answer_card_json,updated_at=excluded.updated_at`).run(
        input.identity.agentKind, input.identity.sessionId, input.identity.turnId, snapshot.canonicalStartedAt,
        `authoritative:${snapshotSourceId(input.identity)}`, input.projectionId, input.origin, input.bindingId,
        input.expectedGeneration, input.expectedPaneId, JSON.stringify(input.view), JSON.stringify(answerCard),
        existingProjection?.answer_message_id ?? input.view.answerMessageId,
        existingProjection?.answer_card_id ?? input.view.answerCardId,
        existingProjection?.delivered_revision ?? input.view.answerDeliveredVersion,
        existingProjection?.created_at ?? input.occurredAt, input.occurredAt
      );
      this.context.database.prepare(`DELETE FROM conversation_turn_projection_events
        WHERE agent_kind=? AND session_id=? AND turn_id=? AND started_at=?`).run(
        input.identity.agentKind, input.identity.sessionId, input.identity.turnId, snapshot.canonicalStartedAt
      );
      snapshot.events.forEach((event, index) => {
        this.context.database.prepare(`INSERT INTO conversation_turn_projection_events(
          agent_kind,session_id,turn_id,started_at,event_id,sequence,created_at
        ) VALUES (?,?,?,?,?,?,?)`).run(
          input.identity.agentKind, input.identity.sessionId, input.identity.turnId, snapshot.canonicalStartedAt,
          event.eventId, index + 1, input.occurredAt
        );
      });

      const prompt = this.context.database.prepare("SELECT state FROM prompt_jobs WHERE id=? AND binding_id=?").get(input.projectionId, input.bindingId) as { state: string } | undefined;
      if (prompt) {
        const terminalState = input.view.phase === "completed" ? "delivered" : "failed";
        this.context.database.prepare(`UPDATE prompt_jobs SET state=?,observation_state='completed',error=?,updated_at=?
          WHERE id=? AND binding_id=?`).run(
          terminalState, input.view.phase === "failed" ? input.view.notice : null, input.occurredAt, input.projectionId, input.bindingId
        );
        this.projections.saveRunCard(input.view);
      }
      const currentTopic = this.projections.loadTopicView(input.bindingId) ?? initialTopicView(input.bindingId);
      const topic = mirrorRunCardToTopic(currentTopic, input.view);
      this.projections.saveTopicView(topic);

      let outboxReserved = false;
      if (prompt && binding.root_message_id) {
        const frozen = this.context.database.prepare("SELECT COALESCE(MAX(page_index),-1) AS page_index FROM answer_pages WHERE prompt_id=? AND state IN ('frozen','finished')").get(input.projectionId) as { page_index: number };
        if (Number(frozen.page_index) >= 0) {
          const pageIndex = Number(frozen.page_index) + 1;
          const continuation: RunCardView = {
            ...input.view,
            answerMessageId: null,
            answerCardId: null,
            answerElementId: answerElementId(input.projectionId, pageIndex),
            answerSequence: 0,
            answerPageIndex: pageIndex,
            answerPageStart: 0,
            notice: input.view.phase === "completed"
              ? "已通过 Core 权威 Turn snapshot 补回历史结果；原冻结页面未修改。"
              : `已通过 Core 权威 Turn snapshot 补回历史结果；原冻结页面未修改。\n\n${input.view.notice ?? "Agent turn failed"}`
          };
          const reply = this.reservePrimaryAnswer({
            id: randomUUID(),
            idempotencyKey: `authoritative-turn-recovery:${snapshotSourceId(input.identity)}:${input.projectionId}`,
            bindingId: input.bindingId,
            bindingGeneration: input.expectedGeneration,
            promptId: input.projectionId,
            viewVersion: input.view.viewVersion,
            cardRole: "answer",
            workClass: "history",
            rootMessageId: binding.root_message_id,
            kind: "stream_card_create",
            payload: JSON.stringify({
              card: input.answerCardFor(continuation),
              stream: { pageIndex, pageStart: 0, elementId: continuation.answerElementId, deliveryMode: "static" }
            })
          });
          outboxReserved = reply.state === "pending";
        }
      } else if (existingProjection && binding.root_message_id) {
        const projectionKey = `conversation-turn:${input.projectionId}:answer`;
        const reply = this.reservePrimaryAnswer({
          id: randomUUID(),
          idempotencyKey: `authoritative-turn-recovery:${snapshotSourceId(input.identity)}:${input.projectionId}:answer`,
          bindingId: input.bindingId,
          bindingGeneration: input.expectedGeneration,
          promptId: input.projectionId,
          viewVersion: input.view.viewVersion,
          cardRole: "answer",
          workClass: "history",
          rootMessageId: existingProjection.answer_message_id ?? binding.root_message_id,
          kind: existingProjection.answer_message_id ? "card_update" : "card_reply",
          payload: JSON.stringify(answerCard),
          projectionKey,
          snapshotRevision: input.view.viewVersion,
          laneKeyOverride: projectionKey
        });
        outboxReserved = reply.state === "pending";
      }
      const main = this.projections.reserveMainCardIntent(
        topic,
        binding.root_message_id,
        input.mainCardFor(topic),
        "history",
        input.paneEntryCardFor(topic)
      );
      outboxReserved = outboxReserved || main === "reserved";
      this.context.database.prepare(`UPDATE authoritative_turn_snapshots
        SET applied_at=?,applied_projection_id=?,applied_view_version=?,updated_at=?
        WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=? AND applied_at IS NULL`).run(
        input.occurredAt, input.projectionId, input.view.viewVersion, input.occurredAt, ...identityParams(input.identity)
      );
      this.context.database.prepare(`UPDATE projection_gaps SET state='compensated',compensated_by_version=?,compensated_at=?
        WHERE stage='turn_recovery' AND source_item_id=? AND state='open'`).run(
        SNAPSHOT_VALIDATION_VERSION, input.occurredAt, snapshotSourceId(input.identity)
      );
      this.context.database.prepare("DELETE FROM external_turn_recovery_attempts WHERE prompt_id=?").run(input.projectionId);
      return { outcome: "replaced", outboxReserved };
    });
  }

  private reservePrimaryAnswer(input: EnqueueOutboundReplyInput): OutboundReply {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Authoritative Turn Snapshot prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

  private stageInTransaction(input: AuthoritativeTurnSnapshotPageInput): AuthoritativeTurnSnapshotStageResult {
    const { identity, batch } = input;
    const events = [...batch.events];
    const validationFailure = validatePage(input);
    let snapshot = this.loadAuthoritativeTurnSnapshot(identity);
    if (!snapshot) {
      this.context.database.prepare(`INSERT INTO authoritative_turn_snapshots(
        agent_kind,session_id,turn_id,requested_started_at,owner_kind,owner_id,canonical_started_at,
        state,next_cursor,complete,failure_code,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'staging','',0,NULL,?,?)`).run(
        ...identityParams(identity), input.owner.kind, input.owner.id,
        batch.canonicalStartedAt ?? null, input.observedAt, input.observedAt
      );
      snapshot = this.loadAuthoritativeTurnSnapshot(identity)!;
    }
    const owner = this.context.database.prepare(`SELECT owner_kind, owner_id FROM authoritative_turn_snapshots
      WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=?`).get(...identityParams(identity)) as {
      owner_kind: "binding" | "worker_turn"; owner_id: string;
    };
    if (owner.owner_kind !== input.owner.kind || owner.owner_id !== input.owner.id) {
      return this.ambiguous(input, "owner_conflict");
    }
    if (snapshot.state === "ambiguous" || snapshot.state === "not_found") return this.result(identity, snapshot.state);
    if (validationFailure) return this.ambiguous(input, validationFailure);
    if (snapshot.canonicalStartedAt && batch.canonicalStartedAt && snapshot.canonicalStartedAt !== batch.canonicalStartedAt) {
      return this.ambiguous(input, "canonical_identity_conflict");
    }

    if (batch.outcome === "indexing") {
      this.context.database.prepare(`UPDATE authoritative_turn_snapshots
        SET state='indexing',next_cursor=?,complete=0,failure_code=NULL,updated_at=?
        WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=?`).run(
        input.afterCursor, input.observedAt, ...identityParams(identity)
      );
      return this.result(identity, "indexing");
    }

    const pageHash = hashPage(input);
    const priorPage = this.context.database.prepare(`SELECT page_hash,outcome,next_cursor,complete,events_json FROM authoritative_turn_snapshot_pages
      WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=? AND after_cursor=?`).get(
      ...identityParams(identity), input.afterCursor
    ) as { page_hash: string; outcome: string; next_cursor: string; complete: number; events_json: string } | undefined;
    if (priorPage) {
      if (priorPage.page_hash !== pageHash && !sameSnapshotPage(priorPage, input)) return this.ambiguous(input, "page_content_conflict");
      return this.result(identity, "duplicate");
    }
    if (input.afterCursor !== snapshot.nextCursor) return this.ambiguous(input, "page_discontinuity");

    const serializedEvents = JSON.stringify(events);
    const pageBytes = Buffer.byteLength(serializedEvents, "utf8");
    if (pageBytes > MAX_AUTHORITATIVE_SNAPSHOT_PAGE_BYTES) return this.ambiguous(input, "snapshot_byte_limit_exceeded");
    let addedEventCount = 0;
    let addedEventBytes = 0;
    const serializedUniqueEvents = new Map<string, string>();
    for (const event of events) {
      const duplicateInPage = serializedUniqueEvents.get(event.eventId);
      if (duplicateInPage !== undefined) {
        if (hashEvent(JSON.parse(duplicateInPage) as CoreEventEnvelope) !== hashEvent(event)) return this.ambiguous(input, "snapshot_event_conflict");
        continue;
      }
      const prior = this.context.database.prepare(`SELECT event_hash FROM authoritative_turn_snapshot_events
        WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=? AND event_id=?`).get(
        ...identityParams(identity), event.eventId
      ) as { event_hash: string } | undefined;
      if (prior) {
        if (!matchesSnapshotEventHash(event, prior.event_hash)) return this.ambiguous(input, "snapshot_event_conflict");
        continue;
      }
      const serialized = JSON.stringify(event);
      serializedUniqueEvents.set(event.eventId, serialized);
      addedEventCount += 1;
      addedEventBytes += Buffer.byteLength(serialized, "utf8");
    }
    if (snapshot.eventCount + addedEventCount > MAX_AUTHORITATIVE_SNAPSHOT_EVENTS) {
      return this.ambiguous(input, "snapshot_event_limit_exceeded");
    }
    if (snapshot.payloadBytes + pageBytes + addedEventBytes > MAX_AUTHORITATIVE_SNAPSHOT_BYTES) {
      return this.ambiguous(input, "snapshot_byte_limit_exceeded");
    }

    this.context.database.prepare(`INSERT INTO authoritative_turn_snapshot_pages(
      agent_kind,session_id,turn_id,requested_started_at,after_cursor,next_cursor,outcome,complete,page_hash,events_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      ...identityParams(identity), input.afterCursor, batch.nextCursor, batch.outcome, batch.complete ? 1 : 0,
      pageHash, serializedEvents, input.observedAt
    );

    if (batch.outcome !== "recovered") {
      const state = batch.outcome;
      this.context.database.prepare(`UPDATE authoritative_turn_snapshots
        SET state=?,canonical_started_at=COALESCE(canonical_started_at,?),next_cursor=?,complete=?,failure_code=?,
          payload_bytes=payload_bytes+?,updated_at=?
        WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=?`).run(
        state, batch.canonicalStartedAt ?? null, batch.nextCursor, batch.complete ? 1 : 0,
        state === "not_found" ? "not_found" : "core_ambiguous", pageBytes, input.observedAt, ...identityParams(identity)
      );
      if (state === "not_found" || state === "ambiguous") this.openGap(input, state === "not_found" ? "not_found" : "core_ambiguous");
      return this.result(identity, state);
    }

    let sequence = Number((this.context.database.prepare(`SELECT COALESCE(MAX(sequence),0) AS sequence
      FROM authoritative_turn_snapshot_events
      WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=?`).get(
      ...identityParams(identity)
    ) as { sequence: number }).sequence);
    for (const event of events) {
      const eventHash = hashEvent(event);
      const prior = this.context.database.prepare(`SELECT event_hash FROM authoritative_turn_snapshot_events
        WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=? AND event_id=?`).get(
        ...identityParams(identity), event.eventId
      ) as { event_hash: string } | undefined;
      if (prior) continue;
      sequence += 1;
      this.context.database.prepare(`INSERT INTO authoritative_turn_snapshot_events(
        agent_kind,session_id,turn_id,requested_started_at,event_id,sequence,event_hash,event_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        ...identityParams(identity), event.eventId, sequence, eventHash, serializedUniqueEvents.get(event.eventId)!, input.observedAt
      );
    }
    this.context.database.prepare(`UPDATE authoritative_turn_snapshots
      SET state='staging',canonical_started_at=COALESCE(canonical_started_at,?),next_cursor=?,complete=?,failure_code=NULL,
        event_count=event_count+?,payload_bytes=payload_bytes+?,updated_at=?
      WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=?`).run(
      batch.canonicalStartedAt!, batch.nextCursor, batch.complete ? 1 : 0, addedEventCount, pageBytes + addedEventBytes,
      input.observedAt, ...identityParams(identity)
    );
    if (!batch.complete) return this.result(identity, "staged");

    const failure = this.validateCompleted(identity);
    if (failure) return this.ambiguous(input, failure);
    this.context.database.prepare(`UPDATE authoritative_turn_snapshots SET state='ready',failure_code=NULL,updated_at=?
      WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=?`).run(
      input.observedAt, ...identityParams(identity)
    );
    return this.result(identity, "ready");
  }

  private validateCompleted(identity: AuthoritativeTurnSnapshotIdentity): string | null {
    const snapshot = this.loadAuthoritativeTurnSnapshot(identity)!;
    const starts = snapshot.events.filter(({ payload }) => isRecord(payload) && payload.type === "turn_started");
    if (!snapshot.canonicalStartedAt || starts.length !== 1 || starts[0]!.occurredAt !== snapshot.canonicalStartedAt) return "canonical_start_invalid";
    const terminals = snapshot.events.filter(({ payload }) => isTerminalPayload(payload));
    if (terminals.length !== 1 || snapshot.events.at(-1) !== terminals[0]) return "terminal_event_invalid";
    const snapshotIndexes = new Map(snapshot.events.map((event, index) => [event.eventId, { index, hash: hashEvent(event), event }]));
    const live = this.context.database.prepare(`SELECT i.event_id,i.event_json,i.event_type,i.payload_compacted_at,skeleton.payload_hash
      FROM conversation_turn_projection_events projected
      JOIN core_event_inbox i ON i.event_id=projected.event_id
      LEFT JOIN audit_skeletons skeleton ON skeleton.source_kind='core_event' AND skeleton.source_id=i.event_id
      WHERE projected.agent_kind=? AND projected.session_id=? AND projected.turn_id=? AND projected.started_at=?
      ORDER BY projected.sequence`).all(
      identity.agentKind, identity.sessionId, identity.turnId, snapshot.canonicalStartedAt
    ) as Array<{ event_id:string; event_json:string; event_type:string|null; payload_compacted_at:string|null; payload_hash:string|null }>;
    let priorIndex = -1;
    for (const event of live) {
      const candidate = snapshotIndexes.get(event.event_id);
      if (!candidate) return "live_event_missing";
      if (event.payload_compacted_at === null) {
        if (candidate.hash !== hashEvent(JSON.parse(event.event_json) as CoreEventEnvelope)) return "live_event_conflict";
      } else if (payloadType(candidate.event.payload) !== event.event_type
        || !matchesCompactedCoreEventHash(candidate.event, event.payload_hash)) {
        return "live_event_conflict";
      }
      if (candidate.index <= priorIndex) return "live_event_order_conflict";
      priorIndex = candidate.index;
    }
    return null;
  }

  private ambiguous(input: AuthoritativeTurnSnapshotPageInput, failureCode: string): AuthoritativeTurnSnapshotStageResult {
    this.context.database.prepare(`UPDATE authoritative_turn_snapshots
      SET state='ambiguous',complete=?,failure_code=?,updated_at=?
      WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=?`).run(
      input.batch.complete ? 1 : 0, failureCode, input.observedAt, ...identityParams(input.identity)
    );
    this.openGap(input, failureCode);
    return this.result(input.identity, "ambiguous");
  }

  private openGap(input: AuthoritativeTurnSnapshotPageInput, failureCode: string): void {
    new SqliteProjectionGapStore(this.context).open({
      stage: "turn_recovery",
      ownerKind: input.owner.kind,
      ownerId: input.owner.id,
      sourceItemId: snapshotSourceId(input.identity),
      failureClass: "projection",
      failureCode,
      requiredVersion: SNAPSHOT_VALIDATION_VERSION,
      occurredAt: input.observedAt
    });
  }

  private result(identity: AuthoritativeTurnSnapshotIdentity, outcome: AuthoritativeTurnSnapshotStageResult["outcome"]): AuthoritativeTurnSnapshotStageResult {
    const snapshot = this.loadAuthoritativeTurnSnapshot(identity)!;
    return {
      outcome,
      state: snapshot.state,
      nextCursor: snapshot.nextCursor,
      complete: snapshot.complete,
      canonicalStartedAt: snapshot.canonicalStartedAt,
      failureCode: snapshot.failureCode
    };
  }
}

function validatePage(input: AuthoritativeTurnSnapshotPageInput): string | null {
  const { identity, batch } = input;
  if (batch.events.length > 128) return "page_too_large";
  if (batch.outcome === "recovered" && !batch.canonicalStartedAt) return "canonical_start_missing";
  if (batch.outcome === "recovered" && !batch.complete && (!batch.nextCursor || batch.nextCursor === input.afterCursor)) return "page_cursor_stalled";
  if (batch.outcome !== "recovered" && batch.events.length > 0) return "non_recovered_events";
  for (const event of batch.events) {
    if (event.schemaVersion !== 1 || !event.eventId || event.agentKind !== identity.agentKind
      || event.sessionId !== identity.sessionId || event.turnId !== identity.turnId) return "snapshot_identity_mismatch";
    if (coreEventSemanticHash(event) === null) return "snapshot_event_invalid";
  }
  return null;
}

function identityParams(identity: AuthoritativeTurnSnapshotIdentity): [string, string, string, string] {
  return [identity.agentKind, identity.sessionId, identity.turnId, identity.requestedStartedAt];
}

function hashPage(input: AuthoritativeTurnSnapshotPageInput): string {
  return hash({
    outcome: input.batch.outcome,
    canonicalStartedAt: input.batch.canonicalStartedAt ?? null,
    nextCursor: input.batch.nextCursor,
    complete: input.batch.complete,
    events: input.batch.events.map(hashEvent)
  });
}

function hashEvent(event: CoreEventEnvelope): string {
  const semanticHash = coreEventSemanticHash(event);
  if (semanticHash === null) throw new Error("Invalid authoritative Core event identity");
  return semanticHash;
}
function hashRawEvent(event: CoreEventEnvelope): string { return createHash("sha256").update(JSON.stringify(event)).digest("hex"); }

function matchesSnapshotEventHash(event: CoreEventEnvelope, storedHash: string): boolean {
  return storedHash === hashEvent(event) || storedHash === legacySnapshotEventHash(event);
}

function legacySnapshotEventHash(event: CoreEventEnvelope): string {
  const payload = isRecord(event.payload) && event.payload.type === "human_message"
    ? Object.fromEntries(Object.entries(event.payload).filter(([key]) => key !== "submission_id"))
    : event.payload;
  return hash({
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    agentKind: event.agentKind,
    sessionId: event.sessionId,
    turnId: event.turnId,
    occurredAt: event.occurredAt,
    payload
  });
}

function sameSnapshotPage(
  prior: { outcome: string; next_cursor: string; complete: number; events_json: string },
  input: AuthoritativeTurnSnapshotPageInput
): boolean {
  if (prior.outcome !== input.batch.outcome || prior.next_cursor !== input.batch.nextCursor
    || Boolean(prior.complete) !== input.batch.complete) return false;
  try {
    const events = JSON.parse(prior.events_json) as unknown;
    return Array.isArray(events) && events.length === input.batch.events.length
      && events.every((event, index) => sameSnapshotEvent(event, input.batch.events[index]));
  } catch {
    return false;
  }
}

function sameSnapshotEvent(left: unknown, right: CoreEventEnvelope | undefined): boolean {
  if (!right || !isRecord(left)) return false;
  const leftHash = coreEventSemanticHash(left as unknown as CoreEventEnvelope);
  const rightHash = coreEventSemanticHash(right);
  return leftHash !== null && leftHash === rightHash;
}

function matchesCompactedCoreEventHash(event: CoreEventEnvelope, storedHash: string | null): boolean {
  if (storedHash === null) return false;
  const semanticHash = coreEventSemanticHash(event);
  return semanticHash !== null && (storedHash === semanticHash || storedHash === hashRawEvent(event));
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex"); }
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isTerminalPayload(value: unknown): boolean {
  return isRecord(value) && (value.type === "turn_completed" || value.type === "turn_aborted");
}
function payloadType(value: unknown): string | null { return isRecord(value) && typeof value.type === "string" ? value.type : null; }
function snapshotSourceId(identity: AuthoritativeTurnSnapshotIdentity): string { return `turn-snapshot:${hash(identity)}`; }
