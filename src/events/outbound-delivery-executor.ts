import type { Logger } from "pino";
import type { OutboundDeliveryClaim } from "../domain/delivery.js";
import type { OutboxStore } from "../domain/ports/outbox.js";
import type { OutboundReply } from "../domain/types.js";
import { GatewayDeliveryError, type GatewayDeliveryPort, type GatewayDeliveryReceipt, type GatewayExternalRef } from "../gateways/contract/plugin.js";
import { safeLogError } from "../runtime/safe-error.js";
import { prepareOutboundGatewayIntent } from "./outbound-gateway-intent.js";
import { PermanentDeliveryError } from "./outbound-target-validation.js";
import type { PromptWorkScheduler } from "./prompt-work-scheduler.js";

export type OutboundDeliveryOutcome = "delivered" | "failed";
type AnswerCheckpoint = (promptId: string, viewVersion: number) => void;
type WorkerTurnCheckpoint = (turnId: string, viewVersion: number) => void;
type WorkerMainCheckpoint = (workerId: string, workerSessionGeneration: number, viewVersion: number) => void;
type MainCardCheckpoint = (bindingId: string, viewVersion: number) => void;

/** Executes one durable outbox claim through a provider-neutral Gateway port. */
export class OutboundDeliveryExecutor {
  private readonly answerCheckpoints = new Set<AnswerCheckpoint>();
  private readonly workerTurnCheckpoints = new Set<WorkerTurnCheckpoint>();
  private readonly workerMainCheckpoints = new Set<WorkerMainCheckpoint>();
  private readonly mainCardCheckpoints = new Set<MainCardCheckpoint>();
  private scheduler: PromptWorkScheduler | null = null;

  constructor(private readonly store: OutboxStore, private readonly gateway: GatewayDeliveryPort, private readonly logger: Logger) {}

  onAnswerCheckpoint(listener: AnswerCheckpoint): () => void { return subscribe(this.answerCheckpoints, listener); }
  onWorkerTurnCheckpoint(listener: WorkerTurnCheckpoint): () => void { return subscribe(this.workerTurnCheckpoints, listener); }
  onWorkerMainCheckpoint(listener: WorkerMainCheckpoint): () => void { return subscribe(this.workerMainCheckpoints, listener); }
  onMainCardCheckpoint(listener: MainCardCheckpoint): () => void { return subscribe(this.mainCardCheckpoints, listener); }
  connectPromptScheduler(scheduler: PromptWorkScheduler): void { this.scheduler = scheduler; }

  async deliver(candidate: OutboundReply, dueAt: string | null): Promise<OutboundDeliveryOutcome> {
    if ((candidate.kind === "stream_content" || candidate.kind === "stream_finish") && this.store.dismissSupersededAnswerStream(candidate.id)) return "delivered";
    if (candidate.gatewayPlanJson === null) {
      let intent: ReturnType<typeof prepareOutboundGatewayIntent>["intent"];
      try { intent = prepareOutboundGatewayIntent(this.store, candidate).intent; }
      catch (error) {
        if (!(error instanceof PermanentDeliveryError)) throw error;
        this.store.rejectUnclaimedOutboundReply(candidate.id, safeLogError(error).message, { failureClass: "permanent", effectCertainty: "rejected", larkErrorCode: null, httpStatus: null });
        return "failed";
      }
      const plan = this.gateway.prepare(intent);
      this.store.prepareOutboundGatewayPlan(candidate.id, { gatewayId: plan.gatewayId, gatewayProfileId: plan.profileId, gatewayPlanJson: JSON.stringify(plan) });
    }
    const claim = this.store.claimOutboundReply(candidate.id, dueAt);
    if (!claim) return "failed";
    const reply = claim.reply;
    try {
      const prepared = prepareOutboundGatewayIntent(this.store, reply);
      if (prepared.emptyStreamContent) {
        this.logger.info({ event: "gateway-outbox-empty-stream-content-skipped", gatewayId: reply.gatewayId, replyId: reply.id, bindingId: reply.bindingId, promptId: reply.promptId, sequence: reply.viewVersion, outcome: "checkpointed" }, "checkpointed empty Gateway stream content without an external call");
        this.checkpoint(() => this.store.markOutboundReplyDelivered(claim, reply.rootMessageId!));
      } else {
        const plan = decodeGatewayPlan(reply.gatewayPlanJson);
        if (plan.gatewayId !== reply.gatewayId || plan.profileId !== reply.gatewayProfileId) throw new Error(`Gateway plan identity mismatch for reply ${reply.id}`);
        const receipt = await this.gateway.execute(plan, {
          attemptId: claim.attemptId, leaseFencingToken: claim.fencingToken, idempotencyKey: reply.idempotencyKey,
          priorCheckpoints: reply.cardIdCheckpoint ? [{ kind: "surface", ref: { gatewayId: reply.gatewayId, kind: "surface", opaqueId: reply.cardIdCheckpoint } }] : [],
          checkpoint: async (value) => { this.checkpoint(() => this.store.checkpointOutboundReplyCard(claim, value.ref.opaqueId) !== null); }
        });
        this.settle(claim, receipt);
      }
      this.afterDelivery(reply, prepared.streamMetadata);
      return "delivered";
    } catch (error) {
      if (error instanceof DeliveryCheckpointError) {
        this.logger.error({ event: "gateway-outbox-checkpoint-uncertain", gatewayId: reply.gatewayId, replyId: reply.id, attemptId: claim.attemptId, outcome: "uncertain" }, "external delivery completed but its checkpoint could not be confirmed");
        throw error;
      }
      return this.fail(claim, error);
    }
  }

