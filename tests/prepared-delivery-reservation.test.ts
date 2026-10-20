import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboundReply } from "../src/domain/types.js";
import type { PreparedGatewayDelivery } from "../src/gateways/contract/plugin.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";
import { PreparedDeliveryPoisonError, type PreparedDelivery } from "../src/domain/delivery.js";
import { connectPreparedDeliveryReservation } from "../src/composition/create-outbound-runtime.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { answerElementId } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { prepareOutboundGatewayIntent } from "../src/events/outbound-gateway-intent.js";
import { PermanentDeliveryError } from "../src/events/outbound-target-validation.js";
import type { SqliteAnswerSegmentStore } from "../src/store/sqlite/answer-segment-store.js";
import { createQueuedWorkerTurnCard, workerTurnElementId } from "../src/domain/worker-turn-card-view.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";

let store: SqliteBindingStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe("PreparedDelivery reservation", () => {
  it("fails fast and rolls back when a production producer is not connected", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "initial", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });

    expect(() => graph.promptAcceptance.acceptPrompt({
      prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "initial" },
      view,
      rootMessageId: "root",
      answerCard: primaryAnswerCard("prompt", 0)
    })).toThrow("Prompt Acceptance prepared delivery is not connected");
    expect(graph.promptDispatch.getPrompt("prompt")).toBeNull();
    expect(graph.outbox.listPendingOutboundReplies()).toEqual([]);
    graph.context.close();
  });

  it("prepares every Primary Answer boundary in one atomic multi-page reservation", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "initial", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });
    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "initial" }, view, rootMessageId: "root", answerCard: primaryAnswerCard("prompt", 0) });
    const initial = graph.outbox.listPendingOutboundReplies()[0]!;
    graph.outbox.markOutboundReplyDelivered(initial.id, "answer-message", "answer-card");
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn();
    answerSegments(graph).setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });

    const result = graph.projections.reserveHumanMessageAnswerSegments({
      aggregateKind: "primary-run", aggregateId: "prompt", expectedGeneration: 1, rootMessageId: "root",
      previousFinalizedCard: primaryAnswerCard("prompt", 0),
      nextCards: [primaryAnswerCard("prompt", 1), primaryAnswerCard("prompt", 2)],
      boundaries: [
        { sourceHumanItemId: "human-1", requestText: "continue one", sequence: 5 },
        { sourceHumanItemId: "human-2", requestText: "continue two", sequence: 9 }
      ]
    });

    expect(result.created).toBe(2);
    expect(handedOff).not.toHaveBeenCalled();
    await Promise.resolve();
    const replies = result.replyIds.map((id) => graph.outbox.getOutboundReply(id)!);
    expect(replies).toHaveLength(3);
    expect(replies.every((reply) => reply.state === "pending" && reply.gatewayPlanHash !== null)).toBe(true);
    expect(replies.filter(({ kind }) => kind === "stream_card_create").map(({ payload }) => JSON.parse(payload).stream)).toEqual([
      { pageIndex: 1, pageStart: 5, elementId: answerElementId("prompt", 1) },
      { pageIndex: 2, pageStart: 9, elementId: answerElementId("prompt", 2) }
    ]);
    expect(graph.projections.loadRunCard("prompt")).toMatchObject({ answerPageIndex: 0, answerPageStart: 0, answerElementId: answerElementId("prompt", 0) });
    expect(handedOff).toHaveBeenCalledTimes(3);
    graph.context.close();
  });

  it("freezes Worker Answer boundaries on the Worker Pane scope with a separate parent Pane fence", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane" });
    const createdWorker = graph.instances.createWorkerAgentInstance({
      id: "worker", projectId: "project", name: "Worker", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = graph.instances.attachAgentInstanceRuntime({ instanceId: createdWorker.id, expectedGeneration: createdWorker.generation, herdrWorkspaceId: "workspace", paneId: "worker-pane", nativeSessionId: "worker-session" })!;
    const view = createQueuedWorkerTurnCard({ turnId: "worker-turn", instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "worker-root", requestText: "work", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });
    graph.workerTurns.acceptInstanceTurnWithCard({ id: "worker-turn", idempotencyKey: "worker-turn", actor: { kind: "human", userId: "operator" }, projectId: "project", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work", parentTurnId: null, sourceMessageId: "worker-source", view, render: renderWorkerTurnCard });
    const initial = graph.outbox.listPendingOutboundReplies()[0]!;
    graph.outbox.markOutboundReplyDelivered(initial.id, "worker-message", "worker-card");
    connectRealGatewayPreparation(graph);
    expect(answerSegments(graph).reserveHumanMessageAnswerSegments({
      aggregateKind: "worker-turn", aggregateId: "worker-turn", expectedGeneration: worker.generation, rootMessageId: "worker-root",
      previousFinalizedCard: renderWorkerTurnCard(graph.workerTurns.loadWorkerTurnCard("worker-turn")!),
      nextCards: [renderWorkerTurnCard({ ...graph.workerTurns.loadWorkerTurnCard("worker-turn")!, pageIndex: 1, elementId: workerTurnElementId("worker-turn", 1) })],
      boundaries: [{ sourceHumanItemId: "human", requestText: "next", sequence: 2 }]
    })).toMatchObject({ created: 1 });
    const reply = graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === "worker-turn")!;
    expect(reply).toEqual(expect.objectContaining({
        workerTurnId: "worker-turn",
        deliveryScope: { kind: "pane", workspaceId: "workspace", paneId: "worker-pane" },
        deliveryParentPaneId: "primary-pane",
        deliveryOwnerFence: {
          kind: "worker",
          id: "worker",
          generation: worker.generation,
          sessionGeneration: 1,
          parent: { id: "binding", generation: 1, sessionGeneration: 1 }
        }
      }));
    expect(graph.database.prepare(`SELECT scope_pane_id,delivery_parent_pane_id,delivery_parent_id
      FROM outbound_replies WHERE id=?`).get(reply.id)).toEqual({
      scope_pane_id: "worker-pane", delivery_parent_pane_id: "primary-pane", delivery_parent_id: "binding"
    });
    expect(() => graph.database.prepare("UPDATE outbound_replies SET delivery_parent_pane_id='other' WHERE id=?").run(reply.id))
      .toThrow("immutable_outbound_revision");
    graph.context.close();
  });

  it("fails closed when a Worker delivery has no exact current runtime Pane", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane" });
    const worker = graph.instances.createWorkerAgentInstance({
      id: "worker", projectId: "project", name: "Worker", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;

    expect(() => graph.outbox.enqueueOutboundReply({
      id: "worker-without-runtime", idempotencyKey: "worker-without-runtime", workerId: worker.id,
      workerSessionGeneration: worker.workerSessionGeneration, rootMessageId: "worker-root", kind: "card_update", payload: "{}"
    })).toThrow("invalid_delivery_scope");
    expect(graph.outbox.listPendingOutboundReplies()).toEqual([]);
    graph.context.close();
  });

  it("fails closed instead of downgrading stale Primary Answer producers to Global", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "initial", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });
    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "initial" }, view, rootMessageId: "root", answerCard: primaryAnswerCard("prompt", 0) });
    graph.database.prepare("DELETE FROM outbound_replies").run();
    graph.database.prepare("DELETE FROM answer_pages").run();
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn();
    graph.prompts.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    answerSegments(graph).setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    graph.bindings.updateBinding("binding", { generation: 2 });

    expect(() => graph.prompts.ensureAnswerCard("prompt", "root", primaryAnswerCard("prompt", 0))).toThrow("binding generation changed");
    expect(graph.projections.reserveHumanMessageAnswerSegments({ aggregateKind: "primary-run", aggregateId: "prompt", expectedGeneration: 1, rootMessageId: "root", previousFinalizedCard: {}, nextCards: [{}], boundaries: [{ sourceHumanItemId: "human", requestText: "next", sequence: 2 }] })).toEqual({ created: 0, replyIds: [] });
    expect(graph.outbox.listPendingOutboundReplies()).toEqual([]);
    expect(handedOff).not.toHaveBeenCalled();
    graph.context.close();
  });

  it("prepares PromptStore Answer creation with its exact current Binding fence", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "initial", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });
    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "initial" }, view, rootMessageId: "root", answerCard: primaryAnswerCard("prompt", 0) });
    graph.database.prepare("DELETE FROM outbound_replies").run();
    graph.database.prepare("DELETE FROM answer_pages").run();
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn();
    graph.prompts.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });

    graph.prompts.ensureAnswerCard("prompt", "root", primaryAnswerCard("prompt", 0));
    await Promise.resolve();

    const reply = graph.outbox.listPendingOutboundReplies()[0]!;
    expect(reply).toMatchObject({ promptId: "prompt", gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", paneId: "pane" }, deliveryOwnerFence: { kind: "primary", id: "binding", generation: 1, sessionGeneration: 1 } });
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply.id }));
    graph.context.close();
  });

  it("prepares an externally adopted Primary Answer create through the exact Binding route", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session" });
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn();
    graph.externalTurnAdoption.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    const startedAt = "2026-10-06T00:00:01.000Z";
    const externalView = createQueuedRunCard({ promptId: "ignored", bindingId: "binding", bindingGeneration: 1, title: "Direct", workspaceId: "workspace", paneId: "pane", requestText: "direct", queuePosition: 0, occurredAt: startedAt });

    const result = graph.externalTurnAdoption.adoptExternalTurn({
      bindingId: "binding", expectedGeneration: 1, expectedPaneId: "pane",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session" },
      turnId: "turn", startedAt, requestText: "direct", externalPromptId: "external", externalMessageId: "external",
      externalView, answerCardFor: (view) => primaryAnswerCard(view.promptId, 0)
    });
    await Promise.resolve();

    expect(result).toMatchObject({ outcome: "created_external", outboxReserved: true });
    const reply = graph.outbox.listPendingOutboundReplies()[0]!;
    expect(reply).toMatchObject({ promptId: result.prompt!.id, gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", paneId: "pane" } });
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply.id }));
    graph.context.close();
  });

  it("reuses the original hot handoff when recovery finds an already frozen Answer create", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session" });
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn();
    const consumer = { enqueuePreparedDelivery: handedOff };
    graph.promptAcceptance.setPreparedDeliveryReservation(graph.outbox, consumer);
    graph.promptRecovery.setPreparedDeliveryReservation(graph.outbox, consumer);
    const view = createQueuedRunCard({ promptId: "frozen", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "initial", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });
    graph.promptAcceptance.acceptPrompt({ prompt: { id: "frozen", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "initial" }, view, rootMessageId: "root", answerCard: primaryAnswerCard("frozen", 0) });
    graph.database.prepare("UPDATE prompt_jobs SET state='recovering',observation_state='detached',native_submission_id=id WHERE id='frozen'").run();
    await Promise.resolve();
    expect(handedOff).toHaveBeenCalledOnce();

    expect(graph.promptRecovery.markDetachedPromptRecoveryNeedsHuman({ promptId: "frozen", bindingId: "binding", expectedBindingGeneration: 1, expectedPaneId: "pane", expectedNativeSessionId: "session", reason: "gap", occurredAt: "2026-10-06T00:00:01.000Z", renderRunCard: () => primaryAnswerCard("frozen", 0) })).toEqual({ outcome: "needs_human", outboxReserved: true });
    await Promise.resolve();

    const create = graph.outbox.listPendingOutboundReplies()[0]!;
    expect(create).toMatchObject({ state: "pending", gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", paneId: "pane" } });
    expect(handedOff).toHaveBeenCalledOnce();
    graph.context.close();
  });

  it("prepares and hands off Primary and explicit Global command-result snapshots", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    const commands = graph.commandIntents;
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const prepare = vi.fn((reply: OutboundReply): PreparedGatewayDelivery => ({
      protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1,
      operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey }
    }));
    graph.outbox.setGatewayPlanPreparer(prepare);
    const handedOff = vi.fn();
    commands.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    const base = { chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "operator", projectId: "project", workspaceId: "workspace" };

    commands.accept({
      id: "primary-command", idempotencyKey: "primary-command", laneKey: "binding:binding", command: { kind: "rename", title: "Renamed" },
      context: { ...base, sourceMessageId: "source-primary", primary: { bindingId: "binding", bindingGeneration: 1, paneId: "pane", terminalId: null, nativeSession: null, activePromptId: null } },
      replayPolicy: "safe-before-effect", acceptedAt: "2026-10-06T00:00:00.000Z"
    });
    commands.accept({
      id: "global-command", idempotencyKey: "global-command", laneKey: "project:project", command: { kind: "new", title: "New" },
      context: { ...base, sourceMessageId: "source-global", primary: null }, replayPolicy: "reconcilable", acceptedAt: "2026-10-06T00:00:01.000Z"
    });
    commands.accept({
      id: "stale-command", idempotencyKey: "stale-command", laneKey: "binding:binding", command: { kind: "rename", title: "Stale" },
      context: { ...base, sourceMessageId: "source-stale", primary: { bindingId: "binding", bindingGeneration: 2, paneId: "pane", terminalId: null, nativeSession: null, activePromptId: null } },
      replayPolicy: "safe-before-effect", acceptedAt: "2026-10-06T00:00:02.000Z"
    });
    await Promise.resolve();

    const primary = graph.outbox.getOutboundReply("command-status:primary-command:create")!;
    const global = graph.outbox.getOutboundReply("command-status:global-command:create")!;
    const stale = graph.outbox.getOutboundReply("command-status:stale-command:create");
    expect(primary).toMatchObject({ bindingId: "binding", deliveryScope: { kind: "pane", paneId: "pane" }, deliveryParentPaneId: null, gatewayPlanJson: expect.any(String) });
    expect(global).toMatchObject({ bindingId: null, deliveryScope: { kind: "global" }, deliveryParentPaneId: null, gatewayPlanJson: expect.any(String) });
    expect(stale).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: primary.id }));
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: global.id, scope: { kind: "global" } }));
    graph.context.close();
  });

  it("rolls back a Primary command and its status when deterministic preparation infrastructure fails", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    graph.outbox.setGatewayPlanPreparer(() => { throw new Error("prepare unavailable"); });
    graph.commandIntents.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery() {} });

    expect(() => graph.commandIntents.accept({
      id: "rollback-command", idempotencyKey: "rollback-command", laneKey: "binding:binding", command: { kind: "rename", title: "Renamed" },
      context: { chatId: "chat", topicId: "topic", rootMessageId: "root", sourceMessageId: "source", actorOpenId: "operator", projectId: "project", workspaceId: "workspace", primary: { bindingId: "binding", bindingGeneration: 1, paneId: "pane", terminalId: null, nativeSession: null, activePromptId: null } },
      replayPolicy: "safe-before-effect", acceptedAt: "2026-10-06T00:00:00.000Z"
    })).toThrow("prepare unavailable");
    expect(graph.commandIntents.get("rollback-command")).toBeNull();
    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM command_status_views").get()).toEqual({ count: 0 });
    expect(graph.outbox.listPendingOutboundReplies()).toEqual([]);
    graph.context.close();
  });

  it("hands off a Primary Human Review surface only after the binding projection commits", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", lastAgentState: "working" });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "review", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });
    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "review" }, view, rootMessageId: "root", answerCard: primaryAnswerCard("prompt", 0) });
    graph.database.prepare("UPDATE prompt_jobs SET state='running',observation_state='attached' WHERE id='prompt'").run();
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });

    expect(graph.bindingProjections.observePrimaryPromptState({
      bindingId: "binding", promptId: "prompt", expectedGeneration: 1, expectedPaneId: "pane", state: "blocked",
      notice: "Needs local review", occurredAt: "2026-10-06T00:00:01.000Z", renderHumanReviewNotification: (input) => input
    })).toMatchObject({ notification: { outcome: "reserved", kind: "requested" } });
    expect(handedOff).not.toHaveBeenCalled();
    await Promise.resolve();

    const reply = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) => projectionKey?.startsWith("human-review:primary:"));
    expect(reply).toMatchObject({
      gatewayPlanJson: expect.any(String), deliveryScope: { kind: "pane", paneId: "pane" },
      deliveryOwnerFence: { kind: "primary", id: "binding", generation: 1 }
    });
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply!.id }));
    graph.context.close();
  });

  it("dismisses a prepared Primary Answer create when its page target changes before claim", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn<(delivery: PreparedDelivery) => void>();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "answer", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });

    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "answer" }, view, rootMessageId: "root", answerCard: primaryAnswerCard("prompt", 0) });
    await Promise.resolve();
    const delivery = handedOff.mock.calls[0]![0];
    graph.database.prepare("UPDATE answer_pages SET state='finished',message_id='different-message',card_id='different-card' WHERE prompt_id='prompt' AND page_index=0").run();
    activatePreparedClaimFence(graph);

    expect(claimPrepared(graph, delivery)).toBeNull();
    expect(graph.outbox.getOutboundReply(delivery.replyId)).toMatchObject({
      state: "dismissed",
      error: "Dismissed stale Ring delivery before Gateway execution"
    });
    graph.context.close();
  });

  it("dismisses a prepared Primary Answer create when its Binding root changes before claim", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn<(delivery: PreparedDelivery) => void>();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "answer", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });

    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "answer" }, view, rootMessageId: "root", answerCard: primaryAnswerCard("prompt", 0) });
    await Promise.resolve();
    const delivery = handedOff.mock.calls[0]![0];
    graph.bindings.updateBinding("binding", { rootMessageId: "replacement-root" });
    activatePreparedClaimFence(graph);

    expect(claimPrepared(graph, delivery)).toBeNull();
    expect(graph.outbox.getOutboundReply(delivery.replyId)).toMatchObject({ state: "dismissed" });
    graph.context.close();
  });

  it("claims a prepared Primary Answer create rooted in an active exact thread alias", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", statusMessageId: "main-message" });
    expect(graph.outbox.reservePaneThreadAlias({ publicationKey: "pane-entry", actionMessageId: "directory", bindingId: "binding", bindingGeneration: 1, paneId: "pane", sourceMainMessageId: "main-message", targetChatId: "chat", card: {} })).toBe("reserved");
    graph.outbox.markOutboundReplyDelivered(graph.outbox.listPendingOutboundReplies()[0]!.id, "alias-root", undefined, undefined, "alias-topic");
    await Promise.resolve();
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn<(delivery: PreparedDelivery) => void>();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "answer", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });

    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "answer" }, view, rootMessageId: "alias-root", answerCard: primaryAnswerCard("prompt", 0) });
    await Promise.resolve();
    activatePreparedClaimFence(graph);

    expect(claimPrepared(graph, handedOff.mock.calls[0]![0])).not.toBeNull();
    graph.context.close();
  });

  it.each([
    ["alias root", "UPDATE binding_thread_aliases SET root_message_id='replacement-root',topic_id='replacement-topic'"],
    ["source Main", "UPDATE bindings SET status_message_id='replacement-main' WHERE id='binding'"],
    ["Topic revision", "UPDATE topic_views SET state_json=json_set(state_json, '$.viewVersion', 3) WHERE binding_id='binding'"]
  ])("dismisses a prepared Pane Entry update when its %s target changes before claim", async (_target, mutation) => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", statusMessageId: "main-message" });
    expect(graph.outbox.reservePaneThreadAlias({ publicationKey: "pane-entry", actionMessageId: "directory", bindingId: "binding", bindingGeneration: 1, paneId: "pane", sourceMainMessageId: "main-message", targetChatId: "chat", card: {} })).toBe("reserved");
    graph.outbox.markOutboundReplyDelivered(graph.outbox.listPendingOutboundReplies()[0]!.id, "alias-root", undefined, undefined, "alias-topic");
    await Promise.resolve();
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn<(delivery: PreparedDelivery) => void>();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });
    graph.projections.reserveMainCard({ ...initialTopicView("binding"), title: "Current", viewVersion: 2, deliveredVersion: 2 }, "root", {}, undefined, {});
    await Promise.resolve();
    const delivery = handedOff.mock.calls[0]![0];
    expect(graph.outbox.getOutboundReply(delivery.replyId)).toMatchObject({
      threadAliasId: expect.any(String), projectionKey: expect.stringMatching(/^pane-entry:/), viewVersion: 2
    });
    expect(delivery.snapshotRevision).toBe(2);
    graph.database.prepare(mutation).run();
    activatePreparedClaimFence(graph);

    expect(claimPrepared(graph, delivery)).toBeNull();
    expect(graph.outbox.getOutboundReply(delivery.replyId)).toMatchObject({ state: "dismissed" });
    graph.context.close();
  });

  it("does not claim a Pane Entry projection without persisted alias identity through the generic fallback", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", statusMessageId: "main-message" });
    graph.projections.saveTopicView({ ...initialTopicView("binding"), title: "Current", viewVersion: 2, deliveredVersion: 2 });
    connectRealGatewayPreparation(graph);
    const receipt = graph.outbox.reservePreparedOutboundReply({
      id: "missing-pane-entry-alias", idempotencyKey: "missing-pane-entry-alias", bindingId: "binding", bindingGeneration: 1,
      viewVersion: 2, rootMessageId: "alias-root", kind: "card_update", payload: "{}",
      laneKeyOverride: "pane-entry:missing", projectionKey: "pane-entry:missing", snapshotRevision: 2
    });
    const [delivery] = receipt.consumeEffects();
    activatePreparedClaimFence(graph);

    expect(claimPrepared(graph, delivery!)).toBeNull();
    expect(graph.outbox.getOutboundReply(delivery!.replyId)).toMatchObject({ state: "dismissed" });
    graph.context.close();
  });

  it("claims a prepared Pane Entry update with its exact alias and Topic revision", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", statusMessageId: "main-message" });
    expect(graph.outbox.reservePaneThreadAlias({ publicationKey: "pane-entry", actionMessageId: "directory", bindingId: "binding", bindingGeneration: 1, paneId: "pane", sourceMainMessageId: "main-message", targetChatId: "chat", card: {} })).toBe("reserved");
    graph.outbox.markOutboundReplyDelivered(graph.outbox.listPendingOutboundReplies()[0]!.id, "alias-root", undefined, undefined, "alias-topic");
    await Promise.resolve();
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn<(delivery: PreparedDelivery) => void>();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });
    graph.projections.reserveMainCard({ ...initialTopicView("binding"), title: "Current", viewVersion: 2, deliveredVersion: 2 }, "root", {}, undefined, {});
    await Promise.resolve();
    activatePreparedClaimFence(graph);

    const claim = claimPrepared(graph, handedOff.mock.calls[0]![0]);
    expect(claim).not.toBeNull();
    expect(graph.preparedDeliveries.acknowledgePreparedDelivery(claim!, {
      messageId: "alias-root", surfaceId: null, threadId: null
    })).toBe(true);
    graph.context.close();
  });

  it("delivers exact terminal orphan Answer and Main snapshots on their original Pane Ring", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const queued = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "answer", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });
    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "answer" }, view: queued, rootMessageId: "root", answerCard: primaryAnswerCard("prompt", 0) });
    graph.outbox.markOutboundReplyDelivered(graph.outbox.listPendingOutboundReplies()[0]!.id, "answer-message");
    graph.database.prepare("UPDATE prompt_jobs SET state='running',observation_state='attached' WHERE id='prompt'").run();
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn<(delivery: PreparedDelivery) => void>();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });
    const topic = { ...initialTopicView("binding"), workspaceId: "workspace", paneId: "pane", phase: "orphaned" as const, notice: "pane missing", viewVersion: 1 };

    expect(graph.bindingProjections.orphanBindingWithProjection({
      bindingId: "binding", expectedPaneId: "pane", expectedGeneration: 1, occurredAt: "2026-10-06T00:01:00.000Z",
      reason: "pane missing", view: topic, rootMessageId: "root", mainCard: {}, paneEntryCard: {}, renderRunCard: (run) => primaryAnswerCard(run.promptId, run.answerPageIndex)
    })).toMatchObject({ outcome: "orphaned" });
    await Promise.resolve();

    const answer = graph.outbox.listPendingOutboundReplies().find((reply) => reply.cardRole === "answer" && reply.kind === "card_update")!;
    const main = graph.outbox.listPendingOutboundReplies().find((reply) => reply.targetRole === "session_status")!;
    const deliveries = handedOff.mock.calls.map(([candidate]) => candidate);
    const answerDelivery = deliveries.find((candidate) => candidate.replyId === answer.id)!;
    const mainDelivery = deliveries.find((candidate) => candidate.replyId === main.id)!;
    expect(answer).toMatchObject({ deliveryScope: { kind: "pane", workspaceId: "workspace", paneId: "pane" } });
    expect(main).toMatchObject({ deliveryScope: { kind: "pane", workspaceId: "workspace", paneId: "pane" } });
    activatePreparedClaimFence(graph);
    const answerClaim = claimPrepared(graph, answerDelivery);
    expect(answerClaim).not.toBeNull();
    expect(graph.preparedDeliveries.acknowledgePreparedDelivery(answerClaim!, {
      messageId: "answer-message", surfaceId: null, threadId: null
    })).toBe(true);
    const mainClaim = claimPrepared(graph, mainDelivery);
    expect(mainClaim).not.toBeNull();
    expect(graph.preparedDeliveries.acknowledgePreparedDelivery(mainClaim!, {
      messageId: "main-message", surfaceId: null, threadId: null
    })).toBe(true);
    expect(graph.outbox.getOutboundReply(answerDelivery.replyId)).toMatchObject({ state: "delivered" });
    expect(graph.outbox.getOutboundReply(mainDelivery.replyId)).toMatchObject({ state: "delivered" });
    graph.context.close();
  });

  it("dismisses a prepared Primary Human Review create when its episode closes before claim", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", lastAgentState: "working" });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "review", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });
    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "review" }, view, rootMessageId: "root", answerCard: primaryAnswerCard("prompt", 0) });
    await Promise.resolve();
    const initialAnswer = graph.outbox.listPendingOutboundReplies()[0]!;
    graph.outbox.markOutboundReplyDelivered(initialAnswer.id, "answer-message", "answer-card");
    graph.database.prepare("UPDATE prompt_jobs SET state='running',observation_state='attached' WHERE id='prompt'").run();
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn<(delivery: PreparedDelivery) => void>();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });

    graph.bindingProjections.observePrimaryPromptState({
      bindingId: "binding", promptId: "prompt", expectedGeneration: 1, expectedPaneId: "pane", state: "blocked",
      notice: "Needs local review", occurredAt: "2026-10-06T00:00:01.000Z", renderHumanReviewNotification: (input) => input
    });
    await Promise.resolve();
    const delivery = handedOff.mock.calls[0]![0];
    graph.database.prepare("UPDATE primary_human_review_episodes SET state='resolved' WHERE create_reply_id=?").run(delivery.replyId);
    activatePreparedClaimFence(graph);

    expect(claimPrepared(graph, delivery)).toBeNull();
    expect(graph.outbox.getOutboundReply(delivery.replyId)).toMatchObject({ state: "dismissed" });
    graph.context.close();
  });

  it("rolls back a Primary Human Review episode and suppresses handoff when its surface cannot commit", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", lastAgentState: "working" });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "review", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });
    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "review" }, view, rootMessageId: "root", answerCard: primaryAnswerCard("prompt", 0) });
    await Promise.resolve();
    graph.database.prepare("UPDATE prompt_jobs SET state='running',observation_state='attached' WHERE id='prompt'").run();
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });
    graph.database.exec("CREATE TEMP TRIGGER reject_primary_review BEFORE INSERT ON outbound_replies WHEN NEW.projection_key LIKE 'human-review:primary:%' BEGIN SELECT RAISE(ABORT, 'forced review rollback'); END");

    expect(() => graph.bindingProjections.observePrimaryPromptState({
      bindingId: "binding", promptId: "prompt", expectedGeneration: 1, expectedPaneId: "pane", state: "blocked",
      notice: "Needs local review", occurredAt: "2026-10-06T00:00:01.000Z", renderHumanReviewNotification: (input) => input
    })).toThrow("forced review rollback");
    await Promise.resolve();

    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM primary_human_review_episodes").get()).toEqual({ count: 0 });
    expect(graph.bindings.getBinding("binding")).toMatchObject({ lastAgentState: "working" });
    expect(handedOff).not.toHaveBeenCalled();
    graph.context.close();
  });

  it("creates no Human Review episode or outbound work for a stale Primary fence", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", lastAgentState: "working" });
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "review", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });
    graph.promptAcceptance.acceptPrompt({ prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "review" }, view, rootMessageId: "root", answerCard: primaryAnswerCard("prompt", 0) });
    await Promise.resolve();
    graph.database.prepare("DELETE FROM outbound_replies").run();
    graph.bindings.updateBinding("binding", { generation: 2 });
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });

    expect(graph.bindingProjections.observePrimaryPromptState({
      bindingId: "binding", promptId: "prompt", expectedGeneration: 1, expectedPaneId: "pane", state: "blocked",
      notice: "Needs local review", occurredAt: "2026-10-06T00:00:01.000Z", renderHumanReviewNotification: (input) => input
    })).toMatchObject({ outcome: "stale", notification: { outcome: "skipped", reason: "stale-routing" } });
    await Promise.resolve();

    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM primary_human_review_episodes").get()).toEqual({ count: 0 });
    expect(graph.outbox.listPendingOutboundReplies()).toEqual([]);
    expect(handedOff).not.toHaveBeenCalled();
    graph.context.close();
  });

  it("publishes an Orchestrator clear result to its immutable source target through the original Primary fence", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "orchestrator", kind: "orchestrator", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "original-root", title: "Orchestrator" });
    graph.bindings.updateBinding("orchestrator", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", paneToken: "orch", traexSessionId: "terminal", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session" });
    graph.orchestratorClear.accept({
      id: "clear", idempotencyKey: "clear", actorOpenId: "operator", sourceMessageId: "original-source", confirmationId: "confirmation",
      bindingId: "orchestrator", bindingGeneration: 1, oldSessionEpoch: 1, expectedWorkspaceId: "workspace", expectedPaneId: "pane",
      expectedTerminalId: "terminal", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session" }, expectedStateChangeSeq: 1
    });
    graph.orchestratorClear.finish("clear", "succeeded");
    graph.bindings.updateBinding("orchestrator", { rootMessageId: "replacement-root" });
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });

    expect(graph.orchestratorClear.reserveResult("clear", { result: "done" })).toBe(true);
    expect(handedOff).not.toHaveBeenCalled();
    await Promise.resolve();

    const reply = graph.outbox.getOutboundReply("orchestrator-clear-result:clear");
    expect(reply).toMatchObject({
      rootMessageId: "original-source", deliveryScope: { kind: "pane", paneId: "pane" },
      deliveryOwnerFence: { kind: "primary", id: "orchestrator", generation: 1 }
    });
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply!.id }));
    graph.context.close();
  });

  it("rolls back Orchestrator result delivery and fails closed after its original Primary generation is stale", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "orchestrator", kind: "orchestrator", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Orchestrator" });
    graph.bindings.updateBinding("orchestrator", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane", paneToken: "orch", traexSessionId: "terminal", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session" });
    const accept = (id: string) => graph.orchestratorClear.accept({
      id, idempotencyKey: id, actorOpenId: "operator", sourceMessageId: `source-${id}`, confirmationId: `confirmation-${id}`,
      bindingId: "orchestrator", bindingGeneration: 1, oldSessionEpoch: 1, expectedWorkspaceId: "workspace", expectedPaneId: "pane",
      expectedTerminalId: "terminal", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session" }, expectedStateChangeSeq: 1
    });
    accept("rollback");
    graph.orchestratorClear.finish("rollback", "failed", "failed");
    connectRealGatewayPreparation(graph);
    const handedOff = vi.fn();
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery: handedOff });
    graph.database.exec("CREATE TEMP TRIGGER reject_clear_publication BEFORE INSERT ON orchestrator_clear_result_publications BEGIN SELECT RAISE(ABORT, 'forced clear rollback'); END");

    expect(() => graph.orchestratorClear.reserveResult("rollback", { result: "failed" })).toThrow("forced clear rollback");
    await Promise.resolve();
    expect(graph.outbox.getOutboundReply("orchestrator-clear-result:rollback")).toBeNull();
    expect(handedOff).not.toHaveBeenCalled();

    graph.database.exec("DROP TRIGGER reject_clear_publication");
    accept("stale");
    graph.orchestratorClear.finish("stale", "succeeded");
    graph.bindings.updateBinding("orchestrator", { generation: 2 });
    expect(graph.orchestratorClear.reserveResult("stale", { result: "done" })).toBe(false);
    expect(graph.outbox.getOutboundReply("orchestrator-clear-result:stale")).toBeNull();
    graph.context.close();
  });

  it("catches up a frozen Primary command status after ACK with the original Binding generation", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    graph.outbox.setGatewayPlanPreparer((reply) => ({ protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1, operation: reply.kind === "card_reply" ? "message.reply.view" : "surface.replace", intent: reply.kind === "card_reply" ? { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey } : { kind: "surface.replace", purpose: "operation-result", messageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] } } }));
    const handedOff = vi.fn();
    graph.commandIntents.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    (graph.outbox as unknown as { delivery: { setPreparedDeliveryReservation(reservation: typeof graph.outbox, consumer: { enqueuePreparedDelivery: typeof handedOff }): void } }).delivery.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    graph.commandIntents.accept({
      id: "command", idempotencyKey: "command", laneKey: "binding:binding", command: { kind: "rename", title: "Renamed" },
      context: { chatId: "chat", topicId: "topic", rootMessageId: "root", sourceMessageId: "source", actorOpenId: "operator", projectId: "project", workspaceId: "workspace", primary: { bindingId: "binding", bindingGeneration: 1, paneId: "pane", terminalId: null, nativeSession: null, activePromptId: null } },
      replayPolicy: "safe-before-effect", acceptedAt: "2026-10-06T00:00:00.000Z"
    });
    expect(() => graph.commandIntents.claimNext("binding:binding")).not.toThrow();
    graph.outbox.markOutboundReplyDelivered("command-status:command:create", "command-message", "command-card");
    await Promise.resolve();

    expect(graph.outbox.getOutboundReply("command-status:command:update:2")).toMatchObject({
      bindingId: "binding", deliveryOwnerFence: { kind: "primary", id: "binding", generation: 1 }, gatewayPlanJson: expect.any(String)
    });
    graph.context.close();
  });

  it("prepares only an exactly bound Primary natural-language confirmation", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const prepare = vi.fn((reply: OutboundReply): PreparedGatewayDelivery => ({ protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1, operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey } }));
    graph.outbox.setGatewayPlanPreparer(prepare);
    const handedOff = vi.fn();
    graph.naturalLanguageCommandConfirmations.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    const stage = (id: string, frozenTarget: { version: 1; kind: "swarm"; bindingId: string | null; bindingGeneration: number | null; paneId: string | null; terminalId: null; nativeSession: null; activePromptId: null }) => graph.naturalLanguageCommandConfirmations.stageNaturalLanguageCommandConfirmation({ confirmation: { id, sourceMessageId: `source-${id}`, actorOpenId: "operator", chatId: "chat", topicId: "topic", rootMessageId: "root", envelope: { version: 1, family: "swarm", command: { kind: "stop" } }, frozenTarget, expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-10-06T00:00:00.000Z" }, outbox: { id: `card-${id}`, idempotencyKey: `card-${id}`, card: {} } });
    stage("bound", { version: 1, kind: "swarm", bindingId: "binding", bindingGeneration: 1, paneId: "pane", terminalId: null, nativeSession: null, activePromptId: null });
    stage("stale", { version: 1, kind: "swarm", bindingId: "binding", bindingGeneration: 2, paneId: "pane", terminalId: null, nativeSession: null, activePromptId: null });
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledOnce();
    expect(handedOff).toHaveBeenCalledOnce();
    expect(graph.outbox.getOutboundReply("card-bound")).toMatchObject({ gatewayPlanJson: expect.any(String), deliveryScope: { kind: "pane" } });
    expect(graph.outbox.getOutboundReply("card-stale")).toBeNull();
    graph.context.close();
  });

  it("keeps Primary Input Card ACK catch-up on its original Binding generation", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    graph.outbox.setGatewayPlanPreparer((reply) => ({ protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1, operation: reply.kind === "card_reply" ? "message.reply.view" : "surface.replace", intent: reply.kind === "card_reply" ? { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey } : { kind: "surface.replace", purpose: "operation-result", messageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] } } }));
    const handedOff = vi.fn();
    graph.agentInputs.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    const delivery = (graph.outbox as unknown as { delivery: { setPreparedDeliveryReservation(reservation: typeof graph.outbox, consumer: { enqueuePreparedDelivery: typeof handedOff }): void } }).delivery;
    delivery.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    graph.agentInputs.admitLegacyPendingCard({
      submissionId: "submission", ingressSource: "feishu", sourceMessageKey: "source", actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root" }, text: "hello",
      owner: { kind: "primary", id: "binding", generation: 1 }, paneId: "pane", terminalId: "terminal", expectedAgentKind: "traex", expectedSessionId: "session", recordedAt: "2026-10-06T00:00:00.000Z"
    }, { rootMessageId: "root", pendingCard: { state: "pending" }, workingCard: { state: "working" } });
    graph.database.prepare("UPDATE input_card_views SET card_json=working_card_json,revision=2 WHERE submission_id='submission'").run();
    graph.outbox.markOutboundReplyDelivered("input-card:submission:create", "input-message", "input-card");
    await Promise.resolve();

    expect(graph.outbox.getOutboundReply("input-card:submission:update:2")).toMatchObject({
      bindingId: "binding", deliveryOwnerFence: { kind: "primary", id: "binding", generation: 1 }, gatewayPlanJson: expect.any(String)
    });
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: "input-card:submission:update:2" }));
    graph.context.close();
  });

  it("fails closed on stale Primary Input Card ACK catch-up", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    connectProducerFixture(graph);
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    graph.agentInputs.admitLegacyPendingCard({
      submissionId: "stale-submission", ingressSource: "feishu", sourceMessageKey: "stale-source", actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root" }, text: "hello",
      owner: { kind: "primary", id: "binding", generation: 1 }, paneId: "pane", terminalId: "terminal", expectedAgentKind: "traex", expectedSessionId: "session", recordedAt: "2026-10-06T00:00:00.000Z"
    }, { rootMessageId: "root", pendingCard: { state: "pending" }, workingCard: { state: "working" } });
    graph.database.prepare("UPDATE input_card_views SET card_json=working_card_json,revision=2 WHERE submission_id='stale-submission'").run();
    graph.database.prepare("UPDATE bindings SET state='archived' WHERE id='binding'").run();
    graph.outbox.markOutboundReplyDelivered("input-card:stale-submission:create", "input-message", "input-card");
    expect(graph.outbox.getOutboundReply("input-card:stale-submission:update:2")).toBeNull();
    graph.context.close();
  });

  it("prepares and hands off a legacy Primary Answer create only after Prompt acceptance commits", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.persistBindingPatch("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    graph.outbox.setGatewayPlanPreparer((reply) => ({
      protocolVersion: 1,
      gatewayId: reply.gatewayId,
      profileId: reply.gatewayProfileId,
      rendererRevision: 1,
      operation: "stream.create",
      intent: { kind: "stream.create", purpose: "primary-answer", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey }
    }));
    const handedOff = vi.fn();
    graph.promptAcceptance.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    const view = createQueuedRunCard({
      promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task",
      workspaceId: "workspace", paneId: "pane", requestText: "hello", queuePosition: 1,
      occurredAt: "2026-10-06T00:00:00.000Z"
    });

    graph.promptAcceptance.acceptPrompt({
      prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "hello" },
      view, rootMessageId: "root", answerCard: { schema: "2.0" }
    });

    expect(handedOff).not.toHaveBeenCalled();
    await Promise.resolve();
    const reply = graph.outbox.listPendingOutboundReplies()[0]!;
    expect(reply).toMatchObject({
      promptId: "prompt", bindingId: "binding", gatewayPlanJson: expect.any(String), gatewayPlanHash: expect.any(String),
      deliveryScope: { kind: "pane", workspaceId: "workspace", paneId: "pane" },
      deliveryOwnerFence: { kind: "primary", id: "binding", generation: 1, sessionGeneration: 1 }
    });
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply.id, cardSequence: null }));
    graph.capabilityModules().lifecycle.close();
  });

  it("does not hand off a prepared Primary Answer create when Prompt acceptance rolls back", async () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    graph.bindings.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    graph.bindings.persistBindingPatch("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    graph.outbox.setGatewayPlanPreparer((reply) => ({
      protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1,
      operation: "stream.create", intent: { kind: "stream.create", purpose: "primary-answer", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey }
    }));
    const handedOff = vi.fn();
    graph.promptAcceptance.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery: handedOff });
    graph.database.exec("CREATE TRIGGER reject_prompt_acceptance AFTER INSERT ON outbound_replies BEGIN SELECT RAISE(ABORT, 'forced acceptance rollback'); END");
    const view = createQueuedRunCard({ promptId: "prompt", bindingId: "binding", bindingGeneration: 1, title: "Task", workspaceId: "workspace", paneId: "pane", requestText: "hello", queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z" });

    expect(() => graph.promptAcceptance.acceptPrompt({
      prompt: { id: "prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "hello" },
      view, rootMessageId: "root", answerCard: { schema: "2.0" }
    })).toThrow("forced acceptance rollback");
    await Promise.resolve();

    expect(handedOff).not.toHaveBeenCalled();
    expect(graph.outbox.listPendingOutboundReplies()).toEqual([]);
    expect(graph.promptDispatch.getPrompt("prompt")).toBeNull();
    graph.capabilityModules().lifecycle.close();
  });

  it("returns the frozen Primary Turn Card effect only after its transaction commits", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const prepare = vi.fn((reply: OutboundReply): PreparedGatewayDelivery => Object.freeze({
      protocolVersion: 1,
      gatewayId: "feishu:primary",
      profileId: "feishu-cardkit-v1",
      rendererRevision: 1,
      operation: "message.reply.view",
      intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey }
    }));
    store.setGatewayPlanPreparer(prepare);

    const receipt = store.reservePreparedOutboundReply({
      id: "turn-card",
      idempotencyKey: "turn-card",
      bindingId: "binding",
      bindingGeneration: 1,
      targetRole: "operation_result",
      rootMessageId: "root",
      kind: "card_reply",
      payload: '{"schema":"2.0"}',
      projectionKey: "conversation-turn:segment:page:0",
      snapshotRevision: 1,
      viewVersion: 1,
      laneKeyOverride: "conversation-turn:segment:page:0"
    });

    expect(receipt.commitState).toBe("committed");
    expect(receipt.result).toMatchObject({ id: "turn-card", gatewayPlanJson: expect.any(String), gatewayPlanHash: expect.any(String) });
    expect(receipt.consumeEffects()).toEqual([
      expect.objectContaining({
        replyId: "turn-card",
        scope: expect.objectContaining({ kind: "pane", paneId: "pane" }),
        ownerFence: { kind: "primary", id: "binding", generation: 1, sessionGeneration: 1 },
        deliveryOrder: expect.any(Number),
        idempotencyKey: "turn-card",
        gatewayId: "feishu:primary",
        gatewayProfileId: "feishu-cardkit-v1",
        planHash: expect.any(String),
        projectionKey: "conversation-turn:segment:page:0",
        snapshotRevision: 1,
        rendererRevision: 1,
        cardSequence: null,
        priorCheckpoints: [],
        nextAttemptAt: expect.any(String),
        estimatedBytes: expect.any(Number)
      })
    ]);
    expect(receipt.consumeEffects()).toEqual([]);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("commits one typed deterministic poison effect without returning a prepared delivery", () => {
    store = new SqliteBindingStore(":memory:");
    store.setGatewayPlanPreparer(() => { throw new PreparedDeliveryPoisonError("secret renderer detail"); });

    const receipt = store.reservePreparedOutboundReply({ id: "poison", idempotencyKey: "poison", rootMessageId: "root", kind: "card_reply", payload: "{}" });

    expect(receipt.commitState).toBe("committed");
    expect(receipt.result).toMatchObject({ id: "poison", state: "dead_letter", attemptCount: 1, failureClass: "permanent", effectCertainty: "rejected", gatewayPlanJson: null });
    expect(receipt.result.error).not.toContain("secret renderer detail");
    expect(receipt.consumeEffects()).toEqual([]);
  });

  it("rolls back and propagates an untyped preparation infrastructure failure", () => {
    store = new SqliteBindingStore(":memory:");
    store.setGatewayPlanPreparer(() => { throw new Error("sqlite-adjacent outage"); });

    expect(() => store!.reservePreparedOutboundReply({ id: "infra", idempotencyKey: "infra", rootMessageId: "root", kind: "card_reply", payload: "{}" })).toThrow("sqlite-adjacent outage");
    expect(store.getOutboundReply("infra")).toBeNull();
  });

  it("replays the canonical frozen effect while pending but not after terminal settlement", () => {
    store = new SqliteBindingStore(":memory:");
    const prepare = vi.fn((reply: OutboundReply): PreparedGatewayDelivery => ({
      protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 2,
      operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [{ type: "markdown", markdown: "original" }] }, idempotencyKey: reply.idempotencyKey }
    }));
    store.setGatewayPlanPreparer(prepare);
    const input = { id: "original", idempotencyKey: "replay", rootMessageId: "root", kind: "card_reply" as const, payload: "{}" };

    const first = store.reservePreparedOutboundReply(input).consumeEffects()[0]!;
    const pendingReplay = store.reservePreparedOutboundReply(input).consumeEffects()[0]!;
    store.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message' WHERE id='original'").run();
    const terminalReplay = store.reservePreparedOutboundReply(input).consumeEffects()[0]!;

    expect(prepare).toHaveBeenCalledOnce();
    expect(pendingReplay).toEqual(first);
    expect(terminalReplay).toBeUndefined();
    expect(() => store!.reservePreparedOutboundReply({ ...input, payload: '{"changed":true}' })).toThrow("outbound_idempotency_conflict");
  });

  it("builds a deeply immutable delivery from the canonical stored plan JSON", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const plan: PreparedGatewayDelivery = {
      protocolVersion: 1, gatewayId: "feishu:primary", profileId: "feishu-cardkit-v1", rendererRevision: 1,
      operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: "root", view: { schemaVersion: 1, nodes: [{ type: "markdown", markdown: "stored" }] }, idempotencyKey: "immutable" }
    };
    store.setGatewayPlanPreparer(() => plan);
    const prepared = store.reservePreparedOutboundReply({
      id: "immutable", idempotencyKey: "immutable", bindingId: "binding", bindingGeneration: 1,
      rootMessageId: "root", kind: "card_reply", payload: "{}"
    }).consumeEffects()[0]!;
    (plan.intent as { rootMessageId: string }).rootMessageId = "mutated-after-prepare";

    expect((prepared.preparedPlan.intent as { rootMessageId: string }).rootMessageId).toBe("root");
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.scope)).toBe(true);
    expect(Object.isFrozen(prepared.ownerFence)).toBe(true);
    expect(Object.isFrozen(prepared.preparedPlan)).toBe(true);
    expect(Object.isFrozen(prepared.preparedPlan.intent)).toBe(true);
    expect(Object.isFrozen(prepared.priorCheckpoints)).toBe(true);
  });

  it("prepares and hands off a canonical Primary Turn Card only after its projection commits", async () => {
    const bundle = createTestStoreBundle();
    const driver = bundle.driver;
    const segments = driver.capabilityModules().conversationSegments;
    driver.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    driver.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    bundle.outbox.setGatewayPlanPreparer((reply) => ({ protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1, operation: "surface.replace", intent: { kind: "surface.replace", purpose: "operation-result", messageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] } } }));
    const handedOff: string[] = [];
    segments.setPreparedDeliveryReservation(bundle.outbox, { enqueuePreparedDelivery: (delivery) => handedOff.push(delivery.replyId) });
    const now = new Date().toISOString();
    driver.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('segment','lane','primary','binding',1,'traex','hello','working',2,'root',?,?)").run(now, now);
    driver.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,element_id,state,sequence,delivered_sequence,created_at,updated_at) VALUES('segment:page:0','segment',0,'message','turn-card:segment:page:0','active',1,1,?,?)").run(now, now);

    expect(segments.reserveSnapshot({ segmentId: "segment", pageIndex: 0, messageId: "message", elementId: "turn-card:segment:page:0", card: { schema: "2.0" }, cursor: null, viewVersion: 2 })).toBe("reserved");
    expect(handedOff).toEqual([]);
    await Promise.resolve();
    const reply = driver.listPendingOutboundReplies()[0]!;
    expect(reply).toMatchObject({ bindingId: "binding", deliveryScope: { kind: "pane", paneId: "pane" }, gatewayPlanJson: expect.any(String), gatewayPlanHash: expect.any(String) });
    expect(handedOff).toEqual([reply.id]);
    bundle.lifecycle.close();
  });

  it("does not hand off a prepared Turn Card when the enclosing projection rolls back", async () => {
    const bundle = createTestStoreBundle();
    const driver = bundle.driver;
    const segments = driver.capabilityModules().conversationSegments;
    driver.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    driver.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    bundle.outbox.setGatewayPlanPreparer((reply) => ({ protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1, operation: "surface.replace", intent: { kind: "surface.replace", purpose: "operation-result", messageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] } } }));
    const handedOff = vi.fn();
    segments.setPreparedDeliveryReservation(bundle.outbox, { enqueuePreparedDelivery: handedOff });
    const now = new Date().toISOString();
    driver.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('rollback-segment','lane','primary','binding',1,'traex','hello','working',2,'root',?,?)").run(now, now);
    driver.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,element_id,state,sequence,delivered_sequence,created_at,updated_at) VALUES('rollback-segment:page:0','rollback-segment',0,'message','turn-card:rollback-segment:page:0','active',1,1,?,?)").run(now, now);
    driver.database.exec("CREATE TRIGGER force_projection_rollback BEFORE UPDATE OF pending_reply_id ON conversation_segment_pages BEGIN SELECT RAISE(ABORT, 'forced projection rollback'); END");

    expect(() => segments.reserveSnapshot({ segmentId: "rollback-segment", pageIndex: 0, messageId: "message", elementId: "turn-card:rollback-segment:page:0", card: {}, cursor: null, viewVersion: 2 })).toThrow("forced projection rollback");
    await Promise.resolve();
    expect(handedOff).not.toHaveBeenCalled();
    expect(driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key='turn-card:rollback-segment:page:0'").get()).toEqual({ count: 0 });
    bundle.lifecycle.close();
  });

  it("routes the canonical human-event initial Turn Card create through prepared reservation", async () => {
    const bundle = createTestStoreBundle();
    const driver = bundle.driver;
    const segments = driver.capabilityModules().conversationSegments;
    driver.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    driver.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    bundle.agentInputs.admit({
      submissionId: "submission", ingressSource: "feishu:primary", sourceMessageKey: "source",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root" },
      text: "hello", owner: { kind: "primary", id: "binding", generation: 1 }, paneId: "pane", terminalId: "terminal",
      expectedAgentKind: "traex", expectedSessionId: "session", recordedAt: "2026-10-06T00:00:00.000Z"
    });
    segments.setInitialTurnCardRenderer(() => ({ schema: "2.0" }));
    bundle.outbox.setGatewayPlanPreparer((reply) => ({ protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1, operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey } }));
    const handedOff = vi.fn();
    segments.setPreparedDeliveryReservation(bundle.outbox, { enqueuePreparedDelivery: handedOff });

    const result = segments.projectCanonicalEvent({
      laneId: "lane", laneSequence: 1, observedAt: "2026-10-06T00:00:01.000Z",
      event: { schemaVersion: 1, eventId: "human", cursor: "1", sourceId: "source", agentKind: "traex", sessionId: "session", turnId: "turn", occurredAt: "2026-10-06T00:00:01.000Z", payload: { type: "human_message", message_id: "message", submission_id: "submission", text: "hello" } }
    });
    await Promise.resolve();

    const reply = driver.listPendingOutboundReplies()[0]!;
    expect(result.outcome).toBe("created");
    expect(reply).toMatchObject({ id: `turn-card:${result.segmentId}:page:0:create`, bindingId: "binding", gatewayPlanJson: expect.any(String) });
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply.id }));
    bundle.lifecycle.close();
  });

  it("routes legacy pending Primary Turn Card admission through prepared reservation", async () => {
    const bundle = createTestStoreBundle();
    const driver = bundle.driver;
    const segments = driver.capabilityModules().conversationSegments;
    driver.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    driver.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    bundle.outbox.setGatewayPlanPreparer((reply) => ({ protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1, operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey } }));
    const handedOff = vi.fn();
    segments.setPreparedDeliveryReservation(bundle.outbox, { enqueuePreparedDelivery: handedOff });

    segments.admitLegacyPending({ segmentId: "legacy-segment", submissionId: "submission", producerKey: "lane", owner: { kind: "primary", id: "binding", generation: 1 }, agentKind: "traex", expectedSessionId: "session", requestText: "hello", rootMessageId: "root", card: { schema: "2.0" }, occurredAt: "2026-10-06T00:00:00.000Z" });
    await Promise.resolve();

    const reply = driver.listPendingOutboundReplies()[0]!;
    expect(reply).toMatchObject({ bindingId: "binding", gatewayPlanJson: expect.any(String), deliveryScope: { kind: "pane", paneId: "pane" } });
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply.id }));
    bundle.lifecycle.close();
  });

  it("composes the prepared reservation and committed-delivery consumer seams", () => {
    let preparer: ((reply: OutboundReply) => PreparedGatewayDelivery) | undefined;
    let reservation: unknown;
    let consumer: { enqueuePreparedDelivery(delivery: never): void } | undefined;
    const outbox = {
      setGatewayPlanPreparer: vi.fn((value) => { preparer = value; }),
      reservePreparedOutboundReply: vi.fn()
    };
    const segments = { setPreparedDeliveryReservation: vi.fn((value, sink) => { reservation = value; consumer = sink; }) };
    const prepare = vi.fn((intent) => ({ protocolVersion: 1, gatewayId: "feishu:primary", profileId: "feishu-cardkit-v1", rendererRevision: 1, operation: intent.kind, intent }));
    const wake = vi.fn();

    connectPreparedDeliveryReservation(outbox as never, segments, { prepare } as never, { enqueuePreparedDelivery: wake });
    expect(reservation).toBe(outbox);
    consumer!.enqueuePreparedDelivery({} as never);
    expect(wake).toHaveBeenCalledOnce();
    expect(preparer).toBeTypeOf("function");
  });
});

