import { randomUUID } from "node:crypto";
import type { SqliteContext } from "./context.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";

interface HumanReviewSurfaceRow {
  id: string;
  binding_id: string;
  binding_generation: number;
  surface_generation: number;
  view_version: number;
  delivered_version: number;
  create_reply_id: string | null;
  message_id: string | null;
  card_json: string | null;
}

interface WorkerSurfaceRow extends HumanReviewSurfaceRow {
  turn_id: string;
  instance_id: string;
  worker_session_generation: number;
  state: "open" | "resolved";
  create_card_json: string;
  root_message_id?: string;
}

interface SurfaceRoute {
  projectionKey: string;
  laneKey: string;
  workerId?: string;
  workerSessionGeneration?: number;
}

export class SqliteHumanReviewSurfaceStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(private readonly context: SqliteContext) {}
  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void { this.preparedDeliveryReservation = reservation; this.preparedDeliveryConsumer = consumer; }

  reservePrimary(input: { episodeId: string; rootMessageId: string; createCard: object }): void {
    const episode = this.loadPrimary(input.episodeId);
    if (!episode || episode.surface_generation < 1 || !episode.card_json) return;
    this.reserve(episode, input.rootMessageId, JSON.stringify(input.createCard), {
      projectionKey: `human-review:primary:${episode.id}:surface:${episode.surface_generation}`,
      laneKey: `primary-review:${episode.binding_id}:${episode.binding_generation}`
    });
  }

  reserveWorker(input: { episodeId: string; rootMessageId: string; createCard?: object }): void {
    const episode = this.loadWorker(input.episodeId);
    if (!episode?.card_json) return;
    this.reserve(episode, input.rootMessageId, input.createCard ? JSON.stringify(input.createCard) : episode.create_card_json, {
      projectionKey: workerProjectionKey(episode),
      laneKey: workerLaneKey(episode),
      workerId: episode.instance_id,
      workerSessionGeneration: episode.worker_session_generation
    });
  }

  checkpoint(input: { replyId: string; projectionKey: string; snapshotRevision: number; messageId: string; cardId: string | null }): void {
    if (input.projectionKey.startsWith("human-review:primary:")) this.checkpointPrimary(input);
    else if (input.projectionKey.startsWith("human-review:worker:")) this.checkpointWorker(input);
  }

  replaceWorkerTarget(input: { projectionKey: string; targetMessageId: string; occurredAt: string }): { outcome: "replaced"; replyId: string } | { outcome: "resolved" | "stale" } {
    const episode = this.context.database.prepare(`SELECT episode.*, binding.root_message_id
      FROM worker_human_review_episodes episode
      JOIN bindings binding ON binding.id = episode.binding_id AND binding.generation = episode.binding_generation
        AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
      JOIN agent_instances worker ON worker.id = episode.instance_id AND worker.generation = episode.instance_generation
        AND worker.worker_session_generation = episode.worker_session_generation AND worker.worker_session_lifecycle = 'active'
        AND worker.parent_binding_id = episode.binding_id AND worker.parent_binding_generation = episode.binding_generation
      WHERE ? = 'human-review:worker:' || episode.id || ':surface:' || episode.surface_generation
        AND episode.message_id = ? LIMIT 1`
    ).get(input.projectionKey, input.targetMessageId) as WorkerSurfaceRow | undefined;
    if (!episode) return { outcome: "stale" };
    if (episode.state !== "open") return { outcome: "resolved" };
    this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed',
      error = 'Superseded by replacement Human Review surface', updated_at = ?
      WHERE projection_key = ? AND state = 'pending' AND claim_attempt_id IS NULL AND first_claimed_at IS NULL`
    ).run(input.occurredAt, input.projectionKey);
    const replacementId = randomUUID();
    const updated = this.context.database.prepare(`UPDATE worker_human_review_episodes SET
      surface_generation = surface_generation + 1, delivered_version = 0, create_reply_id = ?,
      message_id = NULL, card_id = NULL, updated_at = ?
      WHERE id = ? AND state = 'open' AND surface_generation = ?`
    ).run(replacementId, input.occurredAt, episode.id, episode.surface_generation);
    if (Number(updated.changes) !== 1) return { outcome: "stale" };
    const current = this.loadWorker(episode.id);
    if (!current) return { outcome: "stale" };
    this.enqueueSurface({
      projectionKey: workerProjectionKey(current), laneKey: workerLaneKey(current),
      workerId: current.instance_id, workerSessionGeneration: current.worker_session_generation
    }, {
      id: replacementId, idempotencyKey: `${workerProjectionKey(current)}:create`,
      bindingId: current.binding_id, bindingGeneration: current.binding_generation,
      targetRole: "operation_result", rootMessageId: episode.root_message_id ?? this.bindingRootMessageId(current.binding_id),
      kind: "card_reply", payload: current.create_card_json,
      laneKeyOverride: workerLaneKey(current), projectionKey: workerProjectionKey(current),
      snapshotRevision: current.view_version
    });
    return { outcome: "replaced", replyId: replacementId };
  }

  private reserve(episode: HumanReviewSurfaceRow, rootMessageId: string, createPayload: string, route: SurfaceRoute): void {
    if (!episode.message_id) {
      const createId = episode.create_reply_id ?? randomUUID();
      const existing = episode.create_reply_id
        ? this.context.database.prepare("SELECT state, first_claimed_at, attempt_count, card_id_checkpoint FROM outbound_replies WHERE id = ?").get(episode.create_reply_id) as { state: string; first_claimed_at: string | null; attempt_count: number; card_id_checkpoint: string | null } | undefined
        : undefined;
      if (existing && (existing.state !== "pending" || existing.first_claimed_at !== null || existing.attempt_count > 0 || existing.card_id_checkpoint !== null)) return;
      this.context.database.prepare(`UPDATE ${surfaceTable(route.projectionKey)} SET create_reply_id = ? WHERE id = ? AND create_reply_id IS NULL`).run(createId, episode.id);
      this.enqueueSurface(route, {
        id: createId, idempotencyKey: `${route.projectionKey}:create`, bindingId: episode.binding_id,
        bindingGeneration: episode.binding_generation, targetRole: "operation_result", rootMessageId,
        kind: "card_reply", payload: createPayload, laneKeyOverride: route.laneKey,
        projectionKey: route.projectionKey, snapshotRevision: episode.view_version
      });
      return;
    }
    this.reserveUpdate(episode, route);
  }

  private checkpointPrimary(input: { replyId: string; projectionKey: string; snapshotRevision: number; messageId: string; cardId: string | null }): void {
    const episode = this.context.database.prepare(`SELECT * FROM primary_human_review_episodes
      WHERE create_reply_id = ? OR (? = 'human-review:primary:' || id || ':surface:' || surface_generation)
      LIMIT 1`).get(input.replyId, input.projectionKey) as HumanReviewSurfaceRow | undefined;
    if (!episode || episode.surface_generation < 1) return;
    this.checkpointRow("primary_human_review_episodes", episode, input, {
      projectionKey: `human-review:primary:${episode.id}:surface:${episode.surface_generation}`,
      laneKey: `primary-review:${episode.binding_id}:${episode.binding_generation}`
    });
  }

  private checkpointWorker(input: { replyId: string; projectionKey: string; snapshotRevision: number; messageId: string; cardId: string | null }): void {
    const episode = this.context.database.prepare(`SELECT * FROM worker_human_review_episodes
      WHERE create_reply_id = ? OR (? = 'human-review:worker:' || id || ':surface:' || surface_generation)
      LIMIT 1`).get(input.replyId, input.projectionKey) as WorkerSurfaceRow | undefined;
    if (!episode) return;
    this.checkpointRow("worker_human_review_episodes", episode, input, {
      projectionKey: workerProjectionKey(episode), laneKey: workerLaneKey(episode),
      workerId: episode.instance_id, workerSessionGeneration: episode.worker_session_generation
    });
  }

  private checkpointRow(table: "primary_human_review_episodes" | "worker_human_review_episodes", episode: HumanReviewSurfaceRow, input: { snapshotRevision: number; messageId: string; cardId: string | null }, route: SurfaceRoute): void {
    this.context.database.prepare(`UPDATE ${table} SET
      message_id = COALESCE(message_id, ?), card_id = COALESCE(?, card_id),
      delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE id = ?`
    ).run(input.messageId, input.cardId, input.snapshotRevision, now(), episode.id);
    const current = table === "primary_human_review_episodes" ? this.loadPrimary(episode.id) : this.loadWorker(episode.id);
    if (current && current.message_id && current.view_version > current.delivered_version) this.reserveUpdate(current, route);
  }

  private reserveUpdate(episode: HumanReviewSurfaceRow, route: SurfaceRoute): void {
    if (!episode.message_id || !episode.card_json || episode.view_version <= episode.delivered_version) return;
    this.enqueueSurface(route, {
      id: randomUUID(), idempotencyKey: `${route.projectionKey}:revision:${episode.view_version}`,
      bindingId: episode.binding_id, bindingGeneration: episode.binding_generation,
      targetRole: "operation_result", rootMessageId: episode.message_id,
      kind: "card_update", payload: episode.card_json, laneKeyOverride: route.laneKey,
      projectionKey: route.projectionKey, snapshotRevision: episode.view_version
    });
  }

  private enqueueSurface(route: SurfaceRoute, input: EnqueueOutboundReplyInput): void {
    if (!input.bindingId || input.bindingGeneration === null || input.bindingGeneration === undefined
      || !this.hasExactActiveBinding(input.bindingId, input.bindingGeneration)) return;
    const routed: EnqueueOutboundReplyInput = route.workerId === undefined || route.workerSessionGeneration === undefined
      ? input
      : { ...input, workerId: route.workerId, workerSessionGeneration: route.workerSessionGeneration };
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Human Review Surface prepared delivery is not connected");
    this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply(routed));
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void { queueMicrotask(() => { for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery); }); }
  private hasExactActiveBinding(id: string, generation: number): boolean { return this.context.database.prepare("SELECT 1 FROM bindings WHERE id=? AND generation=? AND state='active' AND lifecycle='active' AND attachment='attached'").get(id, generation) !== undefined; }

  private loadPrimary(episodeId: string): HumanReviewSurfaceRow | undefined {
    return this.context.database.prepare("SELECT * FROM primary_human_review_episodes WHERE id = ?").get(episodeId) as HumanReviewSurfaceRow | undefined;
  }

  private loadWorker(episodeId: string): WorkerSurfaceRow | undefined {
    return this.context.database.prepare("SELECT * FROM worker_human_review_episodes WHERE id = ?").get(episodeId) as WorkerSurfaceRow | undefined;
  }

  private bindingRootMessageId(bindingId: string): string {
    const row = this.context.database.prepare("SELECT root_message_id FROM bindings WHERE id = ?").get(bindingId) as { root_message_id: string | null } | undefined;
    if (!row?.root_message_id) throw new Error(`Human Review binding route is unavailable: ${bindingId}`);
    return row.root_message_id;
  }
}

function workerProjectionKey(episode: Pick<WorkerSurfaceRow, "id" | "surface_generation">): string {
  return `human-review:worker:${episode.id}:surface:${episode.surface_generation}`;
}

function workerLaneKey(episode: Pick<WorkerSurfaceRow, "instance_id" | "worker_session_generation" | "turn_id">): string {
  return `worker-review:${episode.instance_id}:${episode.worker_session_generation}:${episode.turn_id}`;
}

function surfaceTable(projectionKey: string): "primary_human_review_episodes" | "worker_human_review_episodes" {
  return projectionKey.startsWith("human-review:worker:") ? "worker_human_review_episodes" : "primary_human_review_episodes";
}

function now(): string { return new Date().toISOString(); }
