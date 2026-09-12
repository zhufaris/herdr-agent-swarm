import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { InboundMessageRoutingWorkflow } from "../src/coordinator/inbound-message-routing-workflow.js";
import { PermanentInboundMessageRejection } from "../src/domain/permanent-inbound-message-rejection.js";
import { InstanceTurnCapacityExceeded } from "../src/domain/instance-turn-capacity-error.js";
import { primaryPresentation } from "./helpers/presentation.js";

describe("InboundMessageRoutingWorkflow instance commands", () => {
  it("routes a fixed Worker Session thread before global commands or Primary binding lookup", async () => {
    const thread = { id: "thread-1", workerId: "worker-1", workerSessionGeneration: 1, rootMessageId: "worker-root" };
    const store = {
      findWorkerSessionThreadByScope: vi.fn(() => thread), findWorkerSessionThreadRecordByScope: vi.fn(() => thread), findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false)
    };
    const instanceInteractions = { handleWorkerThreadMessage: vi.fn(async () => undefined), handleCommand: vi.fn() };
    const swarmCommands = { handle: vi.fn() };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } }, store, instanceInteractions, swarmCommands, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: null, chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "/status", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(instanceInteractions.handleWorkerThreadMessage).toHaveBeenCalledWith(message, thread);
    expect(instanceInteractions.handleCommand).not.toHaveBeenCalled();
    expect(swarmCommands.handle).not.toHaveBeenCalled();
  });

  it("rejects a known stale Worker thread instead of falling through to Primary or provisioning", async () => {
    const stale = { id: "thread-old", workerId: "worker-old", workerSessionGeneration: 1, rootMessageId: "worker-root", state: "stale" };
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const store = {
      findWorkerSessionThreadByScope: vi.fn(() => null), findWorkerSessionThreadRecordByScope: vi.fn(() => stale), findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false)
    };
    const instanceInteractions = { handleWorkerThreadMessage: vi.fn(), handleOrdinaryMessage: vi.fn() };
    const provisioning = { selectProject: vi.fn() };
    const workflow = new InboundMessageRoutingWorkflow({ config: { projects: [], lark: { adminOpenIds: [] } }, store, outbound, instanceInteractions, provisioning, presentation: primaryPresentation, logger: pino({ enabled: false }) } as never);
    const message = { eventId: "stale-event", messageId: "stale-message", parentMessageId: null, chatId: "chat", topicId: "old-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(outbound.enqueueCard).toHaveBeenCalledWith("worker-root", "rejected:stale-message", expect.any(Object));
    expect(instanceInteractions.handleWorkerThreadMessage).not.toHaveBeenCalled();
    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(provisioning.selectProject).not.toHaveBeenCalled();
  });

  it("routes an active-topic reply to the Primary FIFO without consulting Worker targeting", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "root", state: "active", lifecycle: "active", generation: 1 };
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false), findWorkerSessionThreadByScope: vi.fn(() => null), findWorkerSessionThreadRecordByScope: vi.fn(() => null),
      getConversationTarget: vi.fn(() => null),
      countPendingPrompts: vi.fn(() => 0),
      acceptPromptWithEffects: vi.fn(() => ({ result: { inserted: false, prompt: { id: "primary-prompt" } }, commitState: "committed", consumeEffects: () => [] }))
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => true) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      store, instanceInteractions, promptRun: { activeTurn: vi.fn(() => null) }, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-worker-reply", messageId: "message-worker-reply", parentMessageId: "worker-task-card", chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(store.acceptPromptWithEffects).toHaveBeenCalledOnce();
  });

  it("falls back to the active Primary FIFO when the replied card is not a Worker Task Card", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "root", title: "Primary", state: "active", lifecycle: "active", generation: 1 };
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false), findWorkerSessionThreadByScope: vi.fn(() => null), findWorkerSessionThreadRecordByScope: vi.fn(() => null), getConversationTarget: vi.fn(() => null), countPendingPrompts: vi.fn(() => 0),
      acceptPromptWithEffects: vi.fn(() => ({ result: { inserted: false, prompt: { id: "primary-prompt" } }, commitState: "committed", consumeEffects: () => [] }))
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => false) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [{ id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" }], lark: { adminOpenIds: [] }, maxQueueDepth: 20 },
      store, instanceInteractions, promptRun: { activeTurn: vi.fn(() => null) }, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-primary-reply", messageId: "message-primary-reply", parentMessageId: "primary-card", chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue primary", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(store.acceptPromptWithEffects).toHaveBeenCalledOnce();
  });

  it("keeps a Lark-flattened Task Card reply on the Primary FIFO instead of guessing a Worker", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "primary-root", title: "Primary", state: "active", lifecycle: "active", generation: 1 };
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false), findWorkerSessionThreadByScope: vi.fn(() => null), findWorkerSessionThreadRecordByScope: vi.fn(() => null), getConversationTarget: vi.fn(() => null), countPendingPrompts: vi.fn(() => 0),
      acceptPromptWithEffects: vi.fn(() => ({ result: { inserted: false, prompt: { id: "primary-prompt" } }, commitState: "committed", consumeEffects: () => [] }))
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
    expect(store.acceptPromptWithEffects).toHaveBeenCalledOnce();
  });

  it("turns a stopped Worker rejection into a durable terminal disposition", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const instanceInteractions = { handleCommand: vi.fn(async () => { throw new Error("Target instance is not running"); }) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      store: { findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), findWorkerSessionThreadByScope: vi.fn(() => null), findWorkerSessionThreadRecordByScope: vi.fn(() => null), getConversationTarget: vi.fn(() => null) },
      outbound, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-1", messageId: "message-1", chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "operator", text: "/to test continue", mentionsBot: false, isRootMessage: true };

    await expect(workflow.handle(message)).rejects.toEqual(expect.objectContaining({
      name: PermanentInboundMessageRejection.name, message: "Target instance is not running"
    }));
    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:message-1", expect.any(Object));
  });

  it("turns a full Worker queue into a durable terminal disposition", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => { throw new InstanceTurnCapacityExceeded(); }) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      store: { findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), findWorkerSessionThreadByScope: vi.fn(() => null), findWorkerSessionThreadRecordByScope: vi.fn(() => null), getConversationTarget: vi.fn(() => null) },
      outbound, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-full", messageId: "message-full", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "operator", text: "send to worker", mentionsBot: false, isRootMessage: true };

    await expect(workflow.handle(message)).rejects.toEqual(expect.objectContaining({
      name: PermanentInboundMessageRejection.name, message: "Target instance queue is full"
    }));
    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:message-full", expect.any(Object));
  });

  it("keeps a full-queue message retryable when durable rejection reservation fails", async () => {
    const reservationFailure = new Error("database unavailable");
    const outbound = { enqueueCard: vi.fn(async () => { throw reservationFailure; }) };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => { throw new InstanceTurnCapacityExceeded(); }) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      store: { findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), findWorkerSessionThreadByScope: vi.fn(() => null), findWorkerSessionThreadRecordByScope: vi.fn(() => null), getConversationTarget: vi.fn(() => null) },
      outbound, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-full", messageId: "message-full", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "operator", text: "send to worker", mentionsBot: false, isRootMessage: true };

    await expect(workflow.handle(message)).rejects.toBe(reservationFailure);
  });
});
