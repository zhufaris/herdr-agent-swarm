import { createHash } from "node:crypto";
import { evaluateRetentionBarrier, parseRetentionTimestampMs, type AuditSkeletonIdentity, type AuditSkeletonInput, type AuditSkeletonLink, type RetentionBarrierFacts } from "../../domain/retention-barrier.js";
import type { DeliveryOwnerFence } from "../../domain/delivery-scope.js";
import type { RetentionAuditStore, RetentionCandidateIdentity } from "../../domain/ports/retention-audit.js";
import type { SqliteContext } from "./context.js";
import { coreEventSemanticHash } from "./core-event-identity.js";

interface SkeletonRow {
  source_kind: AuditSkeletonIdentity["kind"];
  source_id: string;
  payload_hash: string;
  payload_bytes: number;
  lifecycle_state: string;
  owner_kind: string;
  owner_id: string;
  owner_generation: number | null;
  owner_session_generation: number | null;
  owner_parent_id: string | null;
  owner_parent_generation: number | null;
  owner_parent_session_generation: number | null;
  scope_key: string | null;
  binding_id: string | null;
  prompt_id: string | null;
  created_at: string;
  terminal_at: string;
  barrier_version: number;
  state: "verified" | "compacted";
  verified_at: string;
  compacted_at: string | null;
  relationship_hash: string;
}

interface DeliveryCandidateRow {
  id: string;
  payload: string;
  state: string;
  effect_certainty: string | null;
  claim_attempt_id: string | null;
  binding_id: string | null;
  prompt_id: string | null;
  worker_turn_id: string | null;
  delivery_owner_kind: string | null;
  delivery_owner_id: string | null;
  delivery_owner_generation: number | null;
  delivery_owner_session_generation: number | null;
  delivery_parent_id: string | null;
  delivery_parent_generation: number | null;
  delivery_parent_session_generation: number | null;
  scope_key: string | null;
  projection_key: string | null;
  snapshot_revision: number;
  delivery_order: number | null;
  created_at: string;
  updated_at: string;
  checkpoint_settled: number;
  reference_count: number;
  open_gap_count: number;
  active_quarantine_count: number;
  unresolved_recovery_count: number;
  pending_prerequisite_count: number;
  incomplete_replacement_count: number;
  reconstructible: number;
}

export class SqliteRetentionAuditStore implements RetentionAuditStore {
  constructor(private readonly context: SqliteContext) {}

  prepare(candidate: RetentionCandidateIdentity, evaluatedAt: string): ReturnType<RetentionAuditStore["prepare"]> {
    if (!candidate.id.trim() || parseRetentionTimestampMs(evaluatedAt) === null) return { status: "refused", reason: "invalid_evidence" };
    return this.context.transaction("sqlite.retention-audit-store.write", () => {
      if (candidate.kind === "core_event") return this.prepareCoreEvent(candidate, evaluatedAt);
      if (candidate.kind === "answer_timeline_item") return this.prepareTimelineItem(candidate, evaluatedAt);
      if (candidate.kind === "conversation_segment_item") return this.prepareConversationItem(candidate, evaluatedAt);
      if (candidate.kind !== "delivery") return { status: "refused", reason: "projection_not_reconstructible" };
      const evidence = this.readDeliveryCandidate(candidate.id);
      if (!evidence) return { status: "missing" as const };
      const payloadHash = sha256(evidence.payload);
      if (candidate.expectedPayloadHash !== undefined && candidate.expectedPayloadHash !== payloadHash) return { status: "stale_owner" as const };
      const ownerFence = deliveryOwnerFence(evidence);
      if (candidate.expectedOwnerFence !== undefined && !sameOwnerFence(candidate.expectedOwnerFence, ownerFence)) return { status: "stale_owner" as const };
      const facts: RetentionBarrierFacts = {
        terminal: evidence.state === "delivered" || evidence.state === "dismissed",
        terminalAt: evidence.updated_at,
        now: evaluatedAt,
        referenceCount: evidence.reference_count,
        checkpointSettled: evidence.claim_attempt_id === null && evidence.checkpoint_settled === 1,
        openGapCount: evidence.open_gap_count,
        effect: evidence.effect_certainty === "uncertain" ? "uncertain" : "certain",
        activeQuarantineCount: evidence.active_quarantine_count,
        unresolvedRecoveryCount: evidence.unresolved_recovery_count,
        pendingPrerequisiteCount: evidence.pending_prerequisite_count,
        replacement: evidence.incomplete_replacement_count > 0 ? "incomplete" : "not-required",
        projectionReconstructible: evidence.reconstructible === 1
      };
      const decision = evaluateRetentionBarrier(facts);
      if (decision.status === "refused") return decision;
      const skeleton = normalizeSkeleton({
        identity: { kind: "delivery", id: evidence.id }, payloadHash,
        payloadBytes: Buffer.byteLength(evidence.payload, "utf8"), lifecycleState: evidence.state,
        owner: {
          kind: evidence.delivery_owner_kind ?? (evidence.worker_turn_id ? "worker_turn" : evidence.binding_id ? "binding" : "delivery"),
          id: evidence.delivery_owner_id ?? evidence.worker_turn_id ?? evidence.binding_id ?? evidence.id,
          generation: evidence.delivery_owner_generation,
          sessionGeneration: evidence.delivery_owner_session_generation,
          parent: evidence.delivery_parent_id === null ? null : {
            id: evidence.delivery_parent_id,
            generation: evidence.delivery_parent_generation!,
            sessionGeneration: evidence.delivery_parent_session_generation!
          },
          scopeKey: evidence.scope_key
        },
        bindingId: evidence.binding_id, promptId: evidence.prompt_id,
        createdAt: evidence.created_at, terminalAt: evidence.updated_at,
        barrierVersion: 1, state: "verified", verifiedAt: evaluatedAt, compactedAt: null,
        links: this.loadDeliveryLinks(evidence)
      });
      return this.insertOrConfirm(skeleton);
    });
  }

