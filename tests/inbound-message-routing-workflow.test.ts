import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { BindingPromptWorkflow } from "../src/coordinator/binding-prompt-workflow.js";
import { InboundMessageRoutingWorkflow } from "../src/coordinator/inbound-message-routing-workflow.js";
import { PromptAdmissionWorkflow } from "../src/coordinator/prompt-admission-workflow.js";
import { InstanceTurnCapacityExceeded } from "../src/domain/instance-turn-capacity-error.js";
import { InstanceTargetError } from "../src/domain/instance-target-error.js";
import { primaryPresentation } from "./helpers/presentation.js";

describe("InboundMessageRoutingWorkflow instance commands", () => {
  it("stages one durable confirmation for literal /swarm clear", async () => {
    const binding = { id: "binding-1", kind: "orchestrator", projectId: "p1", workspaceId: "w1", paneId: "w1:p1", rootMessageId: "root", state: "active", lifecycle: "active", generation: 1 };
    const context = { chatId: "chat", topicId: "topic", rootMessageId: "root", sourceMessageId: "message-clear", actorOpenId: "admin", projectId: "p1", workspaceId: "w1", primary: { bindingId: "binding-1", bindingGeneration: 1, paneId: "w1:p1", terminalId: "terminal-1", nativeSession: null, activePromptId: null } };
    const swarmCommands = { submit: vi.fn(async () => ({ outcome: "confirmation-required" as const, commandKind: "clear" as const, context })) };
    const requestSwarmConfirmation = vi.fn(async () => undefined);
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: ["admin"] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false) }),
      swarmCommands, naturalLanguage: { interpreter: { interpret: vi.fn() }, workflow: { handle: vi.fn(), requestSwarmConfirmation } },
      presentation: primaryPresentation, logger: pino({ enabled: false })
    });
    const message = { eventId: "event-clear", messageId: "message-clear", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "admin", text: "/swarm clear", mentionsBot: true, isRootMessage: false };

    await expect(workflow.route(message)).resolves.toMatchObject({ decision: "command:clear", disposition: "command_completed" });
    expect(requestSwarmConfirmation).toHaveBeenCalledWith(message, { kind: "clear" }, context);
  });

  it("durably rejects oversized input before routing or prompt acceptance", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workerSessionThreads = { handleMessage: vi.fn() };
    const store = { findBindingByLarkScope: vi.fn(), isBindingThreadAlias: vi.fn(), acceptPromptWithEffects: vi.fn() };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } }, stores: inboundStores(store), outbound, workerSessionThreads,
      presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "oversized-event", messageId: "oversized-message", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "", mentionsBot: true, isRootMessage: false, inputTooLarge: true };

    await expect(workflow.route(message)).resolves.toMatchObject({ decision: "input-too-large", disposition: "rejected" });

    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:oversized-message", expect.any(Object));
    expect(workerSessionThreads.handleMessage).not.toHaveBeenCalled();
    expect(store.findBindingByLarkScope).not.toHaveBeenCalled();
    expect(store.acceptPromptWithEffects).not.toHaveBeenCalled();
  });

  it("returns the durable Agent Input identity for an accepted bound Primary message", async () => {
    const info = vi.fn();
    const binding = activePrimaryBinding({ title: "Primary" });
    const store = { findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false) };
    const agentInput = acceptedAgentInput("durable-submission");
    const workflow = routingWorkflow({
      config: { projects: [{ id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" }], lark: { adminOpenIds: [] }, maxQueueDepth: 20 },
      stores: inboundStores(store), agentInput, presentation: primaryPresentation, logger: { info, error: vi.fn() }
    } as never);
    const message = { eventId: "event-correlated", messageId: "message-correlated", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: false, isRootMessage: false };

    const routed = await workflow.route(message);

    expect(routed).toMatchObject({ bindingId: "binding-1", submissionId: "durable-submission", decision: "agent-input", disposition: "agent_input_accepted" });
    expect(info).not.toHaveBeenCalled();
  });

  it("emits one accepted log for a Worker Session thread route", async () => {
    const info = vi.fn();
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } }, stores: inboundStores({}),
      workerSessionThreads: { handleMessage: vi.fn(async () => ({ handled: true as const, disposition: "prompt_queued" as const })) },
      presentation: primaryPresentation, logger: { info, error: vi.fn() }
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: null, chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue with secret-token-value", mentionsBot: true, isRootMessage: false };

    const routed = await workflow.route(message);

    expect(routed).toEqual({ decision: "worker-session-thread", disposition: "prompt_queued" });
    expect(info).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain(message.text);
  });

  it("routes ordinary bot mentions in a bound Primary thread as Agent Input", async () => {
    const binding = activePrimaryBinding();
    const store = { findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false) };
    const agentInput = acceptedAgentInput();
    const naturalLanguage = { interpreter: { interpret: vi.fn(() => ({ outcome: "command", source: "deterministic", family: "swarm", command: { kind: "stop" } })) }, workflow: { handle: vi.fn() } };
    const workflow = routingWorkflow({ config: { projects: [], lark: { adminOpenIds: ["operator"] } }, stores: inboundStores(store), agentInput, naturalLanguage, presentation: primaryPresentation, logger: pino({ enabled: false }) });
    const mentioned = { eventId: "e1", messageId: "m1", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "停止当前任务", mentionsBot: true, isRootMessage: false };
    await workflow.route(mentioned);
    await workflow.route({ ...mentioned, eventId: "e2", messageId: "m2", mentionsBot: false });

    expect(agentInput.submit).toHaveBeenCalledTimes(2);
    expect(naturalLanguage.interpreter.interpret).not.toHaveBeenCalled();
    expect(naturalLanguage.workflow.handle).not.toHaveBeenCalled();
  });
  it("provisions the configured default project for a mentioned root task", async () => {
    const info = vi.fn();
    const selection = { id: "selection-1", commandMessageId: "message-1", chatId: "chat", topicId: "message-1", rootMessageId: "message-1", actorOpenId: "operator", initialPromptText: "ship it" };
    const binding = { id: "binding-1", gatewayId: "feishu:primary", projectId: "default", workspaceId: "w1", paneId: "w1:p1", traexSessionId: "terminal-1", agentKind: "traex", agentSessionAgent: null, agentSessionValue: null, rootMessageId: "thread-root", state: "active", lifecycle: "active", generation: 1, lastAgentState: "idle" };
    const provisioning = { selectProject: vi.fn(), provisionDefaultProject: vi.fn(async () => ({ binding, selection })) };
    const agentInput = acceptedAgentInput("initial-input");
    const acceptPromptWithEffects = vi.fn();
    const workflow = routingWorkflow({
      config: { gateway: { id: "feishu:primary" }, defaultProjectId: "default", projects: [], lark: { adminOpenIds: ["operator"] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), acceptPromptWithEffects }),
      provisioning, agentInput, presentation: primaryPresentation, logger: { info, error: vi.fn() }, primaryState: { activeTurn: vi.fn(() => null) }
    } as never);
    const message = { eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: "message-1", rootMessageId: "message-1", actorOpenId: "operator", text: "ship it", mentionsBot: true, isRootMessage: true };

    await expect(workflow.route(message)).resolves.toMatchObject({ decision: "create_binding", disposition: "agent_input_accepted", bindingId: "binding-1", submissionId: "initial-input" });

    expect(provisioning.provisionDefaultProject).toHaveBeenCalledWith(message, "ship it", "ship it");
    expect(provisioning.selectProject).not.toHaveBeenCalled();
    expect(agentInput.submit).toHaveBeenCalledWith(expect.objectContaining({ expectedSessionId: null, text: "ship it" }));
    expect(acceptPromptWithEffects).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain(message.text);
  });

  it("lazily initializes the enabled default-project Orchestrator for an allowed root mention", async () => {
    const selection = { id: "selection-orchestrator", commandMessageId: "message-orchestrator", chatId: "chat", topicId: null, rootMessageId: "message-orchestrator", actorOpenId: "allowed-user", initialPromptText: "coordinate this" };
    const binding = { id: "binding-orchestrator", kind: "orchestrator", gatewayId: "feishu:primary", projectId: "default", workspaceId: "w1", paneId: "w1:p1", traexSessionId: "terminal-1", agentKind: "traex", agentSessionAgent: null, agentSessionValue: null, rootMessageId: "thread-root", state: "active", lifecycle: "active", generation: 1 };
    const provisioning = {
      ensureOrchestrator: vi.fn(async () => ({ outcome: "initialized" as const, binding, selection })),
      provisionDefaultProject: vi.fn(), shareOrchestratorThread: vi.fn()
    };
    const promptAdmission = { accept: vi.fn(), acceptInitial: vi.fn(async () => ({ outcome: "accepted" as const, promptId: "initial-orchestrator-prompt" })) };
    const agentInput = acceptedAgentInput("initial-orchestrator-input");
    const naturalLanguage = { interpreter: { interpret: vi.fn(async () => ({ outcome: "unresolved" as const, reason: "not a control request" })) }, workflow: { handle: vi.fn() } };
    const workflow = routingWorkflow({
      config: { gateway: { id: "feishu:primary" }, defaultProjectId: "default", projects: [{ id: "default", displayName: "Default", description: "default", workspaceId: "w1", cwd: "/repo", orchestrator: { enabled: true, cwd: "/orchestrator" } }], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      provisioning, promptAdmission, agentInput, naturalLanguage, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-orchestrator", messageId: "message-orchestrator", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "message-orchestrator", actorOpenId: "allowed-user", text: "coordinate this", mentionsBot: true, isRootMessage: true };

    await expect(workflow.route(message)).resolves.toMatchObject({ decision: "orchestrator_initialize", disposition: "agent_input_accepted", bindingId: "binding-orchestrator", submissionId: "initial-orchestrator-input" });

    expect(provisioning.ensureOrchestrator).toHaveBeenCalledWith(message);
    expect(agentInput.submit).toHaveBeenCalledWith({
      ingressSource: "feishu:primary",
      sourceMessageKey: "message-orchestrator",
      actor: { kind: "human", id: "allowed-user", gatewayId: "feishu:primary", chatId: "chat", topicId: null, rootMessageId: "message-orchestrator" },
      text: "coordinate this",
      owner: { kind: "primary", id: "binding-orchestrator", generation: 1 },
      paneId: "w1:p1",
      terminalId: "terminal-1",
      expectedAgentKind: "traex",
      expectedSessionId: null
    });
    expect(promptAdmission.acceptInitial).not.toHaveBeenCalled();
    expect(provisioning.provisionDefaultProject).not.toHaveBeenCalled();
    expect(naturalLanguage.interpreter.interpret).not.toHaveBeenCalled();
  });

  it("shares the fixed Orchestrator Thread for later root mentions without submitting a Prompt", async () => {
    const binding = { id: "binding-orchestrator", kind: "orchestrator", projectId: "default", workspaceId: "w1", paneId: "w1:p1", topicId: "orchestrator-topic", rootMessageId: "thread-root", state: "active", lifecycle: "active", generation: 1 };
    const provisioning = {
      ensureOrchestrator: vi.fn(async () => ({ outcome: "existing" as const, binding })),
      provisionDefaultProject: vi.fn(), shareOrchestratorThread: vi.fn(async () => undefined)
    };
    const promptAdmission = { accept: vi.fn(), acceptInitial: vi.fn() };
    const workflow = routingWorkflow({
      config: { gateway: { id: "feishu:primary" }, defaultProjectId: "default", projects: [{ id: "default", displayName: "Default", description: "default", workspaceId: "w1", cwd: "/repo", orchestrator: { enabled: true, cwd: "/orchestrator" } }], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      provisioning, promptAdmission, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-later", messageId: "message-later", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "message-later", actorOpenId: "allowed-user", text: "do more work", mentionsBot: true, isRootMessage: true };

    await expect(workflow.route(message)).resolves.toMatchObject({ decision: "orchestrator_entry", disposition: "user_feedback", bindingId: "binding-orchestrator" });

    expect(provisioning.shareOrchestratorThread).toHaveBeenCalledWith(message, binding);
    expect(promptAdmission.accept).not.toHaveBeenCalled();
    expect(promptAdmission.acceptInitial).not.toHaveBeenCalled();
  });

  it("does not gate initial Agent Input on legacy Prompt capacity", async () => {
    const info = vi.fn();
    const selection = { id: "selection-full", commandMessageId: "message-full", chatId: "chat", topicId: "message-full", rootMessageId: "message-full", actorOpenId: "operator", initialPromptText: "ship it" };
    const binding = { id: "binding-full", gatewayId: "feishu:primary", projectId: "default", workspaceId: "w1", paneId: "w1:p1", traexSessionId: "terminal-1", agentKind: "traex", agentSessionAgent: null, agentSessionValue: null, rootMessageId: "thread-root", state: "active", lifecycle: "active", generation: 1, lastAgentState: "idle" };
    const acceptPromptWithEffects = vi.fn(() => { throw new Error("legacy Prompt path must not run"); });
    const workflow = routingWorkflow({
      config: { defaultProjectId: "default", projects: [], lark: { adminOpenIds: ["operator"] } },
      stores: inboundStores({
        findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), countPendingPrompts: vi.fn(() => 20),
        acceptPromptWithEffects
      }),
      provisioning: { provisionDefaultProject: vi.fn(async () => ({ binding, selection })) }, outbound: { enqueueCard: vi.fn(async () => undefined) },
      agentInput: acceptedAgentInput("initial-capacity-independent"), presentation: primaryPresentation, logger: { info, error: vi.fn() }, primaryState: { activeTurn: vi.fn(() => null) }
    } as never);
    const message = { eventId: "event-full", messageId: "message-full", parentMessageId: null, chatId: "chat", topicId: "message-full", rootMessageId: "message-full", actorOpenId: "operator", text: "ship it", mentionsBot: true, isRootMessage: true };

    await expect(workflow.route(message)).resolves.toMatchObject({ decision: "create_binding", disposition: "agent_input_accepted", bindingId: "binding-full" });

    expect(acceptPromptWithEffects).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("submits bound Primary Agent-native slash text unchanged through Agent Input", async () => {
    const binding = {
      id: "binding-1", gatewayId: "feishu:primary", projectId: "p1", workspaceId: "w1", paneId: "w1:primary",
      traexSessionId: "terminal-1", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1",
      agentKind: "traex", rootMessageId: "root", state: "active", lifecycle: "active", generation: 1, lastAgentState: "idle"
    };
    const promptAdmission = { accept: vi.fn(), acceptInitial: vi.fn() };
    const agentInput = { submit: vi.fn(async () => ({ outcome: "accepted" as const, submissionId: "submission-1", state: "prepared" as const })) };
    const naturalLanguage = { interpreter: { interpret: vi.fn() }, workflow: { handle: vi.fn(), requestSwarmConfirmation: vi.fn() } };
    const workflow = routingWorkflow({
      config: { gateway: { id: "feishu:primary" }, projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false) }),
      promptAdmission, agentInput, naturalLanguage, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-model", messageId: "message-model", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "  /model gpt-x  ", mentionsBot: true, isRootMessage: false };

    await expect(workflow.route(message)).resolves.toMatchObject({
      decision: "agent-input",
      disposition: "agent_input_accepted",
      bindingId: "binding-1",
      submissionId: "submission-1"
    });

    expect(agentInput.submit).toHaveBeenCalledWith({
      ingressSource: "feishu:primary",
      sourceMessageKey: "message-model",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root" },
      text: "  /model gpt-x  ",
      input: { schemaVersion: 2, text: "  /model gpt-x  " },
      owner: { kind: "primary", id: "binding-1", generation: 1 },
      paneId: "w1:primary",
      terminalId: "terminal-1",
      expectedAgentKind: "traex",
      expectedSessionId: "session-1"
    });
    expect(promptAdmission.accept).not.toHaveBeenCalled();
    expect(naturalLanguage.interpreter.interpret).not.toHaveBeenCalled();
  });

  it("preserves a matching path-based native session as the Core session fence", async () => {
    const binding = activePrimaryBinding({
      agentKind: "pi",
      agentSessionAgent: "pi",
      agentSessionKind: "path",
      agentSessionValue: "/sessions/pi-1"
    });
    const agentInput = acceptedAgentInput();
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false) }),
      agentInput, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-pi", messageId: "message-pi", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: false, isRootMessage: false };

    await expect(workflow.route(message)).resolves.toMatchObject({ decision: "agent-input", disposition: "agent_input_accepted" });
    expect(agentInput.submit).toHaveBeenCalledWith(expect.objectContaining({
      expectedAgentKind: "pi",
      expectedSessionId: "/sessions/pi-1"
    }));
  });

  it("fails closed before Agent Input admission for a Core-unsupported Primary agent kind", async () => {
    const binding = activePrimaryBinding({ agentKind: "codex", agentSessionAgent: "codex", agentSessionValue: "codex-session" });
    const agentInput = acceptedAgentInput();
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false) }),
      agentInput, outbound, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-codex", messageId: "message-codex", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: false, isRootMessage: false };

    await expect(workflow.route(message)).resolves.toMatchObject({ decision: "agent-input-unsupported", disposition: "rejected" });
    expect(agentInput.submit).not.toHaveBeenCalled();
    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:message-codex", expect.any(Object));
  });

  it("keeps slash characters inside ordinary bound Primary Agent Input", async () => {
    const binding = activePrimaryBinding();
    const agentInput = acceptedAgentInput("ordinary-submission");
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false) }),
      agentInput, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-path", messageId: "message-path", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "please inspect /tmp/output and compare a/b", mentionsBot: false, isRootMessage: false };

    await expect(workflow.route(message)).resolves.toMatchObject({
      decision: "agent-input",
      disposition: "agent_input_accepted",
      submissionId: "ordinary-submission"
    });
    expect(agentInput.submit).toHaveBeenCalledWith(expect.objectContaining({ text: message.text }));
  });

  it("shows a durable rejection when Core definitely cancels bound Primary Agent Input", async () => {
    const binding = activePrimaryBinding();
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const agentInput = { submit: vi.fn(async () => ({ outcome: "accepted" as const, submissionId: "cancelled-submission", state: "cancelled" as const })) };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false) }),
      agentInput, outbound, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-blocked", messageId: "message-blocked", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: false, isRootMessage: false };

    await expect(workflow.route(message)).resolves.toMatchObject({
      decision: "agent-input",
      disposition: "rejected",
      submissionId: "cancelled-submission"
    });
    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:message-blocked", expect.any(Object));
  });

  it("never routes /swarm commands through managed Primary prompt acceptance", async () => {
    const binding = { id: "binding-1", projectId: "p1", workspaceId: "w1", paneId: "w1:primary", rootMessageId: "root", state: "active", lifecycle: "active", generation: 1, lastAgentState: "idle" };
    const bindingPrompts = { acceptManagedInput: vi.fn() };
    const promptAdmission = new PromptAdmissionWorkflow({
      bindingPrompts,
      routing: { isBindingThreadAlias: vi.fn(() => false) },
      primaryState: { activeTurn: vi.fn(() => null) },
      outbound: { enqueueCard: vi.fn(async () => undefined) },
      presentation: primaryPresentation
    } as never);
    const swarmCommands = { submit: vi.fn(async () => ({ outcome: "accepted" as const })) };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false) }),
      promptAdmission, swarmCommands, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);

    await expect(workflow.route({ eventId: "event-status", messageId: "message-status", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "/swarm status", mentionsBot: false, isRootMessage: false }))
      .resolves.toMatchObject({ decision: "command:status", disposition: "command_completed" });
    await expect(workflow.route({ eventId: "event-steer", messageId: "message-steer", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "/swarm steer continue", mentionsBot: false, isRootMessage: false }))
      .resolves.toMatchObject({ decision: "command:steer", disposition: "command_completed" });

    expect(bindingPrompts.acceptManagedInput).not.toHaveBeenCalled();
    expect(swarmCommands.submit).toHaveBeenCalledTimes(2);
  });

  it("does not provision the default project for an unmentioned root message", async () => {
    const provisioning = { selectProject: vi.fn(), provisionDefaultProject: vi.fn() };
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workflow = routingWorkflow({
      config: { defaultProjectId: "default", projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      provisioning, outbound, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-plain", messageId: "message-plain", parentMessageId: null, chatId: "chat", topicId: "message-plain", rootMessageId: "message-plain", actorOpenId: "operator", text: "ordinary chat", mentionsBot: false, isRootMessage: true };

    await workflow.route(message);

    expect(provisioning.provisionDefaultProject).not.toHaveBeenCalled();
    expect(outbound.enqueueCard).toHaveBeenCalledOnce();
  });

  it("routes a fixed Worker Session thread before global commands or Primary binding lookup", async () => {
    const store = { findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => ({ handled: true as const, disposition: "command_completed" as const })) };
    const instanceInteractions = { handleCommand: vi.fn(), handleOrdinaryMessage: vi.fn() };
    const swarmCommands = { submit: vi.fn() };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } }, stores: inboundStores(store), instanceInteractions, workerSessionThreads, swarmCommands, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: null, chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "/status", mentionsBot: true, isRootMessage: false };

    await workflow.route(message);

    expect(workerSessionThreads.handleMessage).toHaveBeenCalledWith(message);
    expect(instanceInteractions.handleCommand).not.toHaveBeenCalled();
    expect(swarmCommands.submit).not.toHaveBeenCalled();
  });

  it("rejects a known stale Worker thread instead of falling through to Primary or provisioning", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const store = { findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => ({ handled: true as const, disposition: "rejected" as const })) };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn() };
    const provisioning = { selectProject: vi.fn() };
    const workflow = routingWorkflow({ config: { projects: [], lark: { adminOpenIds: [] } }, stores: inboundStores(store), outbound, instanceInteractions, workerSessionThreads, provisioning, presentation: primaryPresentation, logger: pino({ enabled: false }) });
    const message = { eventId: "stale-event", messageId: "stale-message", parentMessageId: null, chatId: "chat", topicId: "old-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await workflow.route(message);

    expect(workerSessionThreads.handleMessage).toHaveBeenCalledWith(message);
    expect(outbound.enqueueCard).not.toHaveBeenCalled();
    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(provisioning.selectProject).not.toHaveBeenCalled();
  });

  it("terminalizes a stopped Worker Thread message instead of retrying it", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => { throw new InstanceTargetError("instance_not_running"); }) };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      outbound, workerSessionThreads, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "stopped-worker-event", messageId: "stopped-worker-message", parentMessageId: null, chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await expect(workflow.route(message)).resolves.toMatchObject({ decision: "worker-session-thread", disposition: "rejected" });
    expect(outbound.enqueueCard).toHaveBeenCalledWith("worker-root", "rejected:stopped-worker-message", expect.any(Object));
  });

  it("keeps an unavailable Worker Session Thread message retryable when rejection reservation fails", async () => {
    const reservationFailure = new Error("database unavailable");
    const outbound = { enqueueCard: vi.fn(async () => { throw reservationFailure; }) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => { throw new InstanceTargetError("instance_not_running"); }) };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      outbound, workerSessionThreads, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: "worker-root", chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await expect(workflow.route(message)).rejects.toBe(reservationFailure);
  });

  it("keeps an unknown Worker Session Thread failure retryable", async () => {
    const workerFailure = new Error("database unavailable");
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => { throw workerFailure; }) };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      outbound, workerSessionThreads, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: "worker-root", chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await expect(workflow.route(message)).rejects.toBe(workerFailure);
    expect(outbound.enqueueCard).not.toHaveBeenCalled();
  });

  it("does not terminalize an untyped error that merely reuses an unavailable-target message", async () => {
    const workerFailure = new Error("Target instance is not running");
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const workerSessionThreads = { handleMessage: vi.fn(async () => { throw workerFailure; }) };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false) }),
      outbound, workerSessionThreads, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "worker-event", messageId: "worker-message", parentMessageId: "worker-root", chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await expect(workflow.route(message)).rejects.toBe(workerFailure);
    expect(outbound.enqueueCard).not.toHaveBeenCalled();
  });

  it("routes an active-topic reply to Primary Agent Input without consulting Worker targeting", async () => {
    const binding = activePrimaryBinding();
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false),
      getConversationTarget: vi.fn(() => null),
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => true) };
    const agentInput = acceptedAgentInput();
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores(store), agentInput, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-worker-reply", messageId: "message-worker-reply", parentMessageId: "worker-task-card", chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false };

    await workflow.route(message);

    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(agentInput.submit).toHaveBeenCalledOnce();
  });

  it("falls back to Primary Agent Input when the replied card is not a Worker Task Card", async () => {
    const binding = activePrimaryBinding({ title: "Primary" });
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false), getConversationTarget: vi.fn(() => null)
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => false) };
    const agentInput = acceptedAgentInput();
    const workflow = routingWorkflow({
      config: { projects: [{ id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" }], lark: { adminOpenIds: [] }, maxQueueDepth: 20 },
      stores: inboundStores(store), agentInput, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-primary-reply", messageId: "message-primary-reply", parentMessageId: "primary-card", chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue primary", mentionsBot: true, isRootMessage: false };

    await workflow.route(message);

    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(agentInput.submit).toHaveBeenCalledOnce();
  });

  it("keeps a Lark-flattened Task Card reply on Primary Agent Input instead of guessing a Worker", async () => {
    const binding = activePrimaryBinding({ rootMessageId: "primary-root", title: "Primary" });
    const store = {
      findBindingByLarkScope: vi.fn(() => binding), isBindingThreadAlias: vi.fn(() => false), getConversationTarget: vi.fn(() => null)
    };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => false) };
    const agentInput = acceptedAgentInput();
    const workflow = routingWorkflow({
      config: { projects: [{ id: "p1", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" }], lark: { adminOpenIds: [] }, maxQueueDepth: 20 },
      stores: inboundStores(store), agentInput, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = {
      eventId: "event-flattened-card-reply", messageId: "text-created-from-task-card-reply",
      parentMessageId: "primary-root", rootMessageId: "primary-root", topicId: "topic-1",
      chatId: "chat", actorOpenId: "operator", text: "continue the worker", mentionsBot: true, isRootMessage: false
    };

    await workflow.route(message);

    expect(instanceInteractions.handleOrdinaryMessage).not.toHaveBeenCalled();
    expect(agentInput.submit).toHaveBeenCalledOnce();
  });

  it("turns a stopped Worker rejection into a durable terminal disposition", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const instanceInteractions = { handleCommand: vi.fn(async () => { throw new InstanceTargetError("instance_not_running"); }) };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), getConversationTarget: vi.fn(() => null) }),
      outbound, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-1", messageId: "message-1", chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "operator", text: "/to test continue", mentionsBot: false, isRootMessage: true };

    await expect(workflow.route(message)).resolves.toMatchObject({ disposition: "rejected" });
    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:message-1", expect.any(Object));
  });

  it("turns a full Worker queue into a durable terminal disposition", async () => {
    const outbound = { enqueueCard: vi.fn(async () => undefined) };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => { throw new InstanceTurnCapacityExceeded(); }) };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), getConversationTarget: vi.fn(() => null) }),
      outbound, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-full", messageId: "message-full", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "operator", text: "send to worker", mentionsBot: false, isRootMessage: true };

    await expect(workflow.route(message)).resolves.toMatchObject({ disposition: "rejected" });
    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", "rejected:message-full", expect.any(Object));
  });

  it("keeps a full-queue message retryable when durable rejection reservation fails", async () => {
    const reservationFailure = new Error("database unavailable");
    const outbound = { enqueueCard: vi.fn(async () => { throw reservationFailure; }) };
    const instanceInteractions = { handleOrdinaryMessage: vi.fn(async () => { throw new InstanceTurnCapacityExceeded(); }) };
    const workflow = routingWorkflow({
      config: { projects: [], lark: { adminOpenIds: [] } },
      stores: inboundStores({ findBindingByLarkScope: vi.fn(() => null), isBindingThreadAlias: vi.fn(() => false), getConversationTarget: vi.fn(() => null) }),
      outbound, instanceInteractions, presentation: primaryPresentation, logger: pino({ enabled: false })
    } as never);
    const message = { eventId: "event-full", messageId: "message-full", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "operator", text: "send to worker", mentionsBot: false, isRootMessage: true };

    await expect(workflow.route(message)).rejects.toBe(reservationFailure);
  });
});

