import type { Logger } from "pino";
import { LarkSdkAdapter } from "../../adapters/lark-adapter.js";
import type { LarkPort } from "../../domain/ports/external.js";
import type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "../../domain/types.js";
import { GATEWAY_PROTOCOL_VERSION, GatewayDeliveryError, type ConversationGatewayPlugin, type GatewayDeliveryContext, type GatewayDeliveryIntent, type GatewayDeliveryReceipt, type GatewayExternalRef, type GatewayIngressResponse, type GatewaySession, type NegotiatedGatewayProfile, type PreparedGatewayDelivery } from "../contract/plugin.js";
import { performFeishuDelivery } from "./errors.js";
import { materializeFeishuView } from "./cardkit-view.js";

export interface FeishuGatewayConfig {
  gatewayId: string; appId: string; appSecret: string; chatId: string; botOpenId: string; requestTimeoutMs?: number;
}
interface FeishuPluginOptions { createTransport?: (config: Omit<FeishuGatewayConfig, "gatewayId">, logger?: Logger) => LarkPort; }
const compatibilityPorts = new WeakMap<GatewaySession, LarkPort>();

export function createFeishuGatewayPlugin(options: FeishuPluginOptions = {}): ConversationGatewayPlugin<FeishuGatewayConfig> {
  return {
    manifest: Object.freeze({ kind: "feishu", pluginVersion: "1.0.0", protocolVersion: GATEWAY_PROTOCOL_VERSION }),
    create(config, services) {
      const { gatewayId, ...transportConfig } = config;
      const transport = options.createTransport?.(transportConfig, services.logger) ?? new LarkSdkAdapter(transportConfig, services.logger);
      const profile = feishuProfile();
      const ingress = new FeishuGatewayIngress(gatewayId, transport);
      const delivery = new FeishuGatewayDelivery(gatewayId, profile, transport);
      const session: GatewaySession = {
        gatewayId, profile, ingress, delivery,
        snapshot: () => ({ gatewayId, kind: "feishu", profileId: profile.id, ingress: { ready: transport.isReady() }, delivery: { ready: true }, degradations: profile.degradations }),
        close: () => ingress.stop()
      };
      compatibilityPorts.set(session, transport);
      return session;
    }
  };
}

export function requireFeishuCompatibilityPort(session: GatewaySession): LarkPort {
  const port = compatibilityPorts.get(session);
  if (!port) throw new Error(`Gateway ${session.gatewayId} is not a Feishu compatibility session`);
  return port;
}
export function createFeishuCompatibilityDelivery(transport: LarkPort, gatewayId = "feishu:primary") { return new FeishuGatewayDelivery(gatewayId, feishuProfile(), transport); }

class FeishuGatewayIngress {
  constructor(private readonly gatewayId: string, private readonly transport: LarkPort) {}
  async start(sink: import("../contract/plugin.js").GatewayIngressSink): Promise<void> {
    await this.transport.start(
      async (message) => { await sink.accept(toGatewayMessage(this.gatewayId, message)); },
      async (action) => toLarkActionResponse(await sink.accept(toGatewayAction(this.gatewayId, action)))
    );
  }
  stop(): Promise<void> { return this.transport.stop(); }
}

