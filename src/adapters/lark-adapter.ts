import * as lark from "@larksuiteoapi/node-sdk";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import type { LarkPort } from "../domain/ports.js";
import type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "../domain/types.js";
import { normalizeLarkCardElementIds, normalizeLarkElementId } from "../runtime/lark-card-id.js";
import { safeLogError } from "../runtime/safe-error.js";

interface LarkAdapterOptions {
  appId: string;
  appSecret: string;
  chatId: string;
  botOpenId: string;
  requestTimeoutMs?: number;
}

export class LarkSdkAdapter implements LarkPort {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;
  private ready = false;

  constructor(private readonly options: LarkAdapterOptions, private readonly logger?: Logger) {
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
        return onCardAction(normalized);
      }
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    this.wsClient.close();
    this.ready = false;
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

  async createTopic(card: object, idempotencyKey?: string): Promise<{ topicId: string; rootMessageId: string }> {
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: this.options.chatId, msg_type: "interactive", content: JSON.stringify(card),
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
    const request = (nextContent: string) => this.client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: normalizeLarkElementId(elementId) },
      data: { content: nextContent, sequence, uuid: `stream-${cardId}-${sequence}` }
    });
    try {
      await request(content);
    } catch (error) {
      const fallback = stripFenceLanguages(content);
      if (fallback === content || !isUnsupportedFenceLanguage(error)) throw error;
      await request(fallback);
    }
  }

  async finishStreamingCard(cardId: string, sequence: number, summary: string): Promise<void> {
    await this.client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: { settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }), sequence, uuid: `finish-${cardId}-${sequence}` }
    });
  }

  async shareThread(topicOrRootMessageId: string, target: { messageId: string; chatId: string }): Promise<{ messageId: string }> {
    const [threadId, targetThreadId] = await Promise.all([
      topicOrRootMessageId.startsWith("omt_") ? Promise.resolve(topicOrRootMessageId) : this.resolveThreadId(topicOrRootMessageId),
      this.resolveOptionalThreadId(target.messageId)
    ]);
    if (targetThreadId === threadId) return this.replyText(target.messageId, "当前已在该项目话题中。");
    const response = await this.client.im.v1.thread.forward({
      path: { thread_id: threadId },
      params: { receive_id_type: targetThreadId ? "thread_id" : "chat_id" },
      data: { receive_id: targetThreadId ?? target.chatId }
    });
    return { messageId: requireMessageId(response.data?.message_id) };
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(normalizeLarkCardElementIds(card)) }
    });
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

type MessageEvent = Parameters<NonNullable<lark.EventHandles["im.message.receive_v1"]>>[0];

export function normalizeMessage(data: MessageEvent, botOpenId: string): IncomingLarkMessage | null {
  if (data.sender.sender_type !== "user") return null;
  const normalized = normalizeMessageText(data.message.message_type, data.message.content);
  if (normalized === null) return null;
  let { text } = normalized;

  const botMentions = (data.message.mentions ?? []).filter((mention) => mention.id.open_id === botOpenId);
  const mentionsBot = botMentions.length > 0;
  for (const mention of botMentions) text = text.replaceAll(mention.key, "");
  const normalizedText = text.trim();
  if (!normalizedText) return null;

  const messageId = data.message.message_id;
  const rootMessageId = data.message.root_id ?? null;
  return {
    eventId: data.event_id ?? data.uuid ?? `message:${messageId}`,
    messageId,
    chatId: data.message.chat_id,
    topicId: data.message.thread_id ?? rootMessageId ?? messageId,
    rootMessageId: rootMessageId ?? messageId,
    actorOpenId: data.sender.sender_id?.open_id ?? "unknown",
    text: normalizedText, mentionsBot, isRootMessage: rootMessageId === null,
    hasUnsupportedContent: normalized.hasUnsupportedContent
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