  private prepareCoreEvent(candidate: Extract<RetentionCandidateIdentity, { kind: "core_event" }>, evaluatedAt: string): ReturnType<RetentionAuditStore["prepare"]> {
    const evidence = this.context.database.prepare(`SELECT i.event_id,i.source_id,i.agent_kind,i.session_id,i.turn_id,i.source_cursor,
      i.event_json,i.ingested_at,i.event_type,
      COUNT(l.event_id) AS lane_count,
      COALESCE(SUM(CASE WHEN l.state NOT IN ('projected','ignored') THEN 1 ELSE 0 END),0) AS unsettled_count,
      COALESCE(SUM(CASE WHEN l.state='quarantined' THEN 1 ELSE 0 END),0) AS quarantine_count,
      COALESCE(MAX(l.updated_at),i.ingested_at) AS terminal_at,
      (SELECT COUNT(*) FROM projection_gaps gap WHERE gap.source_item_id=i.event_id AND gap.state='open') AS open_gap_count,
      (SELECT COUNT(*) FROM core_event_lane_items lane
        JOIN core_event_lane_checkpoints checkpoint ON checkpoint.lane_id=lane.lane_id
        WHERE lane.event_id=i.event_id) AS checkpoint_count,
      CASE WHEN (SELECT state FROM core_event_discriminator_backfill WHERE singleton_id=1)='complete' THEN 1 ELSE 0 END AS backfill_complete
      FROM core_event_inbox i LEFT JOIN core_event_lane_items l ON l.event_id=i.event_id
      WHERE i.event_id=? GROUP BY i.event_id`).get(candidate.id) as {
        event_id:string; source_id:string; agent_kind:string; session_id:string; turn_id:string|null; source_cursor:string;
        event_json:string; ingested_at:string; event_type:string|null; lane_count:number; unsettled_count:number;
        quarantine_count:number; terminal_at:string; open_gap_count:number; checkpoint_count:number; backfill_complete:number;
      } | undefined;
    if (!evidence) return { status: "missing" };
    if (evidence.event_type === "human_message") return { status: "refused", reason: "human_input_retained" };
    let event: import("../../domain/core-event-inbox.js").CoreEventEnvelope;
    try { event = JSON.parse(evidence.event_json) as import("../../domain/core-event-inbox.js").CoreEventEnvelope; }
    catch { return { status: "refused", reason: "invalid_evidence" }; }
    const payloadHash = coreEventSemanticHash(event);
    if (payloadHash === null) return { status: "refused", reason: "invalid_evidence" };
    if (candidate.expectedPayloadHash !== undefined && candidate.expectedPayloadHash !== payloadHash) return { status: "stale_owner" };
    const terminalSegments = evidence.turn_id === null ? [] : this.context.database.prepare(`SELECT
      segment.id,segment.state,segment.updated_at,segment.owner_kind,segment.owner_id
      FROM conversation_segments segment
      JOIN core_event_inbox human ON human.event_id=segment.human_event_id
      WHERE segment.agent_kind=? AND segment.session_id=? AND segment.state='completed'
        AND human.agent_kind=? AND human.session_id=? AND human.turn_id=?
        AND EXISTS(SELECT 1 FROM core_event_lane_items terminal_lane
          WHERE terminal_lane.event_id=? AND segment.producer_key='lane:' || terminal_lane.lane_id)
      ORDER BY segment.id LIMIT 2`).all(
        evidence.agent_kind, evidence.session_id, evidence.agent_kind, evidence.session_id,
        evidence.turn_id, evidence.event_id
      ) as Array<{ id:string; state:string; updated_at:string; owner_kind:"primary"|"worker"; owner_id:string }>;
    const terminalSegment = terminalSegments.length === 1 && terminalSegments[0]!.state === "completed" ? terminalSegments[0]! : null;
    const pageRecoveryCount = terminalSegment === null ? 0 : Number((this.context.database.prepare(`SELECT
      (SELECT COUNT(*) FROM conversation_segment_page_recoveries WHERE segment_id=? AND state NOT IN ('delivered','failed'))
      +(SELECT COUNT(*) FROM conversation_segment_page_recovery_parts WHERE segment_id=? AND state NOT IN ('delivered','failed'))
      +(SELECT COUNT(*) FROM conversation_segment_late_recoveries WHERE segment_id=? AND state NOT IN ('delivered','failed')) AS count`).get(
        terminalSegment.id, terminalSegment.id, terminalSegment.id
      ) as { count:number }).count);
    const exactTurnRecoveryCount = evidence.turn_id === null ? 0 : Number((this.context.database.prepare(`SELECT COUNT(*) AS count
      FROM external_turn_recovery_attempts recovery JOIN bindings binding ON binding.id=recovery.binding_id
      WHERE binding.agent_session_agent=? AND recovery.session_value=? AND recovery.turn_id=?`).get(
        evidence.agent_kind, evidence.session_id, evidence.turn_id
      ) as { count:number }).count);
    const unresolvedRecoveryCount = pageRecoveryCount + exactTurnRecoveryCount;
    const ownerOpenGaps = terminalSegment === null ? 0 : Number((this.context.database.prepare(`SELECT COUNT(*) AS count FROM projection_gaps
      WHERE state='open' AND (owner_id=? OR (stage='turn_recovery' AND owner_kind=? AND owner_id=?))`).get(
        terminalSegment.id, terminalSegment.owner_kind === "primary" ? "binding" : "worker_turn", terminalSegment.owner_id
      ) as { count:number }).count);
    const ignoredDiagnostic = evidence.event_type === "source_error" || evidence.event_type === "record_skipped";
    const laneTerminalAtMs = parseRetentionTimestampMs(evidence.terminal_at);
    const ownerTerminalAtMs = terminalSegment === null ? laneTerminalAtMs : parseRetentionTimestampMs(terminalSegment.updated_at);
    const terminalAt = laneTerminalAtMs === null || ownerTerminalAtMs === null ? ""
      : new Date(Math.max(laneTerminalAtMs, ownerTerminalAtMs)).toISOString();
    const decision = evaluateRetentionBarrier({
      terminal: ignoredDiagnostic || terminalSegment !== null,
      terminalAt,
      now: evaluatedAt,
      referenceCount: 0,
      checkpointSettled: evidence.lane_count > 0 && evidence.checkpoint_count === evidence.lane_count
        && evidence.unsettled_count === evidence.quarantine_count && evidence.backfill_complete === 1,
      openGapCount: evidence.open_gap_count + ownerOpenGaps,
      effect: "certain",
      activeQuarantineCount: evidence.quarantine_count,
      unresolvedRecoveryCount,
      pendingPrerequisiteCount: 0,
      replacement: "not-required",
      projectionReconstructible: ignoredDiagnostic || terminalSegment !== null,
      ...(candidate.retentionWindowMs === undefined ? {} : { retentionWindowMs: candidate.retentionWindowMs })
    });
    if (decision.status === "refused") return decision;
    const links: AuditSkeletonLink[] = (this.context.database.prepare(`SELECT lane_id,sequence,state FROM core_event_lane_items
      WHERE event_id=? ORDER BY lane_id`).all(evidence.event_id) as Array<{lane_id:string;sequence:number;state:string}>).map((row) => ({
        kind: "checkpoint", id: row.lane_id, state: `${row.state}:${row.sequence}`
      }));
    if (terminalSegment !== null) links.push({ kind: "owner", id: terminalSegment.id, state: "conversation-segment:completed" });
    return this.insertOrConfirm(normalizeSkeleton({
      identity: { kind: "core_event", id: evidence.event_id }, payloadHash,
      payloadBytes: Buffer.byteLength(evidence.event_json, "utf8"), lifecycleState: ignoredDiagnostic ? "ignored-diagnostic" : "settled",
      owner: { kind: evidence.agent_kind, id: evidence.session_id, generation: null, sessionGeneration: null, parent: null, scopeKey: evidence.source_id },
      bindingId: null, promptId: evidence.turn_id, createdAt: evidence.ingested_at, terminalAt,
      barrierVersion: 1, state: "verified", verifiedAt: evaluatedAt, compactedAt: null, links
    }));
  }

