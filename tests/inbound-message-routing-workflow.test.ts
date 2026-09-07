import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { InboundMessageRoutingWorkflow } from "../src/coordinator/inbound-message-routing-workflow.js";
import { PermanentInboundMessageRejection } from "../src/domain/permanent-inbound-message-rejection.js";
import { primaryPresentation } from "./helpers/presentation.js";

describe("InboundMessageRoutingWorkflow instance commands", () => {
  it("routes an active-topic reply to the Primary FIFO without consulting Worker targeting", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "root", state: "active", lifecycle: "active", generation: 1 };
    const store = {
      findBindingByLarkScope: vi.fn(() => binding),
      getConversationTarget: vi.fn(() => null),
      countPendingPrompts: vi.fn(() => 0),
      acceptPrompt: vi.fn(() => ({ inserted: false, prompt: { id: "primary-prompt" } }))
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => true) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      store, instanceInteractions, promptRun: { activeTurn: vi.fn(() => null) }, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-worker-reply", messageId: "message-worker-reply", parentMessageId: "worker-task-card", chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(store.acceptPrompt).toHaveBeenCalledOnce();
  });

  it("falls back to the active Primary FIFO when the replied card is not a Worker Task Card", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "root", title: "Primary", state: "active", lifecycle: "active", generation: 1 };
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), getConversationTarget: vi.fn(() => null), countPendingPrompts: vi.fn(() => 0),
      acceptPrompt: vi.fn(() => ({ inserted: false, prompt: { id: "primary-prompt" } }))
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => false) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [{ id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" }], lark: { adminOpenIds: [] }, maxQueueDepth: 20 },
      store, instanceInteractions, promptRun: { activeTurn: vi.fn(() => null) }, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-primary-reply", messageId: "message-primary-reply", parentMessageId: "primary-card", chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue primary", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(store.acceptPrompt).toHaveBeenCalledOnce();
  });

  it("keeps a Lark-flattened Task Card reply on the Primary FIFO instead of guessing a Worker", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "primary-root", title: "Primary", state: "active", lifecycle: "active", generation: 1 };
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), getConversationTarget: vi.fn(() => null), countPendingPrompts: vi.fn(() => 0),
      acceptPrompt: vi.fn(() => ({ inserted: false, prompt: { id: "primary-prompt" } }))
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => false) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [{ id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" }], lark: { adminOpenIds: [] }, maxQueueDepth: 20 },
      store, instanceInteractions, promptRun: { activeTurn: vi.fn(() => null) }, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = {
      eventId: "event-flattened-card-reply", messageId: "text-created-from-task-card-reply",
      parentMessageId: "primary-root", rootMessageId: "primary-root", topicId: "topic-1",
      chatId: "chat", actorOpenId: "operator", text: "continue the worker", mentionsBot: true, isRootMessage: false
    };

    await workflow.handle(message);

    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(store.acceptPrompt).toHaveBeenCalledOnce();
  });

  it("turns a stopped Worker rejection into a durable terminal disposition", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const instanceInteractions = { handleCommand: vi.fn(async () => { throw new Error("Target instance is not running"); }) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      store: { findBindingByLarkScope: vi.fn(() => null), getConversationTarget: vi.fn(() => null) },
      outbound, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-1", messageId: "message-1", chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "operator", text: "/to test continue", mentionsBot: false, isRootMessage: true };

    await expect(workflow.handle(message)).rejects.toEqual(expect.objectContaining({
      name: PermanentInboundMessageRejection.name, message: "Target instance is not running"
    }));
    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:message-1", expect.any(Object));
  });
});
