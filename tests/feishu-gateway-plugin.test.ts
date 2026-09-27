import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { LarkPort } from "../src/domain/ports/external.js";
import { createFeishuGatewayPlugin, requireFeishuCompatibilityPort } from "../src/gateways/feishu/plugin.js";

function transport(): LarkPort {
  return {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), isReady: vi.fn(() => true),
    createTopic: vi.fn(async () => ({ topicId: "topic", rootMessageId: "root" })),
    replyText: vi.fn(async () => ({ messageId: "message" })), replyCard: vi.fn(async () => ({ messageId: "message" })),
    replyRichText: vi.fn(async () => ({ messageId: "rich-message" })), updateRichText: vi.fn(async () => {}),
    updateCard: vi.fn(async () => {}), shareThread: vi.fn(async () => ({ messageId: "shared" }))
  };
}

const deliveryContext = { attemptId: "attempt", leaseFencingToken: 1, idempotencyKey: "key", priorCheckpoints: [], checkpoint: vi.fn(async () => {}) };

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

  it("materializes provider-neutral rich text for ordinary reply and update operations", async () => {
    const lark = transport();
    const gateway = createFeishuGatewayPlugin({ createTransport: () => lark }).create(
      { gatewayId: "feishu:primary", appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      { logger: pino({ enabled: false }) }
    );
    const document = { markdown: "Answer **body** ▌" };

    const reply = gateway.delivery.prepare({ kind: "message.reply.rich_text", purpose: "primary-answer", rootMessageId: "root", document, idempotencyKey: "answer-post:p1:0" });
    await expect(gateway.delivery.execute(reply, deliveryContext)).resolves.toEqual({ refs: [{ gatewayId: "feishu:primary", kind: "message", opaqueId: "rich-message" }] });

    const update = gateway.delivery.prepare({ kind: "message.update.rich_text", purpose: "primary-answer", messageId: "rich-message", document });
    await expect(gateway.delivery.execute(update, deliveryContext)).resolves.toEqual({ refs: [] });
    const payload = { zh_cn: { title: "", content: [[{ tag: "md", text: "Answer **body** ▌" }]] } };
    expect(lark.replyRichText).toHaveBeenCalledWith("root", payload, "answer-post:p1:0");
    expect(lark.updateRichText).toHaveBeenCalledWith("rich-message", payload);
  });
});
