import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { CardInteractionWorkflow } from "../src/coordinator/card-interaction-workflow.js";
import { BindingPromptWorkflow } from "../src/coordinator/binding-prompt-workflow.js";
import { SwarmCommandContextResolver } from "../src/coordinator/swarm-command-context-resolver.js";
import { SwarmCommandGateway } from "../src/coordinator/swarm-command-gateway.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { applicationPresentation } from "./helpers/presentation.js";
import { parseCardActionCommand } from "../src/coordinator/card-action-command.js";
import type { IncomingLarkCardAction } from "../src/domain/types.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import type { LarkPort } from "../src/domain/ports.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";

const project = { id: "p1", displayName: "Project", spaceName: "primary-space", description: "Project", workspaceId: "w1", cwd: "/repo" };
const projects = [project];
const HUMAN_INTERRUPTION_NOTICE = "TraeX turn was interrupted by a human operator";

function handle(workflow: CardInteractionWorkflow, action: IncomingLarkCardAction) {
  const command = parseCardActionCommand(action.value, action.option);
  if (command.kind !== "session" && command.kind !== "completion-action") throw new Error(`Expected session action, received ${command.kind}`);
  return workflow.handle(action, command as never);
}

function createAnswerDelivery(store: SqliteBindingStore) {
  const lark: LarkPort = {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
    async replyText() { return { messageId: "unused" }; },
    async replyCard() { return { messageId: "answer-parent" }; },
    async replyStreamingCard() { return { messageId: "answer-parent", cardId: "card-parent" }; },
    async updateCard() {}
  };
  const delivery = createTestPublisher(store, lark, pino({ enabled: false }));
  delivery.start();
  return delivery;
}