  private prepareTimelineItem(candidate: Extract<RetentionCandidateIdentity, { kind: "answer_timeline_item" }>, evaluatedAt: string): ReturnType<RetentionAuditStore["prepare"]> {
    const identity = parseTupleIdentity(candidate.id, "answer_timeline_item", 4);
    if (!identity) return { status: "refused", reason: "invalid_evidence" };
    const aggregateKind = identity[1]!;
    const aggregateId = identity[2]!;
    const itemId = identity[3]!;
    const item = this.context.database.prepare(`SELECT item_json FROM answer_timeline_items
      WHERE aggregate_kind=? AND aggregate_id=? AND item_id=?`).get(aggregateKind, aggregateId, itemId) as { item_json:string } | undefined;
    if (!item) return { status: "missing" };
    const payloadHash = sha256(item.item_json);
    if (candidate.expectedPayloadHash !== undefined && candidate.expectedPayloadHash !== payloadHash) return { status: "stale_owner" };
    const primary = aggregateKind === "primary-run" ? this.context.database.prepare(`SELECT prompt.state AS phase,prompt.updated_at AS terminal_at,
      prompt.created_at,prompt.binding_id,run.binding_generation FROM prompt_jobs prompt
      JOIN run_cards run ON run.prompt_id=prompt.id WHERE prompt.id=?`).get(aggregateId) as {
        phase:string; terminal_at:string; created_at:string; binding_id:string; binding_generation:number;
      } | undefined : undefined;
    const worker = aggregateKind === "worker-turn" ? this.context.database.prepare(`SELECT turn.state AS phase,turn.updated_at AS terminal_at,
      turn.created_at,turn.instance_id,card.instance_generation,card.worker_session_generation FROM instance_turns turn
      JOIN worker_turn_cards card ON card.turn_id=turn.id WHERE turn.id=?`).get(aggregateId) as {
        phase:string; terminal_at:string; created_at:string; instance_id:string; instance_generation:number; worker_session_generation:number;
      } | undefined : undefined;
    if (!primary && !worker) return { status: "refused", reason: "not_terminal" };
    const itemIndex = Number((this.context.database.prepare(`SELECT COUNT(*) AS count FROM answer_timeline_items
      WHERE aggregate_kind=? AND aggregate_id=? AND (sequence,item_id)<(
        SELECT sequence,item_id FROM answer_timeline_items WHERE aggregate_kind=? AND aggregate_id=? AND item_id=?
      )`).get(aggregateKind, aggregateId, aggregateKind, aggregateId, itemId) as { count:number }).count);
    const checkpoint = this.context.database.prepare(`SELECT page_index FROM answer_timeline_page_checkpoints p
      WHERE aggregate_kind=? AND aggregate_id=? AND pending_reply_id IS NULL AND delivered_cursor_json IS NOT NULL
        AND EXISTS(SELECT 1 FROM json_each(p.delivered_items_json) item WHERE json_extract(item.value,'$.id')=?)
        AND json_extract(start_cursor_json,'$.itemIndex')<=?
        AND (json_extract(start_cursor_json,'$.itemIndex')<? OR COALESCE(json_extract(start_cursor_json,'$.offset'),json_extract(start_cursor_json,'$.markdownOffset'),0)=0)
        AND json_extract(delivered_cursor_json,'$.itemIndex')>?
      ORDER BY page_index LIMIT 1`).get(aggregateKind, aggregateId, itemId, itemIndex, itemIndex, itemIndex) as { page_index:number } | undefined;
    const ownerColumn = aggregateKind === "primary-run" ? "prompt_id" : "worker_turn_id";
    const projectionKey = aggregateKind === "primary-run" ? `answer-timeline:${aggregateId}:${checkpoint?.page_index ?? -1}` : null;
    const projection = checkpoint === undefined ? undefined : this.context.database.prepare(`SELECT id FROM outbound_replies
      WHERE ${ownerColumn}=? AND stream_page_index=? AND kind='card_update' AND state IN ('delivered','dismissed')
        AND payload_compacted_at IS NULL AND (? IS NULL OR projection_key=?)
      ORDER BY snapshot_revision DESC,updated_at DESC,id DESC LIMIT 1`).get(
        aggregateId, checkpoint.page_index, projectionKey, projectionKey
      ) as { id:string } | undefined;
    const openGaps = Number((this.context.database.prepare(`SELECT COUNT(*) AS count FROM projection_gaps
      WHERE state='open' AND (source_item_id=? OR owner_id=?)`).get(itemId, aggregateId) as {count:number}).count);
    const phase = primary?.phase ?? worker!.phase;
    const terminalAt = primary?.terminal_at ?? worker!.terminal_at;
    const decision = evaluateRetentionBarrier({
      terminal: ["delivered", "completed", "failed", "cancelled"].includes(phase), terminalAt, now: evaluatedAt,
      referenceCount: 0, checkpointSettled: checkpoint !== undefined, openGapCount: openGaps, effect: "certain",
      activeQuarantineCount: 0, unresolvedRecoveryCount: 0, pendingPrerequisiteCount: 0,
      replacement: "not-required", projectionReconstructible: projection !== undefined
    });
    if (decision.status === "refused") return decision;
    return this.insertOrConfirm(normalizeSkeleton({
      identity: { kind: "answer_timeline_item", id: candidate.id }, payloadHash, payloadBytes: Buffer.byteLength(item.item_json),
      lifecycleState: phase, owner: primary
        ? { kind: "primary", id: primary.binding_id, generation: primary.binding_generation, sessionGeneration: null, parent: null, scopeKey: aggregateId }
        : { kind: "worker", id: worker!.instance_id, generation: worker!.instance_generation, sessionGeneration: worker!.worker_session_generation, parent: null, scopeKey: aggregateId },
      bindingId: primary?.binding_id ?? null, promptId: aggregateKind === "primary-run" ? aggregateId : null,
      createdAt: primary?.created_at ?? worker!.created_at, terminalAt, barrierVersion: 1, state: "verified", verifiedAt: evaluatedAt, compactedAt: null,
      links: [
        { kind: "checkpoint", id: `${aggregateKind}:${aggregateId}:${checkpoint!.page_index}`, state: "delivered" },
        { kind: "projection", id: projection!.id, state: "retains-payload" }
      ]
    }));
  }

