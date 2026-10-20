import { afterEach, describe, expect, it, vi } from "vitest";
import { BindingPromptWorkflow } from "../src/coordinator/binding-prompt-workflow.js";
import { PromptAdmissionWorkflow } from "../src/coordinator/prompt-admission-workflow.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { PromptCapacityExceeded } from "../src/domain/prompt-capacity-error.js";

const binding = { id: "binding", projectId: "project", workspaceId: "workspace", paneId: "workspace:p0", rootMessageId: "root", topicId: "topic", title: "Primary", agentKind: "traex", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", generation: 3 };
const message = { eventId: "event", messageId: "message", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", text: "continue", mentionsBot: false, isRootMessage: false };
const selection = { id: "selection", commandMessageId: "command-message", chatId: "chat", actorOpenId: "operator", initialPromptText: "initial work" };

afterEach(() => vi.useRealTimers());

function bindingSetup(overrides: Record<string, unknown> = {}) {
  const effects = [
    { kind: "outbound-wake" as const },
    { kind: "prompt-wake" as const, bindingId: binding.id },
    { kind: "lifecycle-event" as const, event: { type: "PromptQueued" } }
  ];
  const store = {
    countPendingPrompts: vi.fn(() => 2),
    hasAcceptedPromptSource: vi.fn(() => false),
    getNativeInputBacklog: vi.fn(() => ({ unbatchedInputCount: 0, pendingBatchCount: 0 })),
    getCurrentGoal: vi.fn(() => null),
    loadConversationTurnProjection: vi.fn(() => null),
    projectConversationTurn: vi.fn(() => ({ outcome: "projected", projection: null, supersededPromptIds: [], outboxReserved: false })),
    acceptPromptWithEffects: vi.fn((input: any) => ({ result: { inserted: true, prompt: input.prompt, view: input.view }, commitState: "committed", consumeEffects: () => effects })),
    acceptImmediateNativeInputBatch: vi.fn((input: any) => ({
      inserted: true,
      prompt: {
        id: input.batchId, bindingId: input.input.bindingId, larkMessageId: null, ingressSource: "feishu",
        sourceMessageKey: `feishu-batch:v1:${input.batchId}`, actorOpenId: input.input.actorOpenId,
        body: input.combinedBody, parentPromptId: input.input.parentPromptId, executionOrigin: "bridge",
        priority: "normal", wasDetached: false, dispatchedAt: null, nativeSubmissionId: input.batchId,
        transcriptTurnId: null, transcriptTurnStartedAt: null, modelName: null, modelRevision: null,
        observationState: "not_started", state: "queued", attemptCount: 0, error: null,
        createdAt: input.occurredAt, updatedAt: input.occurredAt
      },
      view: input.view
    })),
    acceptCollectingNativeInput: vi.fn((input: any) => ({
      inserted: true,
      input: { ...input.input, state: "queued", batchId: null, createdAt: input.occurredAt, updatedAt: input.occurredAt },
      batch: { id: input.batchId, bindingId: input.input.bindingId, bindingGeneration: input.input.bindingGeneration, state: "collecting", windowOpenedAt: input.occurredAt, drainDueAt: new Date(Date.parse(input.occurredAt) + input.windowMs).toISOString(), combinedBody: null, executionPromptId: null, formedAt: null, createdAt: input.occurredAt, updatedAt: input.occurredAt }
    })),
    formDueNativeInputBatch: vi.fn(() => ({ outcome: "none" })),
    audit: vi.fn(), ...overrides
  };
  const lifecycleEvents = { publish: vi.fn(async () => undefined) };
  const outboundWork = { wake: vi.fn(), subscribe: vi.fn() };
  const scheduler = { wake: vi.fn(), subscribe: vi.fn() };
  const convergeAnswer = vi.fn(async () => undefined);
  const workflow = new BindingPromptWorkflow({
    config: { projects: [{ id: "project", displayName: "Project", description: "Project", workspaceId: "workspace", cwd: "/repo" }], maxQueueDepth: 20 },
    store,
    lifecycleEvents,
    outboundWork,
    scheduler,
    convergeAnswer,
    presentation: primaryPresentation
  } as never);
  return { workflow, store, lifecycleEvents, outboundWork, scheduler, convergeAnswer };
}

function admissionSetup(overrides: Record<string, unknown> = {}) {
  const bindingPrompts = { acceptManagedInput: vi.fn(async () => ({ result: { inserted: true, prompt: { id: "managed-prompt" } }, commitState: "committed", consumeEffects: () => [] })), ...overrides };
  const outbound = { enqueueCard: vi.fn(async () => undefined) };
  const workflow = new PromptAdmissionWorkflow({
    bindingPrompts,
    routing: { isBindingThreadAlias: vi.fn(() => false) },
    primaryState: { activeTurn: vi.fn(() => ({ promptId: "parent" })) },
    outbound,
    presentation: primaryPresentation
  } as never);
  return { workflow, bindingPrompts, outbound };
}

describe("BindingPromptWorkflow", () => {
  it("schedules stale Answer-button cleanup for immediate native acceptance", async () => {
    const h = bindingSetup({
      countPendingPrompts: vi.fn(() => 0),
      acceptImmediateNativeInputBatch: vi.fn((input: any) => ({
        inserted: true, prompt: { id: input.batchId, bindingId: input.input.bindingId }, view: input.view,
        supersededPromptIds: ["old-answer"]
      }))
    });

    await h.workflow.acceptManagedInput({ binding: binding as never, body: message.text, actor: { openId: message.actorOpenId }, ingressSource: "feishu", sourceMessageKey: message.messageId, larkMessageId: message.messageId, parentPromptId: null, initialProjectionContext: { rootMessageId: "root" } });

    expect(h.convergeAnswer).toHaveBeenCalledWith("old-answer");
  });

  it("schedules stale Answer-button cleanup when native collection starts", async () => {
    const h = bindingSetup({
      acceptCollectingNativeInput: vi.fn((input: any) => ({
        inserted: true, input: { ...input.input, state: "queued", batchId: null, createdAt: input.occurredAt, updatedAt: input.occurredAt },
        batch: { id: input.batchId, bindingId: input.input.bindingId, bindingGeneration: input.input.bindingGeneration, state: "collecting", drainDueAt: "2026-10-02T01:00:02.000Z" },
        supersededPromptIds: ["old-answer"]
      }))
    });

    await h.workflow.acceptManagedInput({ binding: { ...binding, lastAgentState: "working" } as never, body: message.text, actor: { openId: message.actorOpenId }, ingressSource: "feishu", sourceMessageKey: message.messageId, larkMessageId: message.messageId, parentPromptId: null, initialProjectionContext: { rootMessageId: "root" } });

    expect(h.convergeAnswer).toHaveBeenCalledWith("old-answer");
  });

  it("schedules stale Answer-button cleanup when a collected native batch forms", async () => {
    const h = bindingSetup({
      formDueNativeInputBatch: vi.fn(() => ({
        outcome: "formed", prompt: { id: "formed", actorOpenId: "operator" }, view: { promptId: "formed" }, nextBatch: null,
        supersededPromptIds: ["late-old-answer"]
      }))
    });

    await h.workflow.drainDueNativeInputBatch("binding", "2026-10-02T01:00:02.000Z");

    expect(h.convergeAnswer).toHaveBeenCalledWith("late-old-answer");
  });

  it("forms one immediate Native Input Batch for settled ordinary Feishu input", async () => {
    const h = bindingSetup({ countPendingPrompts: vi.fn(() => 0) });
    const accepted = await h.workflow.acceptManagedInput({
      binding: binding as never,
      body: message.text,
      actor: { openId: message.actorOpenId },
      ingressSource: "feishu",
      sourceMessageKey: message.messageId,
      larkMessageId: message.messageId,
      parentPromptId: "parent",
      initialProjectionContext: { rootMessageId: "root" }
    });

    expect(accepted?.result.prompt.id).toEqual(expect.any(String));
    const batchId = h.store.acceptImmediateNativeInputBatch.mock.calls[0]?.[0].batchId;
    expect(h.store.acceptImmediateNativeInputBatch).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        id: expect.any(String), bindingId: "binding", bindingGeneration: 3,
        ingressSource: "feishu", sourceMessageKey: "message", larkMessageId: "message",
        actorOpenId: "operator", body: "continue", rootMessageId: "root", parentPromptId: "parent"
      }),
      batchId,
      combinedBody: "[Feishu message 1/1]\ncontinue",
      view: expect.objectContaining({ promptId: batchId, bindingGeneration: 3, conversionParentPromptId: "parent", requestText: "[Feishu message 1/1]\ncontinue", replyContext: "continue", queuePosition: 1, spaceName: "herdr" }),
      maxQueueDepth: 20
    }));
    expect(h.store.acceptPromptWithEffects).not.toHaveBeenCalled();
    expect(h.outboundWork.wake).toHaveBeenCalledOnce();
    expect(h.scheduler.wake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "binding" });
    expect(h.lifecycleEvents.publish).toHaveBeenCalledOnce();
    expect(h.store.audit).toHaveBeenCalledWith({ actorOpenId: "operator", action: "prompt.queue", target: "binding", outcome: "success" });
  });

  it("copies the Primary Session Goal into a newly accepted Answer view", async () => {
    const currentGoal = { goalId: "goal-1", objective: "Finish the release", status: "active", blockKind: null };
    const h = bindingSetup({ countPendingPrompts: vi.fn(() => 0), getCurrentGoal: vi.fn(() => currentGoal) });
    await h.workflow.acceptManagedInput({
      binding: binding as never,
      body: message.text,
      actor: { openId: message.actorOpenId },
      ingressSource: "feishu",
      sourceMessageKey: message.messageId,
      larkMessageId: message.messageId,
      parentPromptId: "parent",
      initialProjectionContext: { rootMessageId: "root" }
    });

    expect(h.store.acceptImmediateNativeInputBatch).toHaveBeenCalledWith(expect.objectContaining({
      view: expect.objectContaining({ currentGoal })
    }));
  });

  it("durably collects ordinary Feishu input while the Primary turn is active", async () => {
    const h = bindingSetup({ getNativeInputBacklog: vi.fn(() => ({ unbatchedInputCount: 1, pendingBatchCount: 0 })) });
    const activeBinding = { ...binding, lastAgentState: "working" };

    const accepted = await h.workflow.acceptManagedInput({
      binding: activeBinding as never,
      body: "first follow-up",
      actor: { openId: message.actorOpenId },
      ingressSource: "feishu",
      sourceMessageKey: "message-active",
      larkMessageId: "message-active",
      parentPromptId: "parent",
      initialProjectionContext: { rootMessageId: "root" }
    });

    expect(accepted).toMatchObject({ result: { inserted: true, prompt: null, batch: { state: "collecting" } } });
    expect(h.store.acceptCollectingNativeInput).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ bindingId: "binding", bindingGeneration: 3, sourceMessageKey: "message-active", body: "first follow-up" }),
      batchId: expect.any(String), windowMs: 2_000, maxQueueDepth: 20
    }));
    expect(h.store.acceptImmediateNativeInputBatch).not.toHaveBeenCalled();
    expect(h.store.acceptPromptWithEffects).not.toHaveBeenCalled();
    expect(h.scheduler.wake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "binding" });
    expect(h.outboundWork.wake).not.toHaveBeenCalled();
    expect(h.lifecycleEvents.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "NativeInputBacklogChanged",
      payload: { unbatchedInputCount: 1, pendingBatchCount: 0 }
    }));
  });

  it("drains an expired native window before admitting a later Feishu message", async () => {
    const order: string[] = [];
    const h = bindingSetup({
      formDueNativeInputBatch: vi.fn((input: any) => {
        order.push("drain");
        const combinedBody = "[Feishu message 1/1]\nfirst";
        const projection = input.createProjection({ batchId: "expired", binding, combinedBody, titleSource: "first", rootMessageId: "root", memberCount: 1, queuePosition: 1 });
        return { outcome: "formed", batch: { id: "expired", drainDueAt: input.occurredAt }, prompt: { id: "expired", actorOpenId: "operator" }, view: projection.view, nextBatch: null, supersededPromptIds: [] };
      }),
      acceptCollectingNativeInput: vi.fn((input: any) => {
        order.push("accept");
        return { inserted: true, input: { ...input.input, state: "queued", batchId: null, createdAt: input.occurredAt, updatedAt: input.occurredAt }, batch: { id: input.batchId, state: "collecting", drainDueAt: new Date(Date.parse(input.occurredAt) + input.windowMs).toISOString() }, supersededPromptIds: [] };
      })
    });

    await h.workflow.acceptManagedInput({ binding: { ...binding, lastAgentState: "working" } as never, body: "late", actor: { openId: "operator" }, ingressSource: "feishu", sourceMessageKey: "late-message", larkMessageId: "late-message", parentPromptId: null, initialProjectionContext: { rootMessageId: "root" } });

    expect(order).toEqual(["drain", "accept"]);
  });

  it("does not drain an expired native window for duplicate Feishu ingress", async () => {
    const h = bindingSetup({
      hasAcceptedPromptSource: vi.fn(() => true),
      formDueNativeInputBatch: vi.fn(() => { throw new Error("duplicate ingress must not drain"); }),
      acceptCollectingNativeInput: vi.fn((input: any) => ({
        inserted: false,
        input: { ...input.input, id: "existing-input", state: "queued", batchId: null, createdAt: input.occurredAt, updatedAt: input.occurredAt },
        batch: { id: "existing-batch", state: "collecting", drainDueAt: "2026-10-02T01:00:02.000Z" },
        supersededPromptIds: []
      }))
    });

    const accepted = await h.workflow.acceptManagedInput({ binding: { ...binding, lastAgentState: "working" } as never, body: "duplicate", actor: { openId: "operator" }, ingressSource: "feishu", sourceMessageKey: "existing-message", larkMessageId: "existing-message", parentPromptId: null, initialProjectionContext: { rootMessageId: "root" } });

    expect(accepted).toMatchObject({ result: { inserted: false, prompt: null } });
    expect(h.store.formDueNativeInputBatch).not.toHaveBeenCalled();
    expect(h.outboundWork.wake).not.toHaveBeenCalled();
    expect(h.scheduler.wake).not.toHaveBeenCalled();
    expect(h.lifecycleEvents.publish).not.toHaveBeenCalled();
  });

  it("keeps an opened collection window when the Primary settles", async () => {
    const h = bindingSetup({
      countPendingPrompts: vi.fn(() => 0),
      getNativeInputBacklog: vi.fn(() => ({ unbatchedInputCount: 1, pendingBatchCount: 0 }))
    });

    await h.workflow.acceptManagedInput({
      binding: binding as never,
      body: "second before the fixed deadline",
      actor: { openId: message.actorOpenId },
      ingressSource: "feishu",
      sourceMessageKey: "message-after-settle",
      larkMessageId: "message-after-settle",
      parentPromptId: "parent",
      initialProjectionContext: { rootMessageId: "root" }
    });

    expect(h.store.acceptCollectingNativeInput).toHaveBeenCalledOnce();
    expect(h.store.acceptImmediateNativeInputBatch).not.toHaveBeenCalled();
  });

  it("forms a due collected batch into one shared Run and Answer projection", async () => {
    const h = bindingSetup({
      formDueNativeInputBatch: vi.fn((input: any) => {
        const combinedBody = "[Feishu message 1/2]\nfirst\n\n[Feishu message 2/2]\nsecond";
        const projection = input.createProjection({
          batchId: "batch-1", binding, combinedBody, replyContext: "first\n\nsecond",
          titleSource: "first", rootMessageId: "root", memberCount: 2, queuePosition: 2
        });
        expect(projection.view).toEqual(expect.objectContaining({
          requestText: combinedBody,
          replyContext: "first\n\nsecond"
        }));
        return {
          outcome: "formed",
          batch: { id: "batch-1", drainDueAt: input.occurredAt },
          prompt: { id: "batch-1", bindingId: "binding", actorOpenId: "operator", body: combinedBody },
          view: projection.view,
          nextBatch: { id: "batch-2", drainDueAt: "2026-10-02T01:00:04.000Z" }
        };
      })
    });

    await expect(h.workflow.drainDueNativeInputBatch("binding", "2026-10-02T01:00:02.000Z"))
      .resolves.toEqual({ outcome: "formed", nextDueAt: "2026-10-02T01:00:04.000Z" });
    expect(h.store.formDueNativeInputBatch).toHaveBeenCalledWith(expect.objectContaining({ bindingId: "binding", windowMs: 2_000, nextBatchId: expect.any(String) }));
    expect(h.outboundWork.wake).toHaveBeenCalledOnce();
    expect(h.scheduler.wake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "binding" });
    expect(h.lifecycleEvents.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "PromptQueued", payload: expect.objectContaining({ promptId: "batch-1" }) }));
  });

  it("applies bridge Core observations through the Prompt lifecycle facade", async () => {
    const h = bindingSetup({
      getPrompt: vi.fn(() => ({
        id: "prompt-1", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "continue",
        parentPromptId: null, executionOrigin: "bridge", priority: "normal", wasDetached: false,
        dispatchedAt: "2026-09-30T00:00:00.000Z", transcriptTurnId: null, transcriptTurnStartedAt: null,
        modelName: null, modelRevision: null, state: "running", observationState: "attached",
        attemptCount: 1, error: null, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z"
      })),
      claimPromptTranscriptTurn: vi.fn(() => ({ state: "claimed", prompt: {
        id: "prompt-1", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "continue",
        parentPromptId: null, executionOrigin: "bridge", priority: "normal", wasDetached: false,
        dispatchedAt: "2026-09-30T00:00:00.000Z", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-09-30T00:00:01.000Z",
        modelName: null, modelRevision: null, state: "running", observationState: "attached",
        attemptCount: 1, error: null, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z"
      } })),
      listPromptTranscriptTurns: vi.fn(() => [{ turnId: "turn-1", startedAt: "2026-09-30T00:00:01.000Z" }]),
      loadRunCard: vi.fn(() => ({ answer: "" })),
      completeTurn: vi.fn(),
      failPrompt: vi.fn()
    });

    await expect(h.workflow.applyCoreObservation({
      origin: "bridge",
      binding: binding as never,
      prompt: h.store.getPrompt("prompt-1"),
      observation: {
        turnId: "turn-1",
        freshTurnStart: true,
        answerDelta: "same path",
        turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-09-30T00:00:01.000Z" }
      },
      output: { emitted: false, text: "", truncated: false },
      elapsedSeconds: 1
    })).resolves.toMatchObject({ outcome: "projected", owned: true, terminal: null });

    expect(h.lifecycleEvents.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "TurnOutputObserved",
      origin: "herdr",
      payload: expect.objectContaining({ promptId: "prompt-1" })
    }));
  });

  it("correlates a receipt-accepted managed Prompt from its later Core Human Message", async () => {
    const recoveringPrompt = {
      id: "prompt-1", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "continue",
      parentPromptId: null, executionOrigin: "bridge", priority: "normal", wasDetached: true,
      dispatchedAt: "2026-09-30T00:00:00.000Z", nativeSubmissionId: "prompt-1",
      transcriptTurnId: null, transcriptTurnStartedAt: null,
      modelName: null, modelRevision: null, state: "recovering", observationState: "detached",
      attemptCount: 1, error: null, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z"
    };
    const correlatedPrompt = {
      ...recoveringPrompt,
      transcriptTurnId: "turn-1",
      transcriptTurnStartedAt: "2026-09-30T00:00:01.000Z"
    };
    const h = bindingSetup({
      getPrompt: vi.fn(() => recoveringPrompt),
      claimPromptTranscriptTurn: vi.fn(() => ({ state: "claimed", prompt: correlatedPrompt })),
      completeTurn: vi.fn(),
      failPrompt: vi.fn()
    });

    await expect(h.workflow.applyCoreObservation({
      origin: "bridge",
      binding: binding as never,
      prompt: recoveringPrompt as never,
      observation: {
        turnId: "turn-1",
        requestSubmissionId: "prompt-1",
        answerDelta: "continued output",
        turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-09-30T00:00:01.000Z" }
      },
      output: { emitted: false, text: "", truncated: false },
      elapsedSeconds: 1
    })).resolves.toMatchObject({ outcome: "projected", owned: true, prompt: correlatedPrompt });

    expect(h.store.claimPromptTranscriptTurn).toHaveBeenCalledWith({
      promptId: "prompt-1",
      bindingId: "binding",
      turnId: "turn-1",
      startedAt: "2026-09-30T00:00:01.000Z"
    });
    expect(h.lifecycleEvents.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "TurnOutputObserved",
      payload: expect.objectContaining({ promptId: "prompt-1" })
    }));
  });

  it("does not claim managed output from a different Core submission", async () => {
    const recoveringPrompt = {
      id: "prompt-1", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "continue",
      parentPromptId: null, executionOrigin: "bridge", priority: "normal", wasDetached: true,
      dispatchedAt: "2026-09-30T00:00:00.000Z", nativeSubmissionId: "prompt-1",
      transcriptTurnId: null, transcriptTurnStartedAt: null,
      modelName: null, modelRevision: null, state: "recovering", observationState: "detached",
      attemptCount: 1, error: null, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z"
    };
    const h = bindingSetup({
      getPrompt: vi.fn(() => recoveringPrompt),
      claimPromptTranscriptTurn: vi.fn(),
      listPromptTranscriptTurns: vi.fn(() => []),
      completeTurn: vi.fn(),
      failPrompt: vi.fn()
    });

    await expect(h.workflow.applyCoreObservation({
      origin: "bridge",
      binding: binding as never,
      prompt: recoveringPrompt as never,
      observation: {
        turnId: "turn-direct",
        requestSubmissionId: "another-submission",
        answerDelta: "must remain direct output",
        turnLifecycle: { turnId: "turn-direct", state: "active", startedAt: "2026-09-30T00:00:01.000Z" }
      },
      output: { emitted: false, text: "", truncated: false },
      elapsedSeconds: 1
    })).resolves.toMatchObject({ outcome: "ignored", owned: false, prompt: recoveringPrompt });

    expect(h.store.claimPromptTranscriptTurn).not.toHaveBeenCalled();
    expect(h.lifecycleEvents.publish).not.toHaveBeenCalled();
  });

  it("preserves Herdr Core main status and Task List through the direct Turn projection facade", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T00:00:11.000Z"));
    const projectConversationTurn = vi.fn(() => ({ outcome: "projected", projection: null, supersededPromptIds: [], outboxReserved: false }));
    const h = bindingSetup({
      projectConversationTurn
    });

    await expect(h.workflow.applyCoreObservation({
      origin: "herdr",
      binding: binding as never,
      session: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      state: { pendingStarts: new Map(), promptsByTurn: new Map() },
      observation: {
        turnId: "turn-1",
        freshTurnStart: true,
        requestText: "direct work",
        answerDelta: "",
        mainStatus: {
          statusTitle: "Working directly",
          tokenCount: 42,
          planSteps: [{ key: "plan:0", label: "Inspect durable state", state: "active" }]
        },
        turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-09-30T00:00:01.000Z" }
      }
    })).resolves.toMatchObject({ outcome: "projected", owned: false, terminal: null, prompt: null });

    expect(projectConversationTurn).toHaveBeenCalledWith(expect.objectContaining({
      origin: "herdr",
      identity: expect.objectContaining({ sessionId: "session-1", turnId: "turn-1" }),
      view: expect.objectContaining({
        taskListTitle: "Working directly",
        taskList: [{ key: "plan:0", label: "Inspect durable state", state: "active", kind: "step", occurredAt: "2026-09-30T00:00:11.000Z" }]
      })
    }));
    vi.useRealTimers();
  });

  it("returns the existing durable Prompt without repeating post-commit effects", async () => {
    const h = bindingSetup({ acceptPromptWithEffects: vi.fn((input: any) => ({ result: { inserted: false, prompt: { ...input.prompt, id: "existing" }, view: input.view }, commitState: "committed", consumeEffects: vi.fn(() => { throw new Error("must not consume"); }) })) });
    await expect(h.workflow.acceptManagedInput({
      binding: binding as never,
      body: message.text,
      actor: { openId: message.actorOpenId },
      ingressSource: "internal",
      sourceMessageKey: message.messageId,
      larkMessageId: message.messageId,
      parentPromptId: "parent",
      initialProjectionContext: { rootMessageId: "root" }
    })).resolves.toMatchObject({ result: { prompt: { id: "existing" }, inserted: false } });
    expect(h.outboundWork.wake).not.toHaveBeenCalled();
    expect(h.lifecycleEvents.publish).not.toHaveBeenCalled();
    expect(h.store.audit).not.toHaveBeenCalled();
  });

  it("returns the existing immediate Native Input Batch without repeating post-commit effects", async () => {
    const h = bindingSetup({
      countPendingPrompts: vi.fn(() => 0),
      acceptImmediateNativeInputBatch: vi.fn((input: any) => ({
        inserted: false,
        prompt: { id: "existing-batch", bindingId: input.input.bindingId, body: input.combinedBody },
        view: { ...input.view, promptId: "existing-batch" }
      }))
    });

    await expect(h.workflow.acceptManagedInput({
      binding: binding as never,
      body: message.text,
      actor: { openId: message.actorOpenId },
      ingressSource: "feishu",
      sourceMessageKey: message.messageId,
      larkMessageId: message.messageId,
      parentPromptId: null,
      initialProjectionContext: { rootMessageId: "root" }
    })).resolves.toMatchObject({ result: { prompt: { id: "existing-batch" }, inserted: false } });
    expect(h.outboundWork.wake).not.toHaveBeenCalled();
    expect(h.scheduler.wake).not.toHaveBeenCalled();
    expect(h.lifecycleEvents.publish).not.toHaveBeenCalled();
    expect(h.store.audit).not.toHaveBeenCalled();
  });

  it("fails closed when a managed Feishu Prompt omits the source message id", async () => {
    const h = bindingSetup();

    await expect(h.workflow.acceptManagedInput({
      binding: binding as never,
      body: message.text,
      actor: { openId: message.actorOpenId },
      ingressSource: "feishu",
      sourceMessageKey: message.messageId,
      larkMessageId: null,
      parentPromptId: "parent",
      initialProjectionContext: { rootMessageId: "root" }
    })).rejects.toThrow("Managed Feishu Prompt requires a Lark message ID");
  });
});