function harness() {
  const store = new SqliteBindingStore(":memory:");
  const binding = store.createPendingBinding({ id: "b1", creatorOpenId: "creator", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
  store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
  store.enqueuePrompt({ id: "parent", bindingId: "b1", larkMessageId: "parent-message", actorOpenId: "member", body: "work" });
  store.updatePrompt("parent", "running");
  const wakePrompt = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const sessionOperations = { accept: vi.fn(() => "accepted" as const) };
  const commands = { submit: vi.fn(async () => ({ outcome: "accepted" as const, commandKind: "rename" as const, intent: { id: "intent-1" } })) };
  const sessionAdministration = { emitStatus: vi.fn(async () => {}) };
  const workflow = new CardInteractionWorkflow({
    store,
    projects,
    adminOpenIds: ["creator"],
    sessionAdministration,
    commands: commands as never,
    bindingPrompts: { acceptInterruptedContinuation: vi.fn(async () => null) },
    presentation: applicationPresentation,
    logger
  });
  return { store, binding: store.getBinding("b1")!, workflow, wakePrompt, logger, sessionOperations, commands, sessionAdministration };
}

function commandLaneHarness() {
  const store = new SqliteBindingStore(":memory:");
  const modules = store.capabilityModules();
  store.createPendingBinding({ id: "b1", creatorOpenId: "creator", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
  store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "terminal-1", state: "active", lifecycle: "active", attachment: "attached" });
  const sessionAdministration = { emitStatus: vi.fn(async () => {}), rename: vi.fn(async () => true), archive: vi.fn(async () => true), resume: vi.fn(async () => true) };
  const provisioning = { selectProject: vi.fn(async () => undefined), reset: vi.fn(async () => true), attach: vi.fn(async () => true), reattach: vi.fn(async () => undefined), replace: vi.fn(async () => undefined) };
  const gateway = new SwarmCommandGateway({
    store: modules.commandIntents, primaryPrompts: store,
    resolver: new SwarmCommandContextResolver({ config: { projects: [project], defaultProjectId: "p1", lark: { adminOpenIds: ["creator"] } } as never, store, activeTurn: () => null }),
    outbound: { enqueueCard: vi.fn(async () => undefined) }, logger: pino({ enabled: false }),
    provisioning, operationsQuery: { listSpaces: vi.fn(), listTopicPanes: vi.fn(), listSessions: vi.fn(), listFailures: vi.fn() },
    sessionAdministration, modelSelection: { runModel: vi.fn() }, paneControl: { stop: vi.fn(), steer: vi.fn() },
    paneClosure: { requestPaneClose: vi.fn(), confirmPaneClose: vi.fn() }, promptRun: { awake: vi.fn(), skipDetached: vi.fn() },
    instanceControl: { createWorker: vi.fn(), inspect: vi.fn() }, wakeCardContext: vi.fn(), wakeOutbound: vi.fn(), wakeCommand: vi.fn(),
    presentation: applicationPresentation
  } as never);
  const workflow = new CardInteractionWorkflow({
    store,
    projects,
    adminOpenIds: ["creator"],
    sessionAdministration,
    commands: gateway,
    bindingPrompts: { acceptInterruptedContinuation: vi.fn(async () => null) },
    presentation: applicationPresentation,
    logger: { info: vi.fn(), warn: vi.fn() }
  });
  return { store, workflow, gateway };
}

function bindingPromptsFor(
  store: SqliteBindingStore,
  overrides: { schedulerWake?: ReturnType<typeof vi.fn>; outboundWake?: ReturnType<typeof vi.fn>; lifecyclePublish?: ReturnType<typeof vi.fn> } = {}
) {
  return new BindingPromptWorkflow({
    config: { projects, maxQueueDepth: 20 } as never,
    store,
    lifecycleEvents: { publish: overrides.lifecyclePublish ?? vi.fn(async () => undefined) },
    outboundWork: { wake: overrides.outboundWake ?? vi.fn(), subscribe: vi.fn() },
    scheduler: { wake: overrides.schedulerWake ?? vi.fn(), subscribe: vi.fn() },
    presentation: applicationPresentation
  });
}

describe("card interactions", () => {
  it("routes a minimal fresh-card callback to its durable Primary Prompt owner", async () => {
    const actionSetId = `completion-review:v3:${"a".repeat(64)}`;
    const getCompletionReviewOwnerKind = vi.fn(() => "primary-prompt" as const);
    const decidePrimaryCompletionReview = vi.fn(() => ({ ownerKind: "primary-prompt" as const, kind: "submission" as const, promptId: "prompt-1", submissionId: "submission-1", inserted: true }));
    const resume = vi.fn(async () => ({ outcome: "accepted" as const, submissionId: "submission-1", state: "observed" as const }));
    const workflow = new CardInteractionWorkflow({
      store: { getCompletionReviewOwnerKind, decidePrimaryCompletionReview }, projects, adminOpenIds: ["creator"],
      sessionAdministration: { emitStatus: vi.fn() }, commands: { submit: vi.fn() }, bindingPrompts: { ignorePrimaryCompletionAction: vi.fn() },
      agentInput: { resume }, presentation: applicationPresentation, logger: { info: vi.fn(), warn: vi.fn() }
    } as never);
    const value = { action: "completion_action", actionSetId, optionId: "approve" };

    await expect(handle(workflow, { messageId: "review-message", chatId: "chat", operatorOpenId: "ou_requester", value }))
      .resolves.toMatchObject({ toast: { type: "success", content: "已提交选择。" } });
    expect(getCompletionReviewOwnerKind).toHaveBeenCalledWith(actionSetId);
    expect(decidePrimaryCompletionReview).toHaveBeenCalledWith(expect.objectContaining({
      actionSetId, optionId: "approve", messageId: "review-message", actorOpenId: "ou_requester", chatId: "chat"
    }));
    expect(Object.keys(decidePrimaryCompletionReview.mock.calls[0]![0]).sort()).toEqual([
      "actionSetId", "actorOpenId", "chatId", "messageId", "occurredAt", "optionId"
    ]);
    expect(resume).toHaveBeenCalledWith("submission-1");

    decidePrimaryCompletionReview.mockReturnValueOnce({ ownerKind: "primary-prompt", kind: "ignored", promptId: "prompt-2", changed: true } as never);
    await expect(handle(workflow, { messageId: "review-message-2", chatId: "chat", operatorOpenId: "ou_requester", value: { ...value, optionId: "ignore" } }))
      .resolves.toMatchObject({ toast: { type: "success", content: "已忽略。" } });
    expect(resume).toHaveBeenCalledTimes(1);

    decidePrimaryCompletionReview.mockReturnValueOnce({ ownerKind: "primary-prompt", kind: "submission", promptId: "prompt-3", submissionId: "submission-3", inserted: true });
    resume.mockRejectedValueOnce(new Error("temporary resume failure"));
    await expect(handle(workflow, { messageId: "review-message-3", chatId: "chat", operatorOpenId: "ou_requester", value }))
      .resolves.toMatchObject({ toast: { type: "warning", content: expect.stringContaining("已记录") } });
  });

  it("routes a minimal fresh-card callback to its durable Primary Segment owner", async () => {
    const actionSetId = `completion-review:v3:${"c".repeat(64)}`;
    const getCompletionReviewOwnerKind = vi.fn(() => "primary-segment" as const);
    const decidePrimaryCompletionReview = vi.fn(() => ({ ownerKind: "primary-segment" as const, kind: "submission" as const, segmentId: "segment-1", submissionId: "submission-1", inserted: true }));
    const resume = vi.fn(async () => ({ outcome: "accepted" as const, submissionId: "submission-1", state: "observed" as const }));
    const convergeTurnCard = vi.fn(async () => undefined);
    const workflow = new CardInteractionWorkflow({
      store: { getCompletionReviewOwnerKind, decidePrimaryCompletionReview }, projects, adminOpenIds: ["creator"],
      sessionAdministration: { emitStatus: vi.fn() }, commands: { submit: vi.fn() }, bindingPrompts: { ignorePrimaryCompletionAction: vi.fn() },
      agentInput: { resume }, convergeTurnCard, presentation: applicationPresentation, logger: { info: vi.fn(), warn: vi.fn() }
    } as never);

    await expect(handle(workflow, { messageId: "review-message", chatId: "chat", operatorOpenId: "ou_requester", value: { action: "completion_action", actionSetId, optionId: "approve" } }))
      .resolves.toMatchObject({ toast: { type: "success", content: "已提交选择。" } });
    expect(decidePrimaryCompletionReview).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith("submission-1");
    expect(convergeTurnCard).toHaveBeenCalledWith("segment-1");
  });

  it("routes a minimal fresh-card callback to its durable Worker Turn owner", async () => {
    const actionSetId = `completion-review:v3:${"b".repeat(64)}`;
    const getCompletionReviewOwnerKind = vi.fn(() => "worker-turn" as const);
    const decideFreshWorkerCompletionReview = vi.fn(async () => ({
      kind: "followup" as const,
      inserted: true,
      turn: { id: "worker-followup" },
      card: { queuePosition: 2 }
    }));
    const workflow = new CardInteractionWorkflow({
      store: { getCompletionReviewOwnerKind }, projects, adminOpenIds: ["creator"],
      sessionAdministration: { emitStatus: vi.fn() }, commands: { submit: vi.fn() }, bindingPrompts: { ignorePrimaryCompletionAction: vi.fn() },
      agentInput: { resume: vi.fn() }, workerMessaging: { decideFreshWorkerCompletionReview },
      presentation: applicationPresentation, logger: { info: vi.fn(), warn: vi.fn() }
    } as never);
    const value = { action: "completion_action", actionSetId, optionId: "continue" };

    await expect(handle(workflow, { messageId: "worker-review-message", chatId: "chat", operatorOpenId: "ou_requester", value }))
      .resolves.toMatchObject({ toast: { type: "success", content: expect.stringContaining("第 2 位") } });
    expect(decideFreshWorkerCompletionReview).toHaveBeenCalledWith({
      actionSetId, optionId: "continue", messageId: "worker-review-message", chatId: "chat",
      actor: { kind: "human", userId: "ou_requester", channel: "feishu" }
    });

    decideFreshWorkerCompletionReview.mockResolvedValueOnce({ kind: "ignored", changed: true });
    await expect(handle(workflow, { messageId: "worker-review-message", chatId: "chat", operatorOpenId: "ou_requester", value: { ...value, optionId: "ignore" } }))
      .resolves.toMatchObject({ toast: { type: "success", content: "已忽略。" } });
  });

  it("routes an exact Primary Segment choice through the durable Agent Input and reconverges once", async () => {
    const acceptPrimarySegmentCompletionChoice = vi.fn(() => ({ segmentId: "segment-1", submissionId: "submission-1", inserted: true }));
    const resume = vi.fn(async () => ({ outcome: "accepted" as const, submissionId: "submission-1", state: "observed" as const }));
    const convergeTurnCard = vi.fn(async () => undefined);
    const workflow = new CardInteractionWorkflow({
      store: { acceptPrimarySegmentCompletionChoice }, projects, adminOpenIds: ["creator"],
      sessionAdministration: { emitStatus: vi.fn() }, commands: { submit: vi.fn() }, bindingPrompts: { ignorePrimaryCompletionAction: vi.fn() },
      agentInput: { resume }, convergeTurnCard, presentation: applicationPresentation, logger: { info: vi.fn(), warn: vi.fn() }
    } as never);
    const value = { action: "completion_action", actionSetId: "segment-actions-1", optionId: "revise", ownerKind: "primary-segment", ownerId: "segment-1", ownerGeneration: 2, cardMessageId: "turn-card-1" };

    await expect(handle(workflow, { messageId: "turn-card-1", chatId: "chat", operatorOpenId: "ou_requester", value })).resolves.toMatchObject({ toast: { type: "success", content: "已提交选择。" } });
    expect(acceptPrimarySegmentCompletionChoice).toHaveBeenCalledWith(expect.objectContaining({
      actionSetId: "segment-actions-1", optionId: "revise", ownerSegmentId: "segment-1", ownerGeneration: 2,
      cardMessageId: "turn-card-1", actorOpenId: "ou_requester", chatId: "chat"
    }));
    expect(resume).toHaveBeenCalledWith("submission-1");
    expect(convergeTurnCard).toHaveBeenCalledWith("segment-1");

    await expect(handle(workflow, { messageId: "forged-card", chatId: "chat", operatorOpenId: "ou_requester", value })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(acceptPrimarySegmentCompletionChoice).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["recorded", "正在确认"],
    ["attempting", "正在确认"],
    ["uncertain", "正在确认"],
    ["cancelled", "未提交"]
  ] as const)("reports %s Primary Segment choice admission truthfully", async (state, message) => {
    const acceptPrimarySegmentCompletionChoice = vi.fn(() => ({ segmentId: "segment-1", submissionId: "submission-1", inserted: true }));
    const resume = vi.fn(async () => ({ outcome: "accepted" as const, submissionId: "submission-1", state }));
    const workflow = new CardInteractionWorkflow({
      store: { acceptPrimarySegmentCompletionChoice }, projects, adminOpenIds: ["creator"],
      sessionAdministration: { emitStatus: vi.fn() }, commands: { submit: vi.fn() }, bindingPrompts: { ignorePrimaryCompletionAction: vi.fn() },
      agentInput: { resume }, convergeTurnCard: vi.fn(async () => undefined), presentation: applicationPresentation, logger: { info: vi.fn(), warn: vi.fn() }
    } as never);
    const value = { action: "completion_action", actionSetId: "segment-actions-1", optionId: "revise", ownerKind: "primary-segment", ownerId: "segment-1", ownerGeneration: 2, cardMessageId: "turn-card-1" };

    await expect(handle(workflow, { messageId: "turn-card-1", chatId: "chat", operatorOpenId: "ou_requester", value })).resolves.toMatchObject({
      toast: { type: "warning", content: expect.stringContaining(message) }
    });
  });

  it("routes Primary Segment Ignore locally and only reconverges a newly consumed action", async () => {
    const ignorePrimarySegmentCompletionChoice = vi.fn()
      .mockReturnValueOnce({ ownerId: "segment-1", changed: true })
      .mockReturnValueOnce({ ownerId: "segment-1", changed: false });
    const resume = vi.fn();
    const convergeTurnCard = vi.fn(async () => undefined);
    const workflow = new CardInteractionWorkflow({
      store: { ignorePrimarySegmentCompletionChoice }, projects, adminOpenIds: ["creator"],
      sessionAdministration: { emitStatus: vi.fn() }, commands: { submit: vi.fn() }, bindingPrompts: { ignorePrimaryCompletionAction: vi.fn() },
      agentInput: { resume }, convergeTurnCard, presentation: applicationPresentation, logger: { info: vi.fn(), warn: vi.fn() }
    } as never);
    const action = { messageId: "turn-card-1", chatId: "chat", operatorOpenId: "ou_requester", value: { action: "completion_action", actionSetId: "segment-actions-1", optionId: "ignore", ownerKind: "primary-segment", ownerId: "segment-1", ownerGeneration: 2, cardMessageId: "turn-card-1" } };

    await expect(handle(workflow, action)).resolves.toMatchObject({ toast: { type: "success", content: "已忽略。" } });
    await expect(handle(workflow, action)).resolves.toMatchObject({ toast: { type: "success", content: "已忽略。" } });
    expect(ignorePrimarySegmentCompletionChoice).toHaveBeenCalledTimes(2);
    expect(resume).not.toHaveBeenCalled();
    expect(convergeTurnCard).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["default", "default"],
    ["approve", "批准，按当前方案继续执行。"],
    ["continue", "继续。"],
    ["reject", "拒绝，请停止当前方案并等待进一步指示。"]
  ] as const)("retires Primary completion action %s without creating a Prompt", async (selection, _expectedText) => {
    const store = new SqliteBindingStore(":memory:");
    const delivery = createAnswerDelivery(store);
    store.createPendingBinding({ id: "b1", creatorOpenId: "creator", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const parentView = createQueuedRunCard({ promptId: "parent", bindingId: "b1", bindingGeneration: 1, title: "task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-10-01T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "parent-message", ingressSource: "feishu", actorOpenId: "member", body: "work" }, view: parentView, rootMessageId: "root", answerCard: {} });
    await delivery.drain();
    store.updatePrompt("parent", "running");
    store.completeTurn({ promptId: "parent", bindingId: "b1", answer: "done", occurredAt: "2026-10-01T00:00:01.000Z", outputFingerprint: "fp" });
    const completedView = store.loadRunCard("parent")!;
    store.database.prepare(`INSERT INTO completion_notification_obligations(
      owner_kind, owner_id, owner_generation, binding_id, binding_generation, required_view_version,
      state, notification_reply_id, created_at, updated_at, released_at
    ) VALUES ('primary-prompt', 'parent', 1, 'b1', 1, ?, 'waiting_for_answer', NULL, ?, ?, NULL)`).run(
      completedView.viewVersion, "2026-10-01T00:00:01.000Z", "2026-10-01T00:00:01.000Z"
    );
    const actionSet = store.preparePrimaryCompletionActionSet({ promptId: "parent", pageIndex: 0, cardId: "card-parent", messageId: "answer-parent" })!;
    const schedulerWake = vi.fn();
    const outboundWake = vi.fn();
    const convergeAnswer = vi.fn(async () => undefined);
    const bindingPrompts = new BindingPromptWorkflow({
      config: { projects, maxQueueDepth: 20 } as never,
      store,
      lifecycleEvents: { publish: vi.fn(async () => undefined) },
      outboundWork: { wake: outboundWake, subscribe: vi.fn() },
      scheduler: { wake: schedulerWake, subscribe: vi.fn() },
      presentation: applicationPresentation,
      convergeAnswer
    } as never);
    const workflow = new CardInteractionWorkflow({
      store,
      projects,
      adminOpenIds: ["creator"],
      sessionAdministration: { emitStatus: vi.fn(async () => undefined) },
      commands: { submit: vi.fn() } as never,
      bindingPrompts,
      presentation: applicationPresentation,
      logger: { info: vi.fn(), warn: vi.fn() }
    } as never);
    const value = { action: "completion_action", actionSetId: actionSet.id, selection, ownerKind: "primary-prompt", ownerId: "parent", ownerGeneration: 1, cardMessageId: "answer-parent" };

    await expect(handle(workflow, { messageId: "answer-parent", chatId: "chat", operatorOpenId: "member", value })).resolves.toMatchObject({ toast: { type: "warning", content: expect.stringContaining("Agent Input") } });
    await expect(handle(workflow, { messageId: "answer-parent", chatId: "chat", operatorOpenId: "member", value })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(handle(workflow, { messageId: "answer-parent", chatId: "chat", operatorOpenId: "member", value: { ...value, selection: selection === "default" ? "approve" : "default" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(handle(workflow, { messageId: "answer-parent", chatId: "chat", operatorOpenId: "creator", value })).resolves.toMatchObject({ toast: { type: "warning" } });

    expect(store.database.prepare("SELECT body, parent_prompt_id, ingress_source, source_message_key FROM prompt_jobs WHERE parent_prompt_id = 'parent'").all()).toEqual([]);
    expect(store.database.prepare("SELECT state, selected_action, result_source_key FROM completion_action_sets WHERE id = ?").get(actionSet.id)).toEqual({
      state: "available",
      selected_action: null,
      result_source_key: null
    });
    expect(convergeAnswer).not.toHaveBeenCalled();
    expect(schedulerWake).not.toHaveBeenCalled();
    await delivery.stop(); store.close();
  });

  it("retires dynamic Primary choices without consuming or creating a Prompt", async () => {
    const store = new SqliteBindingStore(":memory:");
    const delivery = createAnswerDelivery(store);
    store.createPendingBinding({ id: "b1", creatorOpenId: "creator", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const parentView = createQueuedRunCard({ promptId: "parent", bindingId: "b1", bindingGeneration: 1, title: "task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-10-01T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "parent-message", ingressSource: "feishu", actorOpenId: "member", body: "work" }, view: parentView, rootMessageId: "root", answerCard: {} });
    await delivery.drain();
    store.updatePrompt("parent", "running");
    const answer = ["Choose.", "", "```herdr-choice-list", JSON.stringify({ version: 1, default: "one", options: [
      { id: "one", label: "One", message: "default" }, { id: "two", label: "Two", message: "server-owned message" }
    ] }), "```"].join("\n");
    store.completeTurn({ promptId: "parent", bindingId: "b1", answer, occurredAt: "2026-10-01T00:00:01.000Z", outputFingerprint: "fp" });
    const actionSet = store.preparePrimaryCompletionActionSet({ promptId: "parent", pageIndex: 0, cardId: "card-parent", messageId: "answer-parent" })!;
    expect(actionSet).toMatchObject({ state: "available", mentionOpenId: "member" });
    const completed = store.loadRunCard("parent")!;
    const inlinePayload = JSON.stringify(applicationPresentation.finalAnswer(completed, {
      initialContent: completed.answer, completionActions: actionSet
    }));
    expect(inlinePayload).toContain("Choose.");
    expect(inlinePayload).toContain('"optionId":"one"');
    expect(inlinePayload).toContain('"optionId":"two"');
    expect(inlinePayload).toContain('"optionId":"ignore"');
    const inline = store.enqueueOutboundReply({
      id: "primary-inline-choice", idempotencyKey: "primary-inline-choice", bindingId: "b1", bindingGeneration: 1,
      promptId: "parent", rootMessageId: "answer-parent", kind: "card_update", payload: inlinePayload,
      projectionKey: "primary-inline-choice", snapshotRevision: completed.viewVersion
    });
    expect(store.markOutboundReplyDelivered(inline.id, "answer-parent", "card-parent")).toBe(true);
    expect(store.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("primary-next-input:"))).toHaveLength(0);
    expect(store.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='primary-prompt' AND owner_id='parent'`).get()).toEqual({ state: "suppressed", notification_reply_id: null });
    expect(store.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(actionSet.id)).toEqual({ state: "available" });
    const bindingPrompts = bindingPromptsFor(store);
    const workflow = new CardInteractionWorkflow({ store, projects, adminOpenIds: ["creator"], sessionAdministration: { emitStatus: vi.fn() }, commands: { submit: vi.fn() } as never, bindingPrompts, presentation: applicationPresentation, logger: { info: vi.fn(), warn: vi.fn() } } as never);
    const value = { action: "completion_action", actionSetId: actionSet.id, optionId: "two", message: "client tampering", ownerKind: "primary-prompt", ownerId: "parent", ownerGeneration: 1, cardMessageId: "answer-parent" };
    expect(store.resolvePrimaryCompletionChoice({ actionSetId: actionSet.id, optionId: "two", ownerPromptId: "parent", ownerGeneration: 1, cardMessageId: "answer-parent", actorOpenId: "member" })).toEqual({ label: "Two", message: "server-owned message" });

    await expect(handle(workflow, { messageId: "answer-parent", chatId: "chat", operatorOpenId: "member", value })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(handle(workflow, { messageId: "answer-parent", chatId: "chat", operatorOpenId: "member", value })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(handle(workflow, { messageId: "answer-parent", chatId: "chat", operatorOpenId: "member", value: { ...value, optionId: "one" } })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(handle(workflow, { messageId: "answer-parent", chatId: "chat", operatorOpenId: "member", value: { ...value, optionId: "missing" } })).resolves.toMatchObject({ toast: { type: "warning" } });

    expect(store.database.prepare("SELECT body, source_message_key FROM prompt_jobs WHERE parent_prompt_id = 'parent'").all()).toEqual([]);
    expect(store.database.prepare("SELECT state, selected_action, selected_choice_option_id FROM completion_action_sets WHERE id = ?").get(actionSet.id)).toEqual({ state: "available", selected_action: null, selected_choice_option_id: null });
    await delivery.stop(); store.close();
  });

  it("consumes Primary Ignore locally without creating an ordinary Prompt", async () => {
    const store = new SqliteBindingStore(":memory:");
    const delivery = createAnswerDelivery(store);
    store.createPendingBinding({ id: "b1", creatorOpenId: "creator", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const parentView = createQueuedRunCard({ promptId: "parent", bindingId: "b1", bindingGeneration: 1, title: "task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-10-03T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "parent-message", ingressSource: "feishu", actorOpenId: "member", body: "work" }, view: parentView, rootMessageId: "root", answerCard: {} });
    await delivery.drain();
    store.updatePrompt("parent", "running");
    const answer = "Done.\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"是否继续？\",\"default\":\"yes\",\"options\":[{\"id\":\"yes\",\"label\":\"继续\",\"message\":\"default\"}]}\n```";
    store.completeTurn({ promptId: "parent", bindingId: "b1", answer, occurredAt: "2026-10-03T00:00:01.000Z", outputFingerprint: "fp" });
    const actionSet = store.preparePrimaryCompletionActionSet({ promptId: "parent", pageIndex: 0, cardId: "card-parent", messageId: "answer-parent" })!;
    const convergeAnswer = vi.fn(async () => undefined);
    const bindingPrompts = new BindingPromptWorkflow({
      config: { projects, maxQueueDepth: 20 } as never, store,
      lifecycleEvents: { publish: vi.fn(async () => undefined) }, outboundWork: { wake: vi.fn(), subscribe: vi.fn() },
      scheduler: { wake: vi.fn(), subscribe: vi.fn() }, presentation: applicationPresentation, convergeAnswer
    } as never);
    const workflow = new CardInteractionWorkflow({ store, projects, adminOpenIds: ["creator"], sessionAdministration: { emitStatus: vi.fn() }, commands: { submit: vi.fn() } as never, bindingPrompts, presentation: applicationPresentation, logger: { info: vi.fn(), warn: vi.fn() } } as never);
    const value = { action: "completion_action", actionSetId: actionSet.id, optionId: "ignore", ownerKind: "primary-prompt", ownerId: "parent", ownerGeneration: 1, cardMessageId: "answer-parent" };
    const promptCount = store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get();

    await expect(handle(workflow, { messageId: "answer-parent", chatId: "chat", operatorOpenId: "member", value })).resolves.toMatchObject({ toast: { type: "success", content: "已忽略。" } });
    await expect(handle(workflow, { messageId: "answer-parent", chatId: "chat", operatorOpenId: "member", value })).resolves.toMatchObject({ toast: { type: "success" } });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual(promptCount);
    expect(store.database.prepare("SELECT state, reason FROM completion_action_sets WHERE id = ?").get(actionSet.id)).toEqual({ state: "consumed", reason: "ignored" });
    expect(convergeAnswer).toHaveBeenCalledTimes(2);
    await delivery.stop(); store.close();
  });

  it("shows management controls only to the creator and rejects forged callbacks", async () => {
    const h = harness();
    const member = await handle(h.workflow, { messageId: "main", chatId: "chat", operatorOpenId: "member", value: { action: "open_more_actions", bindingId: "b1" } });
    expect(JSON.stringify(member?.card)).toContain("刷新状态"); expect(JSON.stringify(member?.card)).not.toContain("停止当前任务");
    const forged = await handle(h.workflow, { messageId: "more", chatId: "chat", operatorOpenId: "member", value: { action: "session_archive", bindingId: "b1", bindingGeneration: 1, interactionId: "forged" } });
    expect(forged?.toast?.type).toBe("error");
    const creator = await handle(h.workflow, { messageId: "main", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1" } });
    expect(JSON.stringify(creator?.card)).toContain("停止当前任务"); expect(JSON.stringify(creator?.card)).toContain("关闭 Pane"); expect(JSON.stringify(creator?.card)).not.toContain("模型"); h.store.close();
  });

  it("rejects a historical model callback without persisting Session work", async () => {
    const h = harness();
    const result = await handle(h.workflow, { messageId: "old-more", chatId: "chat", operatorOpenId: "creator", value: { action: "session_model", bindingId: "b1", bindingGeneration: 1, interactionId: "old" } });
    expect(result?.toast?.type).toBe("warning");
    expect(h.sessionOperations.accept).not.toHaveBeenCalled();
    h.store.close();
  });

  it("durably delegates mutating Session callbacks before external execution", async () => {
    const h = harness();
    const opened = await handle(h.workflow, { messageId: "main", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1", bindingGeneration: 1 } });
    const rename = findValue(opened!.card!, "open_rename");

    const result = await handle(h.workflow, { messageId: "rename-card", chatId: "chat", operatorOpenId: "creator", value: { ...rename, action: "submit_rename" }, formValues: { title: "New title" } });

    expect(result?.toast).toEqual({ type: "success", content: "操作已受理。" });
    expect(h.commands.submit).toHaveBeenCalledWith({ source: "card", action: expect.objectContaining({ operatorOpenId: "creator" }), bindingId: "b1", bindingGeneration: 1, interactionId: rename.interactionId, command: { kind: "rename", title: "New title" } });
    expect(h.sessionOperations.accept).not.toHaveBeenCalled();
    h.store.close();
  });

  it("rejects oversized Session form arguments before durable acceptance", async () => {
    const h = harness();
    const opened = await handle(h.workflow, { messageId: "main", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1", bindingGeneration: 1 } });
    const rename = findValue(opened!.card!, "open_rename");

    const result = await handle(h.workflow, { messageId: "rename-card", chatId: "chat", operatorOpenId: "creator", value: { ...rename, action: "submit_rename" }, formValues: { title: "x".repeat(501) } });

    expect(result?.toast?.type).toBe("warning");
    expect(h.sessionOperations.accept).not.toHaveBeenCalled();
    h.store.close();
  });

  it("maps only mutating Session callbacks into CardKit Command intents", async () => {
    const h = harness();
    const base = { messageId: "more", chatId: "chat", operatorOpenId: "creator" };
    const values = [
      { action: "session_stop", operation: "stop", expected: { kind: "stop" } },
      { action: "session_reset", operation: "reset", expected: { kind: "reset", title: null } },
      { action: "session_archive", operation: "archive", expected: { kind: "archive" } },
      { action: "session_resume", operation: "resume", expected: { kind: "resume" } },
      { action: "session_replace", operation: "replace", expected: { kind: "replace" } },
      { action: "session_pane_close", operation: "pane_close", expected: { kind: "pane_close_request" } },
      { action: "submit_rename", operation: "rename", expected: { kind: "rename", title: "New title" }, formValues: { title: "New title" } },
      { action: "submit_reattach", operation: "reattach", expected: { kind: "reattach", paneId: "w1:p2" }, formValues: { pane_id: "w1:p2" } }
    ] as const;
    for (const [index, item] of values.entries()) {
      await handle(h.workflow, { ...base, messageId: `mutation-${index}`, value: { action: item.action, bindingId: "b1", bindingGeneration: 1, interactionId: `interaction-${index}`, operation: item.operation }, ...(item.formValues ? { formValues: item.formValues } : {}) });
      expect(h.commands.submit).toHaveBeenLastCalledWith(expect.objectContaining({ source: "card", bindingId: "b1", bindingGeneration: 1, interactionId: `interaction-${index}`, command: item.expected }));
    }
    const admitted = h.commands.submit.mock.calls.length;
    await handle(h.workflow, { ...base, value: { action: "session_model", bindingId: "b1", bindingGeneration: 1, interactionId: "model" } });
    await handle(h.workflow, { ...base, value: { action: "session_status", bindingId: "b1", bindingGeneration: 1 } });
    await handle(h.workflow, { ...base, value: { action: "open_rename", bindingId: "b1", bindingGeneration: 1, interactionId: "form" } });
    expect(h.commands.submit).toHaveBeenCalledTimes(admitted);
    expect(h.sessionAdministration.emitStatus).toHaveBeenCalledOnce();
    h.store.close();
  });

  it("serializes CardKit rename before slash reset in the same Binding command lane", async () => {
    const h = commandLaneHarness();
    const opened = await handle(h.workflow, { messageId: "main", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1", bindingGeneration: 1 } });
    const rename = findValue(opened!.card!, "open_rename");

    await expect(handle(h.workflow, { messageId: "rename-card", chatId: "chat", operatorOpenId: "creator", value: { ...rename, action: "submit_rename" }, formValues: { title: "Card title" } }))
      .resolves.toMatchObject({ toast: { type: "success" } });
    await expect(h.gateway.submit({
      source: "literal",
      message: { eventId: "slash-reset", messageId: "slash-reset", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "creator", text: "/swarm reset", mentionsBot: true, isRootMessage: false },
      command: { kind: "reset", title: null }
    })).resolves.toMatchObject({ outcome: "accepted", commandKind: "reset" });

    const rows = h.store.database.prepare("SELECT id, lane_key, command_json, state, attempt_count FROM swarm_command_intents ORDER BY created_at, rowid").all() as Array<{ id: string; lane_key: string; command_json: string; state: string; attempt_count: number }>;
    expect(rows.map((row) => ({ lane: row.lane_key, command: JSON.parse(row.command_json) as object, state: row.state, attempts: row.attempt_count }))).toEqual([
      { lane: "binding:b1", command: { kind: "rename", title: "Card title" }, state: "accepted", attempts: 0 },
      { lane: "binding:b1", command: { kind: "reset", title: null }, state: "accepted", attempts: 0 }
    ]);

    const first = h.store.claimNextCommandIntent("binding:b1");
    expect(first).toMatchObject({ id: rows[0]!.id, command: { kind: "rename" }, laneKey: "binding:b1", state: "executing", attemptCount: 1 });
    expect(h.store.claimNextCommandIntent("binding:b1")).toBeNull();
    expect(h.store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents WHERE lane_key = 'binding:b1' AND state = 'executing'").get()).toEqual({ count: 1 });

    h.store.finishCommandIntent(first!.id, "succeeded", { code: "completed", detail: null, operationKind: null, operationId: null });
    const second = h.store.claimNextCommandIntent("binding:b1");
    expect(second).toMatchObject({ id: rows[1]!.id, command: { kind: "reset" }, laneKey: "binding:b1", state: "executing", attemptCount: 1 });
    expect(h.store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents WHERE lane_key = 'binding:b1' AND state = 'executing'").get()).toEqual({ count: 1 });
    expect(h.store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
    expect(h.store.database.prepare("SELECT COUNT(*) AS count FROM session_operations").get()).toEqual({ count: 0 });
    h.store.close();
  });

  it("retires a Primary continuation without Prompt or CommandIntent fallback", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", creatorOpenId: "creator", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const parentView = createQueuedRunCard({ promptId: "parent", bindingId: "b1", bindingGeneration: 1, title: "task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-10-01T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "parent-message", actorOpenId: "creator", body: "work" }, view: parentView, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ? WHERE id = 'parent'").run(HUMAN_INTERRUPTION_NOTICE);
    store.database.prepare("UPDATE run_cards SET phase = 'failed', notice = ?, answer_message_id = 'answer-parent' WHERE prompt_id = 'parent'").run(HUMAN_INTERRUPTION_NOTICE);
    store.createCardInteraction({ id: "continue-1", bindingId: "b1", bindingGeneration: 1, actorOpenId: "creator", actionKind: "continuation", parentPromptId: "parent", targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
    const schedulerWake = vi.fn();
    const outboundWake = vi.fn();
    const lifecyclePublish = vi.fn(async () => undefined);
    const workflow = new CardInteractionWorkflow({
      store,
      projects,
      adminOpenIds: ["creator"],
      sessionAdministration: { emitStatus: vi.fn(async () => undefined) },
      commands: { submit: vi.fn() } as never,
      bindingPrompts: bindingPromptsFor(store, { schedulerWake, outboundWake, lifecyclePublish }),
      presentation: applicationPresentation,
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    const submit = {
      action: "primary_continue_submit",
      bindingId: "b1",
      bindingGeneration: 1,
      interactionId: "continue-1",
      parentPromptId: "parent",
      sourceAnswerMessageId: "answer-parent",
      requestedBy: "creator"
    } as const;

    await expect(handle(workflow, {
      messageId: "continuation-card",
      chatId: "chat",
      operatorOpenId: "creator",
      value: submit,
      formValues: { continuation_text: "continue from the partial result" }
    })).resolves.toMatchObject({ toast: { type: "warning", content: expect.stringContaining("Agent Input") } });
    await expect(handle(workflow, {
      messageId: "continuation-card",
      chatId: "chat",
      operatorOpenId: "creator",
      value: submit,
      formValues: { continuation_text: "continue from the partial result" }
    })).resolves.toMatchObject({ toast: { type: "warning" } });

    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE source_message_key = 'card-continuation:v1:continue-1'").get()).toEqual({ count: 0 });
    expect(schedulerWake).not.toHaveBeenCalled();
    expect(outboundWake).not.toHaveBeenCalled();
    expect(lifecyclePublish).not.toHaveBeenCalled();
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'prompt.queue' AND target = 'b1'").get()).toEqual({ count: 0 });
    store.close();
  });

  it("shows only recovery-safe controls for an orphaned binding", async () => {
    const h = harness();
    h.store.updateBinding("b1", { state: "orphaned", attachment: "orphaned" });

    const creator = await handle(h.workflow, { messageId: "main", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1" } });
    const creatorCard = JSON.stringify(creator?.card);
    expect(creatorCard).toContain("刷新状态");
    expect(creatorCard).toContain("重新连接 Pane");
    expect(creatorCard).toContain("创建替代 Pane");
    expect(creatorCard).toContain("归档");
    expect(creatorCard).not.toContain("停止当前任务");
    expect(creatorCard).not.toContain("模型");
    expect(creatorCard).not.toContain("重置会话");
    expect(creatorCard).not.toContain("关闭 Pane");

    const member = await handle(h.workflow, { messageId: "main", chatId: "chat", operatorOpenId: "member", value: { action: "open_more_actions", bindingId: "b1" } });
    expect(JSON.stringify(member?.card)).toContain("刷新状态");
    expect(JSON.stringify(member?.card)).not.toContain("重新连接 Pane");
    h.store.close();
  });

});

function findValue(card: object, action: string): Record<string, unknown> {
  const stack: unknown[] = [card];
  while (stack.length) { const item = stack.pop(); if (!item || typeof item !== "object") continue; const record = item as Record<string, unknown>; if (record.value && typeof record.value === "object" && (record.value as Record<string, unknown>).action === action) return record.value as Record<string, unknown>; stack.push(...Object.values(record)); }
  throw new Error("action not found");
}
