import type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "../domain/types.js";
import type { GatewayInboundEvent, GatewayIngressResponse, GatewayIngressSink } from "./contract/plugin.js";

export interface LegacyGatewayHandlers {
  receiveMessage(message: IncomingLarkMessage): Promise<void>;
  handleAction(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void>;
}

/** Transitional mapping at the composition seam. Core workflows migrate to
 * Gateway events incrementally while persisted Feishu-compatible DTOs remain
 * readable. Remove after the provider-neutral inbound store migration. */
export function createCompatibilityGatewayIngressSink(handlers: LegacyGatewayHandlers): GatewayIngressSink {
  return {
    async accept(event) {
      if (event.kind === "message.received") { await handlers.receiveMessage(toLegacyMessage(event)); return; }
      return toGatewayResponse(await handlers.handleAction(toLegacyAction(event)));
    }
  };
}

function toLegacyMessage(event: Extract<GatewayInboundEvent, { kind: "message.received" }>): IncomingLarkMessage {
  return {
    gatewayId: event.address.gatewayId, eventId: event.eventKey, messageId: event.message.opaqueId, parentMessageId: event.parentMessage?.opaqueId ?? null,
    chatId: event.address.conversation.opaqueId, topicId: event.address.thread?.opaqueId ?? null, rootMessageId: event.address.rootMessage?.opaqueId ?? null,
    actorOpenId: event.actor.opaqueId, text: event.text, mentionsBot: event.mentionsAgent, isRootMessage: event.isRoot, hasUnsupportedContent: event.hasUnsupportedContent, inputTooLarge: event.inputTooLarge ?? false
  };
}

function toLegacyAction(event: Extract<GatewayInboundEvent, { kind: "interaction.invoked" }>): IncomingLarkCardAction {
  return {
    messageId: event.sourceMessage.opaqueId, chatId: event.address.conversation.opaqueId, operatorOpenId: event.actor.opaqueId,
    value: event.commandPayload, option: event.option, formValues: { ...event.values }
  };
}

function toGatewayResponse(response: LarkCardActionResult | void): GatewayIngressResponse {
  if (!response) return;
  return {
    ...(response.toast ? { toast: { level: response.toast.type, text: response.toast.content } } : {}),
    ...(response.card ? { replaceView: response.card } : {})
  };
}

