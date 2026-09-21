import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { LarkPort } from "../src/domain/ports/external.js";
import type { ConversationGatewayPlugin, GatewayInboundEvent } from "../src/gateways/contract/plugin.js";
import { createFeishuGatewayPlugin } from "../src/gateways/feishu/plugin.js";
import { createInMemoryGatewayPlugin, type InMemoryGatewayControl } from "./helpers/in-memory-gateway-plugin.js";

interface Harness { plugin: ConversationGatewayPlugin<{ gatewayId: string }>; config: { gatewayId: string }; emit(event: GatewayInboundEvent): Promise<void>; }

function memoryHarness(): Harness {
  const control: InMemoryGatewayControl = { delivered: [], async emit() { throw new Error("not started"); } };
  return { plugin: createInMemoryGatewayPlugin(control), config: { gatewayId: "memory:test" }, async emit(event) { await control.emit(event); } };
}
function feishuHarness(): Harness {
  let onMessage: ((message: import("../src/domain/types.js").IncomingLarkMessage) => Promise<void>) | null = null;
  const transport: LarkPort = {
    async start(handler) { onMessage = handler; }, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "topic", rootMessageId: "root" }; }, async replyText() { return { messageId: "message" }; }, async replyCard() { return { messageId: "message" }; }, async updateCard() {}, async shareThread() { return { messageId: "shared" }; }
  };
  return {
    plugin: createFeishuGatewayPlugin({ createTransport: () => transport }) as ConversationGatewayPlugin<{ gatewayId: string }>, config: { gatewayId: "feishu:test" },
    async emit(event) {
      if (event.kind !== "message.received" || !onMessage) throw new Error("unsupported test event");
      await onMessage({ eventId: event.eventKey, messageId: event.message.opaqueId, parentMessageId: event.parentMessage?.opaqueId ?? null, chatId: event.address.conversation.opaqueId, topicId: event.address.thread?.opaqueId ?? null, rootMessageId: event.address.rootMessage?.opaqueId ?? null, actorOpenId: event.actor.opaqueId, text: event.text, mentionsBot: event.mentionsAgent, isRootMessage: event.isRoot, hasUnsupportedContent: event.hasUnsupportedContent });
    }
  };
}

describe.each([["Feishu", feishuHarness], ["memory", memoryHarness]] as const)("%s Gateway contract", (_name, createHarness) => {
  it("starts ingress, emits normalized namespaced events, and reports readiness", async () => {
    const harness = createHarness();
    const session = harness.plugin.create(harness.config, { logger: pino({ enabled: false }) });
    const accept = vi.fn(async () => undefined);
    await session.ingress.start({ accept });
    const event: GatewayInboundEvent = { schemaVersion: 1, kind: "message.received", eventKey: "event-1", occurredAt: "2026-09-12T00:00:00.000Z", address: { gatewayId: session.gatewayId, conversation: { gatewayId: session.gatewayId, kind: "conversation", opaqueId: "chat" }, thread: null, rootMessage: { gatewayId: session.gatewayId, kind: "message", opaqueId: "root" } }, message: { gatewayId: session.gatewayId, kind: "message", opaqueId: "message" }, parentMessage: null, actor: { gatewayId: session.gatewayId, kind: "actor", opaqueId: "actor" }, text: "hello", mentionsAgent: true, isRoot: false, hasUnsupportedContent: false, inputTooLarge: false };

    await harness.emit(event);

    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ kind: "message.received", address: expect.objectContaining({ gatewayId: session.gatewayId }), actor: expect.objectContaining({ gatewayId: session.gatewayId }) }));
    expect(session.snapshot().ingress.ready).toBe(true);
    await session.close();
  });
});
