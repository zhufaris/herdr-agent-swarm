import type { OutboundDeliveryStore } from "../domain/ports/outbox.js";
import type { OutboundReply } from "../domain/types.js";
import type { GatewayDeliveryIntent, GatewayDeliveryPurpose } from "../gateways/contract/plugin.js";
import { isGatewayView, legacyGatewayView } from "../gateways/contract/view.js";
import { materializeOutboundReply } from "./outbound-intent-materializer.js";
import { assertAnswerCardCreateTarget, assertAnswerCardTarget, assertAnswerMessageTarget, assertAnswerRichTextCreateTarget, assertAnswerRichTextUpdateTarget, assertAnswerStreamTarget, assertWorkerCardCreateTarget, assertWorkerCardTarget, assertWorkerMainCreateTarget, assertWorkerMainMessageTarget, assertWorkerMessageTarget, assertWorkerRichTextCreateTarget, assertWorkerRichTextUpdateTarget, PermanentDeliveryError } from "./outbound-target-validation.js";

export interface PreparedOutboundGatewayIntent { intent: GatewayDeliveryIntent; streamMetadata: boolean; emptyStreamContent: boolean; }

export function prepareOutboundGatewayIntent(store: OutboundDeliveryStore, reply: OutboundReply): PreparedOutboundGatewayIntent {
  const payload = materializeOutboundReply(reply);
  const purpose = deliveryPurpose(reply);
  if (reply.intentKind === "rich-text-reply") {
    const decoded = decodeRichTextPayload(payload);
    const rootMessageId = requireRootMessageId(reply);
    if (reply.workerTurnId) assertWorkerRichTextCreateTarget(store, reply.workerTurnId, rootMessageId, decoded);
    else assertAnswerRichTextCreateTarget(store, reply.bindingId, reply.promptId, rootMessageId, decoded);
    return { intent: { kind: "message.reply.rich_text", purpose, rootMessageId, document: decoded.document, idempotencyKey: reply.idempotencyKey }, streamMetadata: true, emptyStreamContent: false };
  }
  if (reply.intentKind === "rich-text-update") {
    const decoded = decodeRichTextPayload(payload);
    const messageId = requireRootMessageId(reply);
    if (reply.workerTurnId) assertWorkerRichTextUpdateTarget(store, reply.workerTurnId, messageId, decoded);
    else assertAnswerRichTextUpdateTarget(store, reply.bindingId, reply.promptId, messageId, decoded);
    return { intent: { kind: "message.update.rich_text", purpose, messageId, document: decoded.document }, streamMetadata: true, emptyStreamContent: false };
  }
  if (reply.kind === "group_card_create") {
    if (!reply.targetChatId || (reply.threadAliasId === null) === (reply.workerThreadId === null)) throw new PermanentDeliveryError("Group card target is incomplete");
    return { intent: { kind: "conversation.create", purpose, conversationId: reply.targetChatId, view: renderableView(payload), idempotencyKey: reply.idempotencyKey }, streamMetadata: false, emptyStreamContent: false };
  }
  const rootMessageId = requireRootMessageId(reply);
  if (reply.kind === "card_update") {
    if (reply.cardRole === "answer") assertAnswerMessageTarget(store, reply.bindingId, reply.promptId, rootMessageId);
    if (reply.workerTurnId) assertWorkerMessageTarget(store, reply.workerTurnId, rootMessageId);
    if (reply.workerId && reply.workerSessionGeneration !== null) assertWorkerMainMessageTarget(store, reply.workerId, reply.workerSessionGeneration, rootMessageId);
    return { intent: { kind: "surface.replace", purpose, messageId: rootMessageId, view: renderableView(payload), ...(reply.cardSequence !== null ? { sequence: reply.cardSequence } : reply.targetRole === "session_status" ? { sequence: 1 } : {}) }, streamMetadata: false, emptyStreamContent: false };
  }
  if (reply.kind === "stream_card_create") {
    const decoded = decodeStreamingCardPayload(payload);
    if (reply.workerTurnId) assertWorkerCardCreateTarget(store, reply.workerTurnId, rootMessageId, decoded.card, decoded.stream);
    else assertAnswerCardCreateTarget(store, reply.bindingId, reply.promptId, rootMessageId, decoded.card, decoded.stream);
    return { intent: { kind: "stream.create", purpose, rootMessageId, view: gatewayView(decoded.card), idempotencyKey: reply.idempotencyKey }, streamMetadata: Boolean(decoded.stream), emptyStreamContent: false };
  }
  if (reply.kind === "stream_content") {
    const decoded = parseObject(payload) as { elementId?: unknown; content?: unknown; sequence?: unknown };
    const slot = typeof decoded.elementId === "string" ? decoded.elementId : "";
    const content = typeof decoded.content === "string" ? decoded.content : "";
    const sequence = typeof decoded.sequence === "number" ? decoded.sequence : -1;
    if (reply.workerTurnId) assertWorkerCardTarget(store, reply.workerTurnId, rootMessageId, slot);
    else assertAnswerStreamTarget(store, reply.bindingId, reply.promptId, rootMessageId, slot);
    return { intent: { kind: "stream.append", purpose, surfaceId: rootMessageId, slot, content, sequence }, streamMetadata: true, emptyStreamContent: content.length === 0 };
  }
  if (reply.kind === "stream_finish") {
    const decoded = parseObject(payload) as { summary?: unknown; sequence?: unknown };
    if (reply.workerTurnId) assertWorkerCardTarget(store, reply.workerTurnId, rootMessageId);
    else assertAnswerCardTarget(store, reply.bindingId, reply.promptId, rootMessageId);
    return { intent: { kind: "stream.finish", purpose, surfaceId: rootMessageId, sequence: typeof decoded.sequence === "number" ? decoded.sequence : -1, summary: typeof decoded.summary === "string" ? decoded.summary : "" }, streamMetadata: true, emptyStreamContent: false };
  }
  if (reply.kind === "card_reply" && reply.workerId && reply.workerSessionGeneration !== null) assertWorkerMainCreateTarget(store, reply.workerId, reply.workerSessionGeneration, rootMessageId);
  return {
    intent: reply.kind === "text"
      ? { kind: "message.reply.text", purpose, rootMessageId, text: payload, idempotencyKey: reply.idempotencyKey }
      : { kind: "message.reply.view", purpose, rootMessageId, view: renderableView(payload), idempotencyKey: reply.idempotencyKey },
    streamMetadata: false, emptyStreamContent: false
  };
}

