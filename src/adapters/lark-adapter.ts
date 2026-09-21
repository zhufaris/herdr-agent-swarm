import * as lark from "@larksuiteoapi/node-sdk";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import type { LarkPort } from "../domain/ports/external.js";
import type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "../domain/types.js";
import { normalizeLarkCardElementIds, normalizeLarkElementId } from "../runtime/lark-card-id.js";
import { safeLogError } from "../runtime/safe-error.js";
import { LruMap } from "../runtime/lru-map.js";
import { compactPromptInput } from "../domain/prompt-input-policy.js";

const CARD_ID_CACHE_CAPACITY = 512;
const MAX_LARK_MESSAGE_CONTENT_BYTES = 64 * 1_024;

interface LarkAdapterOptions {
  appId: string;
  appSecret: string;
  chatId: string;
  botOpenId: string;
  requestTimeoutMs?: number;
  cardIdCacheCapacity?: number;
}

export class LarkSdkAdapter implements LarkPort {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;
  private readonly cardIdsByMessageId: LruMap<string, string>;
  private ready = false;

  constructor(private readonly options: LarkAdapterOptions, private readonly logger?: Logger) {
    this.cardIdsByMessageId = new LruMap(options.cardIdCacheCapacity ?? CARD_ID_CACHE_CAPACITY);
    this.client = new lark.Client({
      appId: options.appId, appSecret: options.appSecret,
      httpInstance: withRequestTimeout(lark.defaultHttpInstance as unknown as lark.HttpInstance, options.requestTimeoutMs ?? 30_000)
    });
    this.wsClient = new lark.WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 10 },
      onReady: () => this.setReady(true, "lark-websocket-ready", "Lark WebSocket connected"),
      onError: (error) => this.setReady(false, "lark-websocket-error", "Lark WebSocket error", error),
      onReconnecting: () => this.setReady(false, "lark-websocket-reconnecting", "Lark WebSocket reconnecting"),
      onReconnected: () => this.setReady(true, "lark-websocket-reconnected", "Lark WebSocket reconnected")
    });
  }

  async start(onMessage: (message: IncomingLarkMessage) => Promise<void>, onCardAction?: (action: IncomingLarkCardAction) => Promise<LarkCardActionResult | void>): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const normalized = normalizeMessage(data, this.options.botOpenId);
        if (!normalized || normalized.chatId !== this.options.chatId) return;
        await onMessage(normalized);
      },
      "card.action.trigger": async (data: lark.RawCardActionEvent) => {
        const normalized = normalizeCardActionEvent(data);
        if (!normalized || normalized.chatId !== this.options.chatId || !onCardAction) return;
        const startedAt = Date.now();
        const action = cardActionName(normalized.value);
        this.logger?.info({ event: "lark-card-action-received", action, messageId: normalized.messageId, cardDiagnostics: cardActionDiagnostics(data), outcome: "accepted" }, "Lark card action received");
        try {
          const result = await onCardAction(normalized);
          this.logger?.info({ event: "lark-card-action-completed", action, messageId: normalized.messageId, outcome: "responded", responseKind: cardActionResponseKind(result), durationMs: Date.now() - startedAt }, "Lark card action completed");
          return normalizeCardActionResponse(result);
        } catch (error) {
          this.logger?.error({ event: "lark-card-action-failed", action, messageId: normalized.messageId, outcome: "failed", durationMs: Date.now() - startedAt, err: safeLogError(error) }, "Lark card action failed");
          return { toast: { type: "error", content: "操作失败，请稍后重试。" } };
        }
      }
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    this.wsClient.close();
    this.ready = false;
    this.cardIdsByMessageId.clear();
  }

  isReady(): boolean { return this.ready; }

  private setReady(ready: boolean, event: string, message: string, error?: unknown): void {
    if (this.ready === ready && event !== "lark-websocket-error") return;
    this.ready = ready;
    const context = { event, outcome: ready ? "connected" : "disconnected", ...(error === undefined ? {} : { err: safeLogError(error) }) };
    if (event === "lark-websocket-error") this.logger?.error(context, message);
    else if (ready) this.logger?.info(context, message);
    else this.logger?.warn(context, message);
  }

  async createTopic(card: object, idempotencyKey?: string, targetChatId = this.options.chatId): Promise<{ topicId: string; rootMessageId: string }> {
    if (targetChatId !== this.options.chatId) throw new Error("Lark group-card target is outside the configured chat");
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: targetChatId, msg_type: "interactive", content: JSON.stringify(card),
        ...(idempotencyKey ? { uuid: larkMessageUuid(idempotencyKey) } : {})
      }
    });
    const messageId = requireMessageId(response.data?.message_id);
    return { topicId: response.data?.thread_id ?? messageId, rootMessageId: messageId };
  }

  async replyText(rootMessageId: string, text: string, idempotencyKey?: string): Promise<{ messageId: string }> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: rootMessageId },
      data: { msg_type: "text", content: JSON.stringify({ text }), reply_in_thread: true, ...(idempotencyKey ? { uuid: larkMessageUuid(idempotencyKey) } : {}) }
    });
    return { messageId: requireMessageId(response.data?.message_id) };
  }

  async replyCard(rootMessageId: string, card: object, idempotencyKey?: string): Promise<{ messageId: string }> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: rootMessageId },
      data: { msg_type: "interactive", content: JSON.stringify(normalizeLarkCardElementIds(card)), reply_in_thread: true, ...(idempotencyKey ? { uuid: larkMessageUuid(idempotencyKey) } : {}) }
    });
    return { messageId: requireMessageId(response.data?.message_id) };
  }

  async replyStreamingCard(rootMessageId: string, card: object): Promise<{ messageId: string; cardId: string }> {
    const { cardId } = await this.createStreamingCard(card);
    const { messageId } = await this.replyStreamingCardReference(rootMessageId, cardId, "");
    return { messageId, cardId };
  }

  async createStreamingCard(card: object): Promise<{ cardId: string }> {
    const created = await this.client.cardkit.v1.card.create({ data: { type: "card_json", data: JSON.stringify(normalizeLarkCardElementIds(card)) } });
    assertCardKitSuccess("create", created);
    const cardId = created.data?.card_id;
    if (!cardId) throw new Error(`Lark CardKit create returned no card_id (${safeResponseMetadata(created)})`);
    return { cardId };
  }

  async replyStreamingCardReference(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<{ messageId: string }> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: rootMessageId },
      data: { msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }), reply_in_thread: true, ...(idempotencyKey ? { uuid: larkMessageUuid(idempotencyKey) } : {}) }
    });
    return { messageId: requireMessageId(response.data?.message_id) };
  }

  async streamCardContent(cardId: string, elementId: string, content: string, sequence: number): Promise<void> {
    const request = async (nextContent: string): Promise<void> => {
      const response = await this.client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: normalizeLarkElementId(elementId) },
        data: { content: nextContent, sequence, uuid: `stream-${cardId}-${sequence}` }
      });
      assertCardKitSuccess("content update", response);
    };
    try {
      await request(content);
    } catch (error) {
      const fallback = stripFenceLanguages(content);
      if (fallback === content || !isUnsupportedFenceLanguage(error)) throw error;
      await request(fallback);
    }
  }

  async finishStreamingCard(cardId: string, sequence: number, summary: string): Promise<void> {
    const response = await this.client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: { settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }), sequence, uuid: `finish-${cardId}-${sequence}` }
    });
    assertCardKitSuccess("settings update", response);
  }

  async shareThread(topicOrRootMessageId: string, target: { messageId: string; chatId: string; sourceRootMessageId?: string }): Promise<{ messageId: string }> {
    const threadId = topicOrRootMessageId.startsWith("omt_")
      ? topicOrRootMessageId
      : await this.resolveThreadId(topicOrRootMessageId);
    try {
      const response = await this.client.im.v1.thread.forward({
        path: { thread_id: threadId },
        params: { receive_id_type: "chat_id" },
        data: { receive_id: target.chatId }
      });
      const messageId = response.data?.message_id;
      if (messageId) return { messageId };
      if (!target.sourceRootMessageId) return { messageId: requireMessageId(messageId) };
    } catch (error) {
      if (!target.sourceRootMessageId || !isInvalidThreadForward(error)) throw error;
    }
    const response = await this.client.im.v1.message.forward({
      path: { message_id: target.sourceRootMessageId! },
      params: { receive_id_type: "chat_id" },
      data: { receive_id: target.chatId }
    });
    return { messageId: requireMessageId(response.data?.message_id) };
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(normalizeLarkCardElementIds(card)) }
    });
  }

  async updateCardKit(messageId: string, card: object, sequence: number): Promise<void> {
    let cardId = this.cardIdsByMessageId.get(messageId);
    if (!cardId) {
      const converted = await this.client.cardkit.v1.card.idConvert({ data: { message_id: messageId } });
      assertCardKitSuccess("ID conversion", converted);
      cardId = converted.data?.card_id;
      if (!cardId) throw new Error(`Lark CardKit ID conversion returned no card_id (${safeResponseMetadata(converted)})`);
      this.cardIdsByMessageId.set(messageId, cardId);
    }
    const response = await this.client.cardkit.v1.card.update({
      path: { card_id: cardId },
      data: {
        card: { type: "card_json", data: JSON.stringify(normalizeLarkCardElementIds(card)) },
        sequence, uuid: `update-${cardId}-${sequence}`
      }
    });
    assertCardKitSuccess("update", response);
  }

  private async resolveThreadId(rootMessageId: string): Promise<string> {
    const threadId = await this.resolveOptionalThreadId(rootMessageId);
    if (!threadId) throw new Error(`Lark message ${rootMessageId} does not belong to a thread`);
    return threadId;
  }

  private async resolveOptionalThreadId(messageId: string): Promise<string | null> {
    const response = await this.client.im.v1.message.get({ path: { message_id: messageId } });
    const threadId = response.data?.items?.[0]?.thread_id;
    return threadId ?? null;
  }
}