class FeishuGatewayDelivery {
  constructor(private readonly gatewayId: string, private readonly profile: NegotiatedGatewayProfile, private readonly transport: LarkPort) {}
  prepare(intent: GatewayDeliveryIntent): PreparedGatewayDelivery {
    return Object.freeze({ protocolVersion: GATEWAY_PROTOCOL_VERSION, gatewayId: this.gatewayId, profileId: this.profile.id, rendererRevision: this.profile.rendererRevision, operation: intent.kind, intent: structuredClone(intent) });
  }
  async execute(plan: PreparedGatewayDelivery, context: GatewayDeliveryContext): Promise<GatewayDeliveryReceipt> {
    if (plan.gatewayId !== this.gatewayId || plan.profileId !== this.profile.id || plan.protocolVersion !== GATEWAY_PROTOCOL_VERSION) throw new GatewayDeliveryError({ failureClass: "permanent", effectCertainty: "rejected", providerCode: null, httpStatus: null, safeMessage: "Feishu Gateway delivery plan identity mismatch" });
    const intent = plan.intent;
    const view = "view" in intent ? materializeFeishuView(intent.view) : null;
    if (intent.kind === "conversation.create") {
      const receipt = await performFeishuDelivery(intent, "create_topic", () => this.transport.createTopic(view!, intent.idempotencyKey, intent.conversationId));
      return { refs: [ref(this.gatewayId, "thread", receipt.topicId), ref(this.gatewayId, "message", receipt.rootMessageId)] };
    }
    if (intent.kind === "message.reply.text") return { refs: [ref(this.gatewayId, "message", (await performFeishuDelivery(intent, "reply_text", () => this.transport.replyText(intent.rootMessageId, intent.text, intent.idempotencyKey))).messageId)] };
    if (intent.kind === "message.reply.view") {
      const receipt = await performFeishuDelivery(intent, "reply_card", () => this.transport.replyCard(intent.rootMessageId, view!, intent.idempotencyKey));
      const cardId = (receipt as { cardId?: unknown }).cardId;
      return { refs: [ref(this.gatewayId, "message", receipt.messageId), ...(typeof cardId === "string" ? [ref(this.gatewayId, "surface", cardId)] : [])] };
    }
    if (intent.kind === "surface.replace") {
      if (intent.sequence !== undefined && this.transport.updateCardKit) await performFeishuDelivery(intent, "update_cardkit", () => this.transport.updateCardKit!(intent.messageId, view!, intent.sequence!));
      else await performFeishuDelivery(intent, "update_card", () => this.transport.updateCard(intent.messageId, view!));
      return { refs: [] };
    }
    if (intent.kind === "stream.create") {
      if (this.transport.createStreamingCard && this.transport.replyStreamingCardReference) {
        const prior = context.priorCheckpoints.find((item) => item.kind === "surface")?.ref.opaqueId;
        const surfaceId = prior ?? (await performFeishuDelivery(intent, "create_streaming_card", () => this.transport.createStreamingCard!(view!))).cardId;
        if (!prior) await context.checkpoint({ kind: "surface", ref: ref(this.gatewayId, "surface", surfaceId) });
        const message = await performFeishuDelivery(intent, "reply_streaming_card_reference", () => this.transport.replyStreamingCardReference!(intent.rootMessageId, surfaceId, intent.idempotencyKey));
        return { refs: [ref(this.gatewayId, "message", message.messageId), ref(this.gatewayId, "surface", surfaceId)] };
      }
      const receipt = this.transport.replyStreamingCard
        ? await performFeishuDelivery(intent, "reply_streaming_card", () => this.transport.replyStreamingCard!(intent.rootMessageId, view!))
        : { ...(await performFeishuDelivery(intent, "reply_card", () => this.transport.replyCard(intent.rootMessageId, view!, intent.idempotencyKey))), cardId: "" };
      return { refs: [ref(this.gatewayId, "message", receipt.messageId), ...(receipt.cardId ? [ref(this.gatewayId, "surface", receipt.cardId)] : [])] };
    }
    if (intent.kind === "stream.append") {
      if (!this.transport.streamCardContent) throw new GatewayDeliveryError({ failureClass: "permanent", effectCertainty: "rejected", providerCode: null, httpStatus: null, safeMessage: "Feishu Gateway does not support stream append" });
      await performFeishuDelivery(intent, "stream_card_content", () => this.transport.streamCardContent!(intent.surfaceId, intent.slot, intent.content, intent.sequence));
      return { refs: [] };
    }
    if (intent.kind === "stream.finish") {
      if (!this.transport.finishStreamingCard) throw new GatewayDeliveryError({ failureClass: "permanent", effectCertainty: "rejected", providerCode: null, httpStatus: null, safeMessage: "Feishu Gateway does not support stream finish" });
      await performFeishuDelivery(intent, "finish_streaming_card", () => this.transport.finishStreamingCard!(intent.surfaceId, intent.sequence, intent.summary));
      return { refs: [] };
    }
    return { refs: [ref(this.gatewayId, "message", (await performFeishuDelivery(intent, "share_thread", () => this.transport.shareThread(intent.conversationId, { messageId: intent.messageId, chatId: intent.targetConversationId, ...(intent.rootMessageId ? { sourceRootMessageId: intent.rootMessageId } : {}) }))).messageId)] };
  }
}

function feishuProfile(): NegotiatedGatewayProfile {
  return deepFreeze({
    id: "feishu-cardkit-v1", protocolVersion: GATEWAY_PROTOCOL_VERSION, rendererRevision: 1, degradations: [],
    capabilities: {
      conversations: { threads: "native", share: true },
      presentation: { richViews: true, mutableSurfaces: true, actions: "forms", incremental: { mode: "sequenced-region", maxChars: 28_000 } },
      idempotency: { create: "provider-key", reply: "provider-key", update: "provider-key" }
    }
  });
}
function ref<K extends GatewayExternalRef["kind"]>(gatewayId: string, kind: K, opaqueId: string): GatewayExternalRef<K> { return { gatewayId, kind, opaqueId }; }
function toGatewayMessage(gatewayId: string, message: IncomingLarkMessage): import("../contract/plugin.js").GatewayInboundEvent {
  const root = message.rootMessageId ?? message.messageId;
  return { schemaVersion: 1, kind: "message.received", eventKey: message.eventId, occurredAt: new Date().toISOString(), address: { gatewayId, conversation: ref(gatewayId, "conversation", message.chatId), thread: message.topicId ? ref(gatewayId, "thread", message.topicId) : null, rootMessage: ref(gatewayId, "message", root) }, message: ref(gatewayId, "message", message.messageId), parentMessage: message.parentMessageId ? ref(gatewayId, "message", message.parentMessageId) : null, actor: ref(gatewayId, "actor", message.actorOpenId), text: message.text, mentionsAgent: message.mentionsBot, isRoot: message.isRootMessage, hasUnsupportedContent: message.hasUnsupportedContent ?? false, inputTooLarge: message.inputTooLarge ?? false };
}
function toGatewayAction(gatewayId: string, action: IncomingLarkCardAction): import("../contract/plugin.js").GatewayInboundEvent {
  return { schemaVersion: 1, kind: "interaction.invoked", eventKey: `interaction:${action.messageId}:${JSON.stringify(action.value)}`, occurredAt: new Date().toISOString(), address: { gatewayId, conversation: ref(gatewayId, "conversation", action.chatId), thread: null, rootMessage: ref(gatewayId, "message", action.messageId) }, sourceMessage: ref(gatewayId, "message", action.messageId), actor: ref(gatewayId, "actor", action.operatorOpenId), interactionRef: typeof action.value === "object" && action.value && "interactionId" in action.value ? String(action.value.interactionId) : "", commandPayload: structuredClone(action.value), option: action.option ?? null, values: action.formValues ?? {} };
}
function toLarkActionResponse(response: GatewayIngressResponse): LarkCardActionResult | void {
  if (!response) return;
  return { ...(response.toast ? { toast: { type: response.toast.level, content: response.toast.text } } : {}), ...(response.replaceView ? { card: response.replaceView } : {}) };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
