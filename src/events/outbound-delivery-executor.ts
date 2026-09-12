import type { OutboundDeliveryClaim } from "../domain/delivery.js";
import type { Logger } from "pino";
import type { LarkPort } from "../domain/ports/external.js";
import type { OutboxStore } from "../domain/ports/outbox.js";
import type { OutboundReply } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { classifyDeliveryError } from "./delivery-error-classifier.js";
import { materializeOutboundReply } from "./outbound-intent-materializer.js";
import type { PromptWorkScheduler } from "./prompt-work-scheduler.js";
import { assertAnswerCardCreateTarget, assertAnswerCardTarget, assertAnswerMessageTarget, assertAnswerStreamTarget, assertWorkerCardCreateTarget, assertWorkerCardTarget, assertWorkerMainCreateTarget, assertWorkerMainMessageTarget, assertWorkerMessageTarget, assertWorkerProgressTarget, PermanentDeliveryError } from "./outbound-target-validation.js";

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

  async deliver(candidate: OutboundReply, dueAt: string | null): Promise<OutboundDeliveryOutcome> {
    if ((candidate.kind === "stream_content" || candidate.kind === "stream_finish") && this.store.dismissSupersededAnswerStream(candidate.id)) return "delivered";
    const claim = this.store.claimOutboundReply(candidate.id, dueAt);
    if (!claim) return "failed";
    const reply = claim.reply;
    try {
      const materializedPayload = materializeOutboundReply(reply);
      if (reply.kind === "group_card_create") await this.deliverGroupCardCreate(claim, materializedPayload);
      else if (reply.kind === "card_update") await this.deliverCardUpdate(claim, materializedPayload);
      else if (reply.kind === "stream_card_create") await this.deliverStreamCardCreate(claim, materializedPayload);
      else if (reply.kind === "stream_content") await this.deliverStreamContent(claim, materializedPayload);
      else if (reply.kind === "stream_finish") await this.deliverStreamFinish(claim, materializedPayload);
      else await this.deliverReply(claim, materializedPayload);
      return "delivered";
    } catch (error) {
      if (error instanceof DeliveryCheckpointError) {
        this.logger.error({ event: "lark-outbox-checkpoint-uncertain", replyId: reply.id, attemptId: claim.attemptId, outcome: "uncertain" }, "external delivery completed but its checkpoint could not be confirmed");
        throw error;
      }
      return this.fail(claim, error);
    }
  }

  private async deliverGroupCardCreate(claim: OutboundDeliveryClaim, payload: string): Promise<void> {
    const reply = claim.reply;
    if (!reply.targetChatId || (reply.threadAliasId === null) === (reply.workerThreadId === null)) throw new PermanentDeliveryError("Group card target is incomplete");
    const sent = await this.lark.createTopic(parseDeliveryObject(payload), reply.idempotencyKey, reply.targetChatId);
    this.checkpoint(() => this.store.markOutboundReplyDelivered(claim, sent.rootMessageId, undefined, sent.topicId));
    if (reply.workerThreadId && reply.workerId && reply.workerSessionGeneration !== null && reply.viewVersion !== null) this.notify("worker-main", this.workerMainCheckpoints, (listener) => listener(reply.workerId!, reply.workerSessionGeneration!, reply.viewVersion!), reply);
  }

  private async deliverCardUpdate(claim: OutboundDeliveryClaim, payload: string): Promise<void> {
    const reply = claim.reply;
    const rootMessageId = requireRootMessageId(reply);
    if (reply.cardRole === "answer") assertAnswerMessageTarget(this.store, reply.bindingId, reply.promptId, rootMessageId);
    if (reply.workerTurnId) assertWorkerMessageTarget(this.store, reply.workerTurnId, rootMessageId);
    if (reply.workerId && reply.workerSessionGeneration !== null) assertWorkerMainMessageTarget(this.store, reply.workerId, reply.workerSessionGeneration, rootMessageId);
    const card = parseDeliveryObject(payload);
    if (reply.targetRole === "session_status" && this.lark.updateCardKit) await this.lark.updateCardKit(rootMessageId, card, reply.cardSequence ?? 1);
    else await this.lark.updateCard(rootMessageId, card);
    this.checkpoint(() => this.store.markOutboundReplyDelivered(claim, rootMessageId));
    if (reply.workerTurnId) this.notify("worker-turn", this.workerTurnCheckpoints, (listener) => listener(reply.workerTurnId!, reply.viewVersion ?? 0), reply);
    if (reply.workerId && reply.workerSessionGeneration !== null) this.notify("worker-main", this.workerMainCheckpoints, (listener) => listener(reply.workerId!, reply.workerSessionGeneration!, reply.viewVersion ?? 0), reply);
    if (reply.bindingId && reply.targetRole === "session_status") this.notify("main-card", this.mainCardCheckpoints, (listener) => listener(reply.bindingId!, reply.viewVersion ?? 0), reply);
  }

  private async deliverStreamCardCreate(claim: OutboundDeliveryClaim, payload: string): Promise<void> {
    const reply = claim.reply;
    const rootMessageId = requireRootMessageId(reply);
    const decoded = decodeStreamingCardPayload(payload);
    if (reply.workerTurnId) assertWorkerCardCreateTarget(this.store, reply.workerTurnId, rootMessageId, decoded.card, decoded.stream);
    else assertAnswerCardCreateTarget(this.store, reply.bindingId, reply.promptId, rootMessageId, decoded.card, decoded.stream);
    let sent: { messageId: string; cardId?: string };
    if (this.lark.createStreamingCard && this.lark.replyStreamingCardReference) {
      const cardId = reply.cardIdCheckpoint ?? (await this.lark.createStreamingCard(decoded.card)).cardId;
      this.checkpoint(() => this.store.checkpointOutboundReplyCard(claim, cardId) !== null);
      sent = { ...(await this.lark.replyStreamingCardReference(rootMessageId, cardId, reply.idempotencyKey)), cardId };
    } else if (this.lark.replyStreamingCard) sent = await this.lark.replyStreamingCard(rootMessageId, decoded.card);
    else sent = await this.lark.replyCard(rootMessageId, decoded.card, reply.idempotencyKey);
    this.checkpoint(() => this.store.markOutboundReplyDelivered(claim, sent.messageId, sent.cardId));
    this.runPostDelivery("bridge-message", reply, () => this.store.recordBridgeMessage(sent.messageId));
    if (reply.bindingId && reply.promptId && this.store.getPrompt(reply.promptId)) this.runPostDelivery("prompt-wakeup", reply, () => this.scheduler?.wake({ kind: "prompt-ready", bindingId: reply.bindingId! }));
    if (reply.promptId && decoded.stream) this.notify("answer", this.answerCheckpoints, (listener) => listener(reply.promptId!, (reply.viewVersion ?? 0) + 1), reply);
    if (reply.workerTurnId && decoded.stream) this.notify("worker-turn", this.workerTurnCheckpoints, (listener) => listener(reply.workerTurnId!, (reply.viewVersion ?? 0) + 1), reply);
  }

  private async deliverStreamContent(claim: OutboundDeliveryClaim, materializedPayload: string): Promise<void> {
    const reply = claim.reply;
    const rootMessageId = requireRootMessageId(reply);
    if (!this.lark.streamCardContent) throw new PermanentDeliveryError("Lark adapter does not support CardKit content streaming");
    const payload = parseDeliveryObject(materializedPayload) as unknown as { elementId: string; content: string; sequence: number; pageIndex: number; workerElement?: "progress" };
    if (reply.workerTurnId) {
      if (payload.workerElement === "progress") assertWorkerProgressTarget(this.store, reply.workerTurnId, rootMessageId, payload.elementId, payload.pageIndex);
      else assertWorkerCardTarget(this.store, reply.workerTurnId, rootMessageId, payload.elementId);
    } else assertAnswerStreamTarget(this.store, reply.bindingId, reply.promptId, rootMessageId, payload.elementId);
    if (payload.content) await this.lark.streamCardContent(rootMessageId, payload.elementId, payload.content, payload.sequence);
    else this.logger.info({ event: "lark-outbox-empty-answer-content-skipped", replyId: reply.id, bindingId: reply.bindingId, promptId: reply.promptId, sequence: payload.sequence, outcome: "checkpointed" }, "checkpointed an empty legacy Answer update without sending it to Lark");
    this.checkpoint(() => this.store.markOutboundReplyDelivered(claim, rootMessageId));
    if (reply.promptId) this.notify("answer", this.answerCheckpoints, (listener) => listener(reply.promptId!, reply.viewVersion ?? 0), reply);
    if (reply.workerTurnId) this.notify("worker-turn", this.workerTurnCheckpoints, (listener) => listener(reply.workerTurnId!, reply.viewVersion ?? 0), reply);
  }

  private async deliverStreamFinish(claim: OutboundDeliveryClaim, materializedPayload: string): Promise<void> {
    const reply = claim.reply;
    const rootMessageId = requireRootMessageId(reply);
    if (!this.lark.finishStreamingCard) throw new PermanentDeliveryError("Lark adapter does not support CardKit stream finalization");
    const payload = parseDeliveryObject(materializedPayload) as unknown as { summary: string; sequence: number };
    if (reply.workerTurnId) assertWorkerCardTarget(this.store, reply.workerTurnId, rootMessageId);
    else assertAnswerCardTarget(this.store, reply.bindingId, reply.promptId, rootMessageId);
    await this.lark.finishStreamingCard(rootMessageId, payload.sequence, payload.summary);
    this.checkpoint(() => this.store.markOutboundReplyDelivered(claim, rootMessageId));
    if (reply.promptId) this.notify("answer", this.answerCheckpoints, (listener) => listener(reply.promptId!, reply.viewVersion ?? 0), reply);
    if (reply.workerTurnId) this.notify("worker-turn", this.workerTurnCheckpoints, (listener) => listener(reply.workerTurnId!, reply.viewVersion ?? 0), reply);
  }

  private async deliverReply(claim: OutboundDeliveryClaim, payload: string): Promise<void> {
    const reply = claim.reply;
    const rootMessageId = requireRootMessageId(reply);
    if (reply.kind === "card_reply" && reply.workerId && reply.workerSessionGeneration !== null) assertWorkerMainCreateTarget(this.store, reply.workerId, reply.workerSessionGeneration, rootMessageId);
    const sent = reply.kind === "text" ? await this.lark.replyText(rootMessageId, payload, reply.idempotencyKey) : await this.lark.replyCard(rootMessageId, parseDeliveryObject(payload), reply.idempotencyKey);
    const cardId = "cardId" in sent && typeof sent.cardId === "string" ? sent.cardId : undefined;
    this.checkpoint(() => this.store.markOutboundReplyDelivered(claim, sent.messageId, cardId));
    this.runPostDelivery("bridge-message", reply, () => this.store.recordBridgeMessage(sent.messageId));
    if (reply.workerId && reply.workerSessionGeneration !== null) this.notify("worker-main", this.workerMainCheckpoints, (listener) => listener(reply.workerId!, reply.workerSessionGeneration!, reply.viewVersion ?? 0), reply);
    if (reply.bindingId && reply.targetRole === "session_status") this.notify("main-card", this.mainCardCheckpoints, (listener) => listener(reply.bindingId!, reply.viewVersion ?? 0), reply);
  }

  private checkpoint(operation: () => boolean): void {
    try {
      if (!operation()) throw new Error("stale_outbound_receipt");
    } catch { throw new DeliveryCheckpointError("outbound_checkpoint_uncertain"); }
  }

  private fail(claim: OutboundDeliveryClaim, error: unknown): OutboundDeliveryOutcome {
    const reply = claim.reply;
    const classified = classifyDeliveryError(error);
    const metadata = { failureClass: classified.failureClass, effectCertainty: classified.effectCertainty, httpStatus: classified.httpStatus, larkErrorCode: classified.larkErrorCode, ...(classified.recoveryKind === undefined ? {} : { recoveryKind: classified.recoveryKind }) };
    const transition = this.store.markOutboundReplyFailedWithQuarantine(claim, classified.message, metadata, classified.retryDelayMs);
    if (!transition) {
      this.logger.warn({ event: "lark-outbox-stale-receipt", replyId: reply.id, attemptId: claim.attemptId, outcome: "ignored" }, "ignored a stale delivery receipt");
      return "failed";
    }
    const failed = transition?.reply ?? null;
    const context = { event: failed?.state === "dead_letter" ? "lark-outbox-dead-lettered" : "lark-outbox-retry-scheduled", err: safeLogError(error), replyId: reply.id, replyKind: reply.kind, bindingId: reply.bindingId, promptId: reply.promptId, attempt: failed?.attemptCount ?? reply.attemptCount + 1, nextAttemptAt: failed?.nextAttemptAt, failureClass: classified.failureClass, effectCertainty: classified.effectCertainty, httpStatus: classified.httpStatus, larkErrorCode: classified.larkErrorCode, autoRecoveryCount: failed?.autoRecoveryCount ?? reply.autoRecoveryCount, laneClass: transition?.laneClass, quarantineAction: transition?.action, outcome: failed?.state === "dead_letter" ? "dead_letter" : "retry" };
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

class DeliveryCheckpointError extends Error {}

function subscribe<Listener>(listeners: Set<Listener>, listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); }

function decodeStreamingCardPayload(payload: string): { card: object; stream?: { pageIndex: number; pageStart: number; elementId: string; deliveryMode?: "static" } } {
  const decoded = parseDeliveryObject(payload) as object & { card?: object; stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown; deliveryMode?: unknown } };
  if (!decoded.card || !decoded.stream) return { card: decoded };
  const stream = { pageIndex: typeof decoded.stream.pageIndex === "number" ? decoded.stream.pageIndex : -1, pageStart: typeof decoded.stream.pageStart === "number" ? decoded.stream.pageStart : -1, elementId: typeof decoded.stream.elementId === "string" ? decoded.stream.elementId : "" };
  return decoded.stream.deliveryMode === "static" ? { card: decoded.card, stream: { ...stream, deliveryMode: "static" } } : { card: decoded.card, stream };
}
function requireRootMessageId(reply: OutboundReply): string { if (!reply.rootMessageId) throw new PermanentDeliveryError(`Outbound reply ${reply.id} has no root message target`); return reply.rootMessageId; }
function parseDeliveryObject(payload: string): object {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch { throw new PermanentDeliveryError("Durable delivery payload is not a JSON object"); }
}