function withRequestTimeout(base: lark.HttpInstance, timeout: number): lark.HttpInstance {
  const options = <D>(input?: lark.HttpRequestOptions<D>): lark.HttpRequestOptions<D> => ({ ...input, timeout });
  return {
    request: (input) => base.request(options(input)),
    get: (url, input) => base.get(url, options(input)),
    delete: (url, input) => base.delete(url, options(input)),
    head: (url, input) => base.head(url, options(input)),
    options: (url, input) => base.options(url, options(input)),
    post: (url, data, input) => base.post(url, data, options(input)),
    put: (url, data, input) => base.put(url, data, options(input)),
    patch: (url, data, input) => base.patch(url, data, options(input))
  };
}

function stripFenceLanguages(content: string): string {
  return content.replace(/^( {0,3}`{3,})[A-Za-z0-9_+.-]{1,32}\s*$/gm, "$1");
}

function isUnsupportedFenceLanguage(error: unknown): boolean {
  const candidate = error as { message?: unknown; response?: { data?: { msg?: unknown; message?: unknown } } };
  const messages = [candidate?.message, candidate?.response?.data?.msg, candidate?.response?.data?.message]
    .filter((value): value is string => typeof value === "string");
  return messages.some((message) => /unsupported[^\n]*(?:fence|language)|(?:fence|language)[^\n]*unsupported/i.test(message));
}

function isInvalidThreadForward(error: unknown): boolean {
  const candidate = error as { response?: { status?: unknown; data?: { code?: unknown } } };
  return candidate?.response?.status === 400 && Number(candidate.response.data?.code) === 230001;
}

type MessageEvent = Parameters<NonNullable<lark.EventHandles["im.message.receive_v1"]>>[0];

export function normalizeMessage(data: MessageEvent, botOpenId: string): IncomingLarkMessage | null {
  if (data.sender.sender_type !== "user") return null;
  const rawInputTooLarge = Buffer.byteLength(data.message.content, "utf8") > MAX_LARK_MESSAGE_CONTENT_BYTES;
  const normalized = rawInputTooLarge ? { text: "", hasUnsupportedContent: false } : normalizeMessageText(data.message.message_type, data.message.content);
  if (normalized === null) return null;
  let { text } = normalized;

  const botMentions = (data.message.mentions ?? []).filter((mention) => mention.id.open_id === botOpenId);
  const mentionsBot = botMentions.length > 0;
  for (const mention of botMentions) text = text.replaceAll(mention.key, "");
  const normalizedText = text.trim();
  if (!normalizedText && !rawInputTooLarge) return null;
  const bounded = compactPromptInput(normalizedText);
  const inputTooLarge = rawInputTooLarge || bounded.inputTooLarge;

  const messageId = data.message.message_id;
  const rootMessageId = data.message.root_id ?? null;
  return {
    eventId: data.event_id ?? data.uuid ?? `message:${messageId}`,
    messageId, parentMessageId: data.message.parent_id ?? null,
    chatId: data.message.chat_id,
    topicId: data.message.thread_id ?? rootMessageId ?? messageId,
    rootMessageId: rootMessageId ?? messageId,
    actorOpenId: data.sender.sender_id?.open_id ?? "unknown",
    text: inputTooLarge ? "" : bounded.text, mentionsBot, isRootMessage: rootMessageId === null,
    hasUnsupportedContent: normalized.hasUnsupportedContent, inputTooLarge
  };
}

function normalizeMessageText(messageType: string, content: string): { text: string; hasUnsupportedContent: boolean } | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown; content?: unknown; content_v2?: unknown };
    if (messageType === "text") return typeof parsed.text === "string"
      ? { text: parsed.text, hasUnsupportedContent: false }
      : null;
    if (messageType !== "post") return null;
    const paragraphs = Array.isArray(parsed.content_v2) ? parsed.content_v2 : parsed.content;
    if (!Array.isArray(paragraphs)) return null;
    let hasUnsupportedContent = false;
    const text = paragraphs.map((paragraph) => {
      if (!Array.isArray(paragraph)) {
        hasUnsupportedContent = true;
        return "";
      }
      return paragraph.map((node) => {
        const normalizedNode = normalizePostNode(node);
        if (normalizedNode === null) {
          hasUnsupportedContent = true;
          return "";
        }
        return normalizedNode;
      }).join("");
    }).join("\n");
    return { text, hasUnsupportedContent };
  } catch { return null; }
}

function normalizePostNode(node: unknown): string | null {
  if (!isRecord(node)) return null;
  if (node.tag === "text" && typeof node.text === "string") return node.text;
  if (node.tag === "at" && typeof node.user_id === "string") return node.user_id;
  return null;
}

export function normalizeCardActionEvent(data: lark.RawCardActionEvent): IncomingLarkCardAction | null {
  const messageId = data.context?.open_message_id ?? data.open_message_id;
  const chatId = data.context?.open_chat_id ?? data.open_chat_id;
  const operatorOpenId = data.operator?.open_id;
  if (!messageId || !chatId || !operatorOpenId || data.action?.value === undefined) return null;
  return {
    messageId, chatId, operatorOpenId, value: data.action.value,
    ...(typeof data.action.option === "string" ? { option: data.action.option } : {}),
    ...normalizeFormValues((data.action as { form_value?: unknown }).form_value)
  };
}

const CardFormValuesSchema = z.record(z.unknown());

function normalizeFormValues(value: unknown): { formValues: Record<string, string> } | object {
  const parsed = CardFormValuesSchema.safeParse(value);
  if (!parsed.success) return {};
  const formValues = Object.fromEntries(Object.entries(parsed.data).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return Object.keys(formValues).length ? { formValues } : {};
}

function cardActionName(value: unknown): string {
  return isRecord(value) && typeof value.action === "string" ? value.action.slice(0, 128) : "unknown";
}

function cardActionDiagnostics(data: lark.RawCardActionEvent): { tag: string | null; hasFormValue: boolean; formValueKeys: string[] } {
  const action = data.action as { tag?: unknown; form_value?: unknown } | undefined;
  return {
    tag: typeof action?.tag === "string" ? action.tag.slice(0, 64) : null,
    hasFormValue: action?.form_value !== undefined,
    formValueKeys: safeFormValueKeys(action?.form_value)
  };
}

function safeFormValueKeys(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value).filter((key) => /^[a-z][a-z0-9_]{0,64}$/.test(key)).slice(0, 16);
}

function cardActionResponseKind(result: LarkCardActionResult | void): "none" | "toast" | "card" | "toast_and_card" {
  if (!result) return "none";
  if (result.toast && result.card) return "toast_and_card";
  if (result.card) return "card";
  return result.toast ? "toast" : "none";
}

function normalizeCardActionResponse(result: LarkCardActionResult | void): object | void {
  if (!result?.card) return result;
  return { ...result, card: { type: "raw", data: normalizeLarkCardElementIds(result.card) } };
}

function requireMessageId(value: string | undefined): string {
  if (!value) throw new Error("Lark response did not contain message_id");
  return value;
}

function larkMessageUuid(idempotencyKey: string): string {
  if (idempotencyKey.length <= 50) return idempotencyKey;
  return `bridge_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40)}`;
}

function safeResponseMetadata(response: unknown): string {
  if (!isRecord(response)) return `responseType=${typeof response}`;
  const data = isRecord(response.data) ? response.data : null;
  const code = typeof response.code === "number" || typeof response.code === "string" ? String(response.code) : "missing";
  const msg = typeof response.msg === "string" ? JSON.stringify(response.msg.slice(0, 200)) : "missing";
  const dataKeys = data ? Object.keys(data).sort().join(",") : "";
  const responseKeys = Object.keys(response).sort().join(",");
  return `code=${code}, msg=${msg}, dataKeys=[${dataKeys}], responseKeys=[${responseKeys}]`;
}

function assertCardKitSuccess(operation: string, response: unknown): void {
  if (!isRecord(response)) return;
  const code = response.code;
  if (code === undefined || code === null || code === 0 || code === "0" || code === "") return;
  throw Object.assign(new Error(`Lark CardKit ${operation} failed (${safeResponseMetadata(response)})`), { larkCode: code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
