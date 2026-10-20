import { describe, expect, it, vi } from "vitest";
import { DurableInboundPipeline } from "../src/coordinator/durable-inbound-pipeline.js";

const authorizationMessage = {
  eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "message-1",
  actorOpenId: "ou_member", text: "inspect this", mentionsBot: true, isRootMessage: true
};

function harness(allowedOpenIds = ["ou_member"]) {
  const store = {
    isBridgeMessage: vi.fn(() => false), recordInboundMessage: vi.fn(() => true), recoverProcessingInboundMessages: vi.fn(() => 0),
    claimNextInboundMessage: vi.fn(() => null), markInboundMessageAccepted: vi.fn(), releaseInboundMessage: vi.fn()
  };
  const inboundWork = { subscribe: vi.fn(() => () => {}), notify: vi.fn(async () => undefined) };
  const router = { route: vi.fn(async () => ({ decision: "prompt", disposition: "prompt_queued" as const })) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { pipeline: new DurableInboundPipeline({ chatId: "chat", allowedOpenIds, store, router, inboundWork, logger } as never), store, router, inboundWork, logger };
}

describe("DurableInboundPipeline admission", () => {
  it("persists only a compact marker and emits a content-free hint for oversized input", async () => {
    const h = harness();
    const oversized = { ...authorizationMessage, text: "x".repeat(12_001) };

    await h.pipeline.receive(oversized);

    expect(h.store.recordInboundMessage).toHaveBeenCalledWith({
      ...oversized,
      text: "",
      input: { schemaVersion: 2, text: "" },
      inputTooLarge: true
    });
    expect(h.inboundWork.notify).toHaveBeenCalledWith(expect.objectContaining({ payload: { eventId: oversized.eventId } }));
    expect(JSON.stringify(h.inboundWork.notify.mock.calls)).not.toContain(oversized.text);
  });

  it("does not persist a message from an unapproved group member", async () => {
    const h = harness(["ou_allowed"]);
    await h.pipeline.receive(authorizationMessage);
    expect(h.store.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.inboundWork.notify).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ actorOpenId: "ou_member", reason: "actor_not_allowed" }), expect.any(String));
  });

  it("persists work only once for an explicitly approved member", async () => {
    const h = harness();
    await h.pipeline.receive(authorizationMessage);
    expect(h.store.recordInboundMessage).toHaveBeenCalledWith({
      ...authorizationMessage,
      input: { schemaVersion: 2, text: authorizationMessage.text }
    });
  });
});
