import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerMainView, reduceWorkerMainView } from "../src/domain/worker-main-view.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { renderWorkerHumanReviewNotification } from "../src/cards/worker-human-review-notification.js";
import { connectPreparedDeliveryProducers } from "../src/composition/create-outbound-runtime.js";
import type { GatewayDeliveryIntent } from "../src/gateways/contract/plugin.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";
import { WORKER_EXPIRED_TARGET_PROOFS } from "../src/store/sqlite/outbox-recovery/semantic-recovery-proof.js";

let graph: SqliteCapabilityGraph | undefined;

afterEach(() => {
  graph?.context.close();
  graph = undefined;
});

function fixture() {
  graph = new SqliteCapabilityGraph(":memory:");
  graph.bindings.createPendingBinding({
    id: "binding",
    projectId: "project",
    workspaceId: "primary-workspace",
    chatId: "chat",
    topicId: "primary-topic",
    rootMessageId: "primary-root",
    title: "Primary"
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
  const view = createWorkerMainView({
    workerId: worker.id,
    workerSessionGeneration: worker.workerSessionGeneration,
    parentBindingId: "binding",
    parentBindingGeneration: 1,
    parentPaneId: "primary-pane",
    workerName: worker.name,
    ownerName: "Primary",
    runtimeGeneration: worker.generation,
    runtimeState: worker.observedState,
    runtimeAttached: true,
    desiredState: worker.desiredState,
    parentActive: true,
    paneId: "worker-pane",
    workspace: "/repo",
    branch: null,
    model: null,
    occurredAt: "2026-10-06T00:00:00.000Z"
  });
  graph.cardContexts.saveWorkerMainView(view);
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
  return { graph, worker, view, handedOff };
}

function reserveCanonicalThread(target: ReturnType<typeof fixture>) {
  expect(target.graph.workerThreads.reserve({
    publicationKey: "worker-thread:worker:1",
    workerId: target.worker.id,
    workerSessionGeneration: target.worker.workerSessionGeneration,
    parentBindingId: "binding",
    parentBindingGeneration: 1,
    parentPaneId: "primary-pane",
    targetChatId: "chat",
    mode: "canonical-main",
    viewVersion: target.view.viewVersion,
    card: { schema: "2.0" }
  })).toBe("reserved");
}

function activateDeliveryFence(target: SqliteCapabilityGraph): void {
  const lease = target.leases.acquireInstanceLease("owner", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z")!;
  target.leases.activateWriteFence(lease.ownerId, lease.fencingToken);
}

describe("T8 Worker Main and canonical Worker thread Ring migration", () => {
  it("routes canonical Worker Main creation to its exact Worker Pane Ring with the complete parent fence", async () => {
    const target = fixture();

    reserveCanonicalThread(target);
    await Promise.resolve();

    const reply = target.graph.outbox.listPendingOutboundReplies()[0]!;
    expect(reply).toMatchObject({
      kind: "group_card_create",
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
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply.id }));
  });

  it("activates the canonical Worker thread only after the Ring ACK and preserves its delivery checkpoint", async () => {
    const target = fixture();
    reserveCanonicalThread(target);
    await Promise.resolve();
    const delivery = target.handedOff.mock.calls[0]![0];
    const lease = target.graph.leases.acquireInstanceLease("owner", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z")!;
    target.graph.leases.activateWriteFence(lease.ownerId, lease.fencingToken);
    const claim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery,
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    })!;

    expect(target.graph.workerThreads.resolveScope({ chatId: "chat", topicId: null, rootMessageId: null })).toEqual({ kind: "none" });
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(claim, {
      messageId: "worker-main-message",
      surfaceId: "worker-main-card",
      threadId: "worker-topic"
    })).toBe(true);

    expect(target.graph.workerThreads.resolveScope({ chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-main-message" })).toMatchObject({
      kind: "active",
      target: { workerId: "worker", rootMessageId: "worker-main-message", parentPaneId: "primary-pane" }
    });
    expect(target.graph.cardContexts.loadWorkerMainView("worker", 1)).toMatchObject({
      messageId: "worker-main-message",
      cardId: "worker-main-card",
      deliveredVersion: target.view.viewVersion
    });
  });

  it("claims and acknowledges a migrated legacy Worker row without rescoping it", async () => {
    const target = fixture();
    reserveCanonicalThread(target);
    await Promise.resolve();
    const reply = target.graph.outbox.listPendingOutboundReplies()[0]!;
    const immutable = target.graph.database.prepare(`SELECT sql FROM sqlite_master
      WHERE type='trigger' AND name='outbound_replies_immutable_claim'`).get() as { sql: string };
    target.graph.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    target.graph.database.prepare(`UPDATE outbound_replies
      SET scope_key=json_array('pane','primary-workspace','primary-pane'),scope_pane_id='primary-pane'
      WHERE id=?`).run(reply.id);
    target.graph.database.exec(immutable.sql);
    const hydrated = target.graph.preparedDeliveries.hydratePreparedDelivery(reply.id);
    if (hydrated.status !== "prepared") throw new Error(`expected legacy prepared delivery, received ${hydrated.status}`);
    expect(hydrated.delivery).toMatchObject({
      scope: { kind: "pane", workspaceId: "primary-workspace", paneId: "primary-pane" },
      parentPaneId: "primary-pane"
    });
    activateDeliveryFence(target.graph);

    const claim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: hydrated.delivery,
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    });

    expect(claim).not.toBeNull();
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(claim!, {
      messageId: "legacy-worker-main-message", surfaceId: "legacy-worker-main-card", threadId: "legacy-worker-topic"
    })).toBe(true);
    expect(target.graph.outbox.getOutboundReply(reply.id)).toMatchObject({
      state: "delivered", deliveryScope: { kind: "pane", paneId: "primary-pane" }, deliveryParentPaneId: "primary-pane"
    });
  });

  it("keeps the immutable canonical Worker thread create claimable across a newer Worker Main view and converges the latest view after ACK", async () => {
    const target = fixture();
    reserveCanonicalThread(target);
    await Promise.resolve();
    const createDelivery = target.handedOff.mock.calls[0]![0];
    const latest = reduceWorkerMainView(target.view, {
      type: "tasks", currentTask: null, queueCount: 1, nextTaskTitle: "next", recentTasks: [],
      occurredAt: "2026-10-06T00:00:01.000Z"
    });
    expect(target.graph.cardContexts.saveWorkerMainView(latest)).toMatchObject({ viewVersion: 2 });
    const lease = target.graph.leases.acquireInstanceLease("owner", "2026-10-06T00:00:02.000Z", "2099-01-01T00:00:00.000Z")!;
    target.graph.leases.activateWriteFence(lease.ownerId, lease.fencingToken);

    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: createDelivery, at: "2098-10-06T00:00:00.000Z", expiresAt: "2098-10-06T00:01:00.000Z"
    });
    expect(createClaim).not.toBeNull();
    if (!createClaim) throw new Error("expected canonical Worker thread create claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "worker-main-message", surfaceId: "worker-main-card", threadId: "worker-topic"
    })).toBe(true);
    expect(target.graph.cardContexts.loadWorkerMainView("worker", 1)).toMatchObject({
      viewVersion: 2, deliveredVersion: 1, messageId: "worker-main-message", cardId: "worker-main-card"
    });

    const invalidation = target.graph.cardContexts.listPendingCardContextInvalidations().find(({ targetKind, targetId }) => targetKind === "worker-session" && targetId === "worker")!;
    expect(target.graph.cardContexts.projectCardContext(invalidation, {
      workerMain: (view) => ({ viewVersion: view.viewVersion }), workerThreadEntryReady: (entry) => ({ entry }),
      workerTask: () => ({}), primaryMain: () => ({}), primaryPaneEntry: () => ({}), primaryAnswer: () => ({})
    })).toBe("reserved");
    await Promise.resolve();
    const update = target.graph.outbox.listPendingOutboundReplies().find(({ kind, projectionKey }) => kind === "card_update" && projectionKey === "worker-main:worker:1")!;
    const updateDelivery = target.handedOff.mock.calls.map(([delivery]) => delivery).find(({ replyId }) => replyId === update.id)!;
    const updateClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: updateDelivery, at: "2098-10-06T00:00:03.000Z", expiresAt: "2098-10-06T00:01:03.000Z"
    });
    expect(updateClaim).not.toBeNull();
    if (!updateClaim) throw new Error("expected latest Worker Main update claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(updateClaim, { messageId: "worker-main-message" })).toBe(true);
    const converged = target.graph.cardContexts.loadWorkerMainView("worker", 1)!;
    expect(converged.viewVersion).toBeGreaterThanOrEqual(2);
    expect(converged.deliveredVersion).toBe(converged.viewVersion);
  });

  it("routes an expired Worker Main target runtime replacement through the Worker Pane Ring", async () => {
    const target = fixture();
    reserveCanonicalThread(target);
    await Promise.resolve();
    const lease = target.graph.leases.acquireInstanceLease("owner", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z")!;
    target.graph.leases.activateWriteFence(lease.ownerId, lease.fencingToken);
    const createDelivery = target.handedOff.mock.calls[0]![0];
    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: createDelivery, at: "2098-10-06T00:00:00.000Z", expiresAt: "2098-10-06T00:01:00.000Z"
    })!;
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "expired-worker-main", surfaceId: "expired-card", threadId: "worker-topic"
    })).toBe(true);

    const current = target.graph.cardContexts.loadWorkerMainView("worker", 1)!;
    const latest = reduceWorkerMainView(current, {
      type: "tasks", currentTask: null, queueCount: 1, nextTaskTitle: "recover", recentTasks: [],
      occurredAt: "2026-10-06T00:00:01.000Z"
    });
    target.graph.cardContexts.reserveWorkerMainCard(latest, "primary-root", { schema: "2.0" });
    await Promise.resolve();
    const update = target.graph.outbox.listPendingOutboundReplies().find(({ kind, projectionKey }) => kind === "card_update" && projectionKey === "worker-main:worker:1")!;
    const updateDelivery = target.handedOff.mock.calls.map(([delivery]) => delivery).find(({ replyId }) => replyId === update.id)!;
    const updateClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: updateDelivery, at: "2098-10-06T00:00:02.000Z", expiresAt: "2098-10-06T00:01:02.000Z"
    })!;
    expect(target.graph.preparedDeliveries.failPreparedDelivery(updateClaim, {
      error: "expired", retryAt: "2098-10-06T00:02:00.000Z",
      metadata: { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230031", recoveryKind: "expired_worker_view_target", providerOperation: "update_card" }
    })).toBe("dead_letter");
    await Promise.resolve();

    const replacement = target.graph.outbox.listPendingOutboundReplies().find(({ idempotencyKey }) => idempotencyKey.startsWith(`worker-main:recovery-create:${update.id}`))!;
    expect(replacement).toMatchObject({
      kind: "group_card_create", workerThreadId: expect.any(String),
      projectionKey: `worker-main-recovery:${update.id}`,
      deliveryScope: { kind: "pane", workspaceId: "primary-workspace", paneId: "worker-pane" },
      deliveryParentPaneId: "primary-pane",
      deliveryOwnerFence: { kind: "worker", id: "worker", parent: { id: "binding", generation: 1, sessionGeneration: 1 } }
    });
    const replacementDelivery = target.handedOff.mock.calls.map(([delivery]) => delivery).find(({ replyId }) => replyId === replacement.id)!;
    const replacementClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: replacementDelivery, at: "2098-10-06T00:00:03.000Z", expiresAt: "2098-10-06T00:01:03.000Z"
    });
    expect(replacementClaim).not.toBeNull();
    if (!replacementClaim) throw new Error("expected Worker Main recovery claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(replacementClaim, {
      messageId: "recovered-worker-main", surfaceId: "recovered-card", threadId: "recovered-topic"
    })).toBe(true);
    expect(target.graph.database.prepare("SELECT state,resolved_by_reply_id FROM delivery_recoveries WHERE failed_reply_id=?").get(update.id)).toEqual({
      state: "recovered", resolved_by_reply_id: replacement.id
    });
  });

  it("routes cold-start Worker Main expired-target recovery through PreparedDelivery", async () => {
    const target = fixture();
    reserveCanonicalThread(target);
    await Promise.resolve();
    const lease = target.graph.leases.acquireInstanceLease("owner", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z")!;
    target.graph.leases.activateWriteFence(lease.ownerId, lease.fencingToken);
    const createDelivery = target.handedOff.mock.calls[0]![0];
    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: createDelivery, at: "2098-10-06T00:00:00.000Z", expiresAt: "2098-10-06T00:01:00.000Z"
    })!;
    target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "expired-worker-main", surfaceId: "expired-card", threadId: "worker-topic"
    });
    const current = target.graph.cardContexts.loadWorkerMainView("worker", 1)!;
    const latest = reduceWorkerMainView(current, {
      type: "tasks", currentTask: null, queueCount: 1, nextTaskTitle: "recover", recentTasks: [],
      occurredAt: "2026-10-06T00:00:01.000Z"
    });
    target.graph.cardContexts.reserveWorkerMainCard(latest, "primary-root", { schema: "2.0" });
    await Promise.resolve();
    const update = target.graph.outbox.listPendingOutboundReplies().find(({ kind, projectionKey }) => kind === "card_update" && projectionKey === "worker-main:worker:1")!;
    const updateDelivery = target.handedOff.mock.calls.map(([delivery]) => delivery).find(({ replyId }) => replyId === update.id)!;
    const updateClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: updateDelivery, at: "2098-10-06T00:00:02.000Z", expiresAt: "2098-10-06T00:01:02.000Z"
    })!;
    expect(target.graph.preparedDeliveries.failPreparedDelivery(updateClaim, {
      error: "persisted expired target", retryAt: "2098-10-06T00:02:00.000Z",
      metadata: { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230031" }
    })).toBe("dead_letter");
    target.graph.database.prepare("UPDATE delivery_recoveries SET semantic_recovery_proof=? WHERE failed_reply_id=?").run(
      WORKER_EXPIRED_TARGET_PROOFS.workerMainUpdateCard, update.id
    );

    expect(target.graph.outbox.recoverStaleOutboxQuarantines()).toMatchObject({ dismissedExpiredWorkerTargets: 1 });
    await Promise.resolve();
    const recovery = target.graph.database.prepare("SELECT replacement_reply_id FROM delivery_recoveries WHERE failed_reply_id=?").get(update.id) as { replacement_reply_id: string };
    const replacement = target.graph.outbox.getOutboundReply(recovery.replacement_reply_id)!;
    expect(replacement).toMatchObject({
      kind: "group_card_create", projectionKey: `worker-main-recovery:${update.id}`,
      deliveryScope: { kind: "pane", workspaceId: "primary-workspace", paneId: "worker-pane" },
      deliveryParentPaneId: "primary-pane",
      deliveryOwnerFence: { kind: "worker", id: "worker", parent: { id: "binding", generation: 1, sessionGeneration: 1 } }
    });
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: replacement.id }));
  });

  it.each(["runtime", "session", "parent"] as const)("rejects a stale Worker %s fence and durably advances past its head", async (stale) => {
    const target = fixture();
    reserveCanonicalThread(target);
    await Promise.resolve();
    const delivery = target.handedOff.mock.calls[0]![0];
    const lease = target.graph.leases.acquireInstanceLease("owner", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z")!;
    target.graph.leases.activateWriteFence(lease.ownerId, lease.fencingToken);

    if (stale === "runtime") {
      target.graph.instances.detachAgentInstanceRuntime({ instanceId: "worker", expectedGeneration: target.worker.generation, reason: "replacement" });
    } else if (stale === "session") {
      target.graph.database.prepare("UPDATE agent_instances SET worker_session_generation=worker_session_generation+1 WHERE id='worker'").run();
    } else {
      target.graph.bindings.updateBinding("binding", { generation: 2 });
    }

    expect(target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery,
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    })).toBeNull();
    expect(target.graph.outbox.getOutboundReply(delivery.replyId)).toMatchObject({
      state: "dismissed",
      error: "Dismissed stale Worker Ring delivery before Gateway execution"
    });
    expect(target.graph.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2098-10-06T00:00:00.000Z" }).items)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ replyId: delivery.replyId })]));
  });

  it("prepares a Worker thread-entry card as an operation result without applying Worker Main target validation", async () => {
    const target = fixture();
    reserveCanonicalThread(target);
    await Promise.resolve();
    activateDeliveryFence(target.graph);
    const createDelivery = target.handedOff.mock.calls[0]![0];
    const createClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: createDelivery, at: "2098-10-06T00:00:00.000Z", expiresAt: "2098-10-06T00:01:00.000Z"
    })!;
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(createClaim, {
      messageId: "worker-main-message", surfaceId: "worker-main-card", threadId: "worker-topic"
    })).toBe(true);

    const command = target.graph.commandIntents.accept({
      id: "worker-create", idempotencyKey: "worker-create", laneKey: "binding:binding",
      command: { kind: "worker_create", name: "Worker", agentKind: "traex", model: null, start: true },
      context: {
        projectId: "project", chatId: "chat", topicId: "primary-topic", rootMessageId: "primary-root",
        actorOpenId: "operator", sourceMessageId: "source",
        primary: { bindingId: "binding", bindingGeneration: 1, paneId: "primary-pane", terminalId: null, nativeSession: null, activePromptId: null }
      },
      replayPolicy: "reconcilable", acceptedAt: "2026-10-06T00:00:01.000Z"
    }).intent;
    expect(target.graph.commandIntents.claimNext()).toMatchObject({ id: command.id });
    expect(target.graph.commandIntents.registerWorkerThreadEntry({
      commandIntentId: command.id,
      workerId: target.worker.id,
      workerSessionGeneration: target.worker.workerSessionGeneration,
      bindingId: "binding",
      bindingGeneration: 1,
      rootMessageId: "primary-root"
    })).toBe(true);
    const invalidation = target.graph.cardContexts.listPendingCardContextInvalidations().find(({ targetKind, targetId }) =>
      targetKind === "worker-session" && targetId === target.worker.id)!;
    expect(target.graph.cardContexts.projectCardContext(invalidation, {
      workerMain: () => ({ schema: "2.0" }),
      workerThreadEntryReady: (entry) => ({ schema: "2.0", entry }),
      workerTask: () => ({ schema: "2.0" }),
      primaryMain: () => ({ schema: "2.0" }),
      primaryPaneEntry: () => ({ schema: "2.0" }),
      primaryAnswer: () => ({ schema: "2.0" })
    })).toBe("reserved");
    await Promise.resolve();

    const entry = target.graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) => projectionKey === "worker-thread-entry:worker-create")!;
    expect(entry).toMatchObject({ kind: "card_reply", rootMessageId: "primary-root" });
    const delivery = target.handedOff.mock.calls.map(([prepared]) => prepared).find(({ replyId }) => replyId === entry.id)!;
    expect(delivery.preparedPlan.intent).toMatchObject({
      kind: "message.reply.view", purpose: "operation-result", rootMessageId: "primary-root"
    });
    expect(target.graph.cardContexts.loadWorkerMainView("worker", 1)).toMatchObject({
      messageId: "worker-main-message", cardId: "worker-main-card"
    });
  });

  it("routes Worker Human Review through the same Worker Pane Ring and parent fence", async () => {
    const target = fixture();
    const view = createQueuedWorkerTurnCard({
      turnId: "worker-review-turn", instanceId: target.worker.id, instanceGeneration: target.worker.generation,
      workerSessionGeneration: target.worker.workerSessionGeneration, workerName: target.worker.name,
      parentTurnId: null, rootMessageId: "worker-thread-root", requestText: "review",
      queuePosition: 1, occurredAt: "2026-10-06T00:00:00.000Z"
    });
    target.graph.workerTurns.acceptInstanceTurnWithCard({
      id: view.turnId, idempotencyKey: view.turnId, actor: { kind: "human", userId: "operator" },
      projectId: "project", instanceId: target.worker.id, instanceGeneration: target.worker.generation,
      kind: "turn", text: view.requestText, parentTurnId: null, sourceMessageId: "source", view,
      render: renderWorkerTurnCard
    });
    target.graph.workerTurns.transitionInstanceTurnWithProjection({
      turnId: view.turnId, expectedGeneration: target.worker.generation, state: "running", eventKind: "turn.started",
      change: { type: "running", occurredAt: "2026-10-06T00:00:01.000Z" }, render: renderWorkerTurnCard,
      renderHumanReviewNotification: renderWorkerHumanReviewNotification
    });
    target.graph.workerTurns.transitionInstanceTurnWithProjection({
      turnId: view.turnId, expectedGeneration: target.worker.generation, state: "blocked", eventKind: "turn.blocked",
      change: { type: "blocked", occurredAt: "2026-10-06T00:00:02.000Z", notice: "Needs local review" },
      render: renderWorkerTurnCard, renderHumanReviewNotification: renderWorkerHumanReviewNotification
    });
    await Promise.resolve();

    const reply = target.graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) => projectionKey?.startsWith("human-review:worker:"))!;
    expect(reply).toMatchObject({
      workerId: "worker", workerSessionGeneration: target.worker.workerSessionGeneration,
      deliveryScope: { kind: "pane", workspaceId: "primary-workspace", paneId: "worker-pane" },
      deliveryParentPaneId: "primary-pane",
      deliveryOwnerFence: {
        kind: "worker", id: "worker", generation: target.worker.generation,
        sessionGeneration: target.worker.workerSessionGeneration,
        parent: { id: "binding", generation: 1, sessionGeneration: 1 }
      }
    });
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: reply.id }));

    const createDelivery = target.handedOff.mock.calls.map(([delivery]) => delivery).find(({ replyId }) => replyId === reply.id)!;
    const lease = target.graph.leases.acquireInstanceLease("owner", "2026-10-06T00:00:03.000Z", "2099-01-01T00:00:00.000Z")!;
    target.graph.leases.activateWriteFence(lease.ownerId, lease.fencingToken);
    const task = target.graph.outbox.listPendingOutboundReplies().find(({ id, projectionKey }) => id !== reply.id && projectionKey?.startsWith("worker-task:"))!;
    const taskDelivery = target.handedOff.mock.calls.map(([delivery]) => delivery).find(({ replyId }) => replyId === task.id)!;
    const taskClaim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: taskDelivery, at: "2098-10-06T00:00:00.000Z", expiresAt: "2098-10-06T00:01:00.000Z"
    });
    expect(taskClaim).not.toBeNull();
    if (!taskClaim) throw new Error("expected Worker Task Ring claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(taskClaim, {
      messageId: "worker-task-message", surfaceId: "worker-task-card"
    })).toBe(true);
    const claim = target.graph.preparedDeliveries.claimPreparedDelivery({
      delivery: createDelivery, at: "2098-10-06T00:00:00.000Z", expiresAt: "2098-10-06T00:01:00.000Z"
    });
    expect(claim).not.toBeNull();
    if (!claim) throw new Error("expected Worker Human Review claim");
    expect(target.graph.preparedDeliveries.acknowledgePreparedDelivery(claim, {
      messageId: "worker-review-message", surfaceId: "worker-review-card"
    })).toBe(true);
    expect(target.graph.cardContexts.loadWorkerMainView("worker", target.worker.workerSessionGeneration)).toMatchObject({
      messageId: null, cardId: null, deliveredVersion: 0
    });

    target.graph.workerTurns.transitionInstanceTurnWithProjection({
      turnId: view.turnId, expectedGeneration: target.worker.generation, state: "running", eventKind: "turn.started",
      change: { type: "running", occurredAt: "2026-10-06T00:00:04.000Z" }, render: renderWorkerTurnCard,
      renderHumanReviewNotification: renderWorkerHumanReviewNotification
    });
    await Promise.resolve();
    const resolved = target.graph.outbox.listPendingOutboundReplies().find(({ projectionKey, kind }) => projectionKey === reply.projectionKey && kind === "card_update")!;
    expect(resolved).toMatchObject({
      workerId: "worker", workerSessionGeneration: target.worker.workerSessionGeneration,
      deliveryScope: { kind: "pane", workspaceId: "primary-workspace", paneId: "worker-pane" },
      deliveryParentPaneId: "primary-pane"
    });
    expect(target.handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: resolved.id }));
  });
});
