import * as lark from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";
import type { LarkPort } from "../domain/ports.js";
import type { IncomingLarkCardAction, IncomingLarkMessage } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";

interface LarkAdapterOptions {
  appId: string;
  appSecret: string;
  chatId: string;
  botOpenId: string;
}

export class LarkSdkAdapter implements LarkPort {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;
  private ready = false;

  constructor(private readonly options: LarkAdapterOptions, private readonly logger?: Logger) {
    this.client = new lark.Client({ appId: options.appId, appSecret: options.appSecret });
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

  async start(onMessage: (message: IncomingLarkMessage) => Promise<void>, onCardAction?: (action: IncomingLarkCardAction) => Promise<void>): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const normalized = normalizeMessage(data, this.options.botOpenId);
        if (!normalized || normalized.chatId !== this.options.chatId) return;
        await onMessage(normalized);
      },
      "card.action.trigger": async (data: lark.RawCardActionEvent) => {
        const normalized = normalizeCardActionEvent(data);
        if (!normalized || normalized.chatId !== this.options.chatId || !onCardAction) return;
        await onCardAction(normalized);
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
        ...(idempotencyKey ? { uuid: idempotencyKey } : {})
      }
    });
    const messageId = requireMessageId(response.data?.message_id);
    return { topicId: messageId, rootMessageId: messageId };
  }

  async replyText(rootMessageId: string, text: string): Promise<{ messageId: string }> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: rootMessageId },
      data: { msg_type: "text", content: JSON.stringify({ text }), reply_in_thread: true }
    });
    return { messageId: requireMessageId(response.data?.message_id) };
  }

  async replyCard(rootMessageId: string, card: object): Promise<{ messageId: string }> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: rootMessageId },
      data: { msg_type: "interactive", content: JSON.stringify(card), reply_in_thread: true }
    });
    return { messageId: requireMessageId(response.data?.message_id) };
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) }
    });
  }
}

type MessageEvent = Parameters<NonNullable<lark.EventHandles["im.message.receive_v1"]>>[0];

export function normalizeMessage(data: MessageEvent, botOpenId: string): IncomingLarkMessage | null {
  if (data.sender.sender_type !== "user" || data.message.message_type !== "text") return null;
  let text: string;
  try {
    const parsed = JSON.parse(data.message.content) as { text?: unknown };
    if (typeof parsed.text !== "string") return null;
    text = parsed.text;
  } catch { return null; }

  const botMentions = (data.message.mentions ?? []).filter((mention) => mention.id.open_id === botOpenId);
  const mentionsBot = botMentions.length > 0;
  for (const mention of botMentions) text = text.replaceAll(mention.key, "");
  text = text.trim();
  if (!text) return null;

  const messageId = data.message.message_id;
  const rootMessageId = data.message.root_id ?? null;
  return {
    eventId: data.event_id ?? data.uuid ?? `message:${messageId}`,
    messageId,
    chatId: data.message.chat_id,
    topicId: data.message.thread_id ?? rootMessageId ?? messageId,
    rootMessageId: rootMessageId ?? messageId,
    actorOpenId: data.sender.sender_id?.open_id ?? "unknown",
    text, mentionsBot, isRootMessage: rootMessageId === null
  };
}

export function normalizeCardActionEvent(data: lark.RawCardActionEvent): IncomingLarkCardAction | null {
  const messageId = data.context?.open_message_id ?? data.open_message_id;
  const chatId = data.context?.open_chat_id ?? data.open_chat_id;
  const operatorOpenId = data.operator?.open_id;
  if (!messageId || !chatId || !operatorOpenId || data.action?.value === undefined) return null;
  return { messageId, chatId, operatorOpenId, value: data.action.value };
}

function requireMessageId(value: string | undefined): string {
  if (!value) throw new Error("Lark response did not contain message_id");
  return value;
}
