import type { Logger } from "pino";
import type { LarkPort } from "../domain/ports/external.js";
import type { OutboxStore } from "../domain/ports/outbox.js";
import type { OutboundReply } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { classifyDeliveryError } from "./delivery-error-classifier.js";
import { materializeOutboundReply } from "./outbound-intent-materializer.js";
import type { PromptWorkScheduler } from "./prompt-work-scheduler.js";
import { assertAnswerCardCreateTarget, assertAnswerCardTarget, assertAnswerMessageTarget, assertAnswerStreamTarget, assertWorkerCardCreateTarget, assertWorkerCardTarget, assertWorkerMainCreateTarget, assertWorkerMainMessageTarget, assertWorkerMessageTarget, assertWorkerProgressTarget } from "./outbound-target-validation.js";

export type OutboundDeliveryOutcome = "delivered" | "failed";
type AnswerCheckpoint = (promptId: string, viewVersion: number) => void;
type WorkerTurnCheckpoint = (turnId: string, viewVersion: number) => void;
type WorkerMainCheckpoint = (workerId: string, workerSessionGeneration: number, viewVersion: number) => void;
type MainCardCheckpoint = (bindingId: string, viewVersion: number) => void;

/** Executes one durable outbox intent. Scheduling and retry timing stay outside this module. */
export class OutboundDeliveryExecutor {
  private readonly answerCheckpoints = new Set<AnswerCheckpoint>();
  private readonly workerTurnCheckpoints = new Set<WorkerTurnCheckpoint>();
  private readonly workerMainCheckpoints = new Set<WorkerMainCheckpoint>();
  private readonly mainCardCheckpoints = new Set<MainCardCheckpoint>();
  private scheduler: PromptWorkScheduler | null = null;

  constructor(private readonly store: OutboxStore, private readonly lark: LarkPort, private readonly logger: Logger) {}

  onAnswerCheckpoint(listener: AnswerCheckpoint): () => void { return subscribe(this.answerCheckpoints, listener); }
  onWorkerTurnCheckpoint(listener: WorkerTurnCheckpoint): () => void { return subscribe(this.workerTurnCheckpoints, listener); }
  onWorkerMainCheckpoint(listener: WorkerMainCheckpoint): () => void { return subscribe(this.workerMainCheckpoints, listener); }
  onMainCardCheckpoint(listener: MainCardCheckpoint): () => void { return subscribe(this.mainCardCheckpoints, listener); }
  connectPromptScheduler(scheduler: PromptWorkScheduler): void { this.scheduler = scheduler; }

  async deliver(reply: OutboundReply): Promise<OutboundDeliveryOutcome> {
    try {
      const materializedPayload = materializeOutboundReply(reply);
      if ((reply.kind === "stream_content" || reply.kind === "stream_finish") && this.store.dismissSupersededAnswerStream(reply.id)) {
        this.logger.info({ event: "lark-outbox-answer-stream-dismissed", replyId: reply.id, bindingId: reply.bindingId, promptId: reply.promptId, replyKind: reply.kind, outcome: "dismissed" }, "dismissed an Answer stream event superseded by a continuation page");
        return "delivered";
      }
      if (reply.kind === "card_update") await this.deliverCardUpdate(reply, materializedPayload);
      else if (reply.kind === "stream_card_create") await this.deliverStreamCardCreate(reply, materializedPayload);
      else if (reply.kind === "stream_content") await this.deliverStreamContent(reply, materializedPayload);
      else if (reply.kind === "stream_finish") await this.deliverStreamFinish(reply, materializedPayload);
      else await this.deliverReply(reply, materializedPayload);
      return "delivered";
    } catch (error) {
      return this.fail(reply, error);
    }
  }