  private settle(claim: OutboundDeliveryClaim, receipt: GatewayDeliveryReceipt): void {
    const reply = claim.reply;
    const messageId = findRef(receipt.refs, "message")?.opaqueId ?? reply.rootMessageId;
    const surfaceId = findRef(receipt.refs, "surface")?.opaqueId;
    const threadId = findRef(receipt.refs, "thread")?.opaqueId;
    if (!messageId) throw new Error(`Gateway delivery returned no message identity for reply ${reply.id}`);
    this.checkpoint(() => this.store.markOutboundReplyDelivered(claim, messageId, surfaceId, threadId));
    if (reply.kind === "card_reply" || reply.kind === "stream_card_create" || reply.kind === "text") this.runPostDelivery("bridge-message", reply, () => this.store.recordBridgeMessage(messageId));
  }

  private afterDelivery(reply: OutboundReply, streamMetadata: boolean): void {
    if (reply.kind === "stream_card_create" && reply.bindingId && reply.promptId && this.store.getPrompt(reply.promptId)) this.runPostDelivery("prompt-wakeup", reply, () => this.scheduler?.wake({ kind: "prompt-ready", bindingId: reply.bindingId! }));
    if (reply.promptId && (reply.kind === "stream_content" || reply.kind === "stream_finish")) this.notify("answer", this.answerCheckpoints, (listener) => listener(reply.promptId!, reply.viewVersion ?? 0), reply);
    if (reply.promptId && reply.kind === "stream_card_create" && streamMetadata) this.notify("answer", this.answerCheckpoints, (listener) => listener(reply.promptId!, (reply.viewVersion ?? 0) + 1), reply);
    if (reply.workerTurnId && (reply.kind === "stream_content" || reply.kind === "stream_finish" || reply.kind === "card_update")) this.notify("worker-turn", this.workerTurnCheckpoints, (listener) => listener(reply.workerTurnId!, reply.viewVersion ?? 0), reply);
    if (reply.workerTurnId && reply.kind === "stream_card_create" && streamMetadata) this.notify("worker-turn", this.workerTurnCheckpoints, (listener) => listener(reply.workerTurnId!, (reply.viewVersion ?? 0) + 1), reply);
    if (reply.workerId && reply.workerSessionGeneration !== null && reply.kind !== "group_card_create") this.notify("worker-main", this.workerMainCheckpoints, (listener) => listener(reply.workerId!, reply.workerSessionGeneration!, reply.viewVersion ?? 0), reply);
    if (reply.workerThreadId && reply.workerId && reply.workerSessionGeneration !== null && reply.kind === "group_card_create" && reply.viewVersion !== null) this.notify("worker-main", this.workerMainCheckpoints, (listener) => listener(reply.workerId!, reply.workerSessionGeneration!, reply.viewVersion!), reply);
    if (reply.bindingId && reply.targetRole === "session_status") this.notify("main-card", this.mainCardCheckpoints, (listener) => listener(reply.bindingId!, reply.viewVersion ?? 0), reply);
  }

  private checkpoint(operation: () => boolean): void {
    try { if (!operation()) throw new Error("stale_outbound_receipt"); }
    catch { throw new DeliveryCheckpointError("outbound_checkpoint_uncertain"); }
  }

