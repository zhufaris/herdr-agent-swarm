import type { Logger } from "pino";
import { LarkSdkAdapter } from "../../adapters/lark-adapter.js";
import type { LarkPort } from "../../domain/ports/external.js";
import type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "../../domain/types.js";
import { GATEWAY_PROTOCOL_VERSION, type ConversationGatewayPlugin, type GatewayDeliveryContext, type GatewayDeliveryIntent, type GatewayDeliveryReceipt, type GatewayExternalRef, type GatewayIngressResponse, type GatewaySession, type NegotiatedGatewayProfile, type PreparedGatewayDelivery } from "../contract/plugin.js";

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
    if (plan.gatewayId !== this.gatewayId || plan.profileId !== this.profile.id || plan.protocolVersion !== GATEWAY_PROTOCOL_VERSION) throw new Error("Feishu Gateway delivery plan identity mismatch");
    const intent = plan.intent;
    if (intent.kind === "conversation.create") {
      const receipt = await this.transport.createTopic(intent.view, intent.idempotencyKey, intent.conversationId);
      return { refs: [ref(this.gatewayId, "thread", receipt.topicId), ref(this.gatewayId, "message", receipt.rootMessageId)] };
    }
    if (intent.kind === "message.reply.text") return { refs: [ref(this.gatewayId, "message", (await this.transport.replyText(intent.rootMessageId, intent.text, intent.idempotencyKey)).messageId)] };
    if (intent.kind === "message.reply.view") return { refs: [ref(this.gatewayId, "message", (await this.transport.replyCard(intent.rootMessageId, intent.view, intent.idempotencyKey)).messageId)] };
    if (intent.kind === "surface.replace") {
      if (intent.sequence !== undefined && this.transport.updateCardKit) await this.transport.updateCardKit(intent.messageId, intent.view, intent.sequence);
      else await this.transport.updateCard(intent.messageId, intent.view);
      return { refs: [] };
    }
    if (intent.kind === "stream.create") {
      if (this.transport.createStreamingCard && this.transport.replyStreamingCardReference) {
        const prior = context.priorCheckpoints.find((item) => item.kind === "surface")?.ref.opaqueId;
        const surfaceId = prior ?? (await this.transport.createStreamingCard(intent.view)).cardId;
        if (!prior) await context.checkpoint({ kind: "surface", ref: ref(this.gatewayId, "surface", surfaceId) });
        const message = await this.transport.replyStreamingCardReference(intent.rootMessageId, surfaceId, intent.idempotencyKey);
        return { refs: [ref(this.gatewayId, "message", message.messageId), ref(this.gatewayId, "surface", surfaceId)] };
      }
      const receipt = this.transport.replyStreamingCard
        ? await this.transport.replyStreamingCard(intent.rootMessageId, intent.view)
        : { ...(await this.transport.replyCard(intent.rootMessageId, intent.view, intent.idempotencyKey)), cardId: "" };
      return { refs: [ref(this.gatewayId, "message", receipt.messageId), ...(receipt.cardId ? [ref(this.gatewayId, "surface", receipt.cardId)] : [])] };
    }
    if (intent.kind === "stream.append") {
      if (!this.transport.streamCardContent) throw new Error("Feishu Gateway does not support stream append");
      await this.transport.streamCardContent(intent.surfaceId, intent.slot, intent.content, intent.sequence);
      return { refs: [] };
    }
    if (intent.kind === "stream.finish") {
      if (!this.transport.finishStreamingCard) throw new Error("Feishu Gateway does not support stream finish");
      await this.transport.finishStreamingCard(intent.surfaceId, intent.sequence, intent.summary);
      return { refs: [] };
    }
    return { refs: [ref(this.gatewayId, "message", (await this.transport.shareThread(intent.conversationId, { messageId: intent.messageId, chatId: intent.targetConversationId })).messageId)] };
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
  return { schemaVersion: 1, kind: "message.received", eventKey: message.eventId, occurredAt: new Date().toISOString(), address: { gatewayId, conversation: ref(gatewayId, "conversation", message.chatId), thread: message.topicId ? ref(gatewayId, "thread", message.topicId) : null, rootMessage: ref(gatewayId, "message", root) }, message: ref(gatewayId, "message", message.messageId), parentMessage: message.parentMessageId ? ref(gatewayId, "message", message.parentMessageId) : null, actor: ref(gatewayId, "actor", message.actorOpenId), text: message.text, mentionsAgent: message.mentionsBot, isRoot: message.isRootMessage, hasUnsupportedContent: message.hasUnsupportedContent ?? false };
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
