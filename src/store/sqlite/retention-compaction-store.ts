import { createHash } from "node:crypto";
import { parseRetentionTimestampMs, type RetentionRefusalReason } from "../../domain/retention-barrier.js";
import { RETENTION_COMPACTION_PAGE_LIMIT, type AuditCoreEventPageInput, type AuditCoreEventPageResult, type CompactRetentionPageInput, type CompactRetentionPageResult, type RetentionCompactionStore } from "../../domain/ports/retention-compaction.js";
import type { SqliteContext } from "./context.js";
import type { SqliteRetentionAuditStore } from "./retention-audit-store.js";

interface CursorRow {
  high_water_key_json: string;
  after_key_json: string | null;
  cycle_state: "scanning" | "complete";
  compacted_count: number;
  refusal_counts_json: string;
}

interface DeliveryKey { updatedAt: string; id: string }
interface DeliveryPageRow extends DeliveryKey {
  payload: string;
  deliveryInputKind: string | null;
  preparationState: string | null;
  presentationSnapshotJson: string | null;
  presentationSnapshotHash: string | null;
  plannerPolicyVersion: number | null;
  rendererPolicyVersion: number | null;
  gatewayProfileVersion: number | null;
  gatewayPlanJson: string | null;
  gatewayPlanHash: string | null;
}
interface CoreKey { ingestedAt: string; eventId: string }
interface CorePageRow extends CoreKey { eventJson: string }
interface TimelineKey { aggregateKind:string; aggregateId:string; sequence:number; itemId:string }
interface TimelinePageRow extends TimelineKey { itemJson:string }
interface ConversationKey { segmentId:string; laneSequence:number; itemOrdinal:number; itemId:string }
interface ConversationPageRow extends ConversationKey { itemJson:string }

export class SqliteRetentionCompactionStore implements RetentionCompactionStore {
  constructor(private readonly context: SqliteContext, private readonly audit: SqliteRetentionAuditStore) {}

  auditPage(input: AuditCoreEventPageInput): AuditCoreEventPageResult {
    if (parseRetentionTimestampMs(input.evaluatedAt) === null
      || !Number.isSafeInteger(input.retentionWindowMs) || input.retentionWindowMs < 0
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > RETENTION_COMPACTION_PAGE_LIMIT) {
      throw new Error("invalid_retention_audit_request");
    }
    return this.context.transaction("sqlite.retention-compaction-store.write", () => this.auditCorePage(input));
  }

  compactPage(input: CompactRetentionPageInput): CompactRetentionPageResult {
    if (parseRetentionTimestampMs(input.evaluatedAt) === null || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > RETENTION_COMPACTION_PAGE_LIMIT) {
      throw new Error("invalid_retention_compaction_request");
    }
    return this.context.transaction("sqlite.retention-compaction-store.write", () => {
      if (input.kind === "delivery") return this.compactDeliveryPage(input);
      if (input.kind === "core_event") return this.compactCorePage(input);
      if (input.kind === "answer_timeline_item") return this.compactTimelinePage(input);
      return this.compactConversationPage(input);
    });
  }

