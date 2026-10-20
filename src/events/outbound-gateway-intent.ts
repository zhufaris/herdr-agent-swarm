import type { GatewayIntentPreparationStore } from "../domain/ports/outbox.js";
import type { OutboundReply } from "../domain/types.js";
import type { GatewayDeliveryIntent, GatewayDeliveryPurpose } from "../gateways/contract/plugin.js";
import { isGatewayView, legacyGatewayView } from "../gateways/contract/view.js";
import { materializeOutboundReply } from "./outbound-intent-materializer.js";
import { assertAnswerCardCreateTarget, assertAnswerCardTarget, assertAnswerMessageTarget, assertAnswerStreamTarget, assertWorkerCardCreateTarget, assertWorkerCardTarget, assertWorkerMainCreateTarget, assertWorkerMainMessageTarget, assertWorkerMessageTarget, assertWorkerProgressTarget, PermanentDeliveryError } from "./outbound-target-validation.js";
import { parseTurnCardProjectionKey } from "../domain/turn-card-projection-key.js";
import type { SemanticDeliveryWork } from "../domain/delivery.js";
import type { ConversationPagePresentationPolicy } from "../domain/ports/presentation.js";
import type { ConversationPagePresentationBudget, ConversationPagePresentationMeasure } from "../domain/conversation-segment.js";
import { GatewayPreparationError, type GatewayDeliveryPort, type PreparedGatewayDelivery } from "../gateways/contract/plugin.js";

export interface PreparedOutboundGatewayIntent { intent: GatewayDeliveryIntent; streamMetadata: boolean; emptyStreamContent: boolean; }

export function prepareSemanticOutboundGatewayPlan(
  work: SemanticDeliveryWork,
  gateway: GatewayDeliveryPort,
  options: {
    policy: ConversationPagePresentationPolicy<import("../domain/delivery.js").PresentationSnapshot, unknown>;
    gatewayProfileVersion: number;
  }
): PreparedGatewayDelivery {
  const policy = options.policy;
  const profileVersion = options.gatewayProfileVersion;
  try {
    if (work.input.snapshot.kind !== "conversation-turn-card"
      || work.input.plannerPolicyVersion !== policy.plannerPolicyVersion
      || work.input.rendererPolicyVersion !== policy.rendererPolicyVersion
      || work.input.gatewayProfileVersion !== profileVersion) {
      throw new Error("semantic_delivery_policy_stale");
    }
    const committed = committedPresentationEvidence(work.input.snapshot);
    if (!committed) throw new Error("semantic_delivery_measurement_invalid");
    if (work.input.snapshot.schemaVersion !== 1
      || committed.budget.profileVersion !== profileVersion
      || committed.pagePlanPolicyVersion !== work.input.plannerPolicyVersion
      || committed.pagePlanBudgetProfileVersion !== committed.budget.profileVersion) {
      throw new Error("semantic_delivery_policy_stale");
    }
    const measurement = policy.measure(work.input.snapshot);
    if (!validMeasurement(measurement)) throw new Error("semantic_delivery_measurement_invalid");
    if (!sameMeasurement(committed.measurement, measurement)) throw new Error("semantic_delivery_measurement_mismatch");
    if (measurement.encodedBytesUpperBound > committed.budget.encodedBytes
      || measurement.elementCount > committed.budget.elementCount
      || measurement.actionCount > committed.budget.actionCount) {
      throw new Error("semantic_delivery_budget_exceeded");
    }
    const view = policy.render(work.input.snapshot);
    if (!isGatewayView(view)) throw new Error("semantic_delivery_view_invalid");
    const intent: GatewayDeliveryIntent = work.deliveryKind === "card_reply"
      ? { kind: "message.reply.view", purpose: "operation-result", rootMessageId: work.rootMessageId, view, idempotencyKey: work.idempotencyKey }
      : { kind: "surface.replace", purpose: "operation-result", messageId: work.rootMessageId, view, ...(work.cardSequence === null ? {} : { sequence: work.cardSequence }) };
    const prepared = gateway.prepare(intent);
    if (prepared.gatewayId !== work.gatewayId || prepared.profileId !== work.gatewayProfileId
      || prepared.rendererRevision !== work.input.rendererPolicyVersion || prepared.operation !== intent.kind) {
      throw new Error("semantic_delivery_gateway_profile_stale");
    }
    return prepared;
  } catch (error) {
    if (error instanceof GatewayPreparationError) throw error;
    throw new GatewayPreparationError(error instanceof Error ? error.message : "semantic_delivery_preparation_failed", { cause: error });
  }
}

