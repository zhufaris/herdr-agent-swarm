import type { DeliveryFailureClass } from "../../domain/delivery.js";
import type { OpenProjectionGapInput, ProjectionGapQuery, ProjectionGapStore, ProjectionGapSummary } from "../../domain/projection-gap.js";
import type { SqliteContext } from "./context.js";
import { parseTurnCardProjectionKey } from "../../domain/turn-card-projection-key.js";

const MAX_CODE_CHARS = 120;

export class SqliteProjectionGapStore implements ProjectionGapStore {
  constructor(private readonly context: SqliteContext) {}

  open(input: OpenProjectionGapInput): void {
    const code = sanitizeCode(input.failureCode);
    this.context.database.prepare(`INSERT INTO projection_gaps(
      stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,required_version,first_failed_at,last_failed_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(stage,owner_kind,owner_id,source_item_id) DO UPDATE SET
      failure_class=excluded.failure_class,failure_code=excluded.failure_code,
      required_version=MAX(COALESCE(projection_gaps.required_version, 0), COALESCE(excluded.required_version, 0)),
      occurrence_count=projection_gaps.occurrence_count+1,last_failed_at=excluded.last_failed_at,
      state='open',compensated_by_version=NULL,compensated_at=NULL`).run(
      input.stage, input.ownerKind, input.ownerId, input.sourceItemId, input.failureClass, code,
      input.requiredVersion ?? null, input.occurredAt, input.occurredAt
    );
  }

  openDeliveryForReply(replyId: string, failureClass: DeliveryFailureClass, failureCode: string, occurredAt: string): void {
    const identity = this.deliveryIdentity(replyId);
    if (!identity) return;
    this.open({ ...identity, sourceItemId: replyId, failureClass, failureCode, occurredAt });
  }

  compensateDeliveryForReply(replyId: string, deliveredVersion: number, occurredAt: string): number {
    const identity = this.deliveryIdentity(replyId);
    let changed = 0;
    if (identity) changed += Number(this.context.database.prepare(`UPDATE projection_gaps
      SET state='compensated',compensated_by_version=?,compensated_at=?,last_failed_at=last_failed_at
      WHERE stage=? AND owner_kind=? AND owner_id=? AND state='open'
        AND COALESCE(required_version, 0) <= ?`).run(
      deliveredVersion, occurredAt, identity.stage, identity.ownerKind, identity.ownerId, deliveredVersion
    ).changes);
    changed += Number(this.context.database.prepare(`UPDATE projection_gaps
      SET state='compensated',compensated_by_version=?,compensated_at=?
      WHERE state='open' AND source_item_id IN (
        SELECT failed_reply_id FROM delivery_recoveries WHERE resolved_by_reply_id=? AND state='recovered'
      ) AND COALESCE(required_version, 0) <= ?`).run(deliveredVersion, occurredAt, replyId, deliveredVersion).changes);
    return changed;
  }

  compensateProjectionEvent(eventId: string, reducerRevision: number, occurredAt: string): number {
    const result = this.context.database.prepare(`UPDATE projection_gaps
      SET state='compensated',compensated_by_version=?,compensated_at=?
      WHERE stage='core_projection' AND source_item_id=? AND state='open'
        AND COALESCE(required_version, 0) < ?`).run(reducerRevision, occurredAt, eventId, reducerRevision);
    return Number(result.changes);
  }

  summarize(query: ProjectionGapQuery): ProjectionGapSummary {
    const owners: Array<{ kind: string; id: string; prefix?: boolean }> = [];
    if (query.bindingId) owners.push({ kind: "binding", id: query.bindingId });
    if (query.promptId) owners.push({ kind: "prompt", id: query.promptId });
    if (query.answerPage) owners.push({ kind: "answer_page", id: answerPageOwnerId(query.answerPage.promptId, query.answerPage.pageIndex) });
    if (query.workerTurnId) owners.push({ kind: "worker_turn", id: query.workerTurnId, prefix: true });
    if (owners.length === 0) return { openProjection: 0, openDelivery: 0, compensated: 0, oldestOpenAt: null };
    const predicates = owners.map((owner) => owner.prefix ? "(owner_kind = ? AND (owner_id = ? OR owner_id LIKE ? ESCAPE '\\'))" : "(owner_kind = ? AND owner_id = ?)").join(" OR ");
    const parameters = owners.flatMap((owner) => owner.prefix ? [owner.kind, owner.id, `${escapeLike(owner.id)}:%`] : [owner.kind, owner.id]);
    const row = this.context.database.prepare(`SELECT
      SUM(CASE WHEN state='open' AND stage='core_projection' THEN 1 ELSE 0 END) AS open_projection,
      SUM(CASE WHEN state='open' AND stage IN ('answer_delivery','main_delivery','worker_delivery') THEN 1 ELSE 0 END) AS open_delivery,
      SUM(CASE WHEN state='compensated' THEN 1 ELSE 0 END) AS compensated,
      MIN(CASE WHEN state='open' THEN first_failed_at END) AS oldest_open_at
      FROM projection_gaps WHERE ${predicates}`).get(...parameters) as {
        open_projection: number | null; open_delivery: number | null; compensated: number | null; oldest_open_at: string | null;
      };
    return { openProjection: Number(row.open_projection ?? 0), openDelivery: Number(row.open_delivery ?? 0), compensated: Number(row.compensated ?? 0), oldestOpenAt: row.oldest_open_at };
  }