  private compactDeliveryPage(input: CompactRetentionPageInput): CompactRetentionPageResult {
    const stored = this.loadCursor("delivery");
    const startNewCycle = stored === null || stored.cycle_state === "complete";
    const highWater = startNewCycle ? this.readDeliveryHighWater() : parseDeliveryKey(stored.high_water_key_json);
    const after = startNewCycle ? null : stored.after_key_json === null ? null : parseDeliveryKey(stored.after_key_json);
    const refusals: Partial<Record<RetentionRefusalReason, number>> = startNewCycle
      ? {}
      : parseRefusalCounts(stored.refusal_counts_json);
    const priorCompacted = startNewCycle ? 0 : stored.compacted_count;
    if (!highWater) {
      this.saveCursor("delivery", input.evaluatedAt, null, null, "complete", priorCompacted, refusals);
      return { source: "delivery", scanned: 0, compacted: 0, alreadyCompacted: 0, refusals: {}, cursor: null, cycleComplete: true };
    }

    const rows = this.readDeliveryPage(after, highWater, input.limit);
    let compacted = 0;
    let alreadyCompacted = 0;
    const pageRefusals: Partial<Record<RetentionRefusalReason, number>> = {};
    for (const row of rows) {
      const semanticRefusal = semanticDeliveryCompactionRefusal(row);
      if (semanticRefusal !== null) {
        increment(refusals, semanticRefusal);
        increment(pageRefusals, semanticRefusal);
        continue;
      }
      const prepared = this.audit.prepare({ kind: "delivery", id: row.id }, input.evaluatedAt);
      switch (prepared.status) {
        case "refused":
          increment(refusals, prepared.reason);
          increment(pageRefusals, prepared.reason);
          continue;
        case "missing":
        case "stale_owner":
          increment(refusals, "invalid_evidence");
          increment(pageRefusals, "invalid_evidence");
          continue;
      }
      if (prepared.skeleton.state === "compacted") {
        alreadyCompacted += 1;
        continue;
      }
      const changed = this.context.database.prepare(`UPDATE outbound_replies
        SET payload='',payload_compacted_at=?,presentation_snapshot_json=CASE
          WHEN delivery_input_kind='semantic-snapshot' THEN NULL
          ELSE presentation_snapshot_json
        END,intent_json=CASE
          WHEN json_valid(intent_json)
            AND json_extract(intent_json,'$.schemaVersion')=1
            AND json_extract(intent_json,'$.kind')=intent_kind
            AND json_extract(intent_json,'$.materializedPayload')=payload
          THEN json_object('schemaVersion',2,'kind',intent_kind)
          ELSE intent_json
        END
        WHERE id=? AND payload_compacted_at IS NULL AND payload=?`)
        .run(input.evaluatedAt, row.id, row.payload).changes;
      if (changed !== 1) throw new Error("retention_compaction_stale_candidate");
      this.context.database.prepare(`UPDATE audit_skeletons SET state='compacted',compacted_at=?
        WHERE source_kind='delivery' AND source_id=? AND state='verified'`).run(input.evaluatedAt, row.id);
      compacted += 1;
    }

    const last = deliveryKeyOf(rows.at(-1)) ?? after;
    const cycleComplete = rows.length === 0 || (last !== null && compareDeliveryKeys(last, highWater) >= 0);
    this.saveCursor("delivery", input.evaluatedAt, highWater, last, cycleComplete ? "complete" : "scanning", priorCompacted + compacted, refusals);
    return {
      source: "delivery", scanned: rows.length, compacted, alreadyCompacted,
      refusals: pageRefusals, cursor: last, cycleComplete
    };
  }

  private compactCorePage(input: CompactRetentionPageInput): CompactRetentionPageResult {
    const stored = this.loadCursor("core_event");
    const startNewCycle = stored === null || stored.cycle_state === "complete" || coreCursorMode(stored.high_water_key_json) !== "compact";
    const highWater = startNewCycle ? this.readCoreHighWater() : parseCoreKey(stored.high_water_key_json);
    const after = startNewCycle ? null : stored.after_key_json === null ? null : parseCoreKey(stored.after_key_json);
    const refusals: Partial<Record<RetentionRefusalReason, number>> = startNewCycle ? {} : parseRefusalCounts(stored.refusal_counts_json);
    const priorCompacted = startNewCycle ? 0 : stored.compacted_count;
    if (!highWater) {
      this.saveCursor("core_event", input.evaluatedAt, coreCursor(null, "compact"), null, "complete", priorCompacted, refusals);
      return { source: "core_event", scanned: 0, compacted: 0, alreadyCompacted: 0, refusals: {}, cursor: null, cycleComplete: true, eligibleBytes: 0 };
    }
    const rows = this.readCorePage(after, highWater, input.limit);
    let compacted = 0;
    let alreadyCompacted = 0;
    let eligibleBytes = 0;
    const pageRefusals: Partial<Record<RetentionRefusalReason, number>> = {};
    for (const row of rows) {
      const prepared = this.audit.prepare({
        kind: "core_event", id: row.eventId,
        ...(input.retentionWindowMs === undefined ? {} : { retentionWindowMs: input.retentionWindowMs })
      }, input.evaluatedAt);
      switch (prepared.status) {
        case "refused": increment(refusals, prepared.reason); increment(pageRefusals, prepared.reason); continue;
        case "missing":
        case "stale_owner": increment(refusals, "invalid_evidence"); increment(pageRefusals, "invalid_evidence"); continue;
      }
      eligibleBytes += prepared.skeleton.payloadBytes;
      if (prepared.skeleton.state === "compacted") { alreadyCompacted += 1; continue; }
      const changed = this.context.database.prepare(`UPDATE core_event_inbox
        SET event_json='null',payload_compacted_at=? WHERE event_id=? AND payload_compacted_at IS NULL AND event_json=?`)
        .run(input.evaluatedAt, row.eventId, row.eventJson).changes;
      if (changed !== 1) throw new Error("retention_compaction_stale_candidate");
      this.context.database.prepare(`UPDATE audit_skeletons SET state='compacted',compacted_at=?
        WHERE source_kind='core_event' AND source_id=? AND state='verified'`).run(input.evaluatedAt, row.eventId);
      compacted += 1;
    }
    const last = coreKeyOf(rows.at(-1)) ?? after;
    const cycleComplete = rows.length === 0 || (last !== null && compareCoreKeys(last, highWater) >= 0);
    this.saveCursor("core_event", input.evaluatedAt, coreCursor(highWater, "compact"), last, cycleComplete ? "complete" : "scanning", priorCompacted + compacted, refusals);
    return { source: "core_event", scanned: rows.length, compacted, alreadyCompacted, refusals: pageRefusals, cursor: last, cycleComplete, eligibleBytes };
  }

