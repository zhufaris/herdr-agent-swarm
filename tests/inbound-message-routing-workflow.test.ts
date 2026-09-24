import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { InboundMessageRoutingWorkflow } from "../src/coordinator/inbound-message-routing-workflow.js";
import { PermanentInboundMessageRejection } from "../src/domain/permanent-inbound-message-rejection.js";
import { InstanceTurnCapacityExceeded } from "../src/domain/instance-turn-capacity-error.js";
import { InstanceTargetError } from "../src/domain/instance-target-error.js";
import { primaryPresentation } from "./helpers/presentation.js";

describe("InboundMessageRoutingWorkflow instance commands", () => {
  it("durably rejects oversized input before routing or prompt acceptance", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workerSessionThreads = { handleMessage: vi.fn() };
    const store = { findBindingByLarkScope: vi.fn(), isBindingThreadAlias: vi.fn(), acceptPromptWithEffects: vi.fn() };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } }, stores: inboundStores(store), outbound, workerSessionThreads,
      presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "oversized-event", messageId: "oversized-message", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "", mentionsBot: true, isRootMessage: false, inputTooLarge: true };

    await expect(workflow.handle(message)).rejects.toEqual(expect.objectContaining({ name: PermanentInboundMessageRejection.name }));

    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:oversized-message", expect.any(Object));
    expect(workerSessionThreads.handleMessage).not.toHaveBeenCalled();
    expect(store.findBindingByLarkScope).not.toHaveBeenCalled();
    expect(store.acceptPromptWithEffects).not.toHaveBeenCalled();
  });

  it("emits one accepted log with route and durable Prompt identity", async () => {
    const info = vi.fn();
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "root", title: "Primary", state: "active", lifecycle: "active", generation: 1 };
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false), countPendingPrompts: vi.fn(() => 0),
      acceptPromptWithEffects: vi.fn((input) => ({ result: { inserted: false, prompt: { ...input.prompt, id: "durable-prompt" }, view: input.view }, commitState: "committed", consumeEffects: () => [] }))
    };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [{ id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" }], lark: { adminOpenIds: [] }, maxQueueDepth: 20 },
      stores: inboundStores(store), primaryState: { activeTurn: vi.fn(() => null) }, presentation: primaryPresentation, logger: { info, error: vi.fn() }
    } as never);
    const message = { eventId: "event-correlated", messageId: "message-correlated", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: false, isRootMessage: false };

    await workflow.handle(message);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "lark-message-accepted", eventId: "event-correlated", messageId: "message-correlated", bindingId: "binding-1", promptId: "durable-prompt", decision: "prompt", disposition: "prompt_queued" }), "completed durable inbound handling");
  });

  it("emits one accepted log for a Worker Session thread route", async () => {
    const info = vi.fn();
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } }, stores: inboundStores({}),
      workerSessionThreads: { handleMessage: vi.fn(async () => ({ handled: true as const, disposition: "prompt_queued" as const })) },
      presentation: primaryPresentation, logger: { info, error: vi.fn() }
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: null, chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue with secret-token-value", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "lark-message-accepted", eventId: "worker-event", messageId: "worker-message", decision: "worker-session-thread", disposition: "prompt_queued" }), "completed durable inbound handling");
    expect(JSON.stringify(info.mock.calls)).not.toContain(message.text);
  });

  it("interprets only explicit mentions before the ordinary Primary prompt fallback", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "root", state: "active", lifecycle: "active", generation: 1 };
    const store = { findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false), countPendingPrompts: vi.fn(() => 0), acceptPromptWithEffects: vi.fn((input) => ({ result: { inserted: false, prompt: input.prompt, view: input.view }, commitState: "committed", consumeEffects: () => [] })) };
    const naturalLanguage = { interpreter: { interpret: vi.fn(() => ({ outcome: "command", source: "deterministic", family: "swarm", command: { kind: "stop" } })) }, workflow: { handle: vi.fn() } };
    const workflow = new InboundMessageRoutingWorkflow({ config: { projects: [], lark: { adminOpenIds: ["operator"] } }, stores: inboundStores(store), naturalLanguage, primaryState: { activeTurn: vi.fn(() => null) }, presentation: primaryPresentation, logger: pino({ enabled: false }) } as never);
    const mentioned = { eventId: "e1", messageId: "m1", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "停止当前任务", mentionsBot: true, isRootMessage: false };
    await workflow.handle(mentioned);
    expect(naturalLanguage.workflow.handle).toHaveBeenCalledOnce();
    expect(store.acceptPromptWithEffects).not.toHaveBeenCalled();

    await workflow.handle({ ...mentioned, eventId: "e2", messageId: "m2", mentionsBot: false });
    expect(naturalLanguage.interpreter.interpret).toHaveBeenCalledOnce();
    expect(store.acceptPromptWithEffects).toHaveBeenCalledOnce();
  });
  it("provisions the configured default project for a mentioned root task", async () => {
    const info = vi.fn();
    const selection = { id: "selection-1", commandMessageId: "message-1", initialPromptText: "ship it" };
    const binding = { id: "binding-1", projectId: "default", workspaceId: "w1", paneId: "w1:p1", rootMessageId: "thread-root", state: "active", lifecycle: "active", generation: 1 };
    const provisioning = { selectProject: vi.fn(), provisionDefaultProject: vi.fn(async () => ({ binding, selection })) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { defaultProjectId: "default", projects: [], lark: { adminOpenIds: ["operator"] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), countPendingPrompts: vi.fn(() => 0), acceptPromptWithEffects: vi.fn((input) => ({ result: { inserted: false, prompt: { ...input.prompt, id: "initial-durable-prompt" }, view: input.view }, commitState: "committed", consumeEffects: () => [] })) }),
      provisioning, presentation: primaryPresentation, logger: { info, error: vi.fn() }, primaryState: { activeTurn: vi.fn(() => null) }
    } as never);
    const message = { eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: "message-1", rootMessageId: "message-1", actorOpenId: "operator", text: "ship it", mentionsBot: true, isRootMessage: true };

    await workflow.handle(message);

    expect(provisioning.provisionDefaultProject).toHaveBeenCalledWith(message, "ship it", "ship it");
    expect(provisioning.selectProject).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "lark-message-accepted", eventId: "event-1", messageId: "message-1", promptId: "initial-durable-prompt", decision: "create_binding", disposition: "prompt_queued" }), "completed durable inbound handling");
    expect(JSON.stringify(info.mock.calls)).not.toContain(message.text);
  });

  it("does not claim an initial Prompt was queued when durable acceptance rejects it", async () => {
    const info = vi.fn();
    const selection = { id: "selection-full", commandMessageId: "message-full", initialPromptText: "ship it" };
    const binding = { id: "binding-full", projectId: "default", workspaceId: "w1", paneId: "w1:p1", rootMessageId: "thread-root", state: "active", lifecycle: "active", generation: 1 };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { defaultProjectId: "default", projects: [], lark: { adminOpenIds: ["operator"] } },
      stores: inboundStores({
        findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), countPendingPrompts: vi.fn(() => 20),
        acceptPromptWithEffects: vi.fn(() => { throw new Error("This topic's prompt queue is full"); })
      }),
      provisioning: { provisionDefaultProject: vi.fn(async () => ({ binding, selection })) }, outbound: { enqueueCard: vi.fn(async () => undefined) },
      presentation: primaryPresentation, logger: { info, error: vi.fn() }, primaryState: { activeTurn: vi.fn(() => null) }
    } as never);
    const message = { eventId: "event-full", messageId: "message-full", parentMessageId: null, chatId: "chat", topicId: "message-full", rootMessageId: "message-full", actorOpenId: "operator", text: "ship it", mentionsBot: true, isRootMessage: true };

    await workflow.handle(message);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "lark-message-accepted", promptId: undefined, decision: "create_binding", disposition: "rejected" }), "completed durable inbound handling");
  });

  it("does not provision the default project for an unmentioned root message", async () => {
    const provisioning = { selectProject: vi.fn(), provisionDefaultProject: vi.fn() };
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { defaultProjectId: "default", projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      provisioning, outbound, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-plain", messageId: "message-plain", parentMessageId: null, chatId: "chat", topicId: "message-plain", rootMessageId: "message-plain", actorOpenId: "operator", text: "ordinary chat", mentionsBot: false, isRootMessage: true };

    await workflow.handle(message);

    expect(provisioning.provisionDefaultProject).not.toHaveBeenCalled();
    expect(outbound.enqueueCard).toHaveBeenCalledOnce();
  });

  it("routes a fixed Worker Session thread before global commands or Primary binding lookup", async () => {
    const store = { findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => ({ handled: true as const, disposition: "command_completed" as const })) };
    const instanceInteractions = { handleCommand: vi.fn(), handleOrdinaryMessage: vi.fn() };
    const swarmCommands = { handle: vi.fn() };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } }, stores: inboundStores(store), instanceInteractions, workerSessionThreads, swarmCommands, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: null, chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "/status", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(workerSessionThreads.handleMessage).toHaveBeenCalledWith(message);
    expect(instanceInteractions.handleCommand).not.toHaveBeenCalled();
    expect(swarmCommands.handle).not.toHaveBeenCalled();
  });

  it("rejects a known stale Worker thread instead of falling through to Primary or provisioning", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const store = { findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => ({ handled: true as const, disposition: "rejected" as const })) };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn() };
    const provisioning = { selectProject: vi.fn() };
    const workflow = new InboundMessageRoutingWorkflow({ config: { projects: [], lark: { adminOpenIds: [] } }, stores: inboundStores(store), outbound, instanceInteractions, workerSessionThreads, provisioning, presentation: primaryPresentation, logger: pino({ enabled: false }) } as never);
    const message = { eventId: "stale-event", messageId: "stale-message", parentMessageId: null, chatId: "chat", topicId: "old-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(workerSessionThreads.handleMessage).toHaveBeenCalledWith(message);
    expect(outbound.enqueueCard).not.toHaveBeenCalled();
    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(provisioning.selectProject).not.toHaveBeenCalled();
  });

  it("terminalizes a stopped Worker Thread message instead of retrying it", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => { throw new InstanceTargetError("instance_not_running"); }) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      outbound, workerSessionThreads, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "stopped-worker-event", messageId: "stopped-worker-message", parentMessageId: null, chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await expect(workflow.handle(message)).rejects.toEqual(expect.objectContaining({
      name: PermanentInboundMessageRejection.name, message: "Target instance is not running"
    }));
    expect(outbound.enqueueCard).toHaveBeenCalledWith("worker-root", "rejected:stopped-worker-message", expect.any(Object));
  });

  it("keeps an unavailable Worker Session Thread message retryable when rejection reservation fails", async () => {
    const reservationFailure = new Error("database unavailable");
    const outbound = { enqueueCard: vi.fn(async () => { throw reservationFailure; }) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => { throw new InstanceTargetError("instance_not_running"); }) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      outbound, workerSessionThreads, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: "worker-root", chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await expect(workflow.handle(message)).rejects.toBe(reservationFailure);
  });

  it("keeps an unknown Worker Session Thread failure retryable", async () => {
    const workerFailure = new Error("database unavailable");
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => { throw workerFailure; }) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      outbound, workerSessionThreads, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: "worker-root", chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await expect(workflow.handle(message)).rejects.toBe(workerFailure);
    expect(outbound.enqueueCard).not.toHaveBeenCalled();
  });

  it("does not terminalize an untyped error that merely reuses an unavailable-target message", async () => {
    const workerFailure = new Error("Target instance is not running");
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => { throw workerFailure; }) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      outbound, workerSessionThreads, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: "worker-root", chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await expect(workflow.handle(message)).rejects.toBe(workerFailure);
    expect(outbound.enqueueCard).not.toHaveBeenCalled();
  });

  it("routes an active-topic reply to the Primary FIFO without consulting Worker targeting", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "root", state: "active", lifecycle: "active", generation: 1 };
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false),
      getConversationTarget: vi.fn(() => null),
      countPendingPrompts: vi.fn(() => 0),
      acceptPromptWithEffects: vi.fn(() => ({ result: { inserted: false, prompt: { id: "primary-prompt" } }, commitState: "committed", consumeEffects: () => [] }))
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => true) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores(store), instanceInteractions, primaryState: { activeTurn: vi.fn(() => null) }, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-worker-reply", messageId: "message-worker-reply", parentMessageId: "worker-task-card", chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(store.acceptPromptWithEffects).toHaveBeenCalledOnce();
  });

  it("falls back to the active Primary FIFO when the replied card is not a Worker Task Card", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "root", title: "Primary", state: "active", lifecycle: "active", generation: 1 };
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false), getConversationTarget: vi.fn(() => null), countPendingPrompts: vi.fn(() => 0),
      acceptPromptWithEffects: vi.fn(() => ({ result: { inserted: false, prompt: { id: "primary-prompt" } }, commitState: "committed", consumeEffects: () => [] }))
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => false) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [{ id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" }], lark: { adminOpenIds: [] }, maxQueueDepth: 20 },
      stores: inboundStores(store), instanceInteractions, primaryState: { activeTurn: vi.fn(() => null) }, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-primary-reply", messageId: "message-primary-reply", parentMessageId: "primary-card", chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue primary", mentionsBot: true, isRootMessage: false };

    await workflow.handle(message);

    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(store.acceptPromptWithEffects).toHaveBeenCalledOnce();
  });

  it("keeps a Lark-flattened Task Card reply on the Primary FIFO instead of guessing a Worker", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "primary-root", title: "Primary", state: "active", lifecycle: "active", generation: 1 };
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false), getConversationTarget: vi.fn(() => null), countPendingPrompts: vi.fn(() => 0),
      acceptPromptWithEffects: vi.fn(() => ({ result: { inserted: false, prompt: { id: "primary-prompt" } }, commitState: "committed", consumeEffects: () => [] }))
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => false) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [{ id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" }], lark: { adminOpenIds: [] }, maxQueueDepth: 20 },
      stores: inboundStores(store), instanceInteractions, primaryState: { activeTurn: vi.fn(() => null) }, presentation: primaryPresentation, logger: pino({ enabled: false })
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
    const instanceInteractions = { handleCommand: vi.fn(async () => { throw new InstanceTargetError("instance_not_running"); }) };
    const workflow = new InboundMessageRoutingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), getConversationTarget: vi.fn(() => null) }),
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
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), getConversationTarget: vi.fn(() => null) }),
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
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), getConversationTarget: vi.fn(() => null) }),
      outbound, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-full", messageId: "message-full", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "operator", text: "send to worker", mentionsBot: false, isRootMessage: true };

    await expect(workflow.handle(message)).rejects.toBe(reservationFailure);
  });
});

function inboundStores(store: Record<string, unknown>) {
  return { routing: store, promptAcceptance: store } as never;
}