describe("PromptAdmissionWorkflow", () => {
  it("maps ordinary Feishu input to managed binding acceptance", async () => {
    const h = admissionSetup();
    await expect(h.workflow.accept(binding as never, message)).resolves.toEqual({ outcome: "accepted", promptId: "managed-prompt" });
    expect(h.bindingPrompts.acceptManagedInput).toHaveBeenCalledWith({
      binding,
      body: "continue",
      actor: { openId: "operator" },
      ingressSource: "feishu",
      sourceMessageKey: "message",
      larkMessageId: "message",
      parentPromptId: "parent",
      priority: "normal",
      initialProjectionContext: { rootMessageId: "root" }
    });
  });

  it("uses the completed project selection identity for initial Prompt idempotency", async () => {
    const h = admissionSetup();
    await expect(h.workflow.acceptInitial(binding as never, selection as never)).resolves.toEqual({ outcome: "accepted", promptId: "managed-prompt" });
    expect(h.bindingPrompts.acceptManagedInput).toHaveBeenCalledWith({
      binding,
      body: "initial work",
      actor: { openId: "operator" },
      ingressSource: "feishu",
      sourceMessageKey: "command-message",
      larkMessageId: "command-message",
      parentPromptId: "parent",
      priority: "normal",
      initialProjectionContext: { rootMessageId: "root" }
    });
  });

  it("defers typed Prompt capacity without reserving rejection feedback", async () => {
    const h = admissionSetup({ acceptManagedInput: vi.fn(async () => { throw new PromptCapacityExceeded(); }) });
    await expect(h.workflow.accept(binding as never, message)).resolves.toEqual({ outcome: "capacity_deferred" });
    expect(h.outbound.enqueueCard).not.toHaveBeenCalled();
  });

  it("does not convert an untyped lookalike error into capacity deferral", async () => {
    const h = admissionSetup({ acceptManagedInput: vi.fn(async () => { throw new Error("This topic's prompt queue is full"); }) });
    await expect(h.workflow.accept(binding as never, message)).rejects.toThrow("This topic's prompt queue is full");
    expect(h.outbound.enqueueCard).not.toHaveBeenCalled();
  });
});