  private auditCorePage(input: AuditCoreEventPageInput): AuditCoreEventPageResult {
    const stored = this.loadCursor("core_event");
    const fresh = stored === null || stored.cycle_state === "complete" || coreCursorMode(stored.high_water_key_json) !== "audit";
    const highWater = fresh ? this.readCoreHighWater() : parseCoreKey(stored.high_water_key_json);
    const after = fresh || stored!.after_key_json === null ? null : parseCoreKey(stored!.after_key_json);
    const cumulative = fresh ? {} : parseRefusalCounts(stored!.refusal_counts_json);
    if (!highWater) {
      this.saveCursor("core_event", input.evaluatedAt, coreCursor(null, "audit"), null, "complete", 0, cumulative);
      return { source: "core_event", scanned: 0, eligible: 0, alreadyVerified: 0, eligibleBytes: 0, refusals: {}, cursor: null, cycleComplete: true };
    }
    const rows = this.readCorePage(after, highWater, input.limit);
    let eligible = 0;
    let alreadyVerified = 0;
    let eligibleBytes = 0;
    const refusals: Partial<Record<RetentionRefusalReason, number>> = {};
    for (const row of rows) {
      const prepared = this.audit.prepare({
        kind: "core_event", id: row.eventId, retentionWindowMs: input.retentionWindowMs
      }, input.evaluatedAt);
      switch (prepared.status) {
        case "refused": increment(cumulative, prepared.reason); increment(refusals, prepared.reason); continue;
        case "missing":
        case "stale_owner": increment(cumulative, "invalid_evidence"); increment(refusals, "invalid_evidence"); continue;
        case "existing": alreadyVerified += 1; break;
        case "recorded": break;
      }
      eligible += 1;
      eligibleBytes += prepared.skeleton.payloadBytes;
    }
    const last = coreKeyOf(rows.at(-1)) ?? after;
    const cycleComplete = rows.length === 0 || (last !== null && compareCoreKeys(last, highWater) >= 0);
    this.saveCursor("core_event", input.evaluatedAt, coreCursor(highWater, "audit"), last, cycleComplete ? "complete" : "scanning", 0, cumulative);
    return { source: "core_event", scanned: rows.length, eligible, alreadyVerified, eligibleBytes, refusals, cursor: last, cycleComplete };
  }

  private readCoreHighWater(): CoreKey | null {
    return this.context.database.prepare(`SELECT ingested_at AS ingestedAt,event_id AS eventId FROM core_event_inbox
      WHERE payload_compacted_at IS NULL ORDER BY ingested_at DESC,event_id DESC LIMIT 1`).get() as CoreKey | undefined ?? null;
  }