  private async deliverCardUpdate(reply: OutboundReply, payload: string): Promise<void> {
    if (reply.cardRole === "answer") assertAnswerMessageTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId);
    if (reply.workerTurnId) assertWorkerMessageTarget(this.store, reply.workerTurnId, reply.rootMessageId);
    if (reply.workerId && reply.workerSessionGeneration !== null) assertWorkerMainMessageTarget(this.store, reply.workerId, reply.workerSessionGeneration, reply.rootMessageId);
    const card = JSON.parse(payload) as object;
    if (reply.targetRole === "session_status" && this.lark.updateCardKit) await this.lark.updateCardKit(reply.rootMessageId, card, reply.cardSequence ?? 1);
    else await this.lark.updateCard(reply.rootMessageId, card);
    this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
    if (reply.workerTurnId) this.notify("worker-turn", this.workerTurnCheckpoints, (listener) => listener(reply.workerTurnId!, reply.viewVersion ?? 0), reply);
    if (reply.workerId && reply.workerSessionGeneration !== null) this.notify("worker-main", this.workerMainCheckpoints, (listener) => listener(reply.workerId!, reply.workerSessionGeneration!, reply.viewVersion ?? 0), reply);
    if (reply.bindingId && reply.targetRole === "session_status") this.notify("main-card", this.mainCardCheckpoints, (listener) => listener(reply.bindingId!, reply.viewVersion ?? 0), reply);
  }

  private async deliverStreamCardCreate(reply: OutboundReply, payload: string): Promise<void> {
    const decoded = decodeStreamingCardPayload(payload);
    if (reply.workerTurnId) assertWorkerCardCreateTarget(this.store, reply.workerTurnId, reply.rootMessageId, decoded.card, decoded.stream);
    else assertAnswerCardCreateTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId, decoded.card, decoded.stream);
    let sent: { messageId: string; cardId?: string };
    if (this.lark.createStreamingCard && this.lark.replyStreamingCardReference) {
      const cardId = reply.cardIdCheckpoint ?? (await this.lark.createStreamingCard(decoded.card)).cardId;
      if (!reply.cardIdCheckpoint) this.store.checkpointOutboundReplyCard(reply.id, cardId);
      sent = { ...(await this.lark.replyStreamingCardReference(reply.rootMessageId, cardId, reply.idempotencyKey)), cardId };
    } else if (this.lark.replyStreamingCard) sent = await this.lark.replyStreamingCard(reply.rootMessageId, decoded.card);
    else sent = await this.lark.replyCard(reply.rootMessageId, decoded.card, reply.idempotencyKey);
    this.store.markOutboundReplyDelivered(reply.id, sent.messageId, sent.cardId);
    this.runPostDelivery("bridge-message", reply, () => this.store.recordBridgeMessage(sent.messageId));
    if (reply.bindingId && reply.promptId && this.store.getPrompt(reply.promptId)) this.runPostDelivery("prompt-wakeup", reply, () => this.scheduler?.wake({ kind: "prompt-ready", bindingId: reply.bindingId! }));
    if (reply.promptId && decoded.stream) this.notify("answer", this.answerCheckpoints, (listener) => listener(reply.promptId!, (reply.viewVersion ?? 0) + 1), reply);
    if (reply.workerTurnId && decoded.stream) this.notify("worker-turn", this.workerTurnCheckpoints, (listener) => listener(reply.workerTurnId!, (reply.viewVersion ?? 0) + 1), reply);
  }

  private async deliverStreamContent(reply: OutboundReply, materializedPayload: string): Promise<void> {
    if (!this.lark.streamCardContent) throw new Error("Lark adapter does not support CardKit content streaming");
    const payload = JSON.parse(materializedPayload) as { elementId: string; content: string; sequence: number; pageIndex: number; workerElement?: "progress" };
    if (reply.workerTurnId) {
      if (payload.workerElement === "progress") assertWorkerProgressTarget(this.store, reply.workerTurnId, reply.rootMessageId, payload.elementId, payload.pageIndex);
      else assertWorkerCardTarget(this.store, reply.workerTurnId, reply.rootMessageId, payload.elementId);
    } else assertAnswerStreamTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId, payload.elementId);
    if (payload.content) await this.lark.streamCardContent(reply.rootMessageId, payload.elementId, payload.content, payload.sequence);
    else this.logger.info({ event: "lark-outbox-empty-answer-content-skipped", replyId: reply.id, bindingId: reply.bindingId, promptId: reply.promptId, sequence: payload.sequence, outcome: "checkpointed" }, "checkpointed an empty legacy Answer update without sending it to Lark");
    this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
    if (reply.promptId) this.notify("answer", this.answerCheckpoints, (listener) => listener(reply.promptId!, reply.viewVersion ?? 0), reply);
    if (reply.workerTurnId) this.notify("worker-turn", this.workerTurnCheckpoints, (listener) => listener(reply.workerTurnId!, reply.viewVersion ?? 0), reply);
  }

  private async deliverStreamFinish(reply: OutboundReply, materializedPayload: string): Promise<void> {
    if (!this.lark.finishStreamingCard) throw new Error("Lark adapter does not support CardKit stream finalization");
    const payload = JSON.parse(materializedPayload) as { summary: string; sequence: number };
    if (reply.workerTurnId) assertWorkerCardTarget(this.store, reply.workerTurnId, reply.rootMessageId);
    else assertAnswerCardTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId);
    await this.lark.finishStreamingCard(reply.rootMessageId, payload.sequence, payload.summary);
    this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
    if (reply.promptId) this.notify("answer", this.answerCheckpoints, (listener) => listener(reply.promptId!, reply.viewVersion ?? 0), reply);
    if (reply.workerTurnId) this.notify("worker-turn", this.workerTurnCheckpoints, (listener) => listener(reply.workerTurnId!, reply.viewVersion ?? 0), reply);
  }

  private async deliverReply(reply: OutboundReply, payload: string): Promise<void> {
    if (reply.kind === "card_reply" && reply.workerId && reply.workerSessionGeneration !== null) assertWorkerMainCreateTarget(this.store, reply.workerId, reply.workerSessionGeneration, reply.rootMessageId);
    const sent = reply.kind === "text" ? await this.lark.replyText(reply.rootMessageId, payload, reply.idempotencyKey) : await this.lark.replyCard(reply.rootMessageId, JSON.parse(payload) as object, reply.idempotencyKey);
    const cardId = "cardId" in sent && typeof sent.cardId === "string" ? sent.cardId : undefined;
    this.store.markOutboundReplyDelivered(reply.id, sent.messageId, cardId);
    this.runPostDelivery("bridge-message", reply, () => this.store.recordBridgeMessage(sent.messageId));
    if (reply.workerId && reply.workerSessionGeneration !== null) this.notify("worker-main", this.workerMainCheckpoints, (listener) => listener(reply.workerId!, reply.workerSessionGeneration!, reply.viewVersion ?? 0), reply);
    if (reply.bindingId && reply.targetRole === "session_status") this.notify("main-card", this.mainCardCheckpoints, (listener) => listener(reply.bindingId!, reply.viewVersion ?? 0), reply);
  }

  private fail(reply: OutboundReply, error: unknown): OutboundDeliveryOutcome {
    const classified = classifyDeliveryError(error);
    const metadata = { failureClass: classified.failureClass, httpStatus: classified.httpStatus, larkErrorCode: classified.larkErrorCode, ...(classified.recoveryKind === undefined ? {} : { recoveryKind: classified.recoveryKind }) };
    const transition = this.store.markOutboundReplyFailedWithQuarantine(reply.id, classified.message, metadata, classified.retryDelayMs);
    const failed = transition?.reply ?? null;
    const context = { event: failed?.state === "dead_letter" ? "lark-outbox-dead-lettered" : "lark-outbox-retry-scheduled", err: safeLogError(error), replyId: reply.id, replyKind: reply.kind, bindingId: reply.bindingId, promptId: reply.promptId, attempt: failed?.attemptCount ?? reply.attemptCount + 1, nextAttemptAt: failed?.nextAttemptAt, failureClass: classified.failureClass, httpStatus: classified.httpStatus, larkErrorCode: classified.larkErrorCode, autoRecoveryCount: failed?.autoRecoveryCount ?? reply.autoRecoveryCount, laneClass: transition?.laneClass, quarantineAction: transition?.action, outcome: failed?.state === "dead_letter" ? "dead_letter" : "retry" };
    if (failed?.state === "dead_letter") this.logger.error(context, classified.failureClass === "permanent" ? "Lark outbox reply rejected by durable target validation" : "Lark outbox reply exhausted retries");
    else this.logger.warn(context, "Lark outbox reply delivery failed; retry scheduled");
    if (transition?.action === "rebuild_answer" && transition.promptId) this.notify("answer", this.answerCheckpoints, (listener) => listener(transition.promptId!, failed?.viewVersion ?? 0), reply);
    return "failed";
  }

  private notify<Listener>(name: string, listeners: ReadonlySet<Listener>, invoke: (listener: Listener) => void, reply: OutboundReply): void {
    for (const listener of listeners) this.runPostDelivery(name, reply, () => invoke(listener));
  }

  private runPostDelivery(name: string, reply: OutboundReply, operation: () => void): void {
    try { operation(); } catch (error) {
      this.logger.error({ event: "lark-outbox-checkpoint-listener-failed", err: safeLogError(error), subscriber: name, replyId: reply.id, replyKind: reply.kind, bindingId: reply.bindingId, promptId: reply.promptId, outcome: "isolated" }, "post-delivery convergence hook failed; durable delivery remains authoritative");
    }
  }
}

function subscribe<Listener>(listeners: Set<Listener>, listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); }

function decodeStreamingCardPayload(payload: string): { card: object; stream?: { pageIndex: number; pageStart: number; elementId: string; deliveryMode?: "static" } } {
  const decoded = JSON.parse(payload) as object & { card?: object; stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown; deliveryMode?: unknown } };
  if (!decoded.card || !decoded.stream) return { card: decoded };
  const stream = { pageIndex: typeof decoded.stream.pageIndex === "number" ? decoded.stream.pageIndex : -1, pageStart: typeof decoded.stream.pageStart === "number" ? decoded.stream.pageStart : -1, elementId: typeof decoded.stream.elementId === "string" ? decoded.stream.elementId : "" };
  return decoded.stream.deliveryMode === "static" ? { card: decoded.card, stream: { ...stream, deliveryMode: "static" } } : { card: decoded.card, stream };
}