  private fail(claim: OutboundDeliveryClaim, error: unknown): OutboundDeliveryOutcome {
    const reply = claim.reply;
    const gatewayFailure = error instanceof GatewayDeliveryError ? error.failure : null;
    const classified = gatewayFailure ?? classifyCoreDeliveryFailure(error);
    const metadata = { failureClass: classified.failureClass, effectCertainty: classified.effectCertainty, httpStatus: classified.httpStatus, larkErrorCode: classified.providerCode, ...(classified.recoveryKind === undefined ? {} : { recoveryKind: classified.recoveryKind }) };
    const transition = this.store.markOutboundReplyFailedWithQuarantine(claim, classified.safeMessage, metadata, classified.retryAfterMs);
    if (!transition) { this.logger.warn({ event: "gateway-outbox-stale-receipt", gatewayId: reply.gatewayId, replyId: reply.id, attemptId: claim.attemptId, outcome: "ignored" }, "ignored a stale Gateway delivery receipt"); return "failed"; }
    const failed = transition.reply;
    const context = { event: failed.state === "dead_letter" ? "gateway-outbox-dead-lettered" : "gateway-outbox-retry-scheduled", err: safeLogError(error instanceof GatewayDeliveryError ? error.cause ?? error : error), gatewayId: reply.gatewayId, replyId: reply.id, replyKind: reply.kind, bindingId: reply.bindingId, promptId: reply.promptId, attempt: failed.attemptCount, nextAttemptAt: failed.nextAttemptAt, failureClass: classified.failureClass, effectCertainty: classified.effectCertainty, httpStatus: classified.httpStatus, providerCode: classified.providerCode, deliveryOperation: classified.providerOperation, deliveryTarget: preparedPurpose(reply), autoRecoveryCount: failed.autoRecoveryCount, laneClass: transition.laneClass, quarantineAction: transition.action, outcome: failed.state === "dead_letter" ? "dead_letter" : "retry" };
    if (failed.state === "dead_letter") this.logger.error(context, classified.failureClass === "permanent" ? "Gateway outbox reply was permanently rejected" : "Gateway outbox reply exhausted retries");
    else this.logger.warn(context, "Gateway outbox reply delivery failed; retry scheduled");
    if (transition.action === "rebuild_answer" && transition.promptId) this.notify("answer", this.answerCheckpoints, (listener) => listener(transition.promptId!, failed.viewVersion ?? 0), reply);
    return "failed";
  }

  private notify<Listener>(name: string, listeners: ReadonlySet<Listener>, invoke: (listener: Listener) => void, reply: OutboundReply): void { for (const listener of listeners) this.runPostDelivery(name, reply, () => invoke(listener)); }
  private runPostDelivery(name: string, reply: OutboundReply, operation: () => void): void {
    try { operation(); } catch (error) { this.logger.error({ event: "gateway-outbox-checkpoint-listener-failed", err: safeLogError(error), gatewayId: reply.gatewayId, subscriber: name, replyId: reply.id, replyKind: reply.kind, bindingId: reply.bindingId, promptId: reply.promptId, outcome: "isolated" }, "post-delivery convergence hook failed; durable delivery remains authoritative"); }
  }
}

function findRef(refs: readonly GatewayExternalRef[], kind: GatewayExternalRef["kind"]): GatewayExternalRef | undefined { return refs.find((ref) => ref.kind === kind); }
function decodeGatewayPlan(value: string | null): import("../gateways/contract/plugin.js").PreparedGatewayDelivery {
  if (!value) throw new Error("Outbound Gateway plan is missing");
  try { return JSON.parse(value) as import("../gateways/contract/plugin.js").PreparedGatewayDelivery; }
  catch { throw new Error("Outbound Gateway plan is invalid"); }
}
function preparedPurpose(reply: OutboundReply): string {
  if (reply.workerTurnId) return "worker-turn"; if (reply.workerId) return "worker-main"; if (reply.targetRole === "session_status") return "primary-main"; if (reply.cardRole === "answer") return "primary-answer"; return "operation-result";
}
class DeliveryCheckpointError extends Error {}
function classifyCoreDeliveryFailure(error: unknown): import("../gateways/contract/plugin.js").GatewayFailure {
  const safe = safeLogError(error);
  if (error instanceof PermanentDeliveryError) return { failureClass: "permanent", effectCertainty: "rejected", providerCode: null, httpStatus: null, safeMessage: safe.message };
  return { failureClass: "unknown", effectCertainty: "uncertain", providerCode: null, httpStatus: null, safeMessage: safe.message };
}
function subscribe<Listener>(listeners: Set<Listener>, listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); }
