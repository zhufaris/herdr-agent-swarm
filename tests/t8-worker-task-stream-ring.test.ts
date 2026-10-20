import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQueuedWorkerTurnCard, workerTurnElementId, workerTurnProgressElementId } from "../src/domain/worker-turn-card-view.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { renderWorkerHumanReviewNotification } from "../src/cards/worker-human-review-notification.js";
import { createWorkerMainView } from "../src/domain/worker-main-view.js";
import type { OutboundReply } from "../src/domain/types.js";
import { connectPreparedDeliveryProducers } from "../src/composition/create-outbound-runtime.js";
import type { GatewayDeliveryIntent } from "../src/gateways/contract/plugin.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";
import { WORKER_EXPIRED_TARGET_PROOFS } from "../src/store/sqlite/outbox-recovery/semantic-recovery-proof.js";

let graph: SqliteCapabilityGraph | undefined;
let temporaryDirectory: string | undefined;

afterEach(() => {
  graph?.context.close();
  graph = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function fixture(path = ":memory:") {
  graph = new SqliteCapabilityGraph(path);
  graph.bindings.createPendingBinding({
    id: "binding",
    projectId: "project",
    workspaceId: "primary-workspace",
    chatId: "chat",
    topicId: "primary-topic",
    rootMessageId: "primary-root",
    title: "Primary",
    creatorOpenId: "operator"
  });
  graph.bindings.updateBinding("binding", {
    state: "active",
    lifecycle: "active",
    attachment: "attached",
    paneId: "primary-pane",
    statusMessageId: "primary-root"
  });
  const created = graph.instances.createWorkerAgentInstance({
    id: "worker",
    projectId: "project",
    name: "Worker",
    role: "worker",
    agentKind: "traex",
    model: null,
    desiredState: "running",
    parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
    workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
  }, 4);
  if (created.outcome !== "created") throw new Error("expected Worker");
  const worker = graph.instances.attachAgentInstanceRuntime({
    instanceId: created.instance.id,
    expectedGeneration: created.instance.generation,
    herdrWorkspaceId: "primary-workspace",
    paneId: "worker-pane",
    nativeSessionId: "worker-session"
  })!;
  const gatewayDelivery = { prepare: (intent: GatewayDeliveryIntent) => ({
    protocolVersion: 1,
    gatewayId: "feishu:primary",
    profileId: "feishu-cardkit-v1",
    rendererRevision: 1,
    operation: intent.kind,
    intent
  }) };
  const handedOff = vi.fn();
  connectPreparedDeliveryProducers(graph.capabilityModules().outbox, graph, gatewayDelivery, { enqueuePreparedDelivery: handedOff });
  return { graph, worker, handedOff };
}

function acceptWorkerTask(target: ReturnType<typeof fixture>, turnId = "worker-turn") {
  const view = createQueuedWorkerTurnCard({
    turnId,
    instanceId: target.worker.id,
    instanceGeneration: target.worker.generation,
    workerSessionGeneration: target.worker.workerSessionGeneration,
    workerName: target.worker.name,
    parentTurnId: null,
    rootMessageId: "worker-thread-root",
    requestText: "run the task",
    queuePosition: 1,
    occurredAt: "2026-10-06T00:00:00.000Z"
  });
  target.graph.workerTurns.acceptInstanceTurnWithCard({
    id: view.turnId,
    idempotencyKey: view.turnId,
    actor: { kind: "human", userId: "operator", channel: "feishu" },
    projectId: "project",
    instanceId: target.worker.id,
    instanceGeneration: target.worker.generation,
    kind: "turn",
    text: view.requestText,
    parentTurnId: null,
    sourceMessageId: `source-${turnId}`,
    view,
    render: renderWorkerTurnCard
  });
  return view;
}

function activateDeliveryFence(target: ReturnType<typeof fixture>) {
  const lease = target.graph.leases.acquireInstanceLease(
    "owner",
    "2026-10-06T00:00:00.000Z",
    "2099-01-01T00:00:00.000Z"
  )!;
  target.graph.leases.activateWriteFence(lease.ownerId, lease.fencingToken);
}

async function activateCanonicalWorkerThread(target: ReturnType<typeof fixture>) {
  const main = createWorkerMainView({
    workerId: target.worker.id,
    workerSessionGeneration: target.worker.workerSessionGeneration,
    parentBindingId: "binding",
    parentBindingGeneration: 1,
    parentPaneId: "primary-pane",
    workerName: target.worker.name,
    ownerName: "Primary",
    runtimeGeneration: target.worker.generation,
    runtimeState: target.worker.observedState,
    runtimeAttached: true,
    desiredState: target.worker.desiredState,
    parentActive: true,
    paneId: "worker-pane",
    workspace: "/repo",
    branch: null,
    model: null,
    occurredAt: "2026-10-06T00:00:00.000Z"
  });
  target.graph.cardContexts.saveWorkerMainView(main);
  expect(target.graph.workerThreads.reserve({
    publicationKey: `worker-thread:${target.worker.id}:${target.worker.workerSessionGeneration}`,
    workerId: target.worker.id,
    workerSessionGeneration: target.worker.workerSessionGeneration,
    parentBindingId: "binding",
    parentBindingGeneration: 1,
    parentPaneId: "primary-pane",
    targetChatId: "chat",
    mode: "canonical-main",
    viewVersion: main.viewVersion,
    card: { schema: "2.0" }
  })).toBe("reserved");
  await Promise.resolve();
  const create = target.graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
    projectionKey === `worker-main:${target.worker.id}:${target.worker.workerSessionGeneration}`)!;
  const claim = target.graph.preparedDeliveries.claimPreparedDelivery({
    delivery: deliveryFor(target, create.id),
    at: "2098-10-06T00:00:00.000Z",
    expiresAt: "2098-10-06T00:01:00.000Z"
  });
  expect(claim).not.toBeNull();
  if (!claim) throw new Error("expected canonical Worker thread claim");
  expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(claim, {
    messageId: "worker-thread-root",
    surfaceId: "worker-main-card",
    threadId: "worker-topic"
  })).toBe(true);
}

