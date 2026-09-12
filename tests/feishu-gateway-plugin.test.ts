import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { LarkPort } from "../src/domain/ports/external.js";
import { createFeishuGatewayPlugin, requireFeishuCompatibilityPort } from "../src/gateways/feishu/plugin.js";

function transport(): LarkPort {
  return {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), isReady: vi.fn(() => true),
    createTopic: vi.fn(async () => ({ topicId: "topic", rootMessageId: "root" })),
    replyText: vi.fn(async () => ({ messageId: "message" })), replyCard: vi.fn(async () => ({ messageId: "message" })),
    updateCard: vi.fn(async () => {}), shareThread: vi.fn(async () => ({ messageId: "shared" }))
  };
}

describe("Feishu Gateway plugin", () => {
  it("exposes a frozen negotiated profile and preserves the compatibility transport", async () => {
    const lark = transport();
    const plugin = createFeishuGatewayPlugin({ createTransport: () => lark });
    const gateway = plugin.create({ gatewayId: "feishu:primary", appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, { logger: pino({ enabled: false }) });

    expect(plugin.manifest).toEqual({ kind: "feishu", pluginVersion: "1.0.0", protocolVersion: 1 });
    expect(gateway.profile).toMatchObject({ id: "feishu-cardkit-v1", capabilities: { conversations: { threads: "native", share: true }, presentation: { actions: "forms", incremental: { mode: "sequenced-region" } } } });
    expect(Object.isFrozen(gateway.profile)).toBe(true);
    expect(requireFeishuCompatibilityPort(gateway)).toBe(lark);
    expect(gateway.snapshot()).toMatchObject({ gatewayId: "feishu:primary", kind: "feishu", ingress: { ready: true }, delivery: { ready: true } });
  });
});