function inboundStores(store: Record<string, unknown>) {
  const legacyAcceptance = store.acceptPromptWithEffects as ((input: any) => { result: unknown }) | undefined;
  return {
    routing: store,
    promptAcceptance: {
      getCurrentGoal: () => null,
      hasAcceptedPromptSource: () => false,
      getNativeInputBacklog: () => ({ unbatchedInputCount: 0, pendingBatchCount: 0 }),
      formDueNativeInputBatch: () => ({ outcome: "none" }),
      acceptImmediateNativeInputBatch: (input: any) => {
        if (!legacyAcceptance) throw new Error("test Prompt acceptance is not configured");
        return legacyAcceptance({
          prompt: {
            id: input.batchId, bindingId: input.input.bindingId, larkMessageId: input.input.larkMessageId,
            actorOpenId: input.input.actorOpenId, body: input.combinedBody
          },
          view: input.view
        }).result;
      },
      acceptCollectingNativeInput: (input: any) => {
        if (!legacyAcceptance) throw new Error("test Prompt acceptance is not configured");
        legacyAcceptance({ prompt: { id: input.batchId, bindingId: input.input.bindingId }, view: null });
        return {
          inserted: true,
          input: { ...input.input, state: "queued", batchId: null, createdAt: input.occurredAt, updatedAt: input.occurredAt },
          batch: { id: input.batchId, bindingId: input.input.bindingId, bindingGeneration: input.input.bindingGeneration, state: "collecting", windowOpenedAt: input.occurredAt, drainDueAt: new Date(Date.parse(input.occurredAt) + input.windowMs).toISOString(), combinedBody: null, executionPromptId: null, formedAt: null, createdAt: input.occurredAt, updatedAt: input.occurredAt }
        };
      },
      ...store
    }
  } as never;
}

