import { createHash } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import { CORE_EVENT_MAX_PROJECTION_ATTEMPTS, CORE_EVENT_REDUCER_REVISION, type CoreEventCheckpointRebase, type CoreEventCheckpointRebaseResult, type CoreEventDiscriminatorBackfillResult, type CoreEventEnvelope, type CoreEventEpochTransitionRebase, type CoreEventEpochTransitionRebaseResult, type CoreEventInboxBatch, type CoreEventInboxCheckpoint, type CoreEventInboxPendingBatch, type CoreEventInboxStore, type CoreEventIngestResult, type CoreEventInvalidCursorGap, type CoreEventLaneBootstrap, type CoreEventLaneBootstrapResult, type CoreEventSettlementResult, type CoreEventSourceTransition, type CoreEventSourceTransitionResult } from "../../domain/core-event-inbox.js";
import { redactSecrets } from "../../runtime/redact-secrets.js";
import { SqliteSavepointOperationError, type SqliteContext } from "./context.js";
import { SqliteProjectionGapStore } from "./projection-gap-store.js";
import { SqliteHumanReviewCandidateStore } from "./human-review-candidate-store.js";
import type { AnswerTimelineDelta } from "../../domain/answer-timeline.js";
import type { GoalChange } from "../../domain/current-goal.js";
import type { SessionActivityProjectionContext } from "../../domain/session-activity.js";
import { coreEventDiscriminators, coreEventDiscriminatorSql, parseCoreEventDiscriminators, type CoreEventDiscriminators } from "./core-event-discriminators.js";
import { coreEventSemanticHash, sameCoreEventSemantics } from "./core-event-identity.js";
import type { DeliveryLatencyTrace } from "../../domain/delivery-trace.js";
import type { ExactRecoveryRoute, HistoricalCoreRecoveryCandidate, HistoricalCoreRecoveryResult, HistoricalRecoveryBacklogSummary } from "../../domain/historical-recovery.js";

const MAX_FAILURE_CHARS = 1_000;
const MAX_CONFLICT_COUNT = 1_000;
const HISTORICAL_RECOVERY_ROUTES_SQL = `exact_routes AS (
    SELECT checkpoint.lane_id,'primary' AS owner_kind,binding.id AS owner_id,
      binding.generation AS owner_generation,binding.gateway_id,binding.root_message_id
    FROM core_event_lane_checkpoints checkpoint
    JOIN bindings binding ON binding.agent_kind=checkpoint.agent_kind
      AND binding.agent_session_kind='id' AND binding.agent_session_value=checkpoint.session_id
    WHERE binding.state IN ('active','orphaned') AND binding.lifecycle='active'
      AND binding.root_message_id IS NOT NULL AND length(binding.root_message_id)>0
    UNION
    SELECT checkpoint.lane_id,'primary',binding.id,binding.generation,
      binding.gateway_id,segment.root_message_id
    FROM core_event_lane_checkpoints checkpoint
    JOIN conversation_segments segment ON segment.producer_key='lane:' || checkpoint.lane_id
      AND segment.owner_kind='primary' AND segment.agent_kind=checkpoint.agent_kind
      AND segment.session_id=checkpoint.session_id
    JOIN bindings binding ON binding.id=segment.owner_id AND binding.generation=segment.owner_generation
    WHERE binding.state IN ('active','orphaned') AND binding.lifecycle='active'
      AND segment.root_message_id<>''
    UNION
    SELECT checkpoint.lane_id,'worker',worker.id,worker.generation,
      binding.gateway_id,segment.root_message_id
    FROM core_event_lane_checkpoints checkpoint
    JOIN conversation_segments segment ON segment.producer_key='lane:' || checkpoint.lane_id
      AND segment.owner_kind='worker' AND segment.agent_kind=checkpoint.agent_kind
      AND segment.session_id=checkpoint.session_id
    JOIN agent_instances worker ON worker.id=segment.owner_id AND worker.generation=segment.owner_generation
      AND worker.role='worker' AND worker.worker_session_lifecycle='active'
    JOIN bindings binding ON binding.id=worker.parent_binding_id
      AND binding.generation=worker.parent_binding_generation
    WHERE binding.state IN ('active','orphaned') AND binding.lifecycle='active'
      AND segment.root_message_id<>''
    UNION
    SELECT checkpoint.lane_id,'worker',worker.id,worker.generation,
      binding.gateway_id,thread.root_message_id
    FROM core_event_lane_checkpoints checkpoint
    JOIN agent_instances worker ON worker.agent_kind=checkpoint.agent_kind
      AND worker.native_session_id=checkpoint.session_id AND worker.role='worker'
      AND worker.desired_state='running' AND worker.worker_session_lifecycle='active'
    JOIN bindings binding ON binding.id=worker.parent_binding_id
      AND binding.generation=worker.parent_binding_generation
    JOIN worker_session_threads thread ON thread.worker_id=worker.id
      AND thread.worker_session_generation=worker.worker_session_generation AND thread.state='active'
    WHERE binding.state IN ('active','orphaned') AND binding.lifecycle='active'
      AND thread.root_message_id IS NOT NULL AND length(thread.root_message_id)>0
  ), unique_routes AS (
    SELECT exact_routes.*,
      ROW_NUMBER() OVER (PARTITION BY lane_id ORDER BY owner_kind,owner_id,owner_generation,gateway_id,root_message_id) AS route_rank,
      COUNT(*) OVER (PARTITION BY lane_id) AS route_count
    FROM exact_routes
  )`;

interface IngestEvidenceRow {
  event_json: string;
  payload_compacted_at: string | null;
  payload_hash: string | null;
  sequence: number | null;
  state: string | null;
}

interface CoreCheckpointRow {
  source_id: string;
  source_epoch: string | null;
  agent_kind: "traex" | "pi";
  session_id: string;
  read_cursor: string;
  latest_cursor: string;
}

interface CoreInboxStatements {
  checkpoint: StatementSync;
  maximumLaneSequence: StatementSync;
  ingestEvidence: StatementSync;
  eventById: StatementSync;
  insertEvent: StatementSync;
  insertLaneItem: StatementSync;
  ignoreLaneItem: StatementSync;
  settleLaneConflict: StatementSync;
  upsertCheckpoint: StatementSync;
  insertCanonicalSubmission: StatementSync;
  canonicalSubmissionById: StatementSync;
  staleReplayEvidence: StatementSync;
  pendingCandidate: StatementSync;
}

interface StoredEventEvidence {
  event: StoredCoreEvent;
  admission: "new" | "duplicate" | "conflict";
  skipProjection: boolean;
}

export class SqliteCoreEventInboxStore implements CoreEventInboxStore {
  private preparedStatements: CoreInboxStatements | null = null;
  private readonly pendingWorkCommittedListeners = new Set<() => void>();