  private prepareConversationItem(candidate: Extract<RetentionCandidateIdentity, { kind: "conversation_segment_item" }>, evaluatedAt: string): ReturnType<RetentionAuditStore["prepare"]> {
    const identity = parseTupleIdentity(candidate.id, "conversation_segment_item", 3);
    if (!identity) return { status: "refused", reason: "invalid_evidence" };
    const segmentId = identity[1]!;
    const itemId = identity[2]!;
    const evidence = this.context.database.prepare(`SELECT item.item_json,item.lane_sequence,item.item_ordinal,segment.state,segment.updated_at AS terminal_at,
      segment.created_at,segment.owner_kind,segment.owner_id,segment.owner_generation,segment.submission_id,
      (SELECT COUNT(*) FROM conversation_segment_pages p WHERE p.segment_id=segment.id) AS page_count,
      (SELECT COUNT(*) FROM conversation_segment_pages p WHERE p.segment_id=segment.id AND (p.state IN ('creating','active') OR p.pending_reply_id IS NOT NULL)) AS active_page_count,
      (SELECT COUNT(*) FROM conversation_segment_page_recoveries r WHERE r.segment_id=segment.id AND r.state NOT IN ('delivered','failed'))
        + (SELECT COUNT(*) FROM conversation_segment_page_recovery_parts r WHERE r.segment_id=segment.id AND r.state NOT IN ('delivered','failed'))
        + (SELECT COUNT(*) FROM conversation_segment_late_recoveries r WHERE r.segment_id=segment.id AND r.state NOT IN ('delivered','failed')) AS recovery_count,
      (SELECT COUNT(*) FROM projection_gaps gap WHERE gap.state='open' AND (gap.source_item_id=item.item_id OR gap.owner_id=segment.id)) AS open_gap_count
      FROM conversation_segment_items item JOIN conversation_segments segment ON segment.id=item.segment_id
      WHERE item.segment_id=? AND item.item_id=?`).get(segmentId, itemId) as {
        item_json:string; lane_sequence:number; item_ordinal:number; state:string; terminal_at:string; created_at:string; owner_kind:string; owner_id:string; owner_generation:number;
        submission_id:string|null; page_count:number; active_page_count:number; recovery_count:number; open_gap_count:number;
      } | undefined;
    if (!evidence) return { status: "missing" };
    const payloadHash = sha256(evidence.item_json);
    if (candidate.expectedPayloadHash !== undefined && candidate.expectedPayloadHash !== payloadHash) return { status: "stale_owner" };
    const itemIndex = Number((this.context.database.prepare(`SELECT COUNT(*) AS count FROM conversation_segment_items
      WHERE segment_id=? AND (lane_sequence,item_ordinal,item_id)<(?,?,?)`).get(
        segmentId, evidence.lane_sequence, evidence.item_ordinal, itemId
      ) as { count:number }).count);
    const page = this.context.database.prepare(`SELECT page_index FROM conversation_segment_pages
      WHERE segment_id=? AND pending_reply_id IS NULL AND delivered_cursor_json IS NOT NULL
        AND COALESCE(json_extract(start_cursor_json,'$.itemIndex'),0)<=?
        AND (COALESCE(json_extract(start_cursor_json,'$.itemIndex'),0)<?
          OR COALESCE(json_extract(start_cursor_json,'$.offset'),json_extract(start_cursor_json,'$.markdownOffset'),0)=0)
        AND json_extract(delivered_cursor_json,'$.itemIndex')>?
      ORDER BY page_index LIMIT 1`).get(segmentId, itemIndex, itemIndex, itemIndex) as { page_index:number }|undefined;
    const projection = page === undefined ? undefined : this.context.database.prepare(`SELECT id FROM outbound_replies
      WHERE projection_key=? AND state IN ('delivered','dismissed') AND payload_compacted_at IS NULL
      ORDER BY snapshot_revision DESC,updated_at DESC,id DESC LIMIT 1`).get(
        `turn-card:${segmentId}:page:${page.page_index}`
      ) as {id:string}|undefined;
    const decision = evaluateRetentionBarrier({
      terminal: ["completed", "failed", "cancelled", "closed"].includes(evidence.state), terminalAt: evidence.terminal_at, now: evaluatedAt,
      referenceCount: 0, checkpointSettled: evidence.page_count > 0 && evidence.active_page_count === 0,
      openGapCount: evidence.open_gap_count, effect: "certain", activeQuarantineCount: 0,
      unresolvedRecoveryCount: evidence.recovery_count, pendingPrerequisiteCount: 0,
      replacement: "not-required", projectionReconstructible: projection !== undefined
    });
    if (decision.status === "refused") return decision;
    return this.insertOrConfirm(normalizeSkeleton({
      identity: { kind: "conversation_segment_item", id: candidate.id }, payloadHash, payloadBytes: Buffer.byteLength(evidence.item_json),
      lifecycleState: evidence.state, owner: { kind: evidence.owner_kind, id: evidence.owner_id, generation: evidence.owner_generation, sessionGeneration: null, parent: null, scopeKey: segmentId },
      bindingId: evidence.owner_kind === "primary" ? evidence.owner_id : null, promptId: evidence.submission_id,
      createdAt: evidence.created_at, terminalAt: evidence.terminal_at, barrierVersion: 1, state: "verified", verifiedAt: evaluatedAt, compactedAt: null,
      links: [{ kind: "projection", id: projection!.id, state: "retains-payload" }]
    }));
  }