  private readCorePage(after: CoreKey | null, highWater: CoreKey, limit: number): CorePageRow[] {
    return this.context.database.prepare(`SELECT ingested_at AS ingestedAt,event_id AS eventId,event_json AS eventJson FROM core_event_inbox
      WHERE payload_compacted_at IS NULL
        AND (? IS NULL OR ingested_at>? OR (ingested_at=? AND event_id>?))
        AND (ingested_at<? OR (ingested_at=? AND event_id<=?))
      ORDER BY ingested_at,event_id LIMIT ?`).all(
        after?.ingestedAt ?? null, after?.ingestedAt ?? "", after?.ingestedAt ?? "", after?.eventId ?? "",
        highWater.ingestedAt, highWater.ingestedAt, highWater.eventId, limit
      ) as unknown as CorePageRow[];
  }

  private compactTimelinePage(input: CompactRetentionPageInput): CompactRetentionPageResult {
    const source = "answer_timeline_item" as const;
    const stored = this.loadCursor(source);
    const fresh = stored === null || stored.cycle_state === "complete";
    const highWater = fresh ? this.readTimelineHighWater() : parseTimelineKey(stored.high_water_key_json);
    const after = fresh || stored!.after_key_json === null ? null : parseTimelineKey(stored!.after_key_json);
    const cumulative = fresh ? {} : parseRefusalCounts(stored!.refusal_counts_json);
    const priorCompacted = fresh ? 0 : stored!.compacted_count;
    if (!highWater) {
      this.saveCursor(source, input.evaluatedAt, null, null, "complete", priorCompacted, cumulative);
      return { source, scanned:0, compacted:0, alreadyCompacted:0, refusals:{}, cursor:null, cycleComplete:true };
    }
    const rows = this.readTimelinePage(after, highWater, input.limit);
    const result = this.compactPayloadRows(source, input.evaluatedAt, rows, (row) => JSON.stringify([source,row.aggregateKind,row.aggregateId,row.itemId]),
      (row) => row.itemJson, (row) => Number(this.context.database.prepare(`UPDATE answer_timeline_items SET item_json='null',payload_compacted_at=?
        WHERE aggregate_kind=? AND aggregate_id=? AND item_id=? AND payload_compacted_at IS NULL AND item_json=?`).run(
          input.evaluatedAt,row.aggregateKind,row.aggregateId,row.itemId,row.itemJson).changes));
    const last = timelineKeyOf(rows.at(-1)) ?? after;
    const complete = rows.length === 0 || (last !== null && compareTimelineKeys(last,highWater)>=0);
    mergeCounts(cumulative,result.refusals);
    this.saveCursor(source,input.evaluatedAt,highWater,last,complete?"complete":"scanning",priorCompacted+result.compacted,cumulative);
    return { source, ...result, cursor:last, cycleComplete:complete };
  }

  private compactConversationPage(input: CompactRetentionPageInput): CompactRetentionPageResult {
    const source = "conversation_segment_item" as const;
    const stored = this.loadCursor(source);
    const fresh = stored === null || stored.cycle_state === "complete";
    const highWater = fresh ? this.readConversationHighWater() : parseConversationKey(stored.high_water_key_json);
    const after = fresh || stored!.after_key_json === null ? null : parseConversationKey(stored!.after_key_json);
    const cumulative = fresh ? {} : parseRefusalCounts(stored!.refusal_counts_json);
    const priorCompacted = fresh ? 0 : stored!.compacted_count;
    if (!highWater) {
      this.saveCursor(source,input.evaluatedAt,null,null,"complete",priorCompacted,cumulative);
      return { source,scanned:0,compacted:0,alreadyCompacted:0,refusals:{},cursor:null,cycleComplete:true };
    }
    const rows = this.readConversationPage(after,highWater,input.limit);
    const result = this.compactPayloadRows(source,input.evaluatedAt,rows,(row)=>JSON.stringify([source,row.segmentId,row.itemId]),
      (row)=>row.itemJson,(row)=>Number(this.context.database.prepare(`UPDATE conversation_segment_items SET item_json='null',payload_compacted_at=?
        WHERE segment_id=? AND item_id=? AND payload_compacted_at IS NULL AND item_json=?`).run(input.evaluatedAt,row.segmentId,row.itemId,row.itemJson).changes));
    const last=conversationKeyOf(rows.at(-1))??after;
    const complete=rows.length===0||(last!==null&&compareConversationKeys(last,highWater)>=0);
    mergeCounts(cumulative,result.refusals);
    this.saveCursor(source,input.evaluatedAt,highWater,last,complete?"complete":"scanning",priorCompacted+result.compacted,cumulative);
    return {source,...result,cursor:last,cycleComplete:complete};
  }