function answerSegments(graph: SqliteCapabilityGraph): SqliteAnswerSegmentStore {
  return (graph.projections as unknown as { segments: SqliteAnswerSegmentStore }).segments;
}

function primaryAnswerCard(promptId: string, pageIndex: number): object {
  return { schema: "2.0", body: { elements: [{ tag: "markdown", element_id: answerElementId(promptId, pageIndex), content: `page-${pageIndex}` }] } };
}

function activatePreparedClaimFence(graph: SqliteCapabilityGraph): void {
  const lease = graph.leases.acquireInstanceLease("test-owner", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z")!;
  graph.capabilityModules().lifecycle.activateWriteFence(lease.ownerId, lease.fencingToken);
}

function claimPrepared(graph: SqliteCapabilityGraph, delivery: PreparedDelivery) {
  return graph.preparedDeliveries.claimPreparedDelivery({
    delivery,
    at: "2098-10-06T00:00:00.000Z",
    expiresAt: "2098-10-06T00:01:00.000Z"
  });
}

function connectProducerFixture(graph: SqliteCapabilityGraph): void {
  connectRealGatewayPreparation(graph);
  graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery() {} });
}

function connectRealGatewayPreparation(graph: SqliteCapabilityGraph): void {
  const deliveryStore = graph.capabilityModules().outbox;
  graph.outbox.setGatewayPlanPreparer((reply) => {
    try {
      const { intent } = prepareOutboundGatewayIntent(deliveryStore, reply);
      return { protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1, operation: intent.kind, intent };
    } catch (error) {
      if (error instanceof PermanentDeliveryError) throw new PreparedDeliveryPoisonError("invalid deterministic test delivery", { cause: error });
      throw error;
    }
  });
}
