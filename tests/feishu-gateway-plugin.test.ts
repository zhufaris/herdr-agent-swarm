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

  it("executes exact-message deletion and preserves the normalized outcome", async () => {
    const deleteMessage = vi.fn(async () => "already_absent" as const);
    const plugin = createFeishuGatewayPlugin({ createTransport: () => ({ ...transport(), deleteMessage }) });
    const gateway = plugin.create({ gatewayId: "feishu:primary", appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, { logger: pino({ enabled: false }) });
    const plan = gateway.delivery.prepare({ kind: "message.delete", purpose: "primary-answer", messageId: "answer-message-1", idempotencyKey: "delete-1" });

    await expect(gateway.delivery.execute(plan, deliveryContext)).resolves.toEqual({ refs: [], messageDeleteOutcome: "already_absent" });
    expect(deleteMessage).toHaveBeenCalledWith("answer-message-1");
  });

  it("fails closed when the Feishu transport cannot delete messages", async () => {
    const plugin = createFeishuGatewayPlugin({ createTransport: () => transport() });
    const gateway = plugin.create({ gatewayId: "feishu:primary", appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, { logger: pino({ enabled: false }) });
    const plan = gateway.delivery.prepare({ kind: "message.delete", purpose: "primary-answer", messageId: "answer-message-1", idempotencyKey: "delete-1" });

    await expect(gateway.delivery.execute(plan, deliveryContext)).rejects.toMatchObject({
      failure: { failureClass: "permanent", effectCertainty: "rejected", safeMessage: "Feishu Gateway does not support message deletion" }
    });
  });

  it("rejects non-JSON interaction commands before they cross the Gateway contract", async () => {
    let onAction: Exclude<Parameters<LarkPort["start"]>[1], undefined> | undefined;
    const lark = {
      ...transport(),
      start: vi.fn(async (_onMessage: Parameters<LarkPort["start"]>[0], action?: Parameters<LarkPort["start"]>[1]) => { onAction = action; })
    } satisfies LarkPort;
    const gateway = createFeishuGatewayPlugin({ createTransport: () => lark }).create(
      { gatewayId: "feishu:primary", appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      { logger: pino({ enabled: false }) }
    );
    const accept = vi.fn(async () => undefined);
    await gateway.ingress.start({ accept });

    await expect(onAction!({
      messageId: "message-1",
      chatId: "chat",
      operatorOpenId: "actor-1",
      value: { action: "session_status", invalid: undefined }
    })).rejects.toThrow();
    expect(accept).not.toHaveBeenCalled();
  });

});
