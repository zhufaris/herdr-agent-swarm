import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { InboundMessageRoutingWorkflow } from "../src/coordinator/inbound-message-routing-workflow.js";
import { PermanentInboundMessageRejection } from "../src/domain/permanent-inbound-message-rejection.js";

describe("InboundMessageRoutingWorkflow instance commands", () => {
  it("turns a stopped Worker rejection into a durable terminal disposition", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const instanceInteractions = { handleCommand: vi.fn(async () => { throw new Error("Target instance is not running"); }) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      store: { findBindingByLarkScope: vi.fn(() => null), getConversationTarget: vi.fn(() => null) },
      outbound, instanceInteractions, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-1", messageId: "message-1", chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "operator", text: "/to test continue", mentionsBot: false, isRootMessage: true };

    await expect(workflow.handle(message)).rejects.toEqual(expect.objectContaining({
      name: PermanentInboundMessageRejection.name, message: "Target instance is not running"
    }));
    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:message-1", expect.any(Object));
  });
});