  constructor(private readonly context: SqliteContext, private readonly dependencies?: {
    observeCanonicalHumanMessage?(input: { submissionId: string; eventId: string; agentKind: "traex" | "pi"; sessionId: string; observedAt: string }): unknown;
    projectCanonicalEvent?(input: { laneId: string; laneSequence: number; sourceId: string; sourceEpoch: string | null; sessionActivityContext?: SessionActivityProjectionContext; event: CoreEventEnvelope; observedAt: string; route?: ExactRecoveryRoute; workClass?: "live" | "history"; model?: string; timelineDeltas?: readonly AnswerTimelineDelta[]; goalChanges?: readonly GoalChange[]; taskList?: readonly { id?: string; label: string; state?: string }[] }): { segmentId?: string | null; outcome?: string } | void;
    deliveryTrace?: DeliveryLatencyTrace;
  }) {}

  onPendingWorkCommitted(listener: () => void): () => void {
    this.pendingWorkCommittedListeners.add(listener);
    return () => { this.pendingWorkCommittedListeners.delete(listener); };
  }

  private get statements(): CoreInboxStatements {
    if (this.preparedStatements) return this.preparedStatements;
    const database = this.context.database;
    return this.preparedStatements = {
      checkpoint: database.prepare("SELECT source_id, source_epoch, agent_kind, session_id, read_cursor, latest_cursor FROM core_event_lane_checkpoints WHERE lane_id = ?"),
      maximumLaneSequence: database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM core_event_lane_items WHERE lane_id = ?"),
      ingestEvidence: database.prepare(`SELECT i.event_json,i.payload_compacted_at,s.payload_hash,l.sequence,l.state
        FROM core_event_inbox i
        LEFT JOIN core_event_lane_items l ON l.event_id=i.event_id AND l.lane_id=?
        LEFT JOIN audit_skeletons s ON s.source_kind='core_event' AND s.source_id=i.event_id
        WHERE i.event_id=?`),
      eventById: database.prepare(`SELECT i.event_json,i.payload_compacted_at,s.payload_hash
        FROM core_event_inbox i LEFT JOIN audit_skeletons s ON s.source_kind='core_event' AND s.source_id=i.event_id
        WHERE i.event_id = ?`),
      insertEvent: database.prepare(`INSERT OR IGNORE INTO core_event_inbox(
        event_id, source_id, agent_kind, session_id, turn_id, source_cursor, occurred_at, event_json, ingested_at,
        event_type,submission_id,channel,call_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertLaneItem: database.prepare(`INSERT INTO core_event_lane_items(
        lane_id, event_id, sequence, state, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?)`),
      ignoreLaneItem: database.prepare(`UPDATE core_event_lane_items SET state='ignored',updated_at=?
        WHERE lane_id=? AND event_id=? AND state='pending'`),
      settleLaneConflict: database.prepare(`UPDATE core_event_lane_items
        SET conflict_count=MIN(conflict_count+1,?),last_conflict_hash=?,
          last_conflict_reason='semantic_conflict',last_conflict_at=?,updated_at=?
        WHERE lane_id=? AND event_id=?`),
      upsertCheckpoint: database.prepare(`INSERT INTO core_event_lane_checkpoints(
        lane_id, source_id, source_epoch, agent_kind, session_id, read_cursor, latest_cursor, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lane_id) DO UPDATE SET
        source_id=excluded.source_id, source_epoch=excluded.source_epoch, agent_kind=excluded.agent_kind, session_id=excluded.session_id,
        read_cursor=excluded.read_cursor, latest_cursor=excluded.latest_cursor, updated_at=excluded.updated_at`),
      insertCanonicalSubmission: database.prepare(`INSERT OR IGNORE INTO canonical_human_message_submissions(
        submission_id,event_id,agent_kind,session_id,observed_at
      ) VALUES (?,?,?,?,?)`),
      canonicalSubmissionById: database.prepare(`SELECT event_id,agent_kind,session_id FROM canonical_human_message_submissions
        WHERE submission_id=?`),
      staleReplayEvidence: database.prepare(`SELECT i.event_json,i.payload_compacted_at,s.payload_hash,l.state,l.sequence
        FROM core_event_lane_items l JOIN core_event_inbox i ON i.event_id = l.event_id
        LEFT JOIN audit_skeletons s ON s.source_kind='core_event' AND s.source_id=i.event_id
        WHERE l.lane_id = ? AND l.event_id = ?`),
      pendingCandidate: database.prepare(`SELECT 1 AS pending FROM core_event_lane_items
        WHERE lane_id=? AND state='pending' AND event_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
    };
  }

  ingestBatch(batch: CoreEventInboxBatch): CoreEventIngestResult {
    validateBatch(batch);
    if (batch.events.length === 0 && batch.nextCursor === batch.afterCursor && batch.nextCursor === batch.latestCursor) {
      const checkpoint = this.statements.checkpoint.get(batch.laneId) as CoreCheckpointRow | undefined;
      if (checkpoint
        && checkpoint.source_id === batch.sourceId
        && checkpoint.source_epoch === (batch.sourceEpoch ?? null)
        && checkpoint.agent_kind === batch.agentKind
        && checkpoint.session_id === batch.sessionId
        && checkpoint.read_cursor === batch.afterCursor
        && checkpoint.latest_cursor === batch.latestCursor) return "accepted";
    }
    const projected: Array<{ submissionId?: string; coreEventId: string; segmentId: string }> = [];
    const result = this.context.transaction("sqlite.core-event-inbox-store.ingest-batch", () => {
      const pendingWorkCandidates: string[] = [];
      const checkpoint = this.statements.checkpoint.get(batch.laneId) as CoreCheckpointRow | undefined;
      if (checkpoint && (checkpoint.source_id !== batch.sourceId || checkpoint.agent_kind !== batch.agentKind || checkpoint.session_id !== batch.sessionId)) {
        throw new Error("Core event inbox identity mismatch");
      }
      if (checkpoint && checkpoint.read_cursor !== batch.afterCursor) {
        this.acceptStaleReplay(batch);
        return "stale_rebase";
      }
      const isCheckpointMetadataRefresh = batch.events.length === 0 && batch.nextCursor === batch.afterCursor;
      if (checkpoint?.source_epoch && checkpoint.source_epoch !== (batch.sourceEpoch ?? null) && !isCheckpointMetadataRefresh) {
        throw new Error("Core event inbox source epoch mismatch");
      }
      let sequence = Number((this.statements.maximumLaneSequence.get(batch.laneId) as { sequence: number }).sequence);
      for (const event of batch.events) {
        const evidence = this.statements.ingestEvidence.get(batch.laneId, event.eventId) as IngestEvidenceRow | undefined;
        const stored = this.storeEvent(event, batch.ingestedAt, evidence ?? null);
        let laneSequence = evidence?.sequence ?? null;
        let laneState = evidence?.state ?? null;
        let insertedLaneItem = false;
        const shouldProjectExactReplay = stored.admission === "duplicate"
          && isExactReplayProjectedPayload(stored.event.payload)
          && !stored.skipProjection;
        if (laneSequence === null) {
          sequence += 1;
          this.statements.insertLaneItem.run(batch.laneId, event.eventId, sequence, batch.ingestedAt, batch.ingestedAt);
          laneSequence = sequence;
          insertedLaneItem = true;
          laneState = "pending";
          if ((stored.admission !== "new" || stored.skipProjection) && !shouldProjectExactReplay) {
            this.statements.ignoreLaneItem.run(batch.ingestedAt, batch.laneId, event.eventId);
            laneState = "ignored";
          }
          if (laneState === "pending") pendingWorkCandidates.push(event.eventId);
        }
        if (stored.admission === "conflict") {
          this.settleConflict(batch.laneId, event.eventId, event, batch.ingestedAt);
        }
        const shouldProjectNewEvent = stored.admission === "new" && !stored.skipProjection && !isSettledLaneItem(laneState ?? undefined);
        const shouldProjectInsertedExactReplay = insertedLaneItem && shouldProjectExactReplay;
        if (shouldProjectNewEvent || shouldProjectInsertedExactReplay) {
          let projection: { segmentId?: string | null; outcome?: string } | void = undefined;
          let savepointCommitted = false;
          try {
            projection = this.context.savepoint("sqlite.core-event-inbox-store.project-event", () => {
              const projected = this.dependencies?.projectCanonicalEvent?.({ laneId: batch.laneId, laneSequence, sourceId: batch.sourceId, sourceEpoch: batch.sourceEpoch ?? null, ...(batch.sessionActivityContext ? { sessionActivityContext: batch.sessionActivityContext } : {}), event: fromStoredEvent(stored.event), observedAt: batch.ingestedAt });
              if (stored.admission === "new") this.observeCanonicalHumanMessage(stored.event, batch.ingestedAt);
              return projected;
            });
            savepointCommitted = true;
          } catch (error) {
            if (!(error instanceof SqliteSavepointOperationError)) throw error;
            if (shouldProjectInsertedExactReplay) throw error;
          }
          if (savepointCommitted && shouldProjectInsertedExactReplay) {
            this.statements.ignoreLaneItem.run(batch.ingestedAt, batch.laneId, event.eventId);
            laneState = "ignored";
          }
          const payload = stored.event.payload as Record<string, unknown>;
          if (savepointCommitted && payload.type === "human_message" && projection?.segmentId) projected.push({
            ...(typeof payload.submission_id === "string" ? { submissionId: payload.submission_id } : {}),
            coreEventId: stored.event.eventId,
            segmentId: projection.segmentId
          });
        }
      }
      this.statements.upsertCheckpoint.run(
        batch.laneId, batch.sourceId, batch.sourceEpoch ?? null, batch.agentKind, batch.sessionId, batch.nextCursor, batch.latestCursor, batch.ingestedAt
      );
      if (pendingWorkCandidates.length > 0) {
        const candidateEventIdsJson = JSON.stringify(pendingWorkCandidates);
        this.context.receipt(undefined, []).afterCommit(() => {
          if (this.pendingWorkCommittedListeners.size === 0) return;
          const pending = this.statements.pendingCandidate.get(batch.laneId, candidateEventIdsJson) as { pending: number } | undefined;
          if (!pending) return;
          for (const listener of this.pendingWorkCommittedListeners) listener();
        });
      }
      return "accepted";
    });
    for (const item of projected) this.dependencies?.deliveryTrace?.mark({
      stage: "core_projected",
      correlation: { ...(item.submissionId ? { submissionId: item.submissionId } : {}), coreEventId: item.coreEventId, segmentId: item.segmentId }
    });
    return result;
  }

  bootstrapExpiredLane(input: CoreEventLaneBootstrap): CoreEventLaneBootstrapResult {
    validateLaneBootstrap(input);
    return this.context.transaction("sqlite.core-event-inbox-store.bootstrap-expired-lane", () => {
      const checkpoint = this.context.database.prepare(`SELECT 1 AS present
        FROM core_event_lane_checkpoints WHERE lane_id=?`).get(input.laneId) as { present: number } | undefined;
      const laneItems = this.context.database.prepare(`SELECT 1 AS present
        FROM core_event_lane_items WHERE lane_id=? LIMIT 1`).get(input.laneId) as { present: number } | undefined;
      if (checkpoint || laneItems) return "stale_rebase";

      this.context.database.prepare(`INSERT INTO core_event_lane_checkpoints(
        lane_id,source_id,source_epoch,agent_kind,session_id,read_cursor,latest_cursor,updated_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(
        input.laneId, input.sourceId, input.sourceEpoch, input.agentKind, input.sessionId,
        input.resumeCursor, input.latestCursor, input.observedAt
      );
      const details = JSON.stringify({
        laneId: input.laneId,
        sourceId: input.sourceId,
        sourceEpoch: input.sourceEpoch,
        agentKind: input.agentKind,
        sessionId: input.sessionId,
        staleCursor: "start",
        resumeCursor: input.resumeCursor,
        earliestCursor: input.earliestCursor,
        latestCursor: input.latestCursor
      });
      const gapIdentity = createHash("sha256").update(details).digest("hex");
      this.context.database.prepare(`INSERT OR IGNORE INTO projection_gaps(
        stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,first_failed_at,last_failed_at,details_json
      ) VALUES ('core_projection',?,?,?,'projection','cursor_expired',?,?,?)`).run(
        input.owner.kind, input.owner.id, `cursor-expired:${gapIdentity}`, input.observedAt, input.observedAt, details
      );
      return "bootstrapped";
    });
  }

  rebaseExpiredCheckpoint(input: CoreEventCheckpointRebase): CoreEventCheckpointRebaseResult {
    validateRebase(input);
    return this.context.transaction("sqlite.core-event-inbox-store.rebase-expired-checkpoint", () => {
      const checkpoint = this.context.database.prepare(`SELECT source_id,source_epoch,agent_kind,session_id,read_cursor
        FROM core_event_lane_checkpoints WHERE lane_id=?`).get(input.laneId) as {
          source_id: string; source_epoch: string | null; agent_kind: string; session_id: string; read_cursor: string;
        } | undefined;
      if (!checkpoint
        || checkpoint.source_id !== input.sourceId
        || checkpoint.source_epoch !== input.expectedSourceEpoch
        || checkpoint.agent_kind !== input.agentKind
        || checkpoint.session_id !== input.sessionId
        || checkpoint.read_cursor !== input.expectedReadCursor) return "stale_rebase";

      const updated = this.context.database.prepare(`UPDATE core_event_lane_checkpoints
        SET source_epoch=?,read_cursor=?,latest_cursor=?,updated_at=?
        WHERE lane_id=? AND source_id=? AND source_epoch IS ? AND agent_kind=? AND session_id=? AND read_cursor=?`).run(
        input.sourceEpoch, input.resumeCursor, input.latestCursor, input.rebasedAt,
        input.laneId, input.sourceId, input.expectedSourceEpoch, input.agentKind, input.sessionId, input.expectedReadCursor
      );
      if (Number(updated.changes) !== 1) return "stale_rebase";

      const details = JSON.stringify({
        laneId: input.laneId,
        sourceId: input.sourceId,
        sourceEpoch: input.sourceEpoch,
        staleCursor: input.expectedReadCursor,
        resumeCursor: input.resumeCursor,
        earliestCursor: input.earliestCursor,
        latestCursor: input.latestCursor
      });
      const gapIdentity = createHash("sha256").update(details).digest("hex");
      this.context.database.prepare(`INSERT OR IGNORE INTO projection_gaps(
        stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,first_failed_at,last_failed_at,details_json
      ) VALUES ('core_projection',?,?,?,'projection','cursor_expired',?,?,?)`).run(
        input.owner.kind, input.owner.id, `cursor-expired:${gapIdentity}`, input.rebasedAt, input.rebasedAt, details
      );
      return "rebased";
    });
  }

  rebaseEpochTransition(input: CoreEventEpochTransitionRebase): CoreEventEpochTransitionRebaseResult {
    validateEpochTransitionRebase(input);
    return this.context.transaction("sqlite.core-event-inbox-store.rebase-epoch-transition", () => {
      const checkpoint = this.context.database.prepare(`SELECT source_id,source_epoch,agent_kind,session_id,read_cursor
        FROM core_event_lane_checkpoints WHERE lane_id=?`).get(input.laneId) as {
          source_id: string; source_epoch: string | null; agent_kind: string; session_id: string; read_cursor: string;
        } | undefined;
      if (!checkpoint
        || checkpoint.source_id !== input.sourceId
        || checkpoint.source_epoch !== input.expectedSourceEpoch
        || checkpoint.agent_kind !== input.agentKind
        || checkpoint.session_id !== input.sessionId
        || checkpoint.read_cursor !== input.expectedReadCursor) return "stale_rebase";

      const updated = this.context.database.prepare(`UPDATE core_event_lane_checkpoints
        SET source_epoch=?,read_cursor='start',latest_cursor=?,updated_at=?
        WHERE lane_id=? AND source_id=? AND source_epoch=? AND agent_kind=? AND session_id=? AND read_cursor=?`).run(
        input.sourceEpoch, input.latestCursor, input.rebasedAt,
        input.laneId, input.sourceId, input.expectedSourceEpoch, input.agentKind, input.sessionId, input.expectedReadCursor
      );
      if (Number(updated.changes) !== 1) return "stale_rebase";

      const details = JSON.stringify({
        laneId: input.laneId,
        sourceId: input.sourceId,
        agentKind: input.agentKind,
        sessionId: input.sessionId,
        expectedSourceEpoch: input.expectedSourceEpoch,
        expectedReadCursor: input.expectedReadCursor,
        sourceEpoch: input.sourceEpoch,
        earliestCursor: input.earliestCursor,
        latestCursor: input.latestCursor
      });
      const gapIdentity = createHash("sha256").update(details).digest("hex");
      this.context.database.prepare(`INSERT OR IGNORE INTO projection_gaps(
        stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,first_failed_at,last_failed_at,details_json
      ) VALUES ('core_projection',?,?,?,'projection','cursor_epoch_changed',?,?,?)`).run(
        input.owner.kind, input.owner.id, `cursor-epoch-changed:${gapIdentity}`, input.rebasedAt, input.rebasedAt, details
      );
      return "rebased";
    });
  }

  transitionSource(input: CoreEventSourceTransition): CoreEventSourceTransitionResult {
    validateSourceTransition(input);
    return this.context.transaction("sqlite.core-event-inbox-store.transition-source", () => {
      const checkpoint = this.context.database.prepare(`SELECT source_id,source_epoch,agent_kind,session_id,read_cursor
        FROM core_event_lane_checkpoints WHERE lane_id=?`).get(input.laneId) as {
          source_id: string; source_epoch: string | null; agent_kind: string; session_id: string; read_cursor: string;
        } | undefined;
      if (!checkpoint
        || checkpoint.source_id !== input.expectedSourceId
        || checkpoint.source_epoch !== input.expectedSourceEpoch
        || checkpoint.agent_kind !== input.agentKind
        || checkpoint.session_id !== input.sessionId
        || checkpoint.read_cursor !== input.expectedReadCursor) return "stale_rebase";

      const updated = this.context.database.prepare(`UPDATE core_event_lane_checkpoints
        SET source_id=?,source_epoch=?,read_cursor='start',latest_cursor=?,updated_at=?
        WHERE lane_id=? AND source_id=? AND source_epoch=? AND agent_kind=? AND session_id=? AND read_cursor=?`).run(
        input.sourceId, input.sourceEpoch, input.latestCursor, input.transitionedAt,
        input.laneId, input.expectedSourceId, input.expectedSourceEpoch, input.agentKind, input.sessionId, input.expectedReadCursor
      );
      if (Number(updated.changes) !== 1) return "stale_rebase";

      const details = JSON.stringify({
        laneId: input.laneId,
        expectedSourceId: input.expectedSourceId,
        expectedSourceEpoch: input.expectedSourceEpoch,
        expectedReadCursor: input.expectedReadCursor,
        sourceId: input.sourceId,
        sourceEpoch: input.sourceEpoch,
        agentKind: input.agentKind,
        sessionId: input.sessionId,
        earliestCursor: input.earliestCursor,
        latestCursor: input.latestCursor
      });
      const gapIdentity = createHash("sha256").update(details).digest("hex");
      this.context.database.prepare(`INSERT OR IGNORE INTO projection_gaps(
        stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,first_failed_at,last_failed_at,details_json
      ) VALUES ('core_projection',?,?,?,'projection','cursor_source_changed',?,?,?)`).run(
        input.owner.kind, input.owner.id, `cursor-source-changed:${gapIdentity}`, input.transitionedAt, input.transitionedAt, details
      );
      return "transitioned";
    });
  }

  recordInvalidCursorGap(input: CoreEventInvalidCursorGap): void {
    validateInvalidCursorGap(input);
    this.context.transaction("sqlite.core-event-inbox-store.record-invalid-cursor-gap", () => {
      const details = JSON.stringify({
        laneId: input.laneId,
        sourceId: input.sourceId,
        sourceEpoch: input.sourceEpoch,
        agentKind: input.agentKind,
        sessionId: input.sessionId,
        readCursor: input.readCursor
      });
      const gapIdentity = createHash("sha256").update(details).digest("hex");
      this.context.database.prepare(`INSERT OR IGNORE INTO projection_gaps(
        stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,first_failed_at,last_failed_at,details_json
      ) VALUES ('core_projection',?,?,?,'projection','invalid_cursor',?,?,?)`).run(
        input.owner.kind, input.owner.id, `invalid-cursor:${gapIdentity}`, input.occurredAt, input.occurredAt, details
      );
    });
  }

  ingestCanonicalSnapshotEvidence(events: readonly CoreEventEnvelope[], ingestedAt: string): number {
    return this.context.transaction("sqlite.core-event-inbox-store.ingest-canonical-snapshot-evidence", () => {
      let observed = 0;
      let recoveredLaneId: string | null = null;
      let recoveredNextLaneSequence: number | null = null;
      for (const [eventIndex, event] of events.entries()) {
        if (event.schemaVersion !== 1 || !event.eventId || !event.sourceId || !event.sessionId) throw new Error("Invalid canonical Core event evidence");
        const storedEvidence = this.storeEvent(event, ingestedAt);
        const stored = storedEvidence.event;
        if (humanSubmissionId(stored.payload)) observed += 1;
        const laneItem = this.context.database.prepare("SELECT lane_id,sequence FROM core_event_lane_items WHERE event_id=? ORDER BY sequence LIMIT 1").get(event.eventId) as { lane_id: string; sequence: number } | undefined;
        const laneSequence = laneItem?.sequence ?? recoveredNextLaneSequence ?? eventIndex;
        if (storedEvidence.admission === "new" && !storedEvidence.skipProjection) {
          this.dependencies?.projectCanonicalEvent?.({ laneId: laneItem?.lane_id ?? recoveredLaneId ?? `snapshot:${event.sourceId}:${event.turnId ?? "session"}`, laneSequence, sourceId: event.sourceId, sourceEpoch: null, event: fromStoredEvent(stored), observedAt: ingestedAt });
        }
        if (storedEvidence.admission === "new") this.observeCanonicalHumanMessage(stored, ingestedAt);
        if (humanSubmissionId(stored.payload)) {
          const segment = this.context.database.prepare("SELECT producer_key FROM conversation_segments WHERE human_event_id=?")
            .get(event.eventId) as { producer_key: string | null } | undefined;
          if (segment?.producer_key?.startsWith("lane:")) recoveredLaneId = segment.producer_key.slice("lane:".length);
        }
        if (recoveredLaneId !== null) recoveredNextLaneSequence = Math.max(recoveredNextLaneSequence ?? 0, laneSequence + 1);
      }
      return observed;
    });
  }

  private storeEvent(event: CoreEventEnvelope, ingestedAt: string, loadedEvidence?: Pick<IngestEvidenceRow, "event_json" | "payload_compacted_at" | "payload_hash"> | null): StoredEventEvidence {
    const incoming = toStoredEvent(event);
    const existingEvent = loadedEvidence === undefined
      ? this.statements.eventById.get(event.eventId) as Pick<IngestEvidenceRow, "event_json" | "payload_compacted_at" | "payload_hash"> | undefined
      : loadedEvidence === null ? undefined : loadedEvidence;
    if (existingEvent?.payload_compacted_at !== null && existingEvent?.payload_compacted_at !== undefined) {
      return { event: incoming, admission: matchesCompactedCoreEventHash(incoming, existingEvent.payload_hash) ? "duplicate" : "conflict", skipProjection: true };
    }
    if (existingEvent) {
      const existing = JSON.parse(existingEvent.event_json) as StoredCoreEvent;
      const admission = sameCoreEventSemantics(existing, incoming) ? "duplicate" : "conflict";
      return { event: existing, admission, skipProjection: admission === "conflict" || isSourceErrorPayload(existing.payload) };
    }
    const normalizedEventJson = JSON.stringify(incoming);
    const discriminators = coreEventDiscriminators(incoming);
    const inserted = this.statements.insertEvent.run(
      event.eventId, event.sourceId, event.agentKind, event.sessionId, event.turnId, event.cursor, event.occurredAt, normalizedEventJson, ingestedAt,
      discriminators.eventType, discriminators.submissionId, discriminators.channel, discriminators.callId
    );
    if (Number(inserted.changes) !== 1) throw new Error("Core event ingest lost its insert decision");
    return { event: incoming, admission: "new", skipProjection: isSourceErrorPayload(incoming.payload) };
  }

  private settleConflict(laneId: string, eventId: string, event: CoreEventEnvelope, observedAt: string): void {
    const hash = coreEventSemanticHash(event) ?? sha256(JSON.stringify(toStoredEvent(event)));
    this.statements.settleLaneConflict.run(MAX_CONFLICT_COUNT, hash, observedAt, observedAt, laneId, eventId);
  }

  private acceptStaleReplay(batch: CoreEventInboxBatch): void {
    for (const event of batch.events) {
      const existing = this.statements.staleReplayEvidence.get(batch.laneId, event.eventId) as (IngestEvidenceRow & { state: string; sequence: number }) | undefined;
      if (!existing) continue;
      const stored = this.storeEvent(event, batch.ingestedAt, existing);
      if (stored.admission === "conflict") this.settleConflict(batch.laneId, event.eventId, event, batch.ingestedAt);
    }
  }

  private observeCanonicalHumanMessage(event: StoredCoreEvent, observedAt: string): void {
    const submissionId = humanSubmissionId(event.payload);
    if (!submissionId) return;
    const inserted = this.statements.insertCanonicalSubmission.run(
      submissionId, event.eventId, event.agentKind, event.sessionId, observedAt
    );
    const recorded = inserted && Number(inserted.changes) === 1
      ? { event_id: event.eventId, agent_kind: event.agentKind, session_id: event.sessionId }
      : this.statements.canonicalSubmissionById.get(submissionId) as { event_id: string; agent_kind: string; session_id: string } | undefined;
    if (!recorded) throw new Error("Canonical Human Message submission identity conflict");
    if (recorded.event_id !== event.eventId || recorded.agent_kind !== event.agentKind || recorded.session_id !== event.sessionId) {
      throw new Error("Canonical Human Message submission identity conflict");
    }
    this.dependencies?.observeCanonicalHumanMessage?.({
      submissionId, eventId: event.eventId, agentKind: event.agentKind, sessionId: event.sessionId, observedAt
    });
  }

  loadPending(laneId: string, limit = 128): CoreEventInboxPendingBatch {
    const boundedLimit = Math.max(1, Math.min(128, Math.floor(limit)));
    this.context.database.prepare(`UPDATE core_event_lane_items
      SET state='pending', attempt_count=0, failure=NULL, failure_fingerprint=NULL, reducer_revision=?, updated_at=?
      WHERE lane_id=? AND state='quarantined' AND reducer_revision < ?`).run(
      CORE_EVENT_REDUCER_REVISION, new Date().toISOString(), laneId, CORE_EVENT_REDUCER_REVISION
    );
    const rows = this.context.database.prepare(`SELECT i.event_id, i.event_json
      FROM core_event_lane_items l JOIN core_event_inbox i ON i.event_id = l.event_id
      WHERE l.lane_id = ? AND l.state = 'pending' AND i.payload_compacted_at IS NULL
      ORDER BY l.sequence LIMIT ?`).all(laneId, boundedLimit) as Array<{ event_id: string; event_json: string }>;
    return {
      events: rows.map((row) => fromStoredEvent(JSON.parse(row.event_json) as StoredCoreEvent)),
      eventIds: rows.map((row) => row.event_id)
    };
  }

  listHistoricalRecoveryCandidates(input: { limit?: number }): HistoricalCoreRecoveryCandidate[] {
    const limit = Math.max(1, Math.min(128, Math.floor(input.limit ?? 32)));
    const rows = this.context.database.prepare(`WITH ${HISTORICAL_RECOVERY_ROUTES_SQL}, pending_heads AS (
        SELECT lane.lane_id,lane.event_id,lane.sequence,lane.created_at,
          ROW_NUMBER() OVER (PARTITION BY lane.lane_id ORDER BY lane.sequence,lane.event_id) AS lane_rank
        FROM core_event_lane_items lane WHERE lane.state='pending'
      )
      SELECT head.lane_id,head.event_id,head.sequence,head.created_at,
        checkpoint.source_id,checkpoint.source_epoch,checkpoint.agent_kind,checkpoint.session_id,
        route.owner_kind,route.owner_id,route.owner_generation,route.gateway_id,route.root_message_id
      FROM pending_heads head
      JOIN core_event_lane_checkpoints checkpoint ON checkpoint.lane_id=head.lane_id
      JOIN unique_routes route ON route.lane_id=head.lane_id
        AND route.route_rank=1 AND route.route_count=1
      WHERE head.lane_rank=1
      ORDER BY head.created_at,head.lane_id,head.sequence LIMIT ?`).all(limit) as Array<{
        lane_id: string; event_id: string; sequence: number; created_at: string;
        source_id: string; source_epoch: string | null; agent_kind: "traex" | "pi"; session_id: string;
        owner_kind: "primary" | "worker"; owner_id: string; owner_generation: number; gateway_id: string; root_message_id: string;
      }>;
    return rows.map((row) => ({
      laneId: row.lane_id,
      eventId: row.event_id,
      laneSequence: Number(row.sequence),
      sourceId: row.source_id,
      sourceEpoch: row.source_epoch,
      agentKind: row.agent_kind,
      sessionId: row.session_id,
      oldestPendingAt: row.created_at,
      route: {
        ownerKind: row.owner_kind,
        ownerId: row.owner_id,
        ownerGeneration: Number(row.owner_generation),
        gatewayId: row.gateway_id,
        rootMessageId: row.root_message_id
      }
    }));
  }

  summarizeHistoricalRecoveryBacklog(): HistoricalRecoveryBacklogSummary {
    const row = this.context.database.prepare(`WITH ${HISTORICAL_RECOVERY_ROUTES_SQL}, route_counts AS (
        SELECT lane_id,MAX(route_count) AS route_count FROM unique_routes GROUP BY lane_id
      ), pending AS (
        SELECT lane_id,COUNT(*) AS pending,MIN(created_at) AS oldest
        FROM core_event_lane_items WHERE state='pending' GROUP BY lane_id
      ) SELECT
        COALESCE(SUM(CASE WHEN route.route_count=1 THEN pending.pending ELSE 0 END),0) AS eligible_pending,
        COALESCE(SUM(CASE WHEN route.route_count=1 THEN 1 ELSE 0 END),0) AS eligible_lanes,
        COALESCE(SUM(CASE WHEN route.route_count=1 THEN 0 ELSE pending.pending END),0) AS ineligible_pending,
        MIN(CASE WHEN route.route_count=1 THEN pending.oldest END) AS oldest_eligible,
        (SELECT COUNT(*) FROM core_event_lane_items WHERE state='quarantined') AS quarantined
      FROM pending LEFT JOIN route_counts route ON route.lane_id=pending.lane_id`).get() as {
        eligible_pending: number; eligible_lanes: number; ineligible_pending: number;
        oldest_eligible: string | null; quarantined: number;
      };
    return {
      eligiblePendingEvents: Number(row.eligible_pending),
      eligibleLanes: Number(row.eligible_lanes),
      ineligiblePendingEvents: Number(row.ineligible_pending),
      quarantinedEvents: Number(row.quarantined),
      oldestEligibleAt: row.oldest_eligible
    };
  }

  reprojectHistoricalCandidate(candidate: HistoricalCoreRecoveryCandidate, observedAt = new Date().toISOString()): HistoricalCoreRecoveryResult {
    const currentRoute = () => this.context.database.prepare(`WITH ${HISTORICAL_RECOVERY_ROUTES_SQL}
      SELECT lane.event_id,lane.sequence,
        checkpoint.source_id,checkpoint.source_epoch,checkpoint.agent_kind,checkpoint.session_id,
        route.owner_kind,route.owner_id,route.owner_generation,route.gateway_id,route.root_message_id,route.route_count,
        inbox.event_json
      FROM core_event_lane_items lane
      JOIN core_event_lane_checkpoints checkpoint ON checkpoint.lane_id=lane.lane_id
      JOIN core_event_inbox inbox ON inbox.event_id=lane.event_id
      JOIN unique_routes route ON route.lane_id=lane.lane_id AND route.route_rank=1 AND route.route_count=1
      WHERE lane.lane_id=? AND lane.event_id=? AND lane.sequence=? AND lane.state='pending'
        AND inbox.payload_compacted_at IS NULL
        AND route.owner_kind=? AND route.owner_id=? AND route.owner_generation=?
        AND route.gateway_id=? AND route.root_message_id=?`
    ).get(
      candidate.laneId, candidate.eventId, candidate.laneSequence,
      candidate.route.ownerKind,
      candidate.route.ownerId, candidate.route.ownerGeneration,
      candidate.route.gatewayId, candidate.route.rootMessageId
    ) as {
      event_id: string; sequence: number; source_id: string; source_epoch: string | null;
      agent_kind: "traex" | "pi"; session_id: string; owner_kind: "primary" | "worker"; owner_id: string; owner_generation: number;
      gateway_id: string; root_message_id: string; route_count: number; event_json: string;
    } | undefined;
    const remaining = () => this.context.database.prepare(
      "SELECT 1 AS present FROM core_event_lane_items WHERE lane_id=? AND state='pending' LIMIT 1"
    ).get(candidate.laneId) !== undefined;
    try {
      const projected = this.context.transaction("sqlite.core-event-inbox-store.reproject-history", () => {
        const row = currentRoute();
        if (!row || Number(row.route_count) !== 1
          || row.source_id !== candidate.sourceId || row.source_epoch !== candidate.sourceEpoch
          || row.agent_kind !== candidate.agentKind || row.session_id !== candidate.sessionId) return false;
        if (!this.dependencies?.projectCanonicalEvent) throw new Error("Core canonical projector is unavailable");
        this.dependencies.projectCanonicalEvent({
          laneId: candidate.laneId, laneSequence: candidate.laneSequence,
          sourceId: candidate.sourceId, sourceEpoch: candidate.sourceEpoch,
          event: fromStoredEvent(JSON.parse(row.event_json) as StoredCoreEvent), observedAt,
          route: candidate.route, workClass: "history"
        });
        this.acknowledge(candidate.laneId, [candidate.eventId], "projected", observedAt, undefined, {
          kind: candidate.route.ownerKind === "primary" ? "binding" : "worker_turn",
          id: candidate.route.ownerId
        });
        return true;
      });
      return { outcome: projected ? "projected" : "stale", remaining: remaining() };
    } catch (error) {
      const outcome = this.acknowledge(
        candidate.laneId, [candidate.eventId], "quarantined", observedAt,
        error instanceof Error ? error.message : String(error),
        { kind: candidate.route.ownerKind === "primary" ? "binding" : "worker_turn", id: candidate.route.ownerId }
      );
      return { outcome: outcome === "quarantined" ? "quarantined" : "retry", remaining: remaining() };
    }
  }

  loadSettledTurnStart(input: { laneId: string; agentKind: "traex" | "pi"; sessionId: string; turnId: string }): CoreEventEnvelope | null {
    const eventType = coreEventDiscriminatorSql(this.context.database, "i", "event_type");
    const rows = this.context.database.prepare(`SELECT i.event_json
      FROM core_event_lane_items l JOIN core_event_inbox i ON i.event_id = l.event_id
      WHERE l.lane_id = ? AND l.state IN ('projected','ignored')
        AND i.agent_kind = ? AND i.session_id = ? AND i.turn_id = ?
        AND i.payload_compacted_at IS NULL
        AND ${eventType} = 'turn_started'
      ORDER BY l.sequence LIMIT 2`).all(
        input.laneId, input.agentKind, input.sessionId, input.turnId
      ) as Array<{ event_json: string }>;
    return rows.length === 1 ? fromStoredEvent(JSON.parse(rows[0]!.event_json) as StoredCoreEvent) : null;
  }

  loadProjectedTurnViewEvents(input: { agentKind: "traex" | "pi"; sessionId: string; turnId: string; startedAt: string }): CoreEventEnvelope[] {
    const eventType = coreEventDiscriminatorSql(this.context.database, "i", "event_type");
    const ordered = this.context.database.prepare(`SELECT i.event_json
      FROM conversation_turn_projection_events projected
      JOIN core_event_inbox i ON i.event_id = projected.event_id
      WHERE projected.agent_kind = ? AND projected.session_id = ? AND projected.turn_id = ? AND projected.started_at = ?
        AND i.payload_compacted_at IS NULL
        AND ${eventType} IN ('tool_call', 'goal_changed')
      ORDER BY projected.sequence`).all(
      input.agentKind, input.sessionId, input.turnId, input.startedAt
    ) as Array<{ event_json: string }>;
    return ordered.map((row) => fromStoredEvent(JSON.parse(row.event_json) as StoredCoreEvent));
  }

  getCheckpoint(laneId: string): CoreEventInboxCheckpoint | null {
    const row = this.statements.checkpoint.get(laneId) as CoreCheckpointRow | undefined;
    return row ? { sourceId: row.source_id, sourceEpoch: row.source_epoch, agentKind: row.agent_kind, sessionId: row.session_id, readCursor: row.read_cursor, latestCursor: row.latest_cursor } : null;
  }

  countOpenProjectionGaps(owner: { kind: "binding" | "worker_turn"; id: string }): number {
    const row = this.context.database.prepare(
      "SELECT count(*) AS count FROM projection_gaps WHERE owner_kind = ? AND owner_id = ? AND state = 'open'"
    ).get(owner.kind, owner.id) as { count: number };
    return Number(row.count);
  }

  backfillDiscriminators(limit = 128, occurredAt = new Date().toISOString()): CoreEventDiscriminatorBackfillResult {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    return this.context.transaction("sqlite.core-event-discriminator-backfill", () => {
      const checkpoint = this.context.database.prepare(`SELECT state,high_water_event_id,after_event_id
        FROM core_event_discriminator_backfill WHERE singleton_id=1`).get() as {
          state: "backfilling" | "complete"; high_water_event_id: string | null; after_event_id: string;
        } | undefined;
      if (!checkpoint) throw new Error("Core event discriminator backfill checkpoint is missing");
      if (checkpoint.state === "complete") return { state: "complete", processed: 0, remaining: false };
      if (checkpoint.high_water_event_id === null) throw new Error("Core event discriminator backfill high water is missing");
      const page = this.context.database.prepare(`SELECT event_id,event_json,event_type,submission_id,channel,call_id
        FROM core_event_inbox WHERE payload_compacted_at IS NULL AND event_id>? AND event_id<=? ORDER BY event_id LIMIT ?`).all(
        checkpoint.after_event_id, checkpoint.high_water_event_id, boundedLimit + 1
      ) as Array<{ event_id: string; event_json: string; event_type: string | null; submission_id: string | null; channel: string | null; call_id: string | null }>;
      const rows = page.slice(0, boundedLimit);
      let afterEventId = checkpoint.after_event_id;
      for (const row of rows) {
        const expected = parseCoreEventDiscriminators(row.event_json);
        assertCompatibleDiscriminators(row, expected);
        this.context.database.prepare(`UPDATE core_event_inbox SET event_type=?,submission_id=?,channel=?,call_id=?
          WHERE event_id=?`).run(expected.eventType, expected.submissionId, expected.channel, expected.callId, row.event_id);
        afterEventId = row.event_id;
      }
      const remaining = page.length > boundedLimit;
      this.context.database.prepare(`UPDATE core_event_discriminator_backfill SET
        state=?,after_event_id=?,processed_count=processed_count+?,updated_at=? WHERE singleton_id=1`).run(
        remaining ? "backfilling" : "complete", afterEventId, rows.length, occurredAt
      );
      return { state: remaining ? "backfilling" : "complete", processed: rows.length, remaining };
    });
  }

  acknowledge(laneId: string, eventIds: readonly string[], outcome: "projected" | "ignored" | "quarantined", occurredAt: string, error?: string, owner?: { kind: "binding" | "worker_turn"; id: string }): CoreEventSettlementResult {
    if (eventIds.length === 0) return "settled";
    const boundedError = error ? redactSecrets(error).slice(0, MAX_FAILURE_CHARS) : null;
    const failureFingerprint = boundedError ? createHash("sha256").update(boundedError).digest("hex") : null;
    return this.context.transaction("sqlite.core-event-inbox-store.acknowledge", () => {
      if (outcome === "projected" && owner) new SqliteHumanReviewCandidateStore(this.context).capture({ laneId, eventIds, occurredAt, owner });
      let result: CoreEventSettlementResult = "settled";
      for (const eventId of new Set(eventIds)) {
        if (outcome === "quarantined") {
          const row = this.context.database.prepare(`SELECT attempt_count,reducer_revision FROM core_event_lane_items
            WHERE lane_id=? AND event_id=? AND state='pending'`).get(laneId, eventId) as { attempt_count: number; reducer_revision: number } | undefined;
          if (!row) continue;
          const priorAttempts = Number(row.reducer_revision) === CORE_EVENT_REDUCER_REVISION ? Number(row.attempt_count) : 0;
          const attempts = priorAttempts + 1;
          const exhausted = attempts >= CORE_EVENT_MAX_PROJECTION_ATTEMPTS;
          result = exhausted ? (result === "settled" ? "quarantined" : result) : "retry";
          this.context.database.prepare(`UPDATE core_event_lane_items
            SET state=?, failure=?, failure_fingerprint=?, attempt_count=?, reducer_revision=?, updated_at=?
            WHERE lane_id=? AND event_id=? AND state='pending'`).run(
            exhausted ? "quarantined" : "pending", exhausted ? failureFingerprint : null, failureFingerprint,
            attempts, CORE_EVENT_REDUCER_REVISION, occurredAt, laneId, eventId
          );
          if (exhausted && owner) new SqliteProjectionGapStore(this.context).open({
            stage: "core_projection", ownerKind: owner.kind, ownerId: owner.id, sourceItemId: eventId,
            failureClass: "projection", failureCode: `projection_${failureFingerprint?.slice(0, 16) ?? "failed"}`,
            requiredVersion: CORE_EVENT_REDUCER_REVISION, occurredAt
          });
          continue;
        }
        this.context.database.prepare(`UPDATE core_event_lane_items
          SET state=?, failure=NULL, failure_fingerprint=NULL, reducer_revision=?, updated_at=?
          WHERE lane_id=? AND event_id=? AND state='pending'`).run(
          outcome, CORE_EVENT_REDUCER_REVISION, occurredAt, laneId, eventId
        );
        if (outcome === "projected") {
          this.recordConversationTurnProjectionOrder(eventId, occurredAt);
          new SqliteProjectionGapStore(this.context).compensateProjectionEvent(eventId, CORE_EVENT_REDUCER_REVISION, occurredAt);
        }
      }
      return result;
    });
  }

  private recordConversationTurnProjectionOrder(eventId: string, occurredAt: string): void {
    const row = this.context.database.prepare(
      "SELECT agent_kind, session_id, turn_id FROM core_event_inbox WHERE event_id = ?"
    ).get(eventId) as {
      agent_kind: "traex" | "pi"; session_id: string; turn_id: string | null;
    } | undefined;
    if (!row?.turn_id) return;
    const projection = this.context.database.prepare(`SELECT started_at FROM conversation_turn_projections
      WHERE agent_kind = ? AND session_id = ? AND turn_id = ?
      ORDER BY created_at, started_at LIMIT 1`).get(
      row.agent_kind, row.session_id, row.turn_id
    ) as { started_at: string } | undefined;
    if (!projection) return;
    const next = this.context.database.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM conversation_turn_projection_events
      WHERE agent_kind = ? AND session_id = ? AND turn_id = ? AND started_at = ?`).get(
      row.agent_kind, row.session_id, row.turn_id, projection.started_at
    ) as { sequence: number };
    this.context.database.prepare(`INSERT OR IGNORE INTO conversation_turn_projection_events(
      agent_kind, session_id, turn_id, started_at, event_id, sequence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      row.agent_kind, row.session_id, row.turn_id, projection.started_at, eventId, Number(next.sequence), occurredAt
    );
    this.context.database.prepare(`UPDATE conversation_turn_projections SET updated_at = ?
      WHERE agent_kind = ? AND session_id = ? AND turn_id = ? AND started_at = ?`).run(
      occurredAt, row.agent_kind, row.session_id, row.turn_id, projection.started_at
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function matchesCompactedCoreEventHash(event: CoreEventEnvelope, storedHash: string | null): boolean {
  if (storedHash === null) return false;
  const semanticHash = coreEventSemanticHash(event);
  return semanticHash !== null && (storedHash === semanticHash || storedHash === sha256(JSON.stringify(toStoredEvent(event))));
}

interface StoredCoreEvent {
  schemaVersion: 1;
  eventId: string;
  cursor: string;
  sourceId: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  turnId: string | null;
  occurredAt: string;
  payload: unknown;
}

function toStoredEvent(event: CoreEventEnvelope): StoredCoreEvent { return { ...event }; }
function fromStoredEvent(event: StoredCoreEvent): CoreEventEnvelope { return { ...event }; }

function assertCompatibleDiscriminators(
  row: { event_id: string; event_type: string | null; submission_id: string | null; channel: string | null; call_id: string | null },
  expected: CoreEventDiscriminators
): void {
  for (const [column, value] of [
    ["event_type", expected.eventType], ["submission_id", expected.submissionId], ["channel", expected.channel], ["call_id", expected.callId]
  ] as const) {
    const actual = row[column];
    if (actual !== null && actual !== value) throw new Error(`Core event discriminator mismatch for ${row.event_id}.${column}`);
  }
}

function isSettledLaneItem(state: string | undefined): boolean {
  return state === "projected" || state === "ignored";
}

function humanSubmissionId(payload: unknown): string | undefined {
  if (!isHumanMessagePayload(payload)) return undefined;
  return typeof payload.submission_id === "string" && payload.submission_id ? payload.submission_id : undefined;
}

function isHumanMessagePayload(payload: unknown): payload is Record<string, unknown> & { type: "human_message" } {
  return typeof payload === "object" && payload !== null && (payload as { type?: unknown }).type === "human_message";
}

function isSourceErrorPayload(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as { type?: unknown }).type === "source_error";
}

function isTokenUsagePayload(payload: unknown): payload is Record<string, unknown> & { type: "token_usage" } {
  return typeof payload === "object" && payload !== null && (payload as { type?: unknown }).type === "token_usage";
}

function isContextSnapshotPayload(payload: unknown): payload is Record<string, unknown> & { type: "context_snapshot" } {
  return typeof payload === "object" && payload !== null && (payload as { type?: unknown }).type === "context_snapshot";
}

function isExactReplayProjectedPayload(payload: unknown): boolean {
  return isTokenUsagePayload(payload) || isContextSnapshotPayload(payload);
}

function validateBatch(batch: CoreEventInboxBatch): void {
  if (!batch.laneId || !batch.sourceId || !batch.sessionId || !batch.nextCursor || !batch.latestCursor) throw new Error("Invalid Core event inbox batch");
  if (batch.events.length > 128) throw new Error("Core event inbox batch exceeds limit");
  for (const event of batch.events) {
    if (event.schemaVersion !== 1 || !event.eventId || event.sourceId !== batch.sourceId || event.agentKind !== batch.agentKind || event.sessionId !== batch.sessionId) {
      throw new Error("Core event inbox identity mismatch");
    }
  }
}

function validateRebase(input: CoreEventCheckpointRebase): void {
  if (!input.laneId || !input.sourceId || !input.sourceEpoch || !input.agentKind || !input.sessionId
    || !input.expectedReadCursor || !input.resumeCursor || !input.earliestCursor || !input.latestCursor
    || !input.owner.id || !input.rebasedAt) throw new Error("Invalid Core event checkpoint rebase");
}

function validateLaneBootstrap(input: CoreEventLaneBootstrap): void {
  if (!input.laneId || !input.sourceId || !input.sourceEpoch || !input.agentKind || !input.sessionId
    || !input.resumeCursor || !input.earliestCursor || !input.latestCursor || !input.owner.id || !input.observedAt) {
    throw new Error("Invalid Core event lane bootstrap");
  }
}

function validateEpochTransitionRebase(input: CoreEventEpochTransitionRebase): void {
  if (!input.laneId || !input.sourceId || !input.expectedSourceEpoch || !input.expectedReadCursor
    || !input.agentKind || !input.sessionId || !input.sourceEpoch || input.sourceEpoch === input.expectedSourceEpoch
    || !input.earliestCursor || !input.latestCursor || !input.owner.id || !input.rebasedAt) {
    throw new Error("Invalid Core event epoch transition rebase");
  }
}

function validateSourceTransition(input: CoreEventSourceTransition): void {
  if (!input.laneId || !input.expectedSourceId || !input.expectedSourceEpoch || !input.expectedReadCursor
    || !input.sourceId || input.sourceId === input.expectedSourceId || !input.sourceEpoch
    || !input.agentKind || !input.sessionId || !input.earliestCursor || !input.latestCursor
    || !input.owner.id || !input.transitionedAt) {
    throw new Error("Invalid Core event source transition");
  }
}

function validateInvalidCursorGap(input: CoreEventInvalidCursorGap): void {
  if (!input.laneId || !input.sourceId || !input.agentKind || !input.sessionId || !input.readCursor
    || !input.owner.id || !input.occurredAt) throw new Error("Invalid Core event invalid-cursor gap");
}