function decodeRichTextPayload(payload: string): { pageIndex: number; pageStart: number; elementId: string; sourceEnd: number | null; terminal: boolean; document: import("../domain/rich-text.js").RichTextDocument } {
  const decoded = parseObject(payload) as { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown; sourceEnd?: unknown; terminal?: unknown; document?: unknown };
  const document = decoded.document as { title?: unknown; markdown?: unknown } | undefined;
  if (!Number.isInteger(decoded.pageIndex) || !Number.isInteger(decoded.pageStart) || typeof decoded.elementId !== "string" || !document || typeof document.markdown !== "string" || (document.title !== undefined && typeof document.title !== "string")) throw new PermanentDeliveryError("Durable rich-text Answer payload is invalid");
  return { pageIndex: Number(decoded.pageIndex), pageStart: Number(decoded.pageStart), elementId: decoded.elementId, sourceEnd: Number.isInteger(decoded.sourceEnd) ? Number(decoded.sourceEnd) : null, terminal: decoded.terminal === true, document: { ...(typeof document.title === "string" ? { title: document.title } : {}), markdown: document.markdown } };
}

export function deliveryPurpose(reply: OutboundReply): GatewayDeliveryPurpose {
  if (reply.kind === "group_card_create") return reply.workerThreadId ? "worker-main" : "group-thread";
  if (reply.workerTurnId) return "worker-turn";
  if (reply.workerId) return "worker-main";
  if (reply.targetRole === "session_status") return "primary-main";
  if (reply.cardRole === "answer") return "primary-answer";
  return "operation-result";
}
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
