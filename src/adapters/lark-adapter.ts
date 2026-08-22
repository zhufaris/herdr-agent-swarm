import * as lark from "@larksuiteoapi/node-sdk";
import type { LarkPort } from "../domain/ports.js";
import type { IncomingLarkMessage } from "../domain/types.js";

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

  constructor(private readonly options: LarkAdapterOptions) {
    this.client = new lark.Client({ appId: options.appId, appSecret: options.appSecret });
    this.wsClient = new lark.WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 10 },
      onReady: () => { this.ready = true; },
      onError: () => { this.ready = false; },
      onReconnecting: () => { this.ready = false; },
      onReconnected: () => { this.ready = true; }
    });
  }

  async start(onMessage: (message: IncomingLarkMessage) => Promise<void>): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const normalized = normalizeMessage(data, this.options.botOpenId);
        if (!normalized || normalized.chatId !== this.options.chatId) return;
        await onMessage(normalized);
      }
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    this.wsClient.close();
    this.ready = false;
  }

  isReady(): boolean { return this.ready; }

  async createTopic(card: object): Promise<{ topicId: string; rootMessageId: string }> {
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: this.options.chatId, msg_type: "interactive", content: JSON.stringify(card) }
    });
    const messageId = requireMessageId(response.data?.message_id);
    return { topicId: messageId, rootMessageId: messageId };
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

function requireMessageId(value: string | undefined): string {
  if (!value) throw new Error("Lark response did not contain message_id");
  return value;
}