  load(identity: AuditSkeletonIdentity): AuditSkeletonInput | null {
    const row = this.context.database.prepare(`SELECT source_kind,source_id,payload_hash,payload_bytes,lifecycle_state,owner_kind,owner_id,owner_generation,owner_session_generation,
      owner_parent_id,owner_parent_generation,owner_parent_session_generation,scope_key,
      binding_id,prompt_id,created_at,terminal_at,barrier_version,state,verified_at,compacted_at,relationship_hash
      FROM audit_skeletons WHERE source_kind=? AND source_id=?`).get(identity.kind, identity.id) as SkeletonRow | undefined;
    if (!row) return null;
    const links = this.context.database.prepare(`SELECT link_kind AS kind,link_id AS id,link_state AS state
      FROM audit_skeleton_links WHERE source_kind=? AND source_id=? ORDER BY link_kind,link_id,link_state`).all(identity.kind, identity.id) as unknown as AuditSkeletonLink[];
    const normalized = normalizeSkeleton({
      identity: { kind: row.source_kind, id: row.source_id }, payloadHash: row.payload_hash, payloadBytes: row.payload_bytes,
      lifecycleState: row.lifecycle_state, owner: {
        kind: row.owner_kind, id: row.owner_id, generation: row.owner_generation, sessionGeneration: row.owner_session_generation,
        parent: row.owner_parent_id === null ? null : {
          id: row.owner_parent_id, generation: row.owner_parent_generation!, sessionGeneration: row.owner_parent_session_generation!
        }, scopeKey: row.scope_key
      },
      bindingId: row.binding_id, promptId: row.prompt_id, createdAt: row.created_at,
      terminalAt: row.terminal_at, barrierVersion: row.barrier_version, state: row.state,
      verifiedAt: row.verified_at, compactedAt: row.compacted_at, links
    });
    if (sha256(JSON.stringify(normalized.links)) !== row.relationship_hash) throw new Error("audit_skeleton_relationship_hash_mismatch");
    return normalized;
  }