function routingWorkflow(options: Record<string, any>): InboundMessageRoutingWorkflow {
  const stores = options.stores ?? {};
  const routing = stores.routing ?? {};
  const promptStore = stores.promptAcceptance ?? {};
  const primaryState = options.primaryState ?? { activeTurn: () => null };
  const bindingPrompts = options.bindingPrompts ?? new BindingPromptWorkflow({
    config: options.config,
    store: promptStore,
    primaryState,
    lifecycleEvents: options.lifecycleEvents ?? { publish: async () => {} },
    outboundWork: options.outboundWork ?? { wake() {}, subscribe: () => () => {} },
    scheduler: options.scheduler ?? { wake() {}, subscribe: () => () => {} },
    presentation: options.presentation ?? primaryPresentation
  } as never);
  const promptAdmission = options.promptAdmission ?? new PromptAdmissionWorkflow({
    bindingPrompts,
    routing,
    primaryState,
    outbound: options.outbound ?? { enqueueCard: async () => {} },
    presentation: options.presentation ?? primaryPresentation
  } as never);
  return new InboundMessageRoutingWorkflow({ ...options, routing, promptAdmission } as never);
}

function activePrimaryBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "binding-1", gatewayId: "feishu:primary", projectId: "p1", workspaceId: "w1", paneId: "w1:primary",
    traexSessionId: "terminal-1", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1",
    agentKind: "traex", rootMessageId: "root", state: "active", lifecycle: "active", generation: 1, lastAgentState: "idle",
    ...overrides
  };
}

function acceptedAgentInput(submissionId = "submission-1") {
  return { submit: vi.fn(async () => ({ outcome: "accepted" as const, submissionId, state: "prepared" as const })) };
}