  pruneCompensated(cutoff: string, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    return Number(this.context.database.prepare(`DELETE FROM projection_gaps WHERE id IN (
      SELECT id FROM projection_gaps
      WHERE state='compensated' AND compensated_at IS NOT NULL AND compensated_at < ?
      ORDER BY compensated_at, id LIMIT ?
    )`).run(cutoff, limit).changes);
  }

  private deliveryIdentity(replyId: string): (Pick<OpenProjectionGapInput, "stage" | "ownerKind" | "ownerId" | "requiredVersion">) | null {
    const row = this.context.database.prepare(`SELECT binding_id,prompt_id,worker_turn_id,worker_id,view_version,stream_page_index,selection_id,kind,card_role,target_role
      FROM outbound_replies WHERE id=?`).get(replyId) as {
        binding_id: string | null; prompt_id: string | null; worker_turn_id: string | null; worker_id: string | null;
        view_version: number | null; stream_page_index: number | null; selection_id: string | null; kind: string; card_role: string | null; target_role: string | null;
      } | undefined;
    if (!row) return null;
    const requiredVersion = row.view_version === null ? null : Number(row.view_version);
    const completionReview = this.context.database.prepare(`SELECT action.owner_kind,action.owner_id,action.page_index,reply.snapshot_revision
      FROM outbound_replies reply JOIN completion_action_sets action ON action.presentation_reply_id=reply.id
      WHERE reply.id=? AND reply.kind='card_reply' AND reply.target_role='operation_result'
        AND reply.projection_key LIKE 'completion-review:%'
        AND action.presentation_kind='fresh-card'`).get(replyId) as {
          owner_kind: "primary-segment" | "primary-prompt" | "worker-turn";
          owner_id: string; page_index: number; snapshot_revision: number;
        } | undefined;
    if (completionReview) {
      if (completionReview.owner_kind === "primary-segment") {
        return { stage: "turn_recovery", ownerKind: "turn_card", ownerId: completionReview.owner_id, requiredVersion: Number(completionReview.snapshot_revision) };
      }
      if (completionReview.owner_kind === "primary-prompt") {
        return { stage: "answer_delivery", ownerKind: "prompt", ownerId: completionReview.owner_id, requiredVersion: Number(completionReview.snapshot_revision) };
      }
      return { stage: "worker_delivery", ownerKind: "worker_turn", ownerId: `${completionReview.owner_id}:${completionReview.page_index}:completion_review`, requiredVersion: Number(completionReview.snapshot_revision) };
    }
    const turnCard = this.context.database.prepare("SELECT projection_key, snapshot_revision FROM outbound_replies WHERE id=? AND projection_key LIKE 'turn-card:%'").get(replyId) as { projection_key: string; snapshot_revision: number } | undefined;
    const target = turnCard?.projection_key ? parseTurnCardProjectionKey(turnCard.projection_key) : null;
    if (target) {
      const page = this.context.database.prepare("SELECT element_id FROM conversation_segment_pages WHERE segment_id=? AND page_index=?").get(target.segmentId, target.pageIndex) as { element_id: string } | undefined;
      if (!page || page.element_id !== turnCard!.projection_key) return null;
      return { stage: "turn_recovery", ownerKind: "turn_card", ownerId: target.segmentId, requiredVersion: Number(turnCard!.snapshot_revision) };
    }
    if (row.card_role === "answer" && row.prompt_id) {
      return row.stream_page_index === null
        ? { stage: "answer_delivery", ownerKind: "prompt", ownerId: row.prompt_id, requiredVersion }
        : { stage: "answer_delivery", ownerKind: "answer_page", ownerId: answerPageOwnerId(row.prompt_id, Number(row.stream_page_index)), requiredVersion };
    }
    if (row.worker_turn_id) {
      const page = row.stream_page_index ?? 0;
      const target = row.kind === "card_update" ? "snapshot" : row.selection_id === "worker-progress" ? "progress" : row.kind === "stream_content" ? "answer" : row.kind;
      return { stage: "worker_delivery", ownerKind: "worker_turn", ownerId: `${row.worker_turn_id}:${page}:${target}`, requiredVersion };
    }
    if (row.binding_id && row.target_role === "session_status") return { stage: "main_delivery", ownerKind: "binding", ownerId: row.binding_id, requiredVersion };
    if (row.binding_id && row.worker_id) return { stage: "worker_delivery", ownerKind: "binding", ownerId: row.binding_id, requiredVersion };
    return null;
  }
}

export function answerPageOwnerId(promptId: string, pageIndex: number): string {
  return `${promptId}:${pageIndex}`;
}

function sanitizeCode(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, MAX_CODE_CHARS);
  return normalized || "delivery_failed";
}

function escapeLike(value: string): string { return value.replace(/[\\%_]/g, "\\$&"); }