function validMeasurement(value: ConversationPagePresentationMeasure): boolean {
  return Number.isSafeInteger(value.encodedBytesUpperBound) && value.encodedBytesUpperBound >= 0
    && Number.isSafeInteger(value.elementCount) && value.elementCount >= 0
    && Number.isSafeInteger(value.actionCount) && value.actionCount >= 0;
}

function validBudget(value: ConversationPagePresentationBudget): boolean {
  return Number.isSafeInteger(value.encodedBytes) && value.encodedBytes > 0
    && Number.isSafeInteger(value.elementCount) && value.elementCount >= 0
    && Number.isSafeInteger(value.actionCount) && value.actionCount >= 0
    && Number.isSafeInteger(value.profileVersion) && value.profileVersion > 0;
}

function committedPresentationEvidence(snapshot: import("../domain/delivery.js").PresentationSnapshot): {
  budget: ConversationPagePresentationBudget;
  measurement: ConversationPagePresentationMeasure;
  pagePlanPolicyVersion: number;
  pagePlanBudgetProfileVersion: number;
} | null {
  const candidate = snapshot as Record<string, unknown>;
  const budget = candidate.presentationBudget;
  const measurement = candidate.presentationMeasure;
  const pagePlan = candidate.pagePlan;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)
    || !measurement || typeof measurement !== "object" || Array.isArray(measurement)
    || !pagePlan || typeof pagePlan !== "object" || Array.isArray(pagePlan)) return null;
  const typedBudget = budget as ConversationPagePresentationBudget;
  const typedMeasurement = measurement as ConversationPagePresentationMeasure;
  const typedPagePlan = pagePlan as Record<string, unknown>;
  if (!validBudget(typedBudget) || !validMeasurement(typedMeasurement)
    || !Number.isSafeInteger(typedPagePlan.policyVersion)
    || !Number.isSafeInteger(typedPagePlan.budgetProfileVersion)) return null;
  return {
    budget: typedBudget,
    measurement: typedMeasurement,
    pagePlanPolicyVersion: typedPagePlan.policyVersion as number,
    pagePlanBudgetProfileVersion: typedPagePlan.budgetProfileVersion as number,
  };
}

function sameMeasurement(left: ConversationPagePresentationMeasure, right: ConversationPagePresentationMeasure): boolean {
  return left.encodedBytesUpperBound === right.encodedBytesUpperBound
    && left.elementCount === right.elementCount
    && left.actionCount === right.actionCount;
}