  private compactPayloadRows<T>(source: "answer_timeline_item"|"conversation_segment_item", evaluatedAt:string, rows:readonly T[],
    identity:(row:T)=>string,payload:(row:T)=>string,update:(row:T)=>number): Pick<CompactRetentionPageResult,"scanned"|"compacted"|"alreadyCompacted"|"refusals"> {
    let compacted=0; let alreadyCompacted=0;
    const refusals:Partial<Record<RetentionRefusalReason,number>>={};
    for(const row of rows){
      const prepared=this.audit.prepare({kind:source,id:identity(row),expectedPayloadHash:sha256(payload(row))},evaluatedAt);
      switch(prepared.status){
        case "refused": increment(refusals,prepared.reason); continue;
        case "missing":
        case "stale_owner": increment(refusals,"invalid_evidence"); continue;
      }
      if(prepared.skeleton.state==="compacted"){alreadyCompacted+=1;continue;}
      if(update(row)!==1) throw new Error("retention_compaction_stale_candidate");
      this.context.database.prepare(`UPDATE audit_skeletons SET state='compacted',compacted_at=?
        WHERE source_kind=? AND source_id=? AND state='verified'`).run(evaluatedAt,source,identity(row));
      compacted+=1;
    }
    return {scanned:rows.length,compacted,alreadyCompacted,refusals};
  }

  private readTimelineHighWater():TimelineKey|null{return this.context.database.prepare(`SELECT aggregate_kind AS aggregateKind,aggregate_id AS aggregateId,sequence,item_id AS itemId
    FROM answer_timeline_items WHERE payload_compacted_at IS NULL ORDER BY aggregate_kind DESC,aggregate_id DESC,sequence DESC,item_id DESC LIMIT 1`).get() as TimelineKey|undefined??null;}
  private readTimelinePage(after:TimelineKey|null,high:TimelineKey,limit:number):TimelinePageRow[]{
    return this.context.database.prepare(`SELECT aggregate_kind AS aggregateKind,aggregate_id AS aggregateId,sequence,item_id AS itemId,item_json AS itemJson
      FROM answer_timeline_items WHERE payload_compacted_at IS NULL
        AND (? IS NULL OR (aggregate_kind,aggregate_id,sequence,item_id)>(?,?,?,?))
        AND (aggregate_kind,aggregate_id,sequence,item_id)<=(?,?,?,?)
      ORDER BY aggregate_kind,aggregate_id,sequence,item_id LIMIT ?`).all(
        after?.aggregateKind??null,after?.aggregateKind??"",after?.aggregateId??"",after?.sequence??0,after?.itemId??"",
        high.aggregateKind,high.aggregateId,high.sequence,high.itemId,limit) as unknown as TimelinePageRow[];
  }
  private readConversationHighWater():ConversationKey|null{return this.context.database.prepare(`SELECT segment_id AS segmentId,lane_sequence AS laneSequence,item_ordinal AS itemOrdinal,item_id AS itemId
    FROM conversation_segment_items WHERE payload_compacted_at IS NULL ORDER BY segment_id DESC,lane_sequence DESC,item_ordinal DESC,item_id DESC LIMIT 1`).get() as ConversationKey|undefined??null;}
  private readConversationPage(after:ConversationKey|null,high:ConversationKey,limit:number):ConversationPageRow[]{
    return this.context.database.prepare(`SELECT segment_id AS segmentId,lane_sequence AS laneSequence,item_ordinal AS itemOrdinal,item_id AS itemId,item_json AS itemJson
      FROM conversation_segment_items WHERE payload_compacted_at IS NULL
        AND (? IS NULL OR (segment_id,lane_sequence,item_ordinal,item_id)>(?,?,?,?))
        AND (segment_id,lane_sequence,item_ordinal,item_id)<=(?,?,?,?)
      ORDER BY segment_id,lane_sequence,item_ordinal,item_id LIMIT ?`).all(
        after?.segmentId??null,after?.segmentId??"",after?.laneSequence??0,after?.itemOrdinal??0,after?.itemId??"",
        high.segmentId,high.laneSequence,high.itemOrdinal,high.itemId,limit) as unknown as ConversationPageRow[];
  }