function deliveryFor(target: ReturnType<typeof fixture>, replyId: string) {
  return target.handedOff.mock.calls
    .map(([delivery]) => delivery)
    .find((delivery) => delivery.replyId === replyId)!;
}

function expectWorkerPaneRing(target: ReturnType<typeof fixture>, reply: OutboundReply) {
  expect(reply).toMatchObject({
    deliveryScope: { kind: "pane", workspaceId: "primary-workspace", paneId: "worker-pane" },
    deliveryParentPaneId: "primary-pane",
    deliveryOwnerFence: {
      kind: "worker",
      id: "worker",
      generation: target.worker.generation,
      sessionGeneration: target.worker.workerSessionGeneration,
      parent: { id: "binding", generation: 1, sessionGeneration: 1 }
    }
  });
  expect(reply.deliveryScope).not.toEqual(expect.objectContaining({ paneId: "primary-pane" }));
}

describe("T8 Worker Task and Answer Ring migration", () => {
  it("atomically reserves the initial Worker Task stream in its exact Worker Pane Ring", async () => {
    const target = fixture();
    const view = acceptWorkerTask(target);
    await Promise.resolve();

    const reply = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === view.turnId)!;
    expect(reply.kind).toBe("stream_card_create");
    expectWorkerPaneRing(target, reply);
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply.id }));
  });

  it("delivers an independent Worker Task through its Worker Pane Ring after another task is conflict-isolated", async () => {
    const target = fixture();
    const failedView = acceptWorkerTask(target, "worker-isolated-a");
    const independentView = acceptWorkerTask(target, "worker-independent-b");
    await Promise.resolve();
    activateDeliveryFence(target);
    const failedReply = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === failedView.turnId)!;
    const independentReply = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === independentView.turnId)!;
    const failedDelivery = deliveryFor(target, failedReply.id);
    const independentDelivery = deliveryFor(target, independentReply.id);
    const failedClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: failedDelivery,
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    });
    if (!failedClaim) throw new Error("expected first Worker Task claim");
    expect(target.graph.preparedDeliveries.failPreparedDelivery(failedClaim, {
      error: "unknown Worker Task outcome",
      retryAt: "2098-10-06T00:02:00.000Z",
      metadata: { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null }
    })).toBe("dead_letter");

    expect(target.graph.preparedDeliveries.recoverQuarantinedRingHeads({
      afterScopeKey: null,
      limit: 10,
      at: "2098-10-06T00:02:00.000Z"
    }).transitionedScopeKeys).toEqual([expect.stringContaining("worker-pane")]);
    expect(target.graph.preparedDeliveries.loadScopePage({
      scope: independentDelivery.scope,
      afterScopeKey: null,
      limit: 1,
      at: "2098-10-06T00:02:00.000Z"
    }).items[0]).toMatchObject({
      authoritativeBlocker: { replyId: failedReply.id },
      head: { replyId: independentReply.id, status: "ready" }
    });
    expect(target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: independentDelivery,
      at: "2098-10-06T00:02:00.000Z",
      expiresAt: "2098-10-06T00:03:00.000Z"
    })).toMatchObject({ replyId: independentReply.id });
  });

  it("keeps Worker Task content, progress, finish, and continuation under one Ring owner and settles stream checkpoints through ACK", async () => {
    const target = fixture();
    const view = acceptWorkerTask(target);
    await Promise.resolve();
    activateDeliveryFence(target);

    const create = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === view.turnId)!;
    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, create.id),
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    });
    expect(createClaim).not.toBeNull();
    if (!createClaim) throw new Error("expected Worker Task create claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "worker-task-message-0",
      surfaceId: "worker-task-card-0"
    })).toBe(true);
    expect(target.graph.workerTurns.listWorkerTurnCardPages(view.turnId)).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "active", messageId: "worker-task-message-0", cardId: "worker-task-card-0" })
    ]);

    expect(target.graph.workerTurns.reserveWorkerTurnContent({
      turnId: view.turnId,
      pageIndex: 0,
      cardId: "worker-task-card-0",
      elementId: view.elementId,
      content: "partial answer",
      sourceEnd: 14
    })).toBe("reserved");
    await Promise.resolve();
    const content = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind, selectionId }) =>
      workerTurnId === view.turnId && kind === "stream_content" && selectionId === null)!;
    expectWorkerPaneRing(target, content);
    const contentClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, content.id),
      at: "2098-10-06T00:00:01.000Z",
      expiresAt: "2098-10-06T00:01:01.000Z"
    });
    expect(contentClaim).not.toBeNull();
    if (!contentClaim) throw new Error("expected Worker Task content claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(contentClaim, { messageId: "worker-task-message-0" })).toBe(true);

    expect(target.graph.workerTurns.reserveWorkerTurnProgress({
      turnId: view.turnId,
      pageIndex: 0,
      cardId: "worker-task-card-0",
      elementId: workerTurnProgressElementId(view.turnId, 0),
      content: "working"
    })).toBe("reserved");
    await Promise.resolve();
    const progress = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, selectionId }) =>
      workerTurnId === view.turnId && selectionId === "worker-progress")!;
    expectWorkerPaneRing(target, progress);
    const progressClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, progress.id),
      at: "2098-10-06T00:00:02.000Z",
      expiresAt: "2098-10-06T00:01:02.000Z"
    });
    expect(progressClaim).not.toBeNull();
    if (!progressClaim) throw new Error("expected Worker Task progress claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(progressClaim, { messageId: "worker-task-message-0" })).toBe(true);

    expect(target.graph.workerTurns.reserveWorkerTurnContinuation({
      turnId: view.turnId,
      pageIndex: 0,
      cardId: "worker-task-card-0",
      summary: "page 0 complete",
      nextPageIndex: 1,
      nextPageStart: 14,
      nextElementId: workerTurnElementId(view.turnId, 1),
      rootMessageId: view.rootMessageId,
      viewVersion: view.viewVersion,
      card: { schema: "2.0", body: { elements: [{ tag: "markdown", element_id: workerTurnProgressElementId(view.turnId, 1), content: "working" }] } }
    })).toBe("reserved");
    await Promise.resolve();
    const finish = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind }) =>
      workerTurnId === view.turnId && kind === "stream_finish")!;
    const continuation = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind, streamPageIndex }) =>
      workerTurnId === view.turnId && kind === "stream_card_create" && streamPageIndex === 1)!;
    expectWorkerPaneRing(target, finish);
    expectWorkerPaneRing(target, continuation);

    const finishClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, finish.id),
      at: "2098-10-06T00:00:03.000Z",
      expiresAt: "2098-10-06T00:01:03.000Z"
    });
    expect(finishClaim).not.toBeNull();
    if (!finishClaim) throw new Error("expected Worker Task finish claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(finishClaim, { messageId: "worker-task-message-0" })).toBe(true);

    const continuationClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, continuation.id),
      at: "2098-10-06T00:00:04.000Z",
      expiresAt: "2098-10-06T00:01:04.000Z"
    });
    expect(continuationClaim).not.toBeNull();
    if (!continuationClaim) throw new Error("expected Worker Task continuation claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(continuationClaim, {
      messageId: "worker-task-message-1",
      surfaceId: "worker-task-card-1"
    })).toBe(true);
    expect(target.graph.workerTurns.listWorkerTurnCardPages(view.turnId)).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen", sequence: finish.cardSequence }),
      expect.objectContaining({ pageIndex: 1, state: "active", messageId: "worker-task-message-1", cardId: "worker-task-card-1" })
    ]);
  });

  it("atomically reserves Worker-owned conversation segment fold and continuation in the Worker Pane Ring", async () => {
    const target = fixture();
    const view = acceptWorkerTask(target, "worker-segment-turn");
    await Promise.resolve();
    activateDeliveryFence(target);
    const create = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === view.turnId)!;
    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, create.id),
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    })!;
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "worker-segment-message-0",
      surfaceId: "worker-segment-card-0"
    })).toBe(true);

    const reserved = target.graph.workerTurns.reserveHumanMessageAnswerSegments({
      aggregateKind: "worker-turn",
      aggregateId: view.turnId,
      expectedGeneration: target.worker.generation,
      rootMessageId: view.rootMessageId,
      previousFinalizedCard: { revision: "page-0-final" },
      nextCards: [{ schema: "2.0", body: { elements: [{ tag: "markdown", element_id: workerTurnProgressElementId(view.turnId, 1), content: "working" }] } }],
      boundaries: [{ sourceHumanItemId: "human-1", requestText: "continue", sequence: 4 }]
    });
    expect(reserved).toMatchObject({ created: 1, replyIds: [expect.any(String), expect.any(String)] });
    await Promise.resolve();

    const [foldId, continuationId] = reserved.replyIds;
    const fold = target.graph.outbox.getOutboundReply(foldId!)!;
    const continuation = target.graph.outbox.getOutboundReply(continuationId!)!;
    expect(fold).toMatchObject({
      kind: "card_update",
      streamPageIndex: 0,
      projectionKey: `worker-task:${view.turnId}:page:0`
    });
    expect(continuation).toMatchObject({
      kind: "stream_card_create",
      streamPageIndex: 1,
      projectionKey: `worker-task:${view.turnId}:page:1`
    });
    expectWorkerPaneRing(target, fold);
    expectWorkerPaneRing(target, continuation);
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: fold.id }));
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: continuation.id }));

    const foldClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, fold.id),
      at: "2098-10-06T00:00:01.000Z",
      expiresAt: "2098-10-06T00:01:01.000Z"
    });
    expect(foldClaim).not.toBeNull();
    if (!foldClaim) throw new Error("expected Worker segment fold claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(foldClaim, {
      messageId: "worker-segment-message-0",
      surfaceId: "worker-segment-card-0"
    })).toBe(true);

    const continuationClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, continuation.id),
      at: "2098-10-06T00:00:02.000Z",
      expiresAt: "2098-10-06T00:01:02.000Z"
    });
    expect(continuationClaim).not.toBeNull();
    if (!continuationClaim) throw new Error("expected Worker segment continuation claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(continuationClaim, {
      messageId: "worker-segment-message-1",
      surfaceId: "worker-segment-card-1"
    })).toBe(true);
    expect(target.graph.workerTurns.listWorkerTurnCardPages(view.turnId)).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen" }),
      expect.objectContaining({ pageIndex: 1, state: "active", messageId: "worker-segment-message-1", cardId: "worker-segment-card-1" })
    ]);
  });

  it("keeps Worker completion choices inline without a parent Pane Ring reminder effect", async () => {
    const target = fixture();
    const view = acceptWorkerTask(target, "worker-completion-turn");
    await Promise.resolve();
    activateDeliveryFence(target);
    const create = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === view.turnId)!;
    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, create.id),
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    })!;
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "worker-completion-message",
      surfaceId: "worker-completion-card"
    })).toBe(true);

    target.graph.workerTurns.claimNextInstanceTurn(target.worker.id, target.worker.generation);
    const answer = "Done.\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"Continue?\",\"default\":\"yes\",\"options\":[{\"id\":\"yes\",\"label\":\"Continue\",\"message\":\"default\"}]}\n```";
    target.graph.workerTurns.transitionInstanceTurnWithProjection({
      turnId: view.turnId,
      expectedGeneration: target.worker.generation,
      state: "completed",
      result: answer,
      eventKind: "turn.completed",
      change: { type: "completed", occurredAt: "2026-10-06T00:00:01.000Z", answer },
      render: renderWorkerTurnCard
    });
    expect(target.graph.workerTurns.reserveWorkerTurnFinish({
      turnId: view.turnId,
      pageIndex: 0,
      cardId: "worker-completion-card",
      summary: "done"
    })).toBe("reserved");
    await Promise.resolve();
    const finish = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind }) =>
      workerTurnId === view.turnId && kind === "stream_finish")!;
    const finishClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, finish.id),
      at: "2098-10-06T00:00:01.000Z",
      expiresAt: "2098-10-06T00:01:01.000Z"
    })!;
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(finishClaim, {
      messageId: "worker-completion-message"
    })).toBe(true);

    const action = target.graph.workerTurns.prepareWorkerCompletionActionSet({
      turnId: view.turnId,
      pageIndex: 0,
      cardId: "worker-completion-card",
      messageId: "worker-completion-message"
    });
    expect(action).toMatchObject({ state: "available", mentionOpenId: "operator" });
    if (!action) throw new Error("expected Worker completion action");
    expect(target.graph.workerTurns.reserveWorkerTurnCardHydration({
      turnId: view.turnId,
      pageIndex: 0,
      cardId: "worker-completion-card",
      messageId: "worker-completion-message",
      card: { actionSetId: action.id }
    })).toBe("reserved");
    await Promise.resolve();
    const component = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind }) =>
      workerTurnId === view.turnId && kind === "card_update")!;
    const componentClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, component.id),
      at: "2098-10-06T00:00:02.000Z",
      expiresAt: "2098-10-06T00:01:02.000Z"
    })!;
    target.handedOff.mockClear();
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(componentClaim, {
      messageId: "worker-completion-message",
      surfaceId: "worker-completion-card"
    })).toBe(true);
    await Promise.resolve();

    expect(target.graph.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) =>
      idempotencyKey.startsWith("worker-next-input:"))).toHaveLength(0);
    expect(target.handedOff).not.toHaveBeenCalled();
    expect(target.graph.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='worker-turn' AND owner_id=?`).get(view.turnId)).toEqual({ state: "suppressed", notification_reply_id: null });
    expect(target.graph.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "available" });
    expect(target.graph.workerTurns.prepareWorkerCompletionActionSet({
      turnId: view.turnId,
      pageIndex: 0,
      cardId: "worker-completion-card",
      messageId: "worker-completion-message"
    })).toMatchObject({ id: action.id, state: "available" });
    await Promise.resolve();
    expect(target.graph.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) =>
      idempotencyKey.startsWith("worker-next-input:"))).toHaveLength(0);
    expect(target.handedOff).not.toHaveBeenCalled();
  });

  it("claims and acknowledges a fresh Worker Completion Review through the Worker Pane Ring", async () => {
    const target = fixture();
    const view = acceptWorkerTask(target, "worker-fresh-review-turn");
    await Promise.resolve();
    activateDeliveryFence(target);
    const create = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === view.turnId)!;
    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, create.id), at: "2098-10-06T00:00:00.000Z", expiresAt: "2098-10-06T00:01:00.000Z"
    })!;
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "worker-fresh-message", surfaceId: "worker-fresh-card"
    })).toBe(true);
    target.graph.workerTurns.claimNextInstanceTurn(target.worker.id, target.worker.generation);
    const answer = "Done.\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"Continue?\",\"default\":\"yes\",\"options\":[{\"id\":\"yes\",\"label\":\"Continue\",\"message\":\"default\"}]}\n```";
    target.graph.workerTurns.transitionInstanceTurnWithProjection({
      turnId: view.turnId, expectedGeneration: target.worker.generation, state: "completed", result: answer,
      eventKind: "turn.completed", change: { type: "completed", occurredAt: "2026-10-06T00:00:01.000Z", answer }, render: renderWorkerTurnCard
    });
    expect(target.graph.workerTurns.reserveWorkerTurnFinish({ turnId: view.turnId, pageIndex: 0, cardId: "worker-fresh-card", summary: "done" })).toBe("reserved");
    await Promise.resolve();
    const finish = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind }) => workerTurnId === view.turnId && kind === "stream_finish")!;
    const finishClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, finish.id), at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })!;
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(finishClaim, { messageId: "worker-fresh-message" })).toBe(true);
    const action = target.graph.workerTurns.prepareWorkerCompletionActionSet({
      turnId: view.turnId, pageIndex: 0, cardId: "worker-fresh-card", messageId: "worker-fresh-message", card: { review: true }
    })!;
    await Promise.resolve();
    const review = target.graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) => projectionKey === `completion-review:${action.id}:surface:1`)!;
    const reviewClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, review.id), at: "2098-10-06T00:00:02.000Z", expiresAt: "2098-10-06T00:01:02.000Z"
    });
    expect(reviewClaim).not.toBeNull();
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(reviewClaim!, {
      messageId: "worker-review-message", surfaceId: "worker-review-card"
    })).toBe(true);
    expect(target.graph.database.prepare("SELECT state,presentation_message_id FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({
      state: "active", presentation_message_id: "worker-review-message"
    });
  });

  it("reserves a Worker Task recovery page without replaying an uncertain stream effect", async () => {
    const target = fixture();
    const view = acceptWorkerTask(target, "worker-recovery-turn");
    await Promise.resolve();
    activateDeliveryFence(target);
    const create = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === view.turnId)!;
    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, create.id),
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    })!;
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "worker-recovery-message-0",
      surfaceId: "worker-recovery-card-0"
    })).toBe(true);
    expect(target.graph.workerTurns.reserveWorkerTurnContent({
      turnId: view.turnId,
      pageIndex: 0,
      cardId: "worker-recovery-card-0",
      elementId: view.elementId,
      content: "partial",
      sourceEnd: 7
    })).toBe("reserved");
    await Promise.resolve();
    const content = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind }) =>
      workerTurnId === view.turnId && kind === "stream_content")!;
    const delivery = deliveryFor(target, content.id);
    const claim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery,
      at: "2098-10-06T00:00:01.000Z",
      expiresAt: "2098-10-06T00:01:01.000Z"
    });
    expect(claim).not.toBeNull();
    if (!claim) throw new Error("expected Worker content claim");
    expect(target.graph.preparedDeliveries.failPreparedDelivery(claim, {
      error: "delivery ownership lost",
      retryAt: "2000-01-01T00:00:00.000Z",
      metadata: { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null }
    })).toBe("retry");
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      const retryClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
        delivery: deliveryFor(target, content.id),
        at: `2098-10-06T00:00:0${attempt}.000Z`,
        expiresAt: `2098-10-06T00:01:0${attempt}.000Z`
      });
      expect(retryClaim).not.toBeNull();
      if (!retryClaim) throw new Error("expected Worker content retry claim");
      expect(target.graph.preparedDeliveries.failPreparedDelivery(retryClaim, {
        error: "delivery ownership lost",
        retryAt: "2000-01-01T00:00:00.000Z",
        metadata: { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null }
      })).toBe(attempt === 3 ? "dead_letter" : "retry");
    }
    expect(target.graph.workerTurns.listWorkerTurnCardPages(view.turnId)).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen" })
    ]);

    expect(target.graph.workerTurns.reserveWorkerTurnRecovery({
      turnId: view.turnId,
      previousPageIndex: 0,
      nextPageIndex: 1,
      pageStart: 0,
      nextElementId: workerTurnElementId(view.turnId, 1),
      rootMessageId: view.rootMessageId,
      viewVersion: view.viewVersion,
      card: { schema: "2.0", body: { elements: [{ tag: "markdown", element_id: workerTurnProgressElementId(view.turnId, 1), content: "recovering" }] } }
    })).toBe("reserved");
    await Promise.resolve();
    const replacement = target.graph.outbox.listPendingOutboundReplies().find(({ idempotencyKey }) =>
      idempotencyKey === `worker-turn:recovery:${view.turnId}:1`)!;
    expect(replacement).toMatchObject({
      kind: "stream_card_create",
      workClass: "history",
      streamPageIndex: 1,
      projectionKey: `worker-task:${view.turnId}:page:1`
    });
    expectWorkerPaneRing(target, replacement);
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: replacement.id }));
    const replacementClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, replacement.id),
      at: "2098-10-06T00:00:10.000Z",
      expiresAt: "2098-10-06T00:01:10.000Z"
    });
    expect(replacementClaim).not.toBeNull();
    if (!replacementClaim) throw new Error("expected Worker recovery claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(replacementClaim, {
      messageId: "worker-recovery-message-1",
      surfaceId: "worker-recovery-card-1"
    })).toBe(true);
    expect(target.graph.database.prepare("SELECT state,resolved_by_reply_id FROM delivery_recoveries WHERE failed_reply_id=?").get(content.id)).toEqual({
      state: "recovered",
      resolved_by_reply_id: replacement.id
    });
  });

  it("replaces a rejected open Worker Human Review target through the same Worker Pane Ring", async () => {
    const target = fixture();
    const view = acceptWorkerTask(target, "worker-review-recovery-turn");
    await Promise.resolve();
    activateDeliveryFence(target);
    const taskCreate = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === view.turnId)!;
    const taskClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, taskCreate.id),
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    })!;
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(taskClaim, {
      messageId: "worker-review-task-message",
      surfaceId: "worker-review-task-card"
    })).toBe(true);
    target.graph.database.prepare("UPDATE instance_turns SET runtime_turn_id=?,runtime_turn_started_at=? WHERE id=?").run(
      "runtime-review-turn",
      "2026-10-06T00:00:00.000Z",
      view.turnId
    );
    target.graph.workerTurns.transitionInstanceTurnWithProjection({
      turnId: view.turnId,
      expectedGeneration: target.worker.generation,
      state: "running",
      eventKind: "turn.started",
      change: { type: "running", occurredAt: "2026-10-06T00:00:01.000Z" },
      render: renderWorkerTurnCard,
      renderHumanReviewNotification: renderWorkerHumanReviewNotification
    });
    target.graph.workerTurns.transitionInstanceTurnWithProjection({
      turnId: view.turnId,
      expectedGeneration: target.worker.generation,
      state: "blocked",
      eventKind: "turn.blocked",
      change: { type: "blocked", occurredAt: "2026-10-06T00:00:02.000Z", notice: "Needs local review" },
      render: renderWorkerTurnCard,
      renderHumanReviewNotification: renderWorkerHumanReviewNotification
    });
    await Promise.resolve();
    const reviewCreate = target.graph.outbox.listPendingOutboundReplies().find(({ projectionKey, kind }) =>
      projectionKey?.startsWith("human-review:worker:") && kind === "card_reply")!;
    const reviewCreateClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, reviewCreate.id),
      at: "2098-10-06T00:00:01.000Z",
      expiresAt: "2098-10-06T00:01:01.000Z"
    })!;
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(reviewCreateClaim, {
      messageId: "worker-review-message",
      surfaceId: "worker-review-card"
    })).toBe(true);

    target.graph.database.prepare(`INSERT INTO core_event_inbox(event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at)
      VALUES ('worker-review-candidate','source','traex','worker-session','runtime-review-turn','c1','2026-10-06T00:00:03.000Z','{}','2026-10-06T00:00:03.000Z')`).run();
    target.graph.database.prepare(`INSERT INTO human_review_candidates(
      source_event_id,owner_kind,owner_id,owner_generation,native_session_id,turn_id,notice,state,created_at,expires_at
    ) VALUES ('worker-review-candidate','worker_turn',?,?,'worker-session','runtime-review-turn','Choose the test scope','pending','2026-10-06T00:00:03.000Z','2026-10-07T00:00:03.000Z')`).run(
      view.turnId,
      target.worker.generation
    );
    target.graph.workerTurns.transitionInstanceTurnWithProjection({
      turnId: view.turnId,
      expectedGeneration: target.worker.generation,
      state: "blocked",
      eventKind: "turn.blocked",
      change: { type: "blocked", occurredAt: "2026-10-06T00:00:04.000Z", notice: "Needs local review" },
      render: renderWorkerTurnCard,
      renderHumanReviewNotification: renderWorkerHumanReviewNotification
    });
    await Promise.resolve();
    const update = target.graph.outbox.listPendingOutboundReplies().find(({ projectionKey, kind }) =>
      projectionKey === reviewCreate.projectionKey && kind === "card_update")!;
    const updateClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, update.id),
      at: "2098-10-06T00:00:02.000Z",
      expiresAt: "2098-10-06T00:01:02.000Z"
    });
    expect(updateClaim).not.toBeNull();
    if (!updateClaim) throw new Error("expected Worker Human Review update claim");
    expect(target.graph.preparedDeliveries.failPreparedDelivery(updateClaim, {
      error: "target withdrawn",
      retryAt: "2000-01-01T00:00:00.000Z",
      metadata: { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230011", recoveryKind: "defunct_target" }
    })).toBe("dead_letter");
    await Promise.resolve();

    const replacement = target.graph.outbox.listPendingOutboundReplies().find(({ projectionKey, kind }) =>
      projectionKey?.startsWith("human-review:worker:") && projectionKey !== reviewCreate.projectionKey && kind === "card_reply")!;
    expect(replacement).toMatchObject({
      workerId: target.worker.id,
      workerSessionGeneration: target.worker.workerSessionGeneration,
      deliveryScope: { kind: "pane", workspaceId: "primary-workspace", paneId: "worker-pane" },
      deliveryParentPaneId: "primary-pane"
    });
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: replacement.id }));
    const replacementClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, replacement.id),
      at: "2098-10-06T00:00:03.000Z",
      expiresAt: "2098-10-06T00:01:03.000Z"
    });
    expect(replacementClaim).not.toBeNull();
    if (!replacementClaim) throw new Error("expected Worker Human Review replacement claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(replacementClaim, {
      messageId: "worker-review-replacement-message",
      surfaceId: "worker-review-replacement-card"
    })).toBe(true);
    expect(target.graph.database.prepare("SELECT state,resolved_by_reply_id FROM delivery_recoveries WHERE failed_reply_id=?").get(update.id)).toEqual({
      state: "recovered",
      resolved_by_reply_id: replacement.id
    });
  });

  it("routes an expired Worker Task runtime replacement through PreparedDelivery in the Worker Pane Ring", async () => {
    const target = fixture();
    activateDeliveryFence(target);
    await activateCanonicalWorkerThread(target);
    const view = acceptWorkerTask(target, "worker-expired-runtime-turn");
    await Promise.resolve();

    const create = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind }) =>
      workerTurnId === view.turnId && kind === "stream_card_create")!;
    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, create.id),
      at: "2098-10-06T00:00:01.000Z",
      expiresAt: "2098-10-06T00:01:01.000Z"
    });
    expect(createClaim).not.toBeNull();
    if (!createClaim) throw new Error("expected Worker Task create claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "worker-expired-runtime-message",
      surfaceId: "worker-expired-runtime-card"
    })).toBe(true);

    const items = [{ kind: "agent_message" as const, id: "message:runtime", sequence: 1, markdown: "Visible result" }];
    expect(target.graph.workerTurns.reserveWorkerAnswerTimelineCard({
      turnId: view.turnId,
      pageIndex: 0,
      messageId: "worker-expired-runtime-message",
      card: { schema: "2.0", revision: "runtime-expired" },
      cursor: null,
      items
    })).toBe("reserved");
    await Promise.resolve();
    const update = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind }) =>
      workerTurnId === view.turnId && kind === "card_update")!;
    expect(update).toMatchObject({
      projectionKey: `worker-task:${view.turnId}:page:0`
    });
    const updateClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, update.id),
      at: "2098-10-06T00:00:02.000Z",
      expiresAt: "2098-10-06T00:01:02.000Z"
    });
    expect(updateClaim).not.toBeNull();
    if (!updateClaim) throw new Error("expected Worker Task update claim");
    expect(target.graph.preparedDeliveries.failPreparedDelivery(updateClaim, {
      error: "expired",
      retryAt: "2098-10-06T00:02:00.000Z",
      metadata: {
        failureClass: "permanent",
        effectCertainty: "rejected",
        httpStatus: 400,
        larkErrorCode: "230031",
        recoveryKind: "expired_worker_view_target",
        providerOperation: "update_card"
      }
    })).toBe("dead_letter");
    await Promise.resolve();

    const replacement = target.graph.outbox.listPendingOutboundReplies().find(({ idempotencyKey }) =>
      idempotencyKey === `worker-turn:recovery-create:${update.id}`)!;
    expect(replacement).toMatchObject({
      kind: "group_card_create",
      workerTurnId: view.turnId,
      streamPageIndex: 0,
      workerId: target.worker.id,
      workerSessionGeneration: target.worker.workerSessionGeneration,
      projectionKey: `worker-turn-recovery:${update.id}`,
      deliveryScope: { kind: "pane", workspaceId: "primary-workspace", paneId: "worker-pane" },
      deliveryParentPaneId: "primary-pane",
      deliveryOwnerFence: {
        kind: "worker",
        id: target.worker.id,
        generation: target.worker.generation,
        sessionGeneration: target.worker.workerSessionGeneration,
        parent: { id: "binding", generation: 1, sessionGeneration: 1 }
      }
    });
    const replacementClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, replacement.id),
      at: "2098-10-06T00:00:03.000Z",
      expiresAt: "2098-10-06T00:01:03.000Z"
    });
    expect(replacementClaim).not.toBeNull();
    if (!replacementClaim) throw new Error("expected Worker Task recovery claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(replacementClaim, {
      messageId: "worker-expired-runtime-recovery",
      surfaceId: "worker-expired-runtime-recovery-card",
      threadId: "worker-expired-runtime-topic"
    })).toBe(true);
    expect(target.graph.database.prepare("SELECT state,resolved_by_reply_id FROM delivery_recoveries WHERE failed_reply_id=?").get(update.id)).toEqual({
      state: "recovered",
      resolved_by_reply_id: replacement.id
    });
  });

  it("routes cold expired Worker Task recovery through PreparedDelivery in the Worker Pane Ring", async () => {
    const target = fixture();
    activateDeliveryFence(target);
    await activateCanonicalWorkerThread(target);
    const view = acceptWorkerTask(target, "worker-expired-cold-turn");
    await Promise.resolve();

    const create = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind }) =>
      workerTurnId === view.turnId && kind === "stream_card_create")!;
    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, create.id),
      at: "2098-10-06T00:00:01.000Z",
      expiresAt: "2098-10-06T00:01:01.000Z"
    });
    expect(createClaim).not.toBeNull();
    if (!createClaim) throw new Error("expected cold Worker Task create claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "worker-expired-cold-message",
      surfaceId: "worker-expired-cold-card"
    })).toBe(true);

    const items = [{ kind: "agent_message" as const, id: "message:cold", sequence: 1, markdown: "Persisted result" }];
    expect(target.graph.workerTurns.reserveWorkerAnswerTimelineCard({
      turnId: view.turnId,
      pageIndex: 0,
      messageId: "worker-expired-cold-message",
      card: { schema: "2.0", revision: "cold-expired" },
      cursor: null,
      items
    })).toBe("reserved");
    await Promise.resolve();
    const update = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId, kind }) =>
      workerTurnId === view.turnId && kind === "card_update")!;
    const updateClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, update.id),
      at: "2098-10-06T00:00:02.000Z",
      expiresAt: "2098-10-06T00:01:02.000Z"
    });
    expect(updateClaim).not.toBeNull();
    if (!updateClaim) throw new Error("expected cold Worker Task update claim");
    expect(target.graph.preparedDeliveries.failPreparedDelivery(updateClaim, {
      error: "persisted expired target",
      retryAt: "2098-10-06T00:02:00.000Z",
      metadata: {
        failureClass: "permanent",
        effectCertainty: "rejected",
        httpStatus: 400,
        larkErrorCode: "230031",
        providerOperation: "update_card"
      }
    })).toBe("dead_letter");
    target.graph.database.prepare("UPDATE delivery_recoveries SET semantic_recovery_proof=? WHERE failed_reply_id=?").run(
      WORKER_EXPIRED_TARGET_PROOFS.workerTurnUpdateCard,
      update.id
    );

    expect(target.graph.outbox.recoverStaleOutboxQuarantines()).toMatchObject({ dismissedExpiredWorkerTargets: 1 });
    await Promise.resolve();
    const recovery = target.graph.database.prepare("SELECT replacement_reply_id FROM delivery_recoveries WHERE failed_reply_id=?").get(update.id) as {
      replacement_reply_id: string;
    };
    const replacement = target.graph.outbox.getOutboundReply(recovery.replacement_reply_id)!;
    expect(replacement).toMatchObject({
      kind: "group_card_create",
      workerTurnId: view.turnId,
      streamPageIndex: 0,
      workerId: target.worker.id,
      workerSessionGeneration: target.worker.workerSessionGeneration,
      projectionKey: `worker-turn-recovery:${update.id}`,
      deliveryScope: { kind: "pane", workspaceId: "primary-workspace", paneId: "worker-pane" },
      deliveryParentPaneId: "primary-pane",
      deliveryOwnerFence: {
        kind: "worker",
        id: target.worker.id,
        generation: target.worker.generation,
        sessionGeneration: target.worker.workerSessionGeneration,
        parent: { id: "binding", generation: 1, sessionGeneration: 1 }
      }
    });
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: replacement.id }));
    const replacementClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: deliveryFor(target, replacement.id),
      at: "2098-10-06T00:00:03.000Z",
      expiresAt: "2098-10-06T00:01:03.000Z"
    });
    expect(replacementClaim).not.toBeNull();
    if (!replacementClaim) throw new Error("expected cold Worker Task recovery claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(replacementClaim, {
      messageId: "worker-expired-cold-recovery",
      surfaceId: "worker-expired-cold-recovery-card",
      threadId: "worker-expired-cold-topic"
    })).toBe(true);
    expect(target.graph.database.prepare("SELECT state,resolved_by_reply_id FROM delivery_recoveries WHERE failed_reply_id=?").get(update.id)).toEqual({
      state: "recovered",
      resolved_by_reply_id: replacement.id
    });
  });

  it.each(["runtime", "session", "parent", "desired"] as const)("fails closed when the Worker Task %s fence becomes stale", async (stale) => {
    const target = fixture();
    const view = acceptWorkerTask(target, `worker-stale-${stale}`);
    await Promise.resolve();
    activateDeliveryFence(target);
    const reply = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === view.turnId)!;
    const delivery = deliveryFor(target, reply.id);

    if (stale === "runtime") {
      target.graph.instances.detachAgentInstanceRuntime({
        instanceId: target.worker.id,
        expectedGeneration: target.worker.generation,
        reason: "replacement"
      });
    } else if (stale === "session") {
      target.graph.database.prepare("UPDATE agent_instances SET worker_session_generation=worker_session_generation+1 WHERE id=?").run(target.worker.id);
    } else if (stale === "parent") {
      target.graph.bindings.updateBinding("binding", { generation: 2 });
    } else {
      target.graph.database.prepare("UPDATE agent_instances SET desired_state='stopped' WHERE id=? AND generation=?").run(target.worker.id, target.worker.generation);
    }

    expect(target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery,
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    })).toBeNull();
    expect(target.graph.outbox.getOutboundReply(reply.id)).toMatchObject({
      state: "dismissed",
      error: "Dismissed stale Worker Ring delivery before Gateway execution"
    });
  });

  it("rolls back a Worker Task reservation without exposing a post-commit handoff", async () => {
    const target = fixture();
    target.graph.database.exec(`CREATE TRIGGER reject_worker_task_reservation
      BEFORE INSERT ON outbound_replies WHEN NEW.worker_turn_id='worker-rollback-turn'
      BEGIN SELECT RAISE(ABORT, 'reject worker task reservation'); END`);

    expect(() => acceptWorkerTask(target, "worker-rollback-turn")).toThrow(/reject worker task reservation/);
    await Promise.resolve();
    expect(target.graph.workerTurns.getInstanceTurn("worker-rollback-turn")).toBeNull();
    expect(target.graph.workerTurns.loadWorkerTurnCard("worker-rollback-turn")).toBeNull();
    expect(target.graph.outbox.listPendingOutboundReplies()).toHaveLength(0);
    expect(target.handedOff).not.toHaveBeenCalled();
  });

  it("rediscovers and settles a persisted Worker Task Ring head after database reopen", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-worker-task-ring-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    const target = fixture(databasePath);
    const view = acceptWorkerTask(target, "worker-cold-turn");
    await Promise.resolve();
    const reply = target.graph.outbox.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === view.turnId)!;
    target.graph.context.close();
    graph = undefined;

    const reopened = new SqliteCapabilityGraph(databasePath);
    graph = reopened;
    expect(reopened.preparedDeliveries.listScopeHeads({
      afterScopeKey: null,
      limit: 10,
      at: "2098-10-06T00:00:00.000Z"
    }).items).toEqual([expect.objectContaining({ replyId: reply.id })]);
    const hydration = reopened.preparedDeliveries.hydratePreparedDelivery(reply.id);
    expect(hydration.status).toBe("prepared");
    if (hydration.status !== "prepared") throw new Error("expected persisted Worker Task PreparedDelivery");
    const lease = reopened.leases.acquireInstanceLease(
      "cold-owner",
      "2026-10-06T00:00:00.000Z",
      "2099-01-01T00:00:00.000Z"
    )!;
    reopened.leases.activateWriteFence(lease.ownerId, lease.fencingToken);
    const claim = reopened.preparedDeliveries.claimPreparedDelivery({
      delivery: hydration.delivery,
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    });
    expect(claim).not.toBeNull();
    if (!claim) throw new Error("expected cold Worker Task claim");
    expect(reopened.preparedDeliveries.acknowledgePreparedDelivery(claim, {
      messageId: "worker-cold-message",
      surfaceId: "worker-cold-card"
    })).toBe(true);
    expect(reopened.workerTurns.listWorkerTurnCardPages(view.turnId)).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "active", messageId: "worker-cold-message", cardId: "worker-cold-card" })
    ]);
  });
});