export function prepareOutboundGatewayIntent(store: GatewayIntentPreparationStore, reply: OutboundReply): PreparedOutboundGatewayIntent {
  const payload = materializeOutboundReply(reply);
  const purpose = deliveryPurpose(reply);
  if (reply.kind === "group_card_create") {
    const targetCount = Number(reply.threadAliasId !== null) + Number(reply.workerThreadId !== null) + Number(reply.shortcutPanelId !== null);
    if (!reply.targetChatId || targetCount !== 1) throw new PermanentDeliveryError("Group card target is incomplete");
    if (reply.workerThreadId) {
      const thread = store.getWorkerThreadTarget?.(reply.workerThreadId);
      if (!store.getWorkerThreadTarget) return { intent: { kind: "conversation.create", purpose, conversationId: reply.targetChatId, view: renderableView(payload), idempotencyKey: reply.idempotencyKey }, streamMetadata: false, emptyStreamContent: false };
      if (!thread || thread.workerId !== reply.workerId || thread.workerSessionGeneration !== reply.workerSessionGeneration) {
        throw new PermanentDeliveryError("Worker thread target is stale");
      }
      if (thread.state === "active" && !isWorkerRecoveryConversationCreate(reply)) {
        if (!thread.rootMessageId) throw new PermanentDeliveryError("Worker thread target is missing its root message");
        return {
          intent: { kind: "message.reply.view", purpose, rootMessageId: thread.rootMessageId, view: renderableView(payload), idempotencyKey: reply.idempotencyKey },
          streamMetadata: false,
          emptyStreamContent: false
        };
      }
    }
    return { intent: { kind: "conversation.create", purpose, conversationId: reply.targetChatId, view: renderableView(payload), idempotencyKey: reply.idempotencyKey }, streamMetadata: false, emptyStreamContent: false };
  }
  const rootMessageId = requireRootMessageId(reply);
  if (reply.kind === "message_delete") return { intent: { kind: "message.delete", purpose, messageId: rootMessageId, idempotencyKey: reply.idempotencyKey }, streamMetadata: false, emptyStreamContent: false };
  if (reply.kind === "card_update") {
    if (reply.cardRole === "answer" && !isTurnCardReply(reply)) assertAnswerMessageTarget(store, reply.bindingId, reply.promptId, reply.streamPageIndex, rootMessageId);
    if (isWorkerTaskProjection(reply) || isLegacyWorkerTaskUpdate(reply)) assertWorkerMessageTarget(store, reply.workerTurnId!, rootMessageId);
    else if (isWorkerMainProjection(reply)) assertWorkerMainMessageTarget(store, reply.workerId!, reply.workerSessionGeneration!, rootMessageId);
    return { intent: { kind: "surface.replace", purpose, messageId: rootMessageId, view: renderableView(payload), ...(reply.cardSequence !== null ? { sequence: reply.cardSequence } : {}) }, streamMetadata: false, emptyStreamContent: false };
  }
  if (reply.kind === "stream_card_create") {
    const decoded = decodeStreamingCardPayload(payload);
    if (reply.workerTurnId) assertWorkerCardCreateTarget(store, reply.workerTurnId, rootMessageId, decoded.card, decoded.stream);
    else assertAnswerCardCreateTarget(store, reply.bindingId, reply.promptId, rootMessageId, decoded.card, decoded.stream);
    return { intent: { kind: "stream.create", purpose, rootMessageId, view: gatewayView(decoded.card), idempotencyKey: reply.idempotencyKey }, streamMetadata: Boolean(decoded.stream), emptyStreamContent: false };
  }
  if (reply.kind === "stream_content") {
    const decoded = parseObject(payload) as { elementId?: unknown; content?: unknown; sequence?: unknown; pageIndex?: unknown; workerElement?: unknown };
    const slot = typeof decoded.elementId === "string" ? decoded.elementId : "";
    const content = typeof decoded.content === "string" ? decoded.content : "";
    const sequence = typeof decoded.sequence === "number" ? decoded.sequence : -1;
    const pageIndex = typeof decoded.pageIndex === "number" ? decoded.pageIndex : -1;
    if (reply.workerTurnId) {
      if (decoded.workerElement === "progress") assertWorkerProgressTarget(store, reply.workerTurnId, rootMessageId, slot, pageIndex);
      else assertWorkerCardTarget(store, reply.workerTurnId, rootMessageId, slot);
    } else assertAnswerStreamTarget(store, reply.bindingId, reply.promptId, rootMessageId, slot);
    return { intent: { kind: "stream.append", purpose, surfaceId: rootMessageId, slot, content, sequence }, streamMetadata: true, emptyStreamContent: content.length === 0 };
  }
  if (reply.kind === "stream_finish") {
    const decoded = parseObject(payload) as { summary?: unknown; sequence?: unknown };
    if (reply.workerTurnId) assertWorkerCardTarget(store, reply.workerTurnId, rootMessageId);
    else assertAnswerCardTarget(store, reply.bindingId, reply.promptId, rootMessageId);
    return { intent: { kind: "stream.finish", purpose, surfaceId: rootMessageId, sequence: typeof decoded.sequence === "number" ? decoded.sequence : -1, summary: typeof decoded.summary === "string" ? decoded.summary : "" }, streamMetadata: true, emptyStreamContent: false };
  }
  if (reply.kind === "card_reply" && isWorkerMainProjection(reply)) assertWorkerMainCreateTarget(store, reply.workerId!, reply.workerSessionGeneration!, rootMessageId);
  return {
    intent: reply.kind === "text"
      ? { kind: "message.reply.text", purpose, rootMessageId, text: payload, idempotencyKey: reply.idempotencyKey }
      : { kind: "message.reply.view", purpose, rootMessageId, view: renderableView(payload), idempotencyKey: reply.idempotencyKey },
    streamMetadata: false, emptyStreamContent: false
  };
}