  private readDeliveryHighWater(): DeliveryKey | null {
    const row = this.context.database.prepare(`SELECT updated_at AS updatedAt,id FROM outbound_replies
      WHERE payload_compacted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 1`).get() as DeliveryKey | undefined;
    return row ?? null;
  }

  private readDeliveryPage(after: DeliveryKey | null, highWater: DeliveryKey, limit: number): DeliveryPageRow[] {
    return this.context.database.prepare(`SELECT updated_at AS updatedAt,id,payload,
      delivery_input_kind AS deliveryInputKind,preparation_state AS preparationState,
      presentation_snapshot_json AS presentationSnapshotJson,presentation_snapshot_hash AS presentationSnapshotHash,
      planner_policy_version AS plannerPolicyVersion,renderer_policy_version AS rendererPolicyVersion,
      gateway_profile_version AS gatewayProfileVersion,gateway_plan_json AS gatewayPlanJson,gateway_plan_hash AS gatewayPlanHash
      FROM outbound_replies
      WHERE payload_compacted_at IS NULL
        AND (? IS NULL OR updated_at>? OR (updated_at=? AND id>?))
        AND (updated_at<? OR (updated_at=? AND id<=?))
      ORDER BY updated_at,id LIMIT ?`).all(
        after?.updatedAt ?? null, after?.updatedAt ?? "", after?.updatedAt ?? "", after?.id ?? "",
        highWater.updatedAt, highWater.updatedAt, highWater.id, limit
      ) as unknown as DeliveryPageRow[];
  }

  private loadCursor(source: CompactRetentionPageInput["kind"]): CursorRow | null {
    return this.context.database.prepare(`SELECT high_water_key_json,after_key_json,cycle_state,compacted_count,refusal_counts_json
      FROM retention_compaction_cursors WHERE source_kind=?`).get(source) as CursorRow | undefined ?? null;
  }

  private saveCursor(source: CompactRetentionPageInput["kind"], now: string, highWater: object | null, after: object | null,
    state: CursorRow["cycle_state"], compactedCount: number, refusals: Partial<Record<RetentionRefusalReason, number>>): void {
    this.context.database.prepare(`INSERT INTO retention_compaction_cursors(
      source_kind,cycle_started_at,high_water_key_json,after_key_json,cycle_state,compacted_count,refusal_counts_json,updated_at
    ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_kind) DO UPDATE SET
      cycle_started_at=excluded.cycle_started_at,high_water_key_json=excluded.high_water_key_json,
      after_key_json=excluded.after_key_json,cycle_state=excluded.cycle_state,compacted_count=excluded.compacted_count,
      refusal_counts_json=excluded.refusal_counts_json,updated_at=excluded.updated_at`).run(
        source, now, JSON.stringify(highWater ?? {}), after === null ? null : JSON.stringify(after), state,
        compactedCount, JSON.stringify(refusals), now
      );
  }
}

function parseDeliveryKey(value: string): DeliveryKey {
  const parsed = JSON.parse(value) as Partial<DeliveryKey>;
  if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") throw new Error("invalid_retention_compaction_cursor");
  return { updatedAt: parsed.updatedAt, id: parsed.id };
}

function parseCoreKey(value: string): CoreKey {
  const parsed = JSON.parse(value) as Partial<CoreKey>;
  if (typeof parsed.ingestedAt !== "string" || typeof parsed.eventId !== "string") throw new Error("invalid_retention_compaction_cursor");
  return { ingestedAt: parsed.ingestedAt, eventId: parsed.eventId };
}

function coreCursor(key: CoreKey | null, mode: "audit" | "compact"): object {
  return key === null ? { mode } : { ...key, mode };
}

