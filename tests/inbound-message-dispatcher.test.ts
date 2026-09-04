import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { InboundMessageDispatcher } from "../src/coordinator/inbound-message-dispatcher.js";
import { PermanentInboundMessageRejection } from "../src/domain/permanent-inbound-message-rejection.js";
import { InProcessInboundWorkNotifier } from "../src/events/inbound-work-notifier.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

const authorizationMessage = {
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

    await h.dispatcher.handleMessage(authorizationMessage);

    expect(h.store.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.inboundWork.notify).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ actorOpenId: "ou_member", reason: "actor_not_allowed" }), expect.any(String));
  });

  it("persists work only for an explicitly approved member", async () => {
    const h = harness();

    await h.dispatcher.handleMessage(authorizationMessage);

    expect(h.store.recordInboundMessage).toHaveBeenCalledWith(authorizationMessage);
  });
});

describe("InboundMessageDispatcher durable FIFO", () => {
  it("acknowledges a permanent rejection and continues the durable FIFO", async () => {
    const store = new SqliteBindingStore(":memory:");
    const inboundWork = new InProcessInboundWorkNotifier();
    const accepted: string[] = [];
    inboundWork.subscribe(({ payload }) => {
      if (payload.eventId === "stopped-worker") throw new PermanentInboundMessageRejection("Target instance is not running");
      accepted.push(payload.eventId);
    });
    const dispatcher = new InboundMessageDispatcher({ chatId: "chat", allowedOpenIds: ["operator"], store, inboundWork, logger: pino({ enabled: false }) });

    try {
      dispatcher.start();
      await dispatcher.handleMessage(message("stopped-worker", "/to test continue"));
      await dispatcher.handleMessage(message("instances", "/instances"));

      expect(accepted).toEqual(["instances"]);
      expect(store.database.prepare("SELECT event_id, state, error FROM inbound_messages ORDER BY event_id").all()).toEqual([
        { event_id: "instances", state: "accepted", error: null },
        { event_id: "stopped-worker", state: "accepted", error: null }
      ]);
      expect(dispatcher.snapshot()).toMatchObject({ state: "idle", retryAttempt: 0, nextRetryAt: null });
    } finally {
      await dispatcher.stop();
      store.close();
    }
  });
});

function message(eventId: string, text: string) {
  return { eventId, messageId: `${eventId}-message`, chatId: "chat", topicId: null, rootMessageId: null, actorOpenId: "operator", text, mentionsBot: false, isRootMessage: true };
}
