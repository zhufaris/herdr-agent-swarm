import { describe, expect, it, vi } from "vitest";
import { InboundMessageDispatcher } from "../src/coordinator/inbound-message-dispatcher.js";

const message = {
  eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "message-1",
  actorOpenId: "ou_member", text: "inspect this", mentionsBot: true, isRootMessage: true
};

function harness(allowedOpenIds = ["ou_member"]) {
  const store = {
    isBridgeMessage: vi.fn(() => false), recordInboundMessage: vi.fn(() => true),
    recoverProcessingInboundMessages: vi.fn(() => 0), claimNextInboundMessage: vi.fn(() => null),
    markInboundMessageAccepted: vi.fn(), releaseInboundMessage: vi.fn()
  };
  const inboundWork = { notify: vi.fn(async () => undefined) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { dispatcher: new InboundMessageDispatcher({ chatId: "chat", allowedOpenIds, store, inboundWork, logger } as never), store, inboundWork, logger };
}

describe("InboundMessageDispatcher authorization", () => {
  it("does not persist a message from an unapproved group member", async () => {
    const h = harness(["ou_allowed"]);

    await h.dispatcher.handleMessage(message);

    expect(h.store.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.inboundWork.notify).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ actorOpenId: "ou_member", reason: "actor_not_allowed" }), expect.any(String));
  });

  it("persists work only for an explicitly approved member", async () => {
    const h = harness();

    await h.dispatcher.handleMessage(message);

    expect(h.store.recordInboundMessage).toHaveBeenCalledWith(message);
  });
});