export function deliveryPurpose(reply: OutboundReply): GatewayDeliveryPurpose {
  if (reply.kind === "group_card_create") return reply.workerThreadId ? "worker-main" : "group-thread";
  if (reply.workerTurnId) return "worker-turn";
  if (isWorkerMainProjection(reply)) return "worker-main";
  if (reply.targetRole === "session_status") return "primary-main";
  if (isTurnCardReply(reply)) return "operation-result";
  if (reply.cardRole === "answer") return "primary-answer";
  return "operation-result";
}
function isWorkerMainProjection(reply: OutboundReply): boolean {
  if (!reply.workerId || reply.workerSessionGeneration === null || reply.workerTurnId !== null) return false;
  if (reply.projectionKey === `worker-main:${reply.workerId}:${reply.workerSessionGeneration}`) return true;
  return reply.projectionKey === null
    && reply.viewVersion !== null
    && reply.promptId === null
    && reply.cardRole === null
    && reply.targetRole === null
    && reply.selectionId === null
    && reply.threadAliasId === null
    && reply.workerThreadId === null
    && (reply.kind === "card_reply" || reply.kind === "card_update");
}
function isWorkerTaskProjection(reply: OutboundReply): boolean {
  return reply.workerTurnId !== null
    && reply.streamPageIndex !== null
    && reply.projectionKey === `worker-task:${reply.workerTurnId}:page:${reply.streamPageIndex}`;
}
function isLegacyWorkerTaskUpdate(reply: OutboundReply): boolean {
  return reply.kind === "card_update"
    && reply.workerTurnId !== null
    && reply.projectionKey === null
    && reply.viewVersion !== null
    && reply.promptId === null
    && reply.workerId === null
    && reply.workerSessionGeneration === null
    && reply.cardRole === null
    && reply.targetRole === null
    && reply.selectionId === null
    && reply.threadAliasId === null
    && reply.workerThreadId === null;
}
function isWorkerRecoveryConversationCreate(reply: OutboundReply): boolean {
  return reply.projectionKey?.startsWith("worker-main-recovery:") === true
    || reply.projectionKey?.startsWith("worker-turn-recovery:") === true
    || reply.projectionKey?.startsWith("worker-task-recovery-thread:") === true;
}
function isTurnCardReply(reply: OutboundReply): boolean { return typeof reply.projectionKey === "string" && parseTurnCardProjectionKey(reply.projectionKey) !== null; }
function requireRootMessageId(reply: OutboundReply): string { if (!reply.rootMessageId) throw new PermanentDeliveryError(`Outbound reply ${reply.id} has no root message target`); return reply.rootMessageId; }
function parseObject(payload: string): object {
  try { const value: unknown = JSON.parse(payload); if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new PermanentDeliveryError("Durable delivery payload is not a JSON object"); }
}
function renderableView(payload: string): import("../gateways/contract/plugin.js").GatewayRenderableView { return gatewayView(parseObject(payload)); }
function gatewayView(value: object): import("../gateways/contract/plugin.js").GatewayRenderableView { return isGatewayView(value) ? value : legacyGatewayView(value); }
function decodeStreamingCardPayload(payload: string): { card: object; stream?: { pageIndex: number; pageStart: number; elementId: string; deliveryMode?: "static" } } {
  const decoded = parseObject(payload) as object & { card?: object; stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown; deliveryMode?: unknown } };
  if (!decoded.card || !decoded.stream) return { card: decoded };
  const stream = { pageIndex: typeof decoded.stream.pageIndex === "number" ? decoded.stream.pageIndex : -1, pageStart: typeof decoded.stream.pageStart === "number" ? decoded.stream.pageStart : -1, elementId: typeof decoded.stream.elementId === "string" ? decoded.stream.elementId : "" };
  return decoded.stream.deliveryMode === "static" ? { card: decoded.card, stream: { ...stream, deliveryMode: "static" } } : { card: decoded.card, stream };
}