function coreCursorMode(value: string): "audit" | "compact" {
  try {
    return (JSON.parse(value) as { mode?: unknown }).mode === "audit" ? "audit" : "compact";
  } catch {
    return "compact";
  }
}

function parseTimelineKey(value:string):TimelineKey{const parsed=JSON.parse(value) as TimelineKey;if(typeof parsed.aggregateKind!=="string"||typeof parsed.aggregateId!=="string"||!Number.isSafeInteger(parsed.sequence)||typeof parsed.itemId!=="string")throw new Error("invalid_retention_compaction_cursor");return parsed;}
function parseConversationKey(value:string):ConversationKey{const parsed=JSON.parse(value) as ConversationKey;if(typeof parsed.segmentId!=="string"||!Number.isSafeInteger(parsed.laneSequence)||!Number.isSafeInteger(parsed.itemOrdinal)||typeof parsed.itemId!=="string")throw new Error("invalid_retention_compaction_cursor");return parsed;}

function parseRefusalCounts(value: string): Partial<Record<RetentionRefusalReason, number>> {
  const parsed = JSON.parse(value) as Partial<Record<RetentionRefusalReason, number>>;
  return parsed && typeof parsed === "object" ? parsed : {};
}

function semanticDeliveryCompactionRefusal(row: DeliveryPageRow): RetentionRefusalReason | null {
  if (row.deliveryInputKind !== "semantic-snapshot") return null;
  if (row.preparationState !== "prepared") return "not_terminal";
  return row.presentationSnapshotJson === null
    || row.presentationSnapshotHash === null
    || row.plannerPolicyVersion === null
    || row.rendererPolicyVersion === null
    || row.gatewayProfileVersion === null
    || row.gatewayPlanJson === null
    || row.gatewayPlanHash === null
    ? "invalid_evidence"
    : null;
}

function increment(counts: Partial<Record<RetentionRefusalReason, number>>, reason: RetentionRefusalReason): void {
  counts[reason] = Math.min(Number.MAX_SAFE_INTEGER, (counts[reason] ?? 0) + 1);
}
function mergeCounts(target:Partial<Record<RetentionRefusalReason,number>>,source:Partial<Record<RetentionRefusalReason,number>>):void{for(const [reason,count] of Object.entries(source) as Array<[RetentionRefusalReason,number]>)target[reason]=Math.min(Number.MAX_SAFE_INTEGER,(target[reason]??0)+count);}

function compareDeliveryKeys(left: DeliveryKey, right: DeliveryKey): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id);
}

function deliveryKeyOf(row: DeliveryPageRow | undefined): DeliveryKey | null {
  return row === undefined ? null : { updatedAt: row.updatedAt, id: row.id };
}

function coreKeyOf(row: CorePageRow | undefined): CoreKey | null {
  return row === undefined ? null : { ingestedAt: row.ingestedAt, eventId: row.eventId };
}

function timelineKeyOf(row: TimelinePageRow | undefined): TimelineKey | null {
  return row === undefined ? null : {
    aggregateKind: row.aggregateKind,
    aggregateId: row.aggregateId,
    sequence: row.sequence,
    itemId: row.itemId
  };
}

function conversationKeyOf(row: ConversationPageRow | undefined): ConversationKey | null {
  return row === undefined ? null : {
    segmentId: row.segmentId,
    laneSequence: row.laneSequence,
    itemOrdinal: row.itemOrdinal,
    itemId: row.itemId
  };
}


function compareCoreKeys(left: CoreKey, right: CoreKey): number {
  return left.ingestedAt.localeCompare(right.ingestedAt) || left.eventId.localeCompare(right.eventId);
}
function compareTimelineKeys(left:TimelineKey,right:TimelineKey):number{return left.aggregateKind.localeCompare(right.aggregateKind)||left.aggregateId.localeCompare(right.aggregateId)||left.sequence-right.sequence||left.itemId.localeCompare(right.itemId);}
function compareConversationKeys(left:ConversationKey,right:ConversationKey):number{return left.segmentId.localeCompare(right.segmentId)||left.laneSequence-right.laneSequence||left.itemOrdinal-right.itemOrdinal||left.itemId.localeCompare(right.itemId);}

function sha256(value:string):string{return createHash("sha256").update(value).digest("hex");}
