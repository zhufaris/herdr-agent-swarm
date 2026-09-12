import { describe, expect, it, vi } from "vitest";
import { GatewayEffectClient } from "../src/gateways/effect-client.js";
import type { GatewayDeliveryPort } from "../src/gateways/contract/plugin.js";

describe("GatewayEffectClient", () => {
  it("executes provider-neutral conversation effects and resolves namespaced receipts", async () => {
    const execute = vi.fn(async () => ({ refs: [
      { gatewayId: "memory:test", kind: "thread" as const, opaqueId: "thread-1" },
      { gatewayId: "memory:test", kind: "message" as const, opaqueId: "message-1" }
    ] }));
    const delivery: GatewayDeliveryPort = {
      prepare: (intent) => ({ protocolVersion: 1, gatewayId: "memory:test", profileId: "plain-v1", rendererRevision: 1, operation: intent.kind, intent }),
      execute
    };

    await expect(new GatewayEffectClient(delivery).createConversation({ conversationId: "chat", view: { text: "hello" }, idempotencyKey: "binding-1", purpose: "primary-main" })).resolves.toEqual({ threadId: "thread-1", rootMessageId: "message-1" });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operation: "conversation.create" }), expect.objectContaining({ idempotencyKey: "binding-1", priorCheckpoints: [] }));
  });

  it("fails closed when the provider omits required external identity", async () => {
    const delivery: GatewayDeliveryPort = {
      prepare: (intent) => ({ protocolVersion: 1, gatewayId: "memory:test", profileId: "plain-v1", rendererRevision: 1, operation: intent.kind, intent }),
      async execute() { return { refs: [] }; }
    };
    await expect(new GatewayEffectClient(delivery).replyText({ rootMessageId: "root", text: "failed", idempotencyKey: "failure", purpose: "operation-result" })).rejects.toThrow("no message identity");
  });
});
