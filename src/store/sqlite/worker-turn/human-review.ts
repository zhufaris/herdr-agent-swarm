import { randomUUID } from "node:crypto";
import type { AgentInstance } from "../../../domain/agent-instance.js";
import type { Binding } from "../../../domain/binding.js";
import type { InstanceTurn, InstanceTurnState } from "../../../domain/instance-turn.js";
import type { WorkerHumanReviewNotificationInput, WorkerHumanReviewReservation } from "../../../domain/worker-human-review.js";
import { canMentionFeishuOpenId } from "../../../domain/worker-human-review.js";
import { decideWorkerHumanReviewRoute } from "../../../domain/worker-turn-policies.js";
import type { WorkerTurnCardView } from "../../../domain/worker-turn-card-view.js";
import type { SqliteContext } from "../context.js";
import { SqliteHumanReviewCandidateStore } from "../human-review-candidate-store.js";
import { SqliteHumanReviewSurfaceStore } from "../human-review-surface-store.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReservation } from "../../../domain/ports/outbox.js";

interface OpenWorkerEpisode {
  id: string;
  notice: string;
  view_version: number;
  message_id: string | null;
}

export class WorkerHumanReview {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getAgentInstance(id: string): AgentInstance | null;
      getBinding(id: string): Binding | null;
    },
  ) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  project(input: {
    turn: InstanceTurn;
    view: WorkerTurnCardView;
    state: InstanceTurnState;
    eventId: number | null;
    render(notification: WorkerHumanReviewNotificationInput): object;
  }): WorkerHumanReviewReservation {
    const instance = this.dependencies.getAgentInstance(input.turn.instanceId);
    const parent = instance?.parent;
    const binding = parent ? this.dependencies.getBinding(parent.bindingId) : null;
    if (
      decideWorkerHumanReviewRoute({ instance, binding, turn: input.turn, view: input.view }) === "stale" ||
      !instance || !parent || !binding?.rootMessageId || !instance.runtimeRef
    ) return { outcome: "skipped", reason: "stale-routing" };

    const open = this.context.database.prepare(`SELECT id, notice, view_version, message_id
      FROM worker_human_review_episodes WHERE turn_id = ? AND instance_generation = ? AND state = 'open'
      ORDER BY requested_at DESC, id DESC LIMIT 1`
    ).get(input.turn.id, input.turn.instanceGeneration) as OpenWorkerEpisode | undefined;
    const candidates = new SqliteHumanReviewCandidateStore(this.context);
    const surfaces = new SqliteHumanReviewSurfaceStore(this.context);
    if (this.preparedDeliveryReservation && this.preparedDeliveryConsumer) {
      surfaces.setPreparedDeliveryReservation(this.preparedDeliveryReservation, this.preparedDeliveryConsumer);
    }

    if (input.state === "blocked") {
      if (!open && (input.turn.state === "blocked" || input.eventId === null)) return { outcome: "skipped", reason: "not-blocked-transition" };
      const episodeId = open?.id ?? randomUUID();
      const candidateNotices = instance.runtimeRef.nativeSessionId && input.turn.runtimeTurnId
        ? candidates.absorb({
          owner: { kind: "worker_turn", id: input.turn.id }, ownerGeneration: input.turn.instanceGeneration,
          nativeSessionId: instance.runtimeRef.nativeSessionId, turnId: input.turn.runtimeTurnId,
          episodeId, occurredAt: input.view.updatedAt
        })
        : [];
      if (open) {
        const notice = appendNotices(open.notice, candidateNotices);
        if (notice === open.notice) return { outcome: "skipped", reason: "not-blocked-transition" };
        const revision = open.view_version + 1;
        const createCard = input.render(this.notificationInput(instance, binding, input.turn, input.view, "waiting", notice, binding.creatorOpenId));
        const updateCard = input.render(this.notificationInput(instance, binding, input.turn, input.view, "waiting", notice, null));
        this.context.database.prepare(`UPDATE worker_human_review_episodes SET notice = ?, view_version = ?,
          create_card_json = ?, card_json = ?, updated_at = ? WHERE id = ? AND state = 'open'`
        ).run(notice, revision, JSON.stringify(createCard), JSON.stringify(updateCard), input.view.updatedAt, open.id);
        surfaces.reserveWorker({ episodeId: open.id, rootMessageId: binding.rootMessageId, createCard });
        return { outcome: "reserved", kind: "updated", mention: open.message_id ? "omitted" : canMentionFeishuOpenId(binding.creatorOpenId) ? "included" : "omitted", eventId: input.eventId, episodeId: open.id };
      }
      const notice = appendNotices(input.view.notice ?? "Worker 正在等待本地处理。", candidateNotices);
      const mention = canMentionFeishuOpenId(binding.creatorOpenId) ? "included" as const : "omitted" as const;
      const createCard = input.render(this.notificationInput(instance, binding, input.turn, input.view, "waiting", notice, binding.creatorOpenId));
      const updateCard = input.render(this.notificationInput(instance, binding, input.turn, input.view, "waiting", notice, null));
      this.context.database.prepare(`INSERT INTO worker_human_review_episodes(
        id, turn_id, instance_id, instance_generation, worker_session_generation, binding_id, binding_generation,
        state, notice, requested_at, resolved_at, surface_generation, view_version, delivered_version,
        create_reply_id, message_id, card_id, create_card_json, card_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, 1, 1, 0, NULL, NULL, NULL, ?, ?, ?)`
      ).run(episodeId, input.turn.id, instance.id, input.turn.instanceGeneration, instance.workerSessionGeneration,
        binding.id, binding.generation, notice, input.view.updatedAt, JSON.stringify(createCard), JSON.stringify(updateCard), input.view.updatedAt);
      surfaces.reserveWorker({ episodeId, rootMessageId: binding.rootMessageId, createCard });
      return { outcome: "reserved", kind: "requested", mention, eventId: input.eventId, episodeId };
    }

    if (!open) return { outcome: "skipped", reason: "not-blocked-transition" };
    const notice = `Worker 已离开等待状态，当前状态：${input.state}。`;
    const card = input.render(this.notificationInput(instance, binding, input.turn, input.view, "resolved", notice, null));
    const revision = open.view_version + 1;
    const resolved = this.context.database.prepare(`UPDATE worker_human_review_episodes SET state = 'resolved', notice = ?,
      resolved_at = ?, view_version = ?, card_json = ?, updated_at = ? WHERE id = ? AND state = 'open'`
    ).run(notice, input.view.updatedAt, revision, JSON.stringify(card), input.view.updatedAt, open.id);
    if (Number(resolved.changes) !== 1) return { outcome: "skipped", reason: "not-blocked-transition" };
    surfaces.reserveWorker({ episodeId: open.id, rootMessageId: binding.rootMessageId, createCard: card });
    return { outcome: "reserved", kind: "resolved", mention: "omitted", eventId: input.eventId, episodeId: open.id };
  }

  private notificationInput(instance: AgentInstance, binding: Binding, turn: InstanceTurn, view: WorkerTurnCardView, state: "waiting" | "resolved", notice: string, creatorOpenId: string | null): WorkerHumanReviewNotificationInput {
    const parent = instance.parent!;
    const runtime = instance.runtimeRef!;
    return {
      state, workerId: instance.id, workerSessionGeneration: instance.workerSessionGeneration,
      workerName: instance.name, turnId: turn.id, taskTitle: turn.text, primaryName: binding.title,
      parentPaneId: parent.paneId, parentPaneToken: binding.paneToken,
      workerPaneId: runtime.paneId, workerPaneToken: runtime.paneToken ?? null,
      notice, creatorOpenId, workerMainMessageId: view.workerMain.messageId
    };
  }
}

function appendNotices(current: string, additions: readonly string[]): string {
  const parts = current.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  for (const addition of additions.map((value) => value.trim()).filter(Boolean)) if (!parts.includes(addition)) parts.push(addition);
  return [...parts.join("\n\n")].slice(0, 4_000).join("");
}
