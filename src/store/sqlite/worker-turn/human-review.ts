import { randomUUID } from "node:crypto";
import type { AgentInstance } from "../../../domain/agent-instance.js";
import type { Binding } from "../../../domain/binding.js";
import type { InstanceTurn } from "../../../domain/instance-turn.js";
import type { OutboxStore } from "../../../domain/ports/outbox.js";
import type {
  WorkerHumanReviewNotificationInput,
  WorkerHumanReviewReservation,
} from "../../../domain/worker-human-review.js";
import { canMentionFeishuOpenId } from "../../../domain/worker-human-review.js";
import { decideWorkerHumanReviewRoute } from "../../../domain/worker-turn-policies.js";
import type { WorkerTurnCardView } from "../../../domain/worker-turn-card-view.js";

export class WorkerHumanReview {
  constructor(
    private readonly dependencies: {
      getAgentInstance(id: string): AgentInstance | null;
      getBinding(id: string): Binding | null;
      enqueueOutboundReply(
        input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & {
          laneKeyOverride?: string;
        },
      ): unknown;
    },
  ) {}

  reserve(input: {
    turn: InstanceTurn;
    view: WorkerTurnCardView;
    eventId: number;
    render(notification: WorkerHumanReviewNotificationInput): object;
  }): WorkerHumanReviewReservation {
    const instance = this.dependencies.getAgentInstance(input.turn.instanceId);
    const parent = instance?.parent;
    const binding = parent
      ? this.dependencies.getBinding(parent.bindingId)
      : null;
    if (
      decideWorkerHumanReviewRoute({
        instance,
        binding,
        turn: input.turn,
        view: input.view,
      }) === "stale" ||
      !instance ||
      !parent ||
      !binding?.rootMessageId ||
      !instance.runtimeRef
    ) {
      return { outcome: "skipped", reason: "stale-routing" };
    }
    const mention = canMentionFeishuOpenId(binding.creatorOpenId)
      ? ("included" as const)
      : ("omitted" as const);
    const card = input.render({
      workerId: instance.id,
      workerSessionGeneration: instance.workerSessionGeneration,
      workerName: instance.name,
      turnId: input.turn.id,
      taskTitle: input.turn.text,
      primaryName: binding.title,
      parentPaneId: parent.paneId,
      parentPaneToken: binding.paneToken,
      workerPaneId: instance.runtimeRef.paneId,
      workerPaneToken: instance.runtimeRef.paneToken ?? null,
      notice: input.view.notice ?? "Worker 正在等待本地处理。",
      creatorOpenId: binding.creatorOpenId,
      workerMainMessageId: input.view.workerMain.messageId,
    });
    this.dependencies.enqueueOutboundReply({
      id: randomUUID(),
      idempotencyKey: `worker-review:${instance.id}:${instance.workerSessionGeneration}:${input.turn.id}:${input.eventId}`,
      bindingId: binding.id,
      targetRole: "operation_result",
      rootMessageId: binding.rootMessageId,
      kind: "card_reply",
      payload: JSON.stringify(card),
    });
    return { outcome: "reserved", mention, eventId: input.eventId };
  }
}
