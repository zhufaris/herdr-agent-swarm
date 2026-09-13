import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { InboundMessageDispatcher } from "../src/coordinator/inbound-message-dispatcher.js";
import { InboundMessageRoutingWorkflow } from "../src/coordinator/inbound-message-routing-workflow.js";
import { InstanceTurnCapacityExceeded } from "../src/domain/instance-turn-capacity-error.js";
import { PermanentInboundMessageRejection } from "../src/domain/permanent-inbound-message-rejection.js";
import { InProcessInboundWorkNotifier } from "../src/events/inbound-work-notifier.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { primaryPresentation } from "./helpers/presentation.js";

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
  it("continues an independent inbound scope when an earlier scope is retryable", async () => {
    const store = new SqliteBindingStore(":memory:");
    const inboundWork = new InProcessInboundWorkNotifier();
    const accepted: string[] = [];
    inboundWork.subscribe(({ payload }) => {
      if (payload.eventId === "a-stopped-worker") throw new Error("Target instance is not running");
      accepted.push(payload.eventId);
    });
    const dispatcher = new InboundMessageDispatcher({ chatId: "chat", allowedOpenIds: ["operator"], store, inboundWork, logger: pino({ enabled: false }) });

    try {
      store.recordInboundMessage({ ...message("a-stopped-worker", "hi"), rootMessageId: "stopped-worker-root" });
      store.recordInboundMessage({ ...message("b-later-stopped-worker", "later"), rootMessageId: "stopped-worker-root" });
      store.recordInboundMessage({ ...message("z-new", "/swarm new"), rootMessageId: "new-root" });
      dispatcher.start();
      await dispatcher.drain();

      expect(accepted).toEqual(["z-new"]);
      expect(store.database.prepare("SELECT event_id, state, error FROM inbound_messages ORDER BY event_id").all()).toEqual([
        { event_id: "a-stopped-worker", state: "received", error: "Target instance is not running" },
        { event_id: "b-later-stopped-worker", state: "received", error: null },
        { event_id: "z-new", state: "accepted", error: null }
      ]);
      expect(dispatcher.snapshot()).toMatchObject({ state: "retry_wait", retryAttempt: 1 });
    } finally {
      await dispatcher.stop();
      store.close();
    }
  });

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

  it("terminally rejects a full Worker queue and continues with later durable input", async () => {
    const store = new SqliteBindingStore(":memory:");
    const inboundWork = new InProcessInboundWorkNotifier();
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const instanceInteractions = {
      handleOrdinaryMessage: vi.fn(async () => { throw new InstanceTurnCapacityExceeded(); }),
      handleCommand: vi.fn(async () => undefined)
    };
    const routing = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } }, stores: { routing: store, promptAcceptance: store }, outbound, instanceInteractions,
      presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    inboundWork.subscribe(({ payload }) => routing.handle(payload));
    const dispatcher = new InboundMessageDispatcher({ chatId: "chat", allowedOpenIds: ["operator"], store, inboundWork, logger: pino({ enabled: false }) });

    try {
      store.recordInboundMessage(message("full-worker", "send to selected worker"));
      store.recordInboundMessage(message("instances", "/instances"));
      dispatcher.start();
      await dispatcher.drain();

      expect(outbound.enqueueCard).toHaveBeenCalledWith("full-worker-message", "rejected:full-worker-message", expect.any(Object));
      expect(instanceInteractions.handleCommand).toHaveBeenCalledOnce();
      expect(store.database.prepare("SELECT event_id, state, error FROM inbound_messages ORDER BY created_at, event_id").all()).toEqual([
        { event_id: "full-worker", state: "accepted", error: null },
        { event_id: "instances", state: "accepted", error: null }
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