  private insertOrConfirm(skeleton: AuditSkeletonInput): ReturnType<RetentionAuditStore["prepare"]> {
    const existing = this.load(skeleton.identity);
    if (existing) {
      const comparableExisting = { ...existing, verifiedAt: skeleton.verifiedAt, state: "verified" as const, compactedAt: null };
      if (JSON.stringify(comparableExisting) !== JSON.stringify(skeleton)) throw new Error("audit_skeleton_conflict");
      return { status: "existing", skeleton: existing };
    }
    this.context.database.prepare(`INSERT INTO audit_skeletons(
      source_kind,source_id,payload_hash,payload_bytes,lifecycle_state,owner_kind,owner_id,owner_generation,owner_session_generation,
      owner_parent_id,owner_parent_generation,owner_parent_session_generation,scope_key,binding_id,prompt_id,
      created_at,terminal_at,barrier_version,state,verified_at,compacted_at,relationship_hash
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      skeleton.identity.kind, skeleton.identity.id, skeleton.payloadHash, skeleton.payloadBytes, skeleton.lifecycleState,
      skeleton.owner.kind, skeleton.owner.id, skeleton.owner.generation, skeleton.owner.sessionGeneration,
      skeleton.owner.parent?.id ?? null, skeleton.owner.parent?.generation ?? null, skeleton.owner.parent?.sessionGeneration ?? null,
      skeleton.owner.scopeKey, skeleton.bindingId, skeleton.promptId,
      skeleton.createdAt, skeleton.terminalAt, skeleton.barrierVersion, skeleton.state, skeleton.verifiedAt, skeleton.compactedAt,
      sha256(JSON.stringify(skeleton.links))
    );
    const insertLink = this.context.database.prepare(`INSERT INTO audit_skeleton_links(
      source_kind,source_id,link_kind,link_id,link_state
    ) VALUES(?,?,?,?,?)`);
    for (const link of skeleton.links) insertLink.run(skeleton.identity.kind, skeleton.identity.id, link.kind, link.id, link.state);
    return { status: "recorded", skeleton };
  }

  private readDeliveryCandidate(id: string): DeliveryCandidateRow | null {
    return this.context.database.prepare(`SELECT reply.id,reply.payload,reply.state,reply.effect_certainty,reply.claim_attempt_id,
      reply.binding_id,reply.prompt_id,reply.worker_turn_id,reply.delivery_owner_kind,reply.delivery_owner_id,
      reply.delivery_owner_generation,reply.delivery_owner_session_generation,reply.delivery_parent_id,reply.delivery_parent_generation,reply.delivery_parent_session_generation,
      reply.scope_key,reply.projection_key,reply.snapshot_revision,reply.delivery_order,reply.created_at,reply.updated_at,
      CASE WHEN reply.scope_key IS NOT NULL AND reply.delivery_order IS NOT NULL AND EXISTS(
        SELECT 1 FROM delivery_ring_checkpoints checkpoint
        WHERE checkpoint.scope_key=reply.scope_key
          AND checkpoint.scope_kind=reply.scope_kind
          AND checkpoint.scope_workspace_id IS reply.scope_workspace_id
          AND checkpoint.scope_pane_id IS reply.scope_pane_id
          AND checkpoint.committed_delivery_order>=reply.delivery_order
      ) THEN 1 ELSE 0 END AS checkpoint_settled,
      (SELECT COUNT(*) FROM conversation_segment_page_recoveries r WHERE r.reply_id=reply.id)
        + (SELECT COUNT(*) FROM conversation_segment_page_recovery_parts r WHERE r.reply_id=reply.id)
        + (SELECT COUNT(*) FROM conversation_segment_late_recoveries r WHERE r.reply_id=reply.id)
        + (SELECT COUNT(*) FROM outbound_reply_prerequisites p WHERE p.prerequisite_reply_id=reply.id)
        + (SELECT COUNT(*) FROM completion_action_sets action
          WHERE action.presentation_reply_id=reply.id AND action.presentation_kind='fresh-card'
            AND action.state IN ('presenting','active'))
        + (SELECT COUNT(*) FROM audit_skeleton_links link WHERE link.link_kind='projection' AND link.link_id=reply.id) AS reference_count,
      (SELECT COUNT(*) FROM projection_gaps gap WHERE gap.source_item_id=reply.id AND gap.state='open') AS open_gap_count,
      (SELECT COUNT(*) FROM outbox_lane_quarantines q WHERE q.failed_reply_id=reply.id AND q.state='active') AS active_quarantine_count,
      (SELECT COUNT(*) FROM delivery_recoveries r WHERE (r.failed_reply_id=reply.id OR r.replacement_reply_id=reply.id) AND r.state='unresolved') AS unresolved_recovery_count,
      (SELECT COUNT(*) FROM outbound_reply_prerequisites p JOIN outbound_replies prerequisite ON prerequisite.id=p.prerequisite_reply_id
        WHERE p.dependent_reply_id=reply.id AND prerequisite.state<>p.required_state) AS pending_prerequisite_count,
      (SELECT COUNT(*) FROM delivery_recoveries r WHERE (r.failed_reply_id=reply.id OR r.replacement_reply_id=reply.id) AND r.state='replacement_pending') AS incomplete_replacement_count,
      CASE WHEN reply.state='dismissed' OR reply.projection_key IS NULL OR EXISTS(
        SELECT 1 FROM outbound_replies newer WHERE newer.projection_key=reply.projection_key
          AND newer.snapshot_revision>reply.snapshot_revision AND newer.state IN ('delivered','dismissed')
      ) THEN 1 ELSE 0 END AS reconstructible
      FROM outbound_replies reply WHERE reply.id=?`).get(id) as DeliveryCandidateRow | undefined ?? null;
  }

  private loadDeliveryLinks(evidence: DeliveryCandidateRow): AuditSkeletonLink[] {
    const id = evidence.id;
    const links: AuditSkeletonLink[] = [];
    const seen = new Set<string>();
    const add = (link: AuditSkeletonLink) => {
      const key = JSON.stringify(link);
      if (!seen.has(key)) { seen.add(key); links.push(link); }
    };
    if (evidence.checkpoint_settled === 1 && evidence.scope_key !== null && evidence.delivery_order !== null) {
      add({ kind: "checkpoint", id: evidence.scope_key, state: `committed-through:${evidence.delivery_order}` });
    }
    for (const row of this.context.database.prepare(`SELECT dependent_reply_id,prerequisite_reply_id,required_state
      FROM outbound_reply_prerequisites WHERE dependent_reply_id=? OR prerequisite_reply_id=?
      ORDER BY dependent_reply_id,prerequisite_reply_id`).all(id, id) as Array<{ dependent_reply_id: string; prerequisite_reply_id: string; required_state: string }>) {
      if (row.dependent_reply_id === id) add({ kind: "prerequisite", id: row.prerequisite_reply_id, state: `depends_on:${row.required_state}` });
      else add({ kind: "prerequisite", id: row.dependent_reply_id, state: `required_by:${row.required_state}` });
    }
    for (const row of this.context.database.prepare(`SELECT failed_reply_id,replacement_reply_id,resolved_by_reply_id,state FROM delivery_recoveries
      WHERE failed_reply_id=? OR replacement_reply_id=? OR resolved_by_reply_id=? ORDER BY failed_reply_id`).all(id, id, id) as Array<{
        failed_reply_id: string; replacement_reply_id: string | null; resolved_by_reply_id: string | null; state: string;
      }>) {
      if (row.failed_reply_id === id) {
        if (row.replacement_reply_id) add({ kind: "replacement", id: row.replacement_reply_id, state: `replacement:${row.state}` });
        if (row.resolved_by_reply_id) add({ kind: "recovery", id: row.resolved_by_reply_id, state: `resolver:${row.state}` });
      } else {
        add({ kind: "recovery", id: row.failed_reply_id, state: row.replacement_reply_id === id ? `replaces:${row.state}` : `resolved:${row.state}` });
        if (row.replacement_reply_id && row.replacement_reply_id !== id) add({ kind: "replacement", id: row.replacement_reply_id, state: `replacement:${row.state}` });
        if (row.resolved_by_reply_id && row.resolved_by_reply_id !== id) add({ kind: "recovery", id: row.resolved_by_reply_id, state: `resolver:${row.state}` });
      }
    }
    const projection = this.context.database.prepare("SELECT projection_key,snapshot_revision FROM outbound_replies WHERE id=?").get(id) as {
      projection_key: string | null; snapshot_revision: number;
    };
    if (projection.projection_key) {
      add({ kind: "projection", id: projection.projection_key, state: `snapshot:${projection.snapshot_revision}` });
      const newer = this.context.database.prepare(`SELECT id,snapshot_revision,state FROM outbound_replies
        WHERE projection_key=? AND snapshot_revision>? AND state IN ('delivered','dismissed')
        ORDER BY snapshot_revision,id LIMIT 1`).get(projection.projection_key, projection.snapshot_revision) as {
          id: string; snapshot_revision: number; state: string;
        } | undefined;
      if (newer) add({ kind: "replacement", id: newer.id, state: `reconstructs:${newer.snapshot_revision}:${newer.state}` });
    }
    return links;
  }
}

function deliveryOwnerFence(evidence: DeliveryCandidateRow): DeliveryOwnerFence | null {
  if (evidence.delivery_owner_kind === "primary" && evidence.delivery_owner_id !== null
    && evidence.delivery_owner_generation !== null && evidence.delivery_owner_session_generation !== null) {
    return {
      kind: "primary", id: evidence.delivery_owner_id,
      generation: evidence.delivery_owner_generation, sessionGeneration: evidence.delivery_owner_session_generation
    };
  }
  if (evidence.delivery_owner_kind === "worker" && evidence.delivery_owner_id !== null
    && evidence.delivery_owner_generation !== null && evidence.delivery_owner_session_generation !== null
    && evidence.delivery_parent_id !== null && evidence.delivery_parent_generation !== null && evidence.delivery_parent_session_generation !== null) {
    return {
      kind: "worker", id: evidence.delivery_owner_id,
      generation: evidence.delivery_owner_generation, sessionGeneration: evidence.delivery_owner_session_generation,
      parent: {
        id: evidence.delivery_parent_id,
        generation: evidence.delivery_parent_generation,
        sessionGeneration: evidence.delivery_parent_session_generation
      }
    };
  }
  return null;
}

function sameOwnerFence(expected: DeliveryOwnerFence | null, actual: DeliveryOwnerFence | null): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function parseTupleIdentity(value: string, kind: string, length: number): string[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === length && parsed[0] === kind
      && parsed.every((part) => typeof part === "string" && part.length > 0) ? parsed as string[] : null;
  } catch { return null; }
}

function normalizeSkeleton(input: AuditSkeletonInput): AuditSkeletonInput {
  const strings = [input.identity.id, input.payloadHash, input.lifecycleState, input.owner.kind, input.owner.id, input.createdAt, input.terminalAt, input.verifiedAt];
  if (strings.some((value) => value.trim().length === 0)
    || !/^[0-9a-f]{64}$/.test(input.payloadHash)
    || !Number.isSafeInteger(input.payloadBytes) || input.payloadBytes < 0
    || !Number.isSafeInteger(input.barrierVersion) || input.barrierVersion < 1
    || (input.owner.generation !== null && (!Number.isSafeInteger(input.owner.generation) || input.owner.generation < 1))
    || (input.owner.sessionGeneration !== null && (!Number.isSafeInteger(input.owner.sessionGeneration) || input.owner.sessionGeneration < 1))
    || (input.owner.parent !== null && (!input.owner.parent.id.trim()
      || !Number.isSafeInteger(input.owner.parent.generation) || input.owner.parent.generation < 1
      || !Number.isSafeInteger(input.owner.parent.sessionGeneration) || input.owner.parent.sessionGeneration < 1))
    || [input.createdAt, input.terminalAt, input.verifiedAt, ...(input.compactedAt === null ? [] : [input.compactedAt])].some((value) => parseRetentionTimestampMs(value) === null)
    || (input.state === "verified" && input.compactedAt !== null)
    || (input.state === "compacted" && input.compactedAt === null)) throw new Error("invalid_audit_skeleton");
  const links = [...input.links].map((link) => ({ ...link })).sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id) || left.state.localeCompare(right.state)
  );
  if (links.some((link) => !link.id.trim() || !link.state.trim())) throw new Error("invalid_audit_skeleton_link");
  for (let index = 1; index < links.length; index += 1) {
    if (JSON.stringify(links[index]) === JSON.stringify(links[index - 1])) throw new Error("duplicate_audit_skeleton_link");
  }
  return {
    identity: { ...input.identity }, payloadHash: input.payloadHash, payloadBytes: input.payloadBytes, lifecycleState: input.lifecycleState,
    owner: { ...input.owner }, bindingId: input.bindingId, promptId: input.promptId,
    createdAt: input.createdAt, terminalAt: input.terminalAt, barrierVersion: input.barrierVersion,
    state: input.state, verifiedAt: input.verifiedAt, compactedAt: input.compactedAt, links
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
