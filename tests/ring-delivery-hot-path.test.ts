import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableInboundPipeline } from "../src/coordinator/durable-inbound-pipeline.js";
import type { PreparedDelivery, PreparedDeliveryPlan, SemanticDeliveryWork } from "../src/domain/delivery.js";
import { RingDeliveryEngine } from "../src/events/ring-delivery-engine.js";
import { PreparedDeliveryRing } from "../src/events/prepared-delivery-ring.js";
import { InProcessInboundWorkNotifier } from "../src/events/inbound-work-notifier.js";
import { prepareSemanticOutboundGatewayPlan } from "../src/events/outbound-gateway-intent.js";
import { GatewayDeliveryError, GatewayPreparationError } from "../src/gateways/contract/plugin.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

afterEach(() => vi.useRealTimers());

function canonicalTurnCard() {
  const bundle = createTestStoreBundle();
  const store = bundle.driver;
  const segments = store.capabilityModules().conversationSegments;
  store.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
  store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
  bundle.outbox.setGatewayPlanPreparer((reply) => ({
    protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1,
    operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey }
  }));
  segments.setPreparedDeliveryReservation(bundle.outbox, { enqueuePreparedDelivery() {} });
  const now = "2026-10-06T00:00:00.000Z";
  store.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('segment','lane','primary','binding',1,'traex','hello','working',2,'root',?,?)").run(now, now);
  store.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,element_id,state,sequence,delivered_sequence,created_at,updated_at) VALUES('segment:page:0','segment',0,NULL,'turn-card:segment:page:0','creating',2,0,?,?)").run(now, now);
  expect(segments.reserveSnapshot({ segmentId: "segment", pageIndex: 0, messageId: null, card: {}, cursor: null, viewVersion: 2 })).toBe("reserved");
  const reply = store.listPendingOutboundReplies()[0]!;
  const hydrated = store.preparedDeliveries.hydratePreparedDelivery(reply.id);
  if (hydrated.status !== "prepared") throw new Error(`unexpected hydration: ${hydrated.status}`);
  const lease = bundle.lease.acquireInstanceLease("owner", now, "2099-01-01T00:00:00.000Z")!;
  bundle.lifecycle.activateWriteFence(lease.ownerId, lease.fencingToken);
  return { bundle, store, delivery: hydrated.delivery };
}

function canonicalWorkerTurnCard() {
  const bundle = createTestStoreBundle();
  const store = bundle.driver;
  const segments = store.capabilityModules().conversationSegments;
  store.createPendingBinding({ id: "parent", projectId: "project", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "parent-root", title: "Primary" });
  store.updateBinding("parent", { state: "active", lifecycle: "active", attachment: "attached", paneId: "parent-pane" });
  const created = bundle.instance.createWorkerAgentInstance({
    id: "worker", projectId: "project", name: "Worker", role: "worker", agentKind: "traex", model: null, desiredState: "running",
    parent: { bindingId: "parent", bindingGeneration: 1, paneId: "parent-pane", nativeSessionId: "parent-session" },
    workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
  }, 4);
  if (created.outcome !== "created") throw new Error("expected Worker");
  const worker = bundle.instance.attachAgentInstanceRuntime({
    instanceId: created.instance.id, expectedGeneration: created.instance.generation,
    herdrWorkspaceId: "workspace", paneId: "worker-pane", nativeSessionId: "worker-session"
  });
  if (!worker) throw new Error("expected attached Worker");
  const now = "2026-10-06T00:00:00.000Z";
  store.database.prepare(`INSERT INTO worker_session_threads(
      id,publication_key,worker_id,worker_session_generation,parent_binding_id,parent_binding_generation,parent_pane_id,
      chat_id,mode,state,topic_id,root_message_id,created_at,activated_at,updated_at
    ) VALUES('worker-thread','worker-thread:worker:1','worker',?,'parent',1,'parent-pane',
      'chat','canonical-main','active','worker-topic','worker-root',?,?,?)`)
    .run(worker.workerSessionGeneration, now, now, now);
  bundle.outbox.setGatewayPlanPreparer((reply) => ({
    protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1,
    operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey }
  }));
  segments.setPreparedDeliveryReservation(bundle.outbox, { enqueuePreparedDelivery() {} });
  store.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('worker-segment','worker-lane','worker','worker',?,'traex','audit','working',1,'worker-root',?,?)`)
    .run(worker.generation, now, now);
  store.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
    ) VALUES('worker-segment:page:0','worker-segment',0,NULL,'turn-card:worker-segment:page:0','creating',1,0,?,?)`)
    .run(now, now);
  expect(segments.reserveSnapshot({ segmentId: "worker-segment", pageIndex: 0, messageId: null, card: {}, cursor: null, viewVersion: 1 })).toBe("reserved");
  const reply = store.listPendingOutboundReplies()[0]!;
  const hydrated = store.preparedDeliveries.hydratePreparedDelivery(reply.id);
  if (hydrated.status !== "prepared") throw new Error(`unexpected hydration: ${hydrated.status}`);
  const lease = bundle.lease.acquireInstanceLease("owner", now, "2099-01-01T00:00:00.000Z")!;
  bundle.lifecycle.activateWriteFence(lease.ownerId, lease.fencingToken);
  return { bundle, store, delivery: hydrated.delivery };
}

function semanticWork(): SemanticDeliveryWork {
  return {
    replyId: "semantic", scope: { kind: "pane", workspaceId: "workspace", paneId: "pane" },
    ownerFence: { kind: "primary", id: "binding", generation: 1, sessionGeneration: 1 }, parentPaneId: null,
    deliveryOrder: 1, workClass: "live", idempotencyKey: "semantic", gatewayId: "gateway", gatewayProfileId: "profile",
    deliveryKind: "card_reply", rootMessageId: "root", cardSequence: null, conflictKey: "semantic", projectionKey: "turn-card:segment:page:0",
    snapshotRevision: 1, priorCheckpoints: [], nextAttemptAt: "2026-10-06T00:00:00.000Z", estimatedBytes: 10,
    input: {
      kind: "semantic-snapshot", subject: { kind: "conversation-page", segmentId: "segment", pageIndex: 0, revision: 1 },
      snapshot: {
        schemaVersion: 1, kind: "conversation-turn-card",
        pagePlan: { policyVersion: 1, budgetProfileVersion: 1, pageIndex: 0, startCursor: null, endCursor: null, hasContinuation: false },
        presentationBudget: { encodedBytes: 9_000, elementCount: 256, actionCount: 32, profileVersion: 1 },
        presentationMeasure: { encodedBytesUpperBound: 100, elementCount: 0, actionCount: 0 }
      }, snapshotHash: "a".repeat(64),
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    }, preparationState: "reserved"
  };
}

function frozen(work: SemanticDeliveryWork, plan: PreparedDeliveryPlan): PreparedDelivery {
  return {
    replyId: work.replyId, scope: work.scope, ownerFence: work.ownerFence, parentPaneId: work.parentPaneId, deliveryOrder: work.deliveryOrder,
    workClass: work.workClass, idempotencyKey: work.idempotencyKey, gatewayId: work.gatewayId, gatewayProfileId: work.gatewayProfileId,
    preparedPlan: plan, planHash: "frozen-hash", conflictKey: work.conflictKey, projectionKey: work.projectionKey,
    snapshotRevision: work.snapshotRevision, rendererRevision: plan.rendererRevision, cardSequence: work.cardSequence,
    priorCheckpoints: work.priorCheckpoints, nextAttemptAt: work.nextAttemptAt, estimatedBytes: work.estimatedBytes
  };
}

describe("Ring Conversation Page hot path", () => {
  it("checks duplicate membership without copying cached Ring items", async () => {
    const work = semanticWork();
    const plan: PreparedDeliveryPlan = {
      protocolVersion: 1, gatewayId: work.gatewayId, profileId: work.gatewayProfileId, rendererRevision: 1,
      operation: "message.reply.view", intent: { kind: "message.reply.view", rootMessageId: work.rootMessageId, view: {}, idempotencyKey: work.idempotencyKey }
    };
    const delivery = { ...frozen(work, plan), nextAttemptAt: "2099-01-01T00:00:00.000Z" };
    const copiedItems = vi.spyOn(PreparedDeliveryRing.prototype, "items");
    const engine = new RingDeliveryEngine({ store: {} as never, gateway: { prepare: vi.fn(), execute: vi.fn() }, coldRecoveryEnabled: false });
    engine.start();

    engine.enqueue(delivery);
    engine.enqueue(delivery);

    expect(copiedItems).not.toHaveBeenCalled();
    copiedItems.mockRestore();
    await engine.stop();
  });

  it("freezes semantic preparation before claim and Gateway execute", async () => {
    const work = semanticWork();
    const order: string[] = [];
    const plan: PreparedDeliveryPlan = {
      protocolVersion: 1, gatewayId: work.gatewayId, profileId: work.gatewayProfileId, rendererRevision: 1,
      operation: "message.reply.view", intent: { kind: "message.reply.view", rootMessageId: work.rootMessageId, view: {}, idempotencyKey: work.idempotencyKey }
    };
    const execute = vi.fn(async () => { order.push("execute"); return { refs: [{ kind: "message" as const, opaqueId: "message" }] }; });
    const store = {
      freezeSemanticDelivery: vi.fn(() => { order.push("freeze"); expect(execute).not.toHaveBeenCalled(); return { outcome: "prepared" as const, delivery: frozen(work, plan) }; }),
      failSemanticDeliveryPreparation: vi.fn(), hydrateDeliveryInput: vi.fn(),
      advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const })),
      claimConversationPageDelivery: vi.fn(({ delivery }) => { order.push("claim"); return { replyId: delivery.replyId, attemptId: "attempt", ownerId: "owner", fencingToken: 1, planHash: delivery.planHash, snapshotRevision: delivery.snapshotRevision }; }),
      checkpointConversationPageDelivery: vi.fn(() => true), acknowledgeConversationPageDelivery: vi.fn(() => true), failConversationPageDelivery: vi.fn(() => "retry" as const)
    };
    const gateway = { prepare: vi.fn(() => { order.push("prepare"); return plan; }), execute };
    const engine = new RingDeliveryEngine({
      store: store as never, gateway,
      prepareSemanticDelivery: (_candidate, port) => port.prepare(plan.intent as never),
      coldRecoveryEnabled: false
    });
    engine.start();
    engine.enqueue(work);

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(order).toEqual(["prepare", "freeze", "claim", "execute"]);
    expect(store.claimConversationPageDelivery).toHaveBeenCalledWith(expect.objectContaining({
      delivery: expect.objectContaining({ replyId: work.replyId }),
      unclaimedCreateNotBefore: expect.any(String)
    }));
    expect(execute).toHaveBeenCalledWith(plan, expect.objectContaining({ idempotencyKey: work.idempotencyKey }));
    await engine.stop();
  });

  it("does not claim or execute after deterministic semantic preparation failure", async () => {
    const work = semanticWork();
    const failSemanticDeliveryPreparation = vi.fn(() => "failed" as const);
    const claimConversationPageDelivery = vi.fn();
    const execute = vi.fn();
    const engine = new RingDeliveryEngine({
      store: { failSemanticDeliveryPreparation, claimConversationPageDelivery } as never,
      gateway: { prepare: vi.fn(), execute },
      prepareSemanticDelivery: () => { throw new GatewayPreparationError("semantic_delivery_measurement_invalid"); },
      coldRecoveryEnabled: false
    });
    engine.start();
    engine.enqueue(work);

    await vi.waitFor(() => expect(failSemanticDeliveryPreparation).toHaveBeenCalledOnce());
    expect(failSemanticDeliveryPreparation).toHaveBeenCalledWith({ work, error: "semantic_delivery_measurement_invalid" });
    expect(claimConversationPageDelivery).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("renders and measures only the recorded semantic policy and Gateway profile", () => {
    const work = semanticWork();
    const view = { schemaVersion: 1 as const, fallbackText: "turn", heading: null, nodes: [], mutable: true, streaming: true };
    const policy = {
      plannerPolicyVersion: 1, rendererPolicyVersion: 1,
      plan: vi.fn(),
      measure: vi.fn(() => ({ encodedBytesUpperBound: 100, elementCount: 0, actionCount: 0 })),
      render: vi.fn(() => view)
    };
    const plan: PreparedDeliveryPlan = {
      protocolVersion: 1, gatewayId: work.gatewayId, profileId: work.gatewayProfileId, rendererRevision: 1,
      operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: work.rootMessageId, view, idempotencyKey: work.idempotencyKey }
    };
    const gateway = { prepare: vi.fn(() => plan), execute: vi.fn() };

    expect(prepareSemanticOutboundGatewayPlan(work, gateway, { policy, gatewayProfileVersion: 1 })).toEqual(plan);
    expect(policy.measure).toHaveBeenCalledWith(work.input.snapshot);
    expect(policy.render).toHaveBeenCalledWith(work.input.snapshot);
    expect(gateway.prepare).toHaveBeenCalledWith(plan.intent);

    expect(() => prepareSemanticOutboundGatewayPlan({
      ...work, input: { ...work.input, gatewayProfileVersion: 2 }
    }, gateway, { policy, gatewayProfileVersion: 1 })).toThrow("semantic_delivery_policy_stale");
    expect(gateway.prepare).toHaveBeenCalledOnce();
  });

  it("rejects consumer rendering when it disagrees with the committed measurement", () => {
    const work = semanticWork();
    const committed = {
      ...work,
      input: { ...work.input, snapshot: {
        ...work.input.snapshot,
        presentationBudget: { encodedBytes: 9_000, elementCount: 256, actionCount: 32, profileVersion: 1 },
        presentationMeasure: { encodedBytesUpperBound: 99, elementCount: 1, actionCount: 0 }
      } }
    } as SemanticDeliveryWork;
    const policy = {
      plannerPolicyVersion:1,rendererPolicyVersion:1,plan:vi.fn(),
      measure:vi.fn(()=>({ encodedBytesUpperBound:100,elementCount:1,actionCount:0 })),
      render:vi.fn(()=>({ schemaVersion:1 as const,fallbackText:"turn",heading:null,nodes:[],mutable:true,streaming:true }))
    };
    const gateway={ prepare:vi.fn((intent)=>({ protocolVersion:1,gatewayId:work.gatewayId,profileId:work.gatewayProfileId,rendererRevision:1,operation:intent.kind,intent })),execute:vi.fn() };

    expect(()=>prepareSemanticOutboundGatewayPlan(committed,gateway,{ policy,gatewayProfileVersion:1 }))
      .toThrow("semantic_delivery_measurement_mismatch");
    expect(gateway.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["encoded bytes", { encodedBytesUpperBound: 9_001, elementCount: 1, actionCount: 0 }],
    ["elements", { encodedBytesUpperBound: 100, elementCount: 257, actionCount: 0 }],
    ["actions", { encodedBytesUpperBound: 100, elementCount: 1, actionCount: 33 }]
  ])("rejects committed %s above the frozen presentation budget before Gateway preparation", (_dimension, presentationMeasure) => {
    const work = semanticWork();
    const committed = {
      ...work,
      input: { ...work.input, snapshot: { ...work.input.snapshot, presentationMeasure } }
    } as SemanticDeliveryWork;
    const policy = {
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, plan: vi.fn(),
      measure: vi.fn(() => presentationMeasure), render: vi.fn()
    };
    const gateway = { prepare: vi.fn(), execute: vi.fn() };

    expect(() => prepareSemanticOutboundGatewayPlan(committed, gateway, { policy, gatewayProfileVersion: 1 }))
      .toThrow("semantic_delivery_budget_exceeded");
    expect(policy.render).not.toHaveBeenCalled();
    expect(gateway.prepare).not.toHaveBeenCalled();
  });

  it("fails closed on malformed committed presentation evidence and inconsistent profile versions", () => {
    const work = semanticWork();
    const policy = {
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, plan: vi.fn(),
      measure: vi.fn(() => ({ encodedBytesUpperBound: 100, elementCount: 0, actionCount: 0 })), render: vi.fn()
    };
    const gateway = { prepare: vi.fn(), execute: vi.fn() };
    const malformed = { ...work, input: { ...work.input, snapshot: { schemaVersion: 1, kind: "conversation-turn-card" } } } as SemanticDeliveryWork;
    const staleProfile = {
      ...work,
      input: { ...work.input, snapshot: {
        ...work.input.snapshot,
        presentationBudget: { encodedBytes: 9_000, elementCount: 256, actionCount: 32, profileVersion: 2 }
      } }
    } as SemanticDeliveryWork;

    expect(() => prepareSemanticOutboundGatewayPlan(malformed, gateway, { policy, gatewayProfileVersion: 1 }))
      .toThrow("semantic_delivery_measurement_invalid");
    expect(() => prepareSemanticOutboundGatewayPlan(staleProfile, gateway, { policy, gatewayProfileVersion: 1 }))
      .toThrow("semantic_delivery_policy_stale");
    expect(policy.measure).not.toHaveBeenCalled();
    expect(policy.render).not.toHaveBeenCalled();
    expect(gateway.prepare).not.toHaveBeenCalled();
  });
  it("atomically claims the exact authoritative prepared head once", () => {
    const { bundle, store, delivery } = canonicalTurnCard();
    const claim = store.preparedDeliveries.claimConversationPageDelivery({ delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z" });

    expect(claim).toMatchObject({ replyId: delivery.replyId, planHash: delivery.planHash, snapshotRevision: 2, ownerId: "owner" });
    expect(store.preparedDeliveries.claimConversationPageDelivery({ delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z" })).toBeNull();
    bundle.lifecycle.close();
  });

  it("claims an exact Worker-owned Conversation Page through prepared delivery routing", () => {
    const { bundle, store, delivery } = canonicalWorkerTurnCard();

    const claim = store.preparedDeliveries.claimPreparedDelivery({
      delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    });
    expect(claim).toMatchObject({ replyId: delivery.replyId, planHash: delivery.planHash, snapshotRevision: 1, ownerId: "owner" });
    expect(store.preparedDeliveries.checkpointConversationPageDelivery(claim!, {
      kind: "surface", ref: { gatewayId: delivery.gatewayId, kind: "surface", opaqueId: "worker-card" }
    })).toBe(true);
    expect(store.preparedDeliveries.acknowledgeConversationPageDelivery(claim!, {
      messageId: "worker-message", surfaceId: "worker-card", threadId: null
    })).toBe(true);
    expect(store.database.prepare("SELECT state,delivered_message_id FROM outbound_replies WHERE id=?").get(delivery.replyId))
      .toEqual({ state: "delivered", delivered_message_id: "worker-message" });
    expect(store.database.prepare("SELECT state,message_id,card_id,pending_reply_id FROM conversation_segment_pages WHERE segment_id='worker-segment' AND page_index=0").get())
      .toEqual({ state: "active", message_id: "worker-message", card_id: "worker-card", pending_reply_id: null });
    bundle.lifecycle.close();
  });

  it("retires an advanced Conversation Page head and releases the page for current projection", () => {
    const { bundle, store, delivery } = canonicalTurnCard();
    store.database.prepare("UPDATE conversation_segment_pages SET sequence=3 WHERE segment_id='segment' AND page_index=0").run();

    expect(store.preparedDeliveries.claimPreparedDelivery({
      delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })).toBeNull();
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(delivery.replyId)).toEqual({ state: "dismissed" });
    expect(store.database.prepare("SELECT state,pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0").get())
      .toEqual({ state: "creating", pending_reply_id: null });
    bundle.lifecycle.close();
  });

  it("reopens an advanced existing-card page instead of replaying its obsolete update", () => {
    const { bundle, store, delivery: createDelivery } = canonicalTurnCard();
    const createClaim = store.preparedDeliveries.claimConversationPageDelivery({
      delivery: createDelivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })!;
    expect(store.preparedDeliveries.acknowledgeConversationPageDelivery(createClaim, {
      messageId: "message", surfaceId: "card", threadId: null
    })).toBe(true);
    const activePage = store.database.prepare("SELECT message_id,card_id,state,sequence,delivery_cohort FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0").get() as {
      message_id: string | null; card_id: string | null; state: string; sequence: number; delivery_cohort: string | null;
    };
    expect(activePage).toMatchObject({ message_id: "message", card_id: "card", state: "active", sequence: 2 });
    expect(store.capabilityModules().conversationSegments.reserveSnapshot({
      segmentId: "segment", pageIndex: 0, messageId: activePage.message_id, cardId: activePage.card_id,
      elementId: "turn-card:segment:page:0", card: {}, cursor: null, viewVersion: 3
    })).toBe("reserved");
    const update = store.listPendingOutboundReplies().find((reply) => reply.state === "pending")!;
    const hydrated = store.preparedDeliveries.hydratePreparedDelivery(update.id);
    if (hydrated.status !== "prepared") throw new Error(`unexpected hydration: ${hydrated.status}`);
    const delivery = hydrated.delivery;
    store.database.prepare("UPDATE conversation_segment_pages SET state='finished',sequence=4 WHERE segment_id='segment' AND page_index=0").run();

    expect(store.preparedDeliveries.claimPreparedDelivery({
      delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })).toBeNull();
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(delivery.replyId)).toEqual({ state: "dismissed" });
    expect(store.database.prepare("SELECT state,sequence,pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0").get())
      .toEqual({ state: "active", sequence: 4, pending_reply_id: null });
    bundle.lifecycle.close();
  });

  it("keeps a frozen page immutable when retiring its obsolete update", () => {
    const { bundle, store, delivery: createDelivery } = canonicalTurnCard();
    const createClaim = store.preparedDeliveries.claimConversationPageDelivery({
      delivery: createDelivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })!;
    expect(store.preparedDeliveries.acknowledgeConversationPageDelivery(createClaim, {
      messageId: "message", surfaceId: "card", threadId: null
    })).toBe(true);
    expect(store.capabilityModules().conversationSegments.reserveSnapshot({
      segmentId: "segment", pageIndex: 0, messageId: "message", cardId: "card",
      elementId: "turn-card:segment:page:0", card: {}, cursor: null, viewVersion: 3
    })).toBe("reserved");
    const update = store.listPendingOutboundReplies().find((reply) => reply.state === "pending")!;
    const hydrated = store.preparedDeliveries.hydratePreparedDelivery(update.id);
    if (hydrated.status !== "prepared") throw new Error(`unexpected hydration: ${hydrated.status}`);
    store.database.prepare("UPDATE conversation_segment_pages SET state='frozen',sequence=4 WHERE segment_id='segment' AND page_index=0").run();

    expect(store.preparedDeliveries.claimPreparedDelivery({
      delivery: hydrated.delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })).toBeNull();
    expect(store.database.prepare("SELECT state,pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0").get())
      .toEqual({ state: "frozen", pending_reply_id: null });
    bundle.lifecycle.close();
  });

  it("retires an ordinary snapshot update after a later Human Message closes its segment", () => {
    const { bundle, store, delivery: createDelivery } = canonicalTurnCard();
    const createClaim = store.preparedDeliveries.claimConversationPageDelivery({
      delivery: createDelivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })!;
    expect(store.preparedDeliveries.acknowledgeConversationPageDelivery(createClaim, {
      messageId: "message", surfaceId: "card", threadId: null
    })).toBe(true);
    expect(store.capabilityModules().conversationSegments.reserveSnapshot({
      segmentId: "segment", pageIndex: 0, messageId: "message", cardId: "card",
      elementId: "turn-card:segment:page:0", card: { state: "working" }, cursor: null, viewVersion: 3
    })).toBe("reserved");
    const update = store.listPendingOutboundReplies().find((reply) => reply.state === "pending")!;
    const hydrated = store.preparedDeliveries.hydratePreparedDelivery(update.id);
    if (hydrated.status !== "prepared") throw new Error(`unexpected hydration: ${hydrated.status}`);
    store.database.prepare("UPDATE conversation_segments SET state='closed' WHERE id='segment'").run();

    expect(store.preparedDeliveries.claimPreparedDelivery({
      delivery: hydrated.delivery, at: "2098-10-06T00:00:02.000Z", expiresAt: "2098-10-06T00:01:02.000Z"
    })).toBeNull();
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(update.id)).toEqual({ state: "dismissed" });
    expect(store.database.prepare("SELECT state,pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0").get())
      .toEqual({ state: "finished", pending_reply_id: null });
    bundle.lifecycle.close();
  });

  it("retires a closed never-delivered Conversation Page without replaying an old card", () => {
    const { bundle, store, delivery } = canonicalWorkerTurnCard();
    store.database.prepare("UPDATE conversation_segments SET state='closed' WHERE id='worker-segment'").run();

    expect(store.preparedDeliveries.claimPreparedDelivery({
      delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })).toBeNull();
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(delivery.replyId)).toEqual({ state: "dismissed" });
    expect(store.database.prepare("SELECT state,pending_reply_id FROM conversation_segment_pages WHERE segment_id='worker-segment' AND page_index=0").get())
      .toEqual({ state: "finished", pending_reply_id: null });
    bundle.lifecycle.close();
  });

  it.each(["frozen", "finished"] as const)("delivers a current-process %s initial page once after a later Human Message closes its segment", (pageState) => {
    const { bundle, store, delivery } = canonicalTurnCard();
    store.database.prepare("UPDATE conversation_segments SET state='closed' WHERE id='segment'").run();
    store.database.prepare("UPDATE conversation_segment_pages SET state=? WHERE segment_id='segment' AND page_index=0").run(pageState);

    const claim = store.preparedDeliveries.claimConversationPageDelivery({
      delivery, at: "2098-10-06T00:00:02.000Z", expiresAt: "2098-10-06T00:01:02.000Z",
      unclaimedCreateNotBefore: "2025-10-05T23:59:59.000Z"
    });
    expect(claim).toMatchObject({ replyId: delivery.replyId });
    expect(store.preparedDeliveries.acknowledgeConversationPageDelivery(claim!, {
      messageId: "closed-segment-message", surfaceId: "closed-segment-card", threadId: null
    })).toBe(true);
    expect(store.database.prepare("SELECT state,delivered_message_id FROM outbound_replies WHERE id=?").get(delivery.replyId))
      .toEqual({ state: "delivered", delivered_message_id: "closed-segment-message" });
    expect(store.database.prepare("SELECT state,message_id,pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0").get())
      .toEqual({ state: pageState, message_id: "closed-segment-message", pending_reply_id: null });
    bundle.lifecycle.close();
  });

  it("retires a pristine initial page that predates the Ring process epoch", () => {
    const { bundle, store, delivery } = canonicalTurnCard();

    expect(store.preparedDeliveries.claimConversationPageDelivery({
      delivery, at: "2098-10-06T00:00:02.000Z", expiresAt: "2098-10-06T00:01:02.000Z",
      unclaimedCreateNotBefore: "2027-10-06T00:00:01.000Z"
    } as never)).toBeNull();
    expect(store.database.prepare("SELECT state,first_claimed_at,card_id_checkpoint FROM outbound_replies WHERE id=?").get(delivery.replyId))
      .toEqual({ state: "dismissed", first_claimed_at: null, card_id_checkpoint: null });
    expect(store.database.prepare("SELECT state,pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0").get())
      .toEqual({ state: "finished", pending_reply_id: null });
    bundle.lifecycle.close();
  });

  it("claims a pristine initial page reserved during the current Ring process epoch", () => {
    const { bundle, store, delivery } = canonicalTurnCard();

    expect(store.preparedDeliveries.claimConversationPageDelivery({
      delivery, at: "2098-10-06T00:00:02.000Z", expiresAt: "2098-10-06T00:01:02.000Z",
      unclaimedCreateNotBefore: "2025-10-05T23:59:59.000Z"
    } as never)).toMatchObject({ replyId: delivery.replyId });
    bundle.lifecycle.close();
  });

  it("does not suppress a pre-epoch initial page with provider-effect evidence", () => {
    const { bundle, store, delivery } = canonicalTurnCard();
    store.database.prepare(`UPDATE outbound_replies SET card_id_checkpoint='existing-card',
      gateway_checkpoint_json=json_object('kind','surface','gatewayId',gateway_id,'opaqueId','existing-card') WHERE id=?`).run(delivery.replyId);
    const hydrated = store.preparedDeliveries.hydratePreparedDelivery(delivery.replyId);
    if (hydrated.status !== "prepared") throw new Error(`unexpected hydration: ${hydrated.status}`);

    expect(store.preparedDeliveries.claimConversationPageDelivery({
      delivery: hydrated.delivery, at: "2098-10-06T00:00:02.000Z", expiresAt: "2098-10-06T00:01:02.000Z",
      unclaimedCreateNotBefore: "2027-10-06T00:00:01.000Z"
    })).toMatchObject({ replyId: delivery.replyId });
    expect(store.database.prepare("SELECT state,card_id_checkpoint FROM outbound_replies WHERE id=?").get(delivery.replyId))
      .toEqual({ state: "pending", card_id_checkpoint: "existing-card" });
    bundle.lifecycle.close();
  });

  it.each([
    ["owner fence", "UPDATE bindings SET session_epoch=2 WHERE id='binding'", "dismissed"],
    ["snapshot target", "UPDATE conversation_segment_pages SET sequence=3 WHERE segment_id='segment' AND page_index=0", "dismissed"],
    ["page ownership", "UPDATE conversation_segment_pages SET pending_reply_id=NULL WHERE segment_id='segment' AND page_index=0", "dismissed"],
    ["cooldown", "INSERT INTO lark_delivery_cooldowns(scope,blocked_until,trigger_count,last_reason,created_at,updated_at) VALUES('app','2099-01-01T00:00:00.000Z',1,'rate','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z')", "pending"],
  ])("rejects an atomic %s mismatch", (_name, mutation, expectedState) => {
    const { bundle, store, delivery } = canonicalTurnCard();
    store.database.exec(mutation);
    expect(store.preparedDeliveries.claimConversationPageDelivery({ delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z" })).toBeNull();
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(delivery.replyId)).toEqual({ state: expectedState });
    bundle.lifecycle.close();
  });

  it.each([
    ["cooldown", "INSERT INTO lark_delivery_cooldowns(scope,blocked_until,trigger_count,last_reason,created_at,updated_at) VALUES('app','2099-01-01T00:00:00.000Z',1,'rate','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z')"],
    ["active quarantine", "INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at) SELECT lane_key,id,'immutable','permanent','active','blocked','test','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id=(SELECT pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0)"],
    ["lost lease", "UPDATE instance_lease SET expires_at_ms=0 WHERE singleton_id=1"]
  ])("preserves a stale page head behind %s", (_name, blockerSql) => {
    const { bundle, store, delivery } = canonicalTurnCard();
    store.database.prepare("UPDATE conversation_segment_pages SET sequence=3 WHERE segment_id='segment' AND page_index=0").run();
    store.database.exec(blockerSql);

    expect(store.preparedDeliveries.claimConversationPageDelivery({
      delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })).toBeNull();
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(delivery.replyId)).toEqual({ state: "pending" });
    expect(store.database.prepare("SELECT pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0").get())
      .toEqual({ pending_reply_id: delivery.replyId });
    bundle.lifecycle.close();
  });

  it("preserves a stale page head with an unmet prerequisite", () => {
    const { bundle, store, delivery } = canonicalTurnCard();
    const prerequisite = bundle.outbox.enqueueOutboundReply({
      id: "stale-required", idempotencyKey: "stale-required", rootMessageId: "root", kind: "text", payload: "waiting"
    });
    store.preparedDeliveries.addPrerequisite({ dependentReplyId: delivery.replyId, prerequisiteReplyId: prerequisite.id, requiredState: "delivered" });
    store.database.prepare("UPDATE conversation_segment_pages SET sequence=3 WHERE segment_id='segment' AND page_index=0").run();

    expect(store.preparedDeliveries.claimConversationPageDelivery({
      delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })).toBeNull();
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(delivery.replyId)).toEqual({ state: "pending" });
    expect(store.database.prepare("SELECT pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0").get())
      .toEqual({ pending_reply_id: delivery.replyId });
    bundle.lifecycle.close();
  });

  it.each([
    ["uncertain effect", "UPDATE outbound_replies SET effect_certainty='uncertain' WHERE id="],
    ["provider checkpoint", "UPDATE outbound_replies SET card_id_checkpoint='card' WHERE id="],
    ["active claim", "UPDATE outbound_replies SET claim_attempt_id='attempt',claimed_owner_id='owner',claimed_fence=1,claimed_at='2098-10-06T00:00:00.000Z',claim_expires_at='2098-10-06T00:01:00.000Z' WHERE id="]
  ])("preserves a stale page head with %s evidence", (_name, mutation) => {
    const { bundle, store, delivery } = canonicalTurnCard();
    store.database.prepare(`${mutation}?`).run(delivery.replyId);
    store.database.prepare("UPDATE conversation_segment_pages SET sequence=3 WHERE segment_id='segment' AND page_index=0").run();

    expect(store.preparedDeliveries.claimConversationPageDelivery({
      delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })).toBeNull();
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(delivery.replyId)).toEqual({ state: "pending" });
    expect(store.database.prepare("SELECT pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0").get())
      .toEqual({ pending_reply_id: delivery.replyId });
    bundle.lifecycle.close();
  });

  it("blocks a successor on the authoritative scope head and an unmet prerequisite", () => {
    const { bundle, store, delivery } = canonicalTurnCard();
    const successor = { ...delivery, replyId: "successor", deliveryOrder: delivery.deliveryOrder + 1 } as PreparedDelivery;
    expect(store.preparedDeliveries.claimConversationPageDelivery({ delivery: successor, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z" })).toBeNull();
    const prerequisite = bundle.outbox.enqueueOutboundReply({ id: "prerequisite", idempotencyKey: "prerequisite", rootMessageId: "root", kind: "text", payload: "waiting" });
    store.preparedDeliveries.addPrerequisite({ dependentReplyId: delivery.replyId, prerequisiteReplyId: prerequisite.id, requiredState: "delivered" });
    expect(store.preparedDeliveries.claimConversationPageDelivery({ delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z" })).toBeNull();
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(delivery.replyId)).toEqual({ state: "pending" });
    bundle.lifecycle.close();
  });

  it("executes the cached plan, checkpoints, and ACKs without hydrating or preparing again", async () => {
    const { bundle, store, delivery } = canonicalTurnCard();
    const hydrate = vi.spyOn(store.preparedDeliveries, "hydratePreparedDelivery");
    const statements = vi.spyOn(store.database, "prepare");
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
    const execute = vi.fn(async (_plan, context) => {
      await context.checkpoint({ kind: "surface", ref: { gatewayId: delivery.gatewayId, kind: "surface", opaqueId: "card" } });
      return { refs: [{ kind: "message" as const, opaqueId: "message" }, { kind: "surface" as const, opaqueId: "card" }] };
    });
    const prepare = vi.fn();
    const engine = new RingDeliveryEngine({ store: store.preparedDeliveries, gateway: { prepare, execute }, coldRecoveryEnabled: false, onAcknowledged: acknowledge });
    engine.start();
    engine.enqueue(delivery);
    await acknowledged;
    await engine.stop();
    const hotStatements = statements.mock.calls.map(([sql]) => String(sql).trim());
    statements.mockRestore();

    expect(hydrate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(hotStatements.length).toBeGreaterThanOrEqual(4);
    expect(hotStatements[0]).toMatch(/^SELECT\b/i);
    expect(hotStatements.every((sql) => /^(SELECT|UPDATE|INSERT)\b/i.test(sql))).toBe(true);
    expect(hotStatements.some((sql) => sql.includes("delivery_ring_checkpoints"))).toBe(true);
    expect(store.getOutboundReply(delivery.replyId)).toMatchObject({ deliveredMessageId: "message", cardIdCheckpoint: "card" });
    expect(store.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get(JSON.stringify(["pane", "workspace", "pane"])))
      .toEqual({ committed_delivery_order: delivery.deliveryOrder });
    bundle.lifecycle.close();
  });

  it("attributes the production ingress, Core, semantic Outbox, Gateway ACK, and SQLite settlement chain", async () => {
    const bundle = createTestStoreBundle();
    const store = bundle.driver;
    const segments = store.capabilityModules().conversationSegments;
    const trace = store.capabilityModules().deliveryTrace;
    const observedStages: string[] = [];
    trace.subscribe({ onObservation: ({ stage }) => { observedStages.push(stage); } });
    const submissionId = "submission-production-chain";
    const segmentId = `segment:${submissionId}`;
    store.createPendingBinding({ id: "binding-trace", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root-trace", title: "Trace" });
    store.updateBinding("binding-trace", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane-trace", traexSessionId: "terminal-trace" });
    store.database.exec("DROP TRIGGER semantic_delivery_rollout_guarded_transition");
    store.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1 WHERE singleton_id=1").run();
    const route = vi.fn(async (message: { messageId: string; actorOpenId: string; text: string }) => {
      const admission = bundle.agentInputs.admit({
        submissionId, ingressSource: "feishu", sourceMessageKey: message.messageId,
        actor: { kind: "human", id: message.actorOpenId, gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root-trace" },
        text: message.text, owner: { kind: "primary", id: "binding-trace", generation: 1 },
        paneId: "pane-trace", terminalId: "terminal-trace", expectedAgentKind: "traex", expectedSessionId: "session-trace",
        recordedAt: "2026-10-10T00:00:00.000Z"
      });
      expect(admission.outcome).toBe("accepted");
      return { decision: "agent-input", disposition: "agent_input_accepted" as const, submissionId };
    });
    const pipeline = new DurableInboundPipeline({
      chatId: "chat", allowedOpenIds: ["operator"], store: bundle.inboundDispatch, router: { route },
      inboundWork: new InProcessInboundWorkNotifier(), logger: pino({ enabled: false }), deliveryTrace: trace
    });
    let engine: RingDeliveryEngine | null = null;
    pipeline.start();
    try {
      const inbound = {
        eventId: "event-production-chain", messageId: "message-production-chain", parentMessageId: null,
        chatId: "chat", topicId: "topic", rootMessageId: "root-trace", actorOpenId: "operator",
        text: "CANARY_PRIVATE_PRODUCTION_CHAIN", mentionsBot: false, isRootMessage: false
      };
      await pipeline.receive(inbound);
      await pipeline.receive(inbound);
      await vi.waitFor(() => {
        expect(route).toHaveBeenCalledOnce();
        expect(observedStages).toContain("submission_admitted");
      });

      const coreEvent = {
        schemaVersion: 1 as const, eventId: "core-production-chain", cursor: "source-trace:1", sourceId: "source-trace",
        agentKind: "traex" as const, sessionId: "session-trace", turnId: "turn-trace", occurredAt: "2026-10-10T00:00:01.000Z",
        payload: { type: "human_message", message_id: "core-message-trace", text: inbound.text, truncated: false, submission_id: submissionId }
      };
      expect(bundle.coreEvents.ingestBatch({
        laneId: "lane-trace", sourceId: coreEvent.sourceId, agentKind: coreEvent.agentKind, sessionId: coreEvent.sessionId,
        afterCursor: "start", nextCursor: coreEvent.cursor, latestCursor: coreEvent.cursor, events: [coreEvent],
        ingestedAt: "2026-10-10T00:00:01.100Z"
      })).toBe("accepted");
      const page = segments.listConversationSegmentPages(segmentId)[0]!;
      expect(page.deliveryCohort).toBe("semantic");
      const snapshot = { schemaVersion: 1, kind: "conversation-turn-card" } as const;
      expect(segments.reserveSemanticSnapshot!({
        transition: "snapshot", segmentId, pageIndex: 0, messageId: null, elementId: page.elementId,
        cursor: null, viewVersion: 1,
        snapshot,
        plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
      })).toBe("reserved");
      const reservedPage = segments.listConversationSegmentPages(segmentId)[0]!;
      const hydrated = bundle.preparedDeliveries.hydrateDeliveryWork(reservedPage.pendingReplyId!);
      if (hydrated.status !== "ready") throw new Error(`unexpected hydration: ${hydrated.status}`);
      const work = hydrated.work;
      const execute = vi.fn(async () => ({ refs: [
        { gatewayId: work.gatewayId, kind: "message" as const, opaqueId: "provider-message-production" },
        { gatewayId: work.gatewayId, kind: "surface" as const, opaqueId: "provider-card-production" }
      ] }));
      const lease = bundle.lease.acquireInstanceLease("owner-trace", "2026-10-10T00:00:02.000Z", "2099-01-01T00:00:00.000Z")!;
      bundle.lifecycle.activateWriteFence(lease.ownerId, lease.fencingToken);
      engine = new RingDeliveryEngine({
        store: bundle.preparedDeliveries,
        gateway: { prepare: vi.fn(), execute },
        prepareSemanticDelivery: (candidate) => ({
          protocolVersion: 1, gatewayId: candidate.gatewayId, profileId: candidate.gatewayProfileId, rendererRevision: 1,
          operation: "message.reply.view", intent: { kind: "message.reply.view", rootMessageId: candidate.rootMessageId, view: {}, idempotencyKey: candidate.idempotencyKey }
        }),
        coldRecoveryEnabled: false,
        deliveryTrace: trace
      });
      engine.start();
      engine.enqueue(work);

      await vi.waitFor(() => expect(store.getOutboundReply(work.replyId)).toMatchObject({
        state: "delivered", deliveredMessageId: "provider-message-production", cardIdCheckpoint: "provider-card-production"
      }));
      await engine.stop();
      engine = null;

      expect(execute).toHaveBeenCalledOnce();
      expect(bundle.preparedDeliveries.acknowledgeConversationPageDelivery({
        replyId: work.replyId, attemptId: "stale-attempt-production", ownerId: lease.ownerId,
        fencingToken: lease.fencingToken, planHash: "stale-plan", snapshotRevision: 1
      }, { messageId: "stale-message", surfaceId: "stale-surface" })).toBe(false);
      expect(trace.snapshot()).toMatchObject({ traces: 1, completed: 1, activePaths: 1 });
      expect(observedStages).toEqual([
        "ingress_accepted", "submission_admitted", "core_projected", "outbox_committed",
        "ring_granted", "gateway_acknowledged", "settled"
      ]);
      const serialized = JSON.stringify(trace.snapshot());
      expect(serialized).not.toMatch(/production-chain|CANARY_PRIVATE|provider-message|provider-card|stale-attempt/);
      expect(Object.keys(trace.snapshot().metrics).every((stage) => [
        "ingress_to_submission", "submission_to_core", "core_to_outbox", "outbox_to_ring",
        "ring_to_gateway_ack", "gateway_ack_to_settlement", "input_to_first_visible_ack", "core_to_first_visible_ack", "core_to_visible_ack", "input_to_settlement"
      ].includes(stage))).toBe(true);
    } finally {
      if (engine) await engine.stop();
      await pipeline.stop();
      bundle.lifecycle.close();
    }
  });

  it("fences stale settlements while advancing past uncertain failures without blocking the Ring", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2098-10-06T00:00:00.000Z"));
    const { bundle, store, delivery } = canonicalTurnCard();
    const reserveSuccessor = (id: string, laneKeyOverride: string) => {
      bundle.outbox.reservePreparedOutboundReply({
        id, idempotencyKey: id, bindingId: "binding", bindingGeneration: 1, targetRole: "operation_result",
        rootMessageId: "root", kind: "card_reply", payload: "{}", projectionKey: `successor:${id}`,
        snapshotRevision: 1, viewVersion: 1, laneKeyOverride
      }).consumeEffects();
      const hydrated = store.preparedDeliveries.hydratePreparedDelivery(id);
      if (hydrated.status !== "prepared") throw new Error(`expected prepared successor, received ${hydrated.status}`);
      return hydrated.delivery;
    };
    const gatewayPrefix = `gateway:${delivery.gatewayId}:`;
    const sameConflict = reserveSuccessor("same-conflict-successor", delivery.conflictKey.slice(gatewayPrefix.length));
    const differentConflict = reserveSuccessor("different-conflict-successor", "different-conflict");
    expect(sameConflict.conflictKey).toBe(delivery.conflictKey);
    expect(differentConflict.conflictKey).not.toBe(delivery.conflictKey);

    let attemptAt = Date.parse("2098-10-06T00:00:01.000Z");
    let finalClaim: ReturnType<typeof store.preparedDeliveries.claimConversationPageDelivery> = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      vi.setSystemTime(attemptAt);
      const hydrated = store.preparedDeliveries.hydratePreparedDelivery(delivery.replyId);
      if (hydrated.status !== "prepared") throw new Error(`expected prepared attempt ${attempt}, received ${hydrated.status}`);
      expect(hydrated.delivery).toMatchObject({
        replyId: delivery.replyId, idempotencyKey: delivery.idempotencyKey, planHash: delivery.planHash,
        conflictKey: delivery.conflictKey, snapshotRevision: delivery.snapshotRevision
      });
      const at = new Date(attemptAt).toISOString();
      const claim = store.preparedDeliveries.claimConversationPageDelivery({
        delivery: hydrated.delivery, at, expiresAt: new Date(attemptAt + 60_000).toISOString()
      });
      if (!claim) throw new Error(`expected claim for uncertain attempt ${attempt}`);
      finalClaim = claim;
      if (attempt === 1) {
        const stale = { ...claim, attemptId: "stale" };
        expect(store.preparedDeliveries.checkpointConversationPageDelivery(stale, {
          kind: "surface", ref: { gatewayId: delivery.gatewayId, kind: "surface", opaqueId: "stale-card" }
        })).toBe(false);
        expect(store.preparedDeliveries.acknowledgeConversationPageDelivery(stale, {
          messageId: "stale-message", surfaceId: "stale-card", threadId: null
        })).toBe(false);
        expect(store.preparedDeliveries.failConversationPageDelivery(stale, {
          error: "stale failure", retryAt: new Date(attemptAt + 1_000).toISOString(),
          metadata: { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: 502, larkErrorCode: "2200" }
        })).toBe("stale");
      }
      const outcome = store.preparedDeliveries.failConversationPageDelivery(claim, {
        error: `timeout outcome unknown ${attempt}`, retryAt: new Date(attemptAt + 1_000).toISOString(),
        metadata: { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: 502, larkErrorCode: "2200" }
      });
      const reply = store.getOutboundReply(delivery.replyId)!;
      expect(reply.attemptCount).toBe(attempt);
      if (attempt < 3) {
        expect(outcome).toBe("retry");
        expect(reply).toMatchObject({ state: "pending", effectCertainty: "uncertain", httpStatus: 502, larkErrorCode: "2200" });
        expect(store.database.prepare("SELECT 1 FROM delivery_ring_checkpoints WHERE scope_key=?")
          .get(JSON.stringify(["pane", "workspace", "pane"]))).toBeUndefined();
        attemptAt = Date.parse(reply.nextAttemptAt);
      } else {
        expect(outcome).toBe("dead_letter");
        expect(reply).toMatchObject({
          state: "dismissed", attemptCount: 3, error: "timeout outcome unknown 3",
          failureClass: "unknown", effectCertainty: "uncertain", httpStatus: 502, larkErrorCode: "2200"
        });
      }
    }

    expect(finalClaim).not.toBeNull();
    expect(store.preparedDeliveries.failConversationPageDelivery(finalClaim!, {
      error: "late failure", retryAt: "2098-10-06T00:10:00.000Z",
      metadata: { failureClass: "permanent", effectCertainty: "uncertain", httpStatus: 400, larkErrorCode: "late" }
    })).toBe("stale");
    expect(store.preparedDeliveries.checkpointConversationPageDelivery(finalClaim!, {
      kind: "surface", ref: { gatewayId: delivery.gatewayId, kind: "surface", opaqueId: "late-card" }
    })).toBe(false);
    expect(store.preparedDeliveries.acknowledgeConversationPageDelivery(finalClaim!, {
      messageId: "late-message", surfaceId: "late-card", threadId: null
    })).toBe(false);
    expect(store.preparedDeliveries.hydratePreparedDelivery(delivery.replyId)).toEqual({ status: "missing" });
    expect(store.preparedDeliveries.claimConversationPageDelivery({
      delivery, at: "2098-10-06T00:05:00.000Z", expiresAt: "2098-10-06T00:06:00.000Z"
    })).toBeNull();
    expect(store.database.prepare("SELECT state,action FROM delivery_recoveries WHERE failed_reply_id=?")
      .get(delivery.replyId)).toEqual({ state: "dismissed", action: "dismiss_attempt_budget" });
    expect(store.database.prepare("SELECT state,action FROM outbox_lane_quarantines WHERE failed_reply_id=?").get(delivery.replyId)).toBeUndefined();
    expect(store.database.prepare(`SELECT state,pending_reply_id,pending_cursor_json
      FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0`).get()).toEqual({
      state: "finished", pending_reply_id: null, pending_cursor_json: null
    });
    expect(store.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?")
      .get(JSON.stringify(["pane", "workspace", "pane"]))).toEqual({ committed_delivery_order: delivery.deliveryOrder });

    const sameClaim = store.preparedDeliveries.claimPreparedDelivery({
      delivery: sameConflict, at: "2098-10-06T00:05:00.000Z", expiresAt: "2098-10-06T00:06:00.000Z"
    });
    expect(sameClaim).toMatchObject({ replyId: sameConflict.replyId });
    expect(store.preparedDeliveries.acknowledgePreparedDelivery(sameClaim!, {
      messageId: "same-conflict-message", surfaceId: null, threadId: null
    })).toBe(true);
    const differentClaim = store.preparedDeliveries.claimPreparedDelivery({
      delivery: differentConflict, at: "2098-10-06T00:05:01.000Z", expiresAt: "2098-10-06T00:06:01.000Z"
    });
    expect(differentClaim).toMatchObject({ replyId: differentConflict.replyId });
    bundle.lifecycle.close();
  });

  it("bounds an uncertain Turn Card update to three attempts before terminal dismissal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2098-10-06T00:00:00.000Z"));
    const { bundle, store, delivery: createDelivery } = canonicalTurnCard();
    const createClaim = store.preparedDeliveries.claimConversationPageDelivery({
      delivery: createDelivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z"
    })!;
    expect(store.preparedDeliveries.acknowledgeConversationPageDelivery(createClaim, {
      messageId: "turn-card-root", surfaceId: "turn-card-surface", threadId: null
    })).toBe(true);
    const segments = store.capabilityModules().conversationSegments;
    expect(segments.reserveSnapshot({
      segmentId: "segment", pageIndex: 0, messageId: "turn-card-root", elementId: "turn-card:segment:page:0",
      card: {}, cursor: null, viewVersion: 3
    })).toBe("reserved");
    const update = store.listPendingOutboundReplies().find((reply) => reply.kind === "card_update")!;
    const checkpointScopeKey = JSON.stringify(["pane", "workspace", "pane"]);
    const initialHydrated = store.preparedDeliveries.hydratePreparedDelivery(update.id);
    if (initialHydrated.status !== "prepared") throw new Error(`expected prepared update seed, received ${initialHydrated.status}`);
    const updateDelivery = initialHydrated.delivery;
    let attemptAt = Date.parse("2098-10-06T00:00:02.000Z");
    const observedDelays: number[] = [];
    let finalClaim: ReturnType<typeof store.preparedDeliveries.claimConversationPageDelivery> = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      vi.setSystemTime(attemptAt);
      const hydrated = store.preparedDeliveries.hydratePreparedDelivery(update.id);
      if (hydrated.status !== "prepared") throw new Error(`expected prepared update ${attempt}, received ${hydrated.status}`);
      const at = new Date(attemptAt).toISOString();
      const claim = store.preparedDeliveries.claimConversationPageDelivery({
        delivery: hydrated.delivery, at, expiresAt: new Date(attemptAt + 60_000).toISOString()
      });
      if (!claim) throw new Error(`expected update claim ${attempt}`);
      finalClaim = claim;
      const outcome = store.preparedDeliveries.failConversationPageDelivery(claim, {
        error: `CardKit 500 attempt ${attempt}`, retryAt: new Date(attemptAt + 1_000).toISOString(),
        metadata: { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: 500, larkErrorCode: "2200" }
      });
      const reply = store.getOutboundReply(update.id)!;
      expect(reply.attemptCount).toBe(attempt);
      if (attempt < 3) {
        expect(outcome).toBe("retry");
        expect(reply).toMatchObject({
          state: "pending", error: `CardKit 500 attempt ${attempt}`, failureClass: "unknown",
          effectCertainty: "uncertain", httpStatus: 500, larkErrorCode: "2200"
        });
        expect(store.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get(checkpointScopeKey))
          .toEqual({ committed_delivery_order: createDelivery.deliveryOrder });
        observedDelays.push(Date.parse(reply.nextAttemptAt) - attemptAt);
        attemptAt = Date.parse(reply.nextAttemptAt);
      } else {
        expect(outcome).toBe("dead_letter");
        expect(reply).toMatchObject({
          state: "dismissed", attemptCount: 3, error: "CardKit 500 attempt 3", failureClass: "unknown",
          effectCertainty: "uncertain", httpStatus: 500, larkErrorCode: "2200"
        });
      }
    }
    expect(observedDelays).toEqual([1_000, 2_000]);
    expect(finalClaim).not.toBeNull();
    expect(store.preparedDeliveries.failConversationPageDelivery(finalClaim!, {
      error: "late update failure", retryAt: "2098-10-06T00:10:00.000Z",
      metadata: { failureClass: "permanent", effectCertainty: "uncertain", httpStatus: 400, larkErrorCode: "late" }
    })).toBe("stale");
    expect(store.preparedDeliveries.hydratePreparedDelivery(update.id)).toEqual({ status: "missing" });
    expect(store.preparedDeliveries.claimConversationPageDelivery({
      delivery: updateDelivery, at: "2098-10-06T00:05:00.000Z", expiresAt: "2098-10-06T00:06:00.000Z"
    })).toBeNull();
    expect(store.database.prepare("SELECT state,action FROM delivery_recoveries WHERE failed_reply_id=?").get(update.id))
      .toEqual({ state: "dismissed", action: "dismiss_attempt_budget" });
    expect(store.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE failed_reply_id=?").get(update.id)).toBeUndefined();
    expect(store.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get(checkpointScopeKey))
      .toEqual({ committed_delivery_order: updateDelivery.deliveryOrder });
    expect(store.database.prepare(`SELECT state,pending_reply_id,pending_cursor_json
      FROM conversation_segment_pages WHERE segment_id='segment' AND page_index=0`).get()).toEqual({
      state: "active", pending_reply_id: null, pending_cursor_json: null
    });
    expect(segments.reconcilePageDelivery("segment", 0)).toBe("ready");
    expect(segments.reserveSnapshot({
      segmentId: "segment", pageIndex: 0, messageId: "turn-card-root", elementId: "turn-card:segment:page:0",
      card: {}, cursor: null, viewVersion: 4
    })).toBe("reserved");
    const successor = store.database.prepare(`SELECT pending_reply_id FROM conversation_segment_pages
      WHERE segment_id='segment' AND page_index=0`).get() as { pending_reply_id: string };
    expect(successor.pending_reply_id).not.toBe(update.id);
    expect(store.preparedDeliveries.hydratePreparedDelivery(successor.pending_reply_id).status).toBe("prepared");
    bundle.lifecycle.close();
  });

  it("bounds safe transient Turn Card retries with shared exponential backoff", () => {
    vi.useFakeTimers();
    const { bundle, store, delivery } = canonicalTurnCard();
    let attemptAt = Date.parse("2098-10-06T00:00:01.000Z");
    const observedDelays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      vi.setSystemTime(attemptAt);
      const hydrated = store.preparedDeliveries.hydratePreparedDelivery(delivery.replyId);
      if (hydrated.status !== "prepared") throw new Error(`expected prepared retry, received ${hydrated.status}`);
      const at = new Date(attemptAt).toISOString();
      const claim = store.preparedDeliveries.claimConversationPageDelivery({
        delivery: hydrated.delivery, at, expiresAt: new Date(attemptAt + 60_000).toISOString()
      });
      if (!claim) throw new Error(`expected claim for attempt ${attempt}`);
      const outcome = store.preparedDeliveries.failConversationPageDelivery(claim, {
        error: "provider temporarily unavailable",
        retryAt: new Date(attemptAt + 1_000).toISOString(),
        metadata: { failureClass: "transient", effectCertainty: "not-started", httpStatus: 503, larkErrorCode: null }
      });
      const reply = store.getOutboundReply(delivery.replyId)!;
      expect(reply.attemptCount).toBe(attempt);
      if (attempt < 3) {
        expect(outcome).toBe("retry");
        expect(reply.state).toBe("pending");
        observedDelays.push(Date.parse(reply.nextAttemptAt) - attemptAt);
        attemptAt = Date.parse(reply.nextAttemptAt);
      } else {
        expect(outcome).toBe("dead_letter");
        expect(reply).toMatchObject({ state: "dismissed", failureClass: "transient", effectCertainty: "not-started" });
      }
    }
    expect(observedDelays).toEqual([1_000, 2_000]);
    expect(store.database.prepare("SELECT state,lane_class,failure_class FROM outbox_lane_quarantines WHERE failed_reply_id=?")
      .get(delivery.replyId)).toBeUndefined();
    bundle.lifecycle.close();
  });

  it("rolls back the Turn Card ACK, provider checkpoint, and delivery checkpoint together", () => {
    const { bundle, store, delivery } = canonicalTurnCard();
    const claim = store.preparedDeliveries.claimConversationPageDelivery({ delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z" });
    if (!claim) throw new Error("expected claim");
    store.database.exec("CREATE TEMP TRIGGER reject_delivery_checkpoint BEFORE INSERT ON delivery_ring_checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoint rollback'); END;");

    expect(() => store.preparedDeliveries.acknowledgeConversationPageDelivery(claim, { messageId: "message", surfaceId: "card", threadId: null })).toThrow("checkpoint rollback");
    expect(store.getOutboundReply(delivery.replyId)).toMatchObject({ state: "pending", deliveredMessageId: null, cardIdCheckpoint: null, gatewayCheckpointJson: null });
    expect(store.database.prepare("SELECT 1 FROM delivery_ring_checkpoints WHERE scope_key=?").get(JSON.stringify(["pane", "workspace", "pane"]))).toBeUndefined();
    bundle.lifecycle.close();
  });

  it("keeps the checkpoint unchanged when a competing stale ACK loses its fence", () => {
    const { bundle, store, delivery } = canonicalTurnCard();
    const claim = store.preparedDeliveries.claimConversationPageDelivery({ delivery, at: "2098-10-06T00:00:01.000Z", expiresAt: "2098-10-06T00:01:01.000Z" });
    if (!claim) throw new Error("expected claim");
    expect(store.preparedDeliveries.acknowledgeConversationPageDelivery(claim, { messageId: "message", surfaceId: "card", threadId: null })).toBe(true);
    const scopeKey = JSON.stringify(["pane", "workspace", "pane"]);
    const committed = store.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get(scopeKey);

    expect(store.preparedDeliveries.acknowledgeConversationPageDelivery(claim, { messageId: "late-message", surfaceId: "late-card", threadId: null })).toBe(false);
    expect(store.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get(scopeKey)).toEqual(committed);
    bundle.lifecycle.close();
  });

  it("uses four global permits while serializing two effects in one Ring", async () => {
    const { bundle, delivery } = canonicalTurnCard();
    bundle.lifecycle.close();
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const gateway = {
      prepare: vi.fn(),
      execute: vi.fn(async (_plan, context) => {
        started.push(context.idempotencyKey);
        await new Promise<void>((resolve) => releases.set(context.idempotencyKey, resolve));
        return { refs: [{ kind: "message" as const, opaqueId: `message-${context.idempotencyKey}` }] };
      })
    };
    const store = {
      recoverExpiredRingClaims: vi.fn(() => []),
      recoverQuarantinedRingHeads: vi.fn(() => ({ transitionedScopeKeys: [], nextCursor: null })),
      claimConversationPageDelivery: vi.fn(({ delivery: candidate }) => ({ replyId: candidate.replyId, attemptId: `claim-${candidate.replyId}`, ownerId: "owner", fencingToken: 1, planHash: candidate.planHash, snapshotRevision: candidate.snapshotRevision })),
      advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const })),
      checkpointConversationPageDelivery: vi.fn(() => true), acknowledgeConversationPageDelivery: vi.fn(() => true), failConversationPageDelivery: vi.fn(() => "retry")
    };
    const engine = new RingDeliveryEngine({ store: store as never, gateway, coldRecoveryEnabled: false });
    const item = (id: string, paneId: string, order: number): PreparedDelivery => ({ ...delivery, replyId: id, idempotencyKey: id, scope: { kind: "pane", workspaceId: "workspace", paneId }, deliveryOrder: order, planHash: `hash-${id}` });
    engine.start();
    for (const candidate of [item("a1", "a", 1), item("a2", "a", 2), item("b1", "b", 1), item("c1", "c", 1), item("d1", "d", 1)]) engine.enqueue(candidate);
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started).toEqual(expect.arrayContaining(["a1", "b1", "c1", "d1"]));
    expect(started).not.toContain("a2");
    for (const id of ["a1", "b1", "c1", "d1"]) releases.get(id)!();
    await vi.waitFor(() => expect(started).toContain("a2"));
    releases.get("a2")!();
    await engine.stop();
  });

  it("renews an active claim beyond its original TTL and stops the heartbeat after settlement", async () => {
    const { bundle, delivery } = canonicalTurnCard();
    bundle.lifecycle.close();
    const startedAt = Date.parse(delivery.nextAttemptAt);
    let now = startedAt;
    let nextTimer = 0;
    const timers = new Map<number, () => void>();
    let release: (() => void) | undefined;
    const execute = vi.fn(async () => new Promise<{ refs: Array<{ kind: "message"; opaqueId: string }> }>((resolve) => {
      release = () => resolve({ refs: [{ kind: "message", opaqueId: "slow-message" }] });
    }));
    const claim = { replyId: delivery.replyId, attemptId: "slow-claim", ownerId: "owner", fencingToken: 1, planHash: delivery.planHash, snapshotRevision: delivery.snapshotRevision };
    const store = {
      recoverExpiredRingClaims: vi.fn(() => []),
      recoverQuarantinedRingHeads: vi.fn(() => ({ transitionedScopeKeys: [], nextCursor: null })),
      advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const })),
      claimConversationPageDelivery: vi.fn(() => claim),
      renewPreparedDeliveryClaim: vi.fn(() => true),
      checkpointConversationPageDelivery: vi.fn(() => true),
      acknowledgeConversationPageDelivery: vi.fn(() => true),
      failConversationPageDelivery: vi.fn(() => "stale" as const)
    };
    const cancelWake = vi.fn((handle: number) => { timers.delete(handle); });
    const engine = new RingDeliveryEngine({
      store: store as never,
      gateway: { prepare: vi.fn(), execute },
      coldRecoveryEnabled: false,
      claimTtlMs: 100,
      now: () => now,
      scheduleWake: (callback) => { const handle = ++nextTimer; timers.set(handle, callback); return handle; },
      cancelWake
    });

    engine.start();
    engine.enqueue(delivery);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    now += 50;
    timers.get(1)!();
    expect(store.renewPreparedDeliveryClaim).toHaveBeenLastCalledWith({
      claim,
      at: new Date(startedAt + 50).toISOString(),
      expiresAt: new Date(startedAt + 150).toISOString()
    });
    now += 75;
    timers.get(2)!();
    expect(store.renewPreparedDeliveryClaim).toHaveBeenCalledTimes(2);
    release!();
    await vi.waitFor(() => expect(store.acknowledgeConversationPageDelivery).toHaveBeenCalledWith(claim, expect.any(Object)));
    expect(execute).toHaveBeenCalledOnce();
    expect(cancelWake).toHaveBeenCalledWith(3);
    await engine.stop();
  });

  it("fences a late Gateway settlement after renewal loses its claim without replaying the effect", async () => {
    const { bundle, delivery } = canonicalTurnCard();
    bundle.lifecycle.close();
    let now = Date.parse(delivery.nextAttemptAt);
    let renewal: (() => void) | undefined;
    let release: (() => void) | undefined;
    const execute = vi.fn(async () => new Promise<{ refs: Array<{ kind: "message"; opaqueId: string }> }>((resolve) => {
      release = () => resolve({ refs: [{ kind: "message", opaqueId: "late-message" }] });
    }));
    const claim = { replyId: delivery.replyId, attemptId: "lost-claim", ownerId: "owner", fencingToken: 1, planHash: delivery.planHash, snapshotRevision: delivery.snapshotRevision };
    const store = {
      recoverExpiredRingClaims: vi.fn(() => []),
      recoverQuarantinedRingHeads: vi.fn(() => ({ transitionedScopeKeys: [], nextCursor: null })),
      advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const })),
      claimConversationPageDelivery: vi.fn(() => claim),
      renewPreparedDeliveryClaim: vi.fn(() => false),
      checkpointConversationPageDelivery: vi.fn(() => true),
      acknowledgeConversationPageDelivery: vi.fn(() => true),
      failConversationPageDelivery: vi.fn(() => "stale" as const)
    };
    const engine = new RingDeliveryEngine({
      store: store as never,
      gateway: { prepare: vi.fn(), execute },
      coldRecoveryEnabled: false,
      claimTtlMs: 100,
      now: () => now,
      scheduleWake: (callback) => { renewal = callback; return 1; },
      cancelWake: vi.fn()
    });

    engine.start();
    engine.enqueue(delivery);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    now += 50;
    renewal!();
    release!();
    await vi.waitFor(() => expect(store.failConversationPageDelivery).toHaveBeenCalledOnce());
    expect(store.renewPreparedDeliveryClaim).toHaveBeenCalledOnce();
    expect(store.acknowledgeConversationPageDelivery).not.toHaveBeenCalled();
    expect(store.failConversationPageDelivery).toHaveBeenCalledWith(claim, expect.objectContaining({
      error: "ring_claim_renewal_uncertain",
      metadata: expect.objectContaining({ effectCertainty: "uncertain" })
    }));
    expect(execute).toHaveBeenCalledOnce();
    await engine.stop();
  });

  it("keeps the same reply runnable after a transient retry is rehydrated before permit release", async () => {
    const { bundle, delivery } = canonicalTurnCard();
    bundle.lifecycle.close();
    let loadCount = 0;
    const refill = {
      load: vi.fn(async () => ({ deliveries: ++loadCount === 2 ? [delivery] : [], nextRetryAt: null, nextPageToken: null })),
      isDurablyEmpty: vi.fn(async () => false)
    };
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("temporary provider failure"))
      .mockResolvedValueOnce({ refs: [{ kind: "message" as const, opaqueId: "message" }] });
    let claimCount = 0;
    const store = {
      recoverExpiredRingClaims: vi.fn(() => []),
      recoverQuarantinedRingHeads: vi.fn(() => ({ transitionedScopeKeys: [], nextCursor: null })),
      claimConversationPageDelivery: vi.fn(({ delivery: candidate }) => ({
        replyId: candidate.replyId, attemptId: `claim-${++claimCount}`,
        ownerId: "owner", fencingToken: 1, planHash: candidate.planHash, snapshotRevision: candidate.snapshotRevision
      })),
      advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const })),
      checkpointConversationPageDelivery: vi.fn(() => true),
      acknowledgeConversationPageDelivery: vi.fn(() => true),
      failConversationPageDelivery: vi.fn(() => "retry" as const)
    };
    const engine = new RingDeliveryEngine({
      store: store as never,
      gateway: { prepare: vi.fn(), execute },
      refill,
      coldRecoveryEnabled: true
    });

    engine.start();
    await engine.whenRecoveryReady();
    engine.enqueue(delivery);

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(store.failConversationPageDelivery).toHaveBeenCalledOnce();
    expect(store.claimConversationPageDelivery).toHaveBeenCalledTimes(2);
    await engine.stop();
  });

  it("preserves provider recovery metadata when Ring delivery fails", async () => {
    const { bundle, delivery } = canonicalTurnCard();
    bundle.lifecycle.close();
    const failConversationPageDelivery = vi.fn(() => "dead_letter" as const);
    const store = {
      claimConversationPageDelivery: vi.fn(({ delivery: candidate }) => ({
        replyId: candidate.replyId, attemptId: "claim", ownerId: "owner", fencingToken: 1,
        planHash: candidate.planHash, snapshotRevision: candidate.snapshotRevision
      })),
      advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const })),
      checkpointConversationPageDelivery: vi.fn(() => true),
      acknowledgeConversationPageDelivery: vi.fn(() => true),
      failConversationPageDelivery
    };
    const failure = {
      failureClass: "permanent" as const, effectCertainty: "rejected" as const,
      httpStatus: null, providerCode: "300317", providerOperation: "update_cardkit",
      recoveryKind: "stale_main_card" as const, safeMessage: "stale Main Card"
    };
    const engine = new RingDeliveryEngine({
      store: store as never,
      gateway: { prepare: vi.fn(), execute: vi.fn(async () => { throw new GatewayDeliveryError(failure); }) },
      coldRecoveryEnabled: false
    });
    engine.start();
    engine.enqueue(delivery);

    await vi.waitFor(() => expect(failConversationPageDelivery).toHaveBeenCalledOnce());
    expect(failConversationPageDelivery).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      error: failure.safeMessage,
      metadata: expect.objectContaining({
        failureClass: failure.failureClass,
        effectCertainty: failure.effectCertainty,
        larkErrorCode: failure.providerCode,
        recoveryKind: failure.recoveryKind,
        providerOperation: failure.providerOperation
      })
    }));
    await engine.stop();
  });

  it("discards stale cached objects and refills after the store safely advances a superseded head", async () => {
    const { bundle, delivery } = canonicalTurnCard();
    bundle.lifecycle.close();
    const successor = { ...delivery, replyId: "successor", idempotencyKey: "successor", deliveryOrder: delivery.deliveryOrder + 1, snapshotRevision: delivery.snapshotRevision + 1, planHash: "successor-hash" };
    const refill = {
      load: vi.fn(async () => ({ deliveries: [successor], nextRetryAt: null })),
      isDurablyEmpty: vi.fn(async () => false)
    };
    const gateway = { prepare: vi.fn(), execute: vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] })) };
    const store = {
      claimConversationPageDelivery: vi.fn(({ delivery: candidate }) => candidate.replyId === delivery.replyId ? null : ({
        replyId: candidate.replyId, attemptId: "successor-claim", ownerId: "owner", fencingToken: 1,
        planHash: candidate.planHash, snapshotRevision: candidate.snapshotRevision
      })),
      advanceSupersededHead: vi.fn(({ delivery: candidate }) => candidate.replyId === delivery.replyId
        ? { outcome: "advanced" as const, scopeKey: '["pane","workspace","pane"]', replacementReplyId: successor.replyId }
        : { outcome: "blocked" as const }),
      checkpointConversationPageDelivery: vi.fn(() => true), acknowledgeConversationPageDelivery: vi.fn(() => true), failConversationPageDelivery: vi.fn(() => "retry" as const)
    };
    const engine = new RingDeliveryEngine({ store: store as never, gateway, refill, coldRecoveryEnabled: false });
    engine.start();
    engine.enqueue(delivery);
    engine.enqueue(successor);

    await vi.waitFor(() => expect(gateway.execute).toHaveBeenCalledOnce());
    expect(store.advanceSupersededHead).toHaveBeenCalledWith({ delivery, at: expect.any(String) });
    expect(refill.load).toHaveBeenCalledWith({ scope: delivery.scope, limit: 4, now: expect.any(String), pageToken: null });
    expect(gateway.execute.mock.calls[0]![0]).toEqual(successor.preparedPlan);
    await engine.stop();
  });

  it("advances a safely superseded claimable head before gateway execution", async () => {
    const { bundle, delivery } = canonicalTurnCard();
    bundle.lifecycle.close();
    const successor = { ...delivery, replyId: "successor", idempotencyKey: "successor", deliveryOrder: delivery.deliveryOrder + 1, snapshotRevision: delivery.snapshotRevision + 1, planHash: "successor-hash" };
    const refill = {
      load: vi.fn(async () => ({ deliveries: [successor], nextRetryAt: null, nextPageToken: null })),
      isDurablyEmpty: vi.fn(async () => false)
    };
    const gateway = { prepare: vi.fn(), execute: vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] })) };
    const store = {
      claimConversationPageDelivery: vi.fn(({ delivery: candidate }) => ({
        replyId: candidate.replyId, attemptId: `claim-${candidate.replyId}`, ownerId: "owner", fencingToken: 1,
        planHash: candidate.planHash, snapshotRevision: candidate.snapshotRevision
      })),
      advanceSupersededHead: vi.fn(({ delivery: candidate }) => candidate.replyId === delivery.replyId
        ? { outcome: "advanced" as const, scopeKey: '["pane","workspace","pane"]', replacementReplyId: successor.replyId }
        : { outcome: "blocked" as const }),
      checkpointConversationPageDelivery: vi.fn(() => true), acknowledgeConversationPageDelivery: vi.fn(() => true), failConversationPageDelivery: vi.fn(() => "retry" as const)
    };
    const engine = new RingDeliveryEngine({ store: store as never, gateway, refill, coldRecoveryEnabled: false });
    engine.start();
    engine.enqueue(delivery);

    await vi.waitFor(() => expect(gateway.execute).toHaveBeenCalledOnce());
    expect(store.advanceSupersededHead).toHaveBeenCalledWith({ delivery, at: expect.any(String) });
    expect(store.claimConversationPageDelivery).not.toHaveBeenCalledWith(expect.objectContaining({ delivery }));
    expect(gateway.execute.mock.calls[0]![0]).toEqual(successor.preparedPlan);
    await engine.stop();
  });

  it("requeues a successor discovered after the active head is acknowledged", async () => {
    const { bundle, delivery } = canonicalTurnCard();
    bundle.lifecycle.close();
    const successor = { ...delivery, replyId: "successor", idempotencyKey: "successor", deliveryOrder: delivery.deliveryOrder + 1, snapshotRevision: delivery.snapshotRevision + 1, planHash: "successor-hash" };
    let loadCount = 0;
    const refill = {
      load: vi.fn(async () => ({ deliveries: loadCount++ === 0 ? [] : loadCount === 2 ? [successor] : [], nextRetryAt: null, nextPageToken: null })),
      isDurablyEmpty: vi.fn(async () => false)
    };
    const executed: string[] = [];
    const store = {
      recoverExpiredRingClaims: vi.fn(() => []),
      recoverQuarantinedRingHeads: vi.fn(() => ({ transitionedScopeKeys: [], nextCursor: null })),
      claimConversationPageDelivery: vi.fn(({ delivery: candidate }) => ({ replyId: candidate.replyId, attemptId: `claim-${candidate.replyId}`, ownerId: "owner", fencingToken: 1, planHash: candidate.planHash, snapshotRevision: candidate.snapshotRevision })),
      advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const })),
      checkpointConversationPageDelivery: vi.fn(() => true), acknowledgeConversationPageDelivery: vi.fn(() => true), failConversationPageDelivery: vi.fn(() => "retry" as const)
    };
    const engine = new RingDeliveryEngine({
      store: store as never,
      gateway: { prepare: vi.fn(), execute: vi.fn(async (_plan, context) => { executed.push(context.idempotencyKey); return { refs: [{ kind: "message" as const, opaqueId: `message-${context.idempotencyKey}` }] }; }) },
      refill, coldRecoveryEnabled: true
    });

    engine.start();
    await engine.whenRecoveryReady();
    engine.enqueue(delivery);

    await vi.waitFor(() => expect(executed).toEqual([delivery.idempotencyKey, successor.idempotencyKey]));
    expect(engine.snapshot()).toMatchObject({ runnableRings: 0, activeDeliveries: 0, cachedItems: 0 });
    await engine.stop();
  });

  it("requeues a successor discovered after an unclaimable head is discarded", async () => {
    const { bundle, delivery } = canonicalTurnCard();
    const trace = bundle.driver.capabilityModules().deliveryTrace;
    bundle.lifecycle.close();
    const successor = { ...delivery, replyId: "successor", idempotencyKey: "successor", deliveryOrder: delivery.deliveryOrder + 1, snapshotRevision: delivery.snapshotRevision + 1, planHash: "successor-hash" };
    let loadCount = 0;
    const refill = {
      load: vi.fn(async () => ({ deliveries: loadCount++ === 0 ? [] : loadCount === 2 ? [successor] : [], nextRetryAt: null, nextPageToken: null })),
      isDurablyEmpty: vi.fn(async () => false)
    };
    const execute = vi.fn(async (_plan, context) => ({ refs: [{ kind: "message" as const, opaqueId: `message-${context.idempotencyKey}` }] }));
    const store = {
      recoverExpiredRingClaims: vi.fn(() => []),
      recoverQuarantinedRingHeads: vi.fn(() => ({ transitionedScopeKeys: [], nextCursor: null })),
      claimConversationPageDelivery: vi.fn(({ delivery: candidate }) => candidate.replyId === delivery.replyId ? null : ({ replyId: candidate.replyId, attemptId: `claim-${candidate.replyId}`, ownerId: "owner", fencingToken: 1, planHash: candidate.planHash, snapshotRevision: candidate.snapshotRevision })),
      advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const })),
      checkpointConversationPageDelivery: vi.fn(() => true), acknowledgeConversationPageDelivery: vi.fn(() => true), failConversationPageDelivery: vi.fn(() => "retry" as const)
    };
    const engine = new RingDeliveryEngine({ store: store as never, gateway: { prepare: vi.fn(), execute }, refill, coldRecoveryEnabled: true, deliveryTrace: trace });

    engine.start();
    await engine.whenRecoveryReady();
    engine.enqueue(delivery);

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]![1]).toMatchObject({ idempotencyKey: successor.idempotencyKey });
    expect(engine.snapshot()).toMatchObject({ runnableRings: 0, activeDeliveries: 0, cachedItems: 0 });
    expect(trace.snapshot().diagnostics.staleAttempts).toBe(1);
    await engine.stop();
  });

  it("rechecks an unclaimable head after permit release without hot-looping once durable refill is empty", async () => {
    const { bundle, delivery } = canonicalTurnCard();
    bundle.lifecycle.close();
    let maintenanceWake: (() => void) | null = null;
    let loadCount = 0;
    const refill = {
      load: vi.fn(async () => ({ deliveries: ++loadCount === 2 ? [delivery] : [], nextRetryAt: null, nextPageToken: null })),
      isDurablyEmpty: vi.fn(async () => false)
    };
    const store = {
      recoverExpiredRingClaims: vi.fn(() => []),
      recoverQuarantinedRingHeads: vi.fn(() => ({ transitionedScopeKeys: [], nextCursor: null })),
      claimConversationPageDelivery: vi.fn(() => null),
      advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const }))
    };
    const engine = new RingDeliveryEngine({
      store: store as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill, coldRecoveryEnabled: true,
      scheduleMaintenance: (callback) => { maintenanceWake = callback; return 1; },
      cancelMaintenance: vi.fn()
    });

    engine.start();
    await engine.whenRecoveryReady();
    engine.enqueue(delivery);
    await vi.waitFor(() => expect(store.claimConversationPageDelivery).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.claimConversationPageDelivery).toHaveBeenCalledOnce();
    expect(engine.snapshot()).toMatchObject({ runnableRings: 0, activeDeliveries: 0, cachedItems: 0 });

    maintenanceWake!();
    await vi.waitFor(() => expect(engine.snapshot().safetyScanRuns).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.claimConversationPageDelivery).toHaveBeenCalledOnce();
    await engine.stop();
  });

  it("releases the Ring grant when semantic preparation throws before claim", async () => {
    const work = semanticWork();
    const plan: PreparedDeliveryPlan = {
      protocolVersion: 1, gatewayId: work.gatewayId, profileId: work.gatewayProfileId, rendererRevision: 1,
      operation: "message.reply.view", intent: { kind: "message.reply.view", rootMessageId: work.rootMessageId, view: {}, idempotencyKey: work.idempotencyKey }
    };
    let failPreparation = true;
    const prepareSemanticDelivery = vi.fn(() => {
      if (failPreparation) throw new Error("preparation exploded");
      return plan;
    });
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const store = {
      freezeSemanticDelivery: vi.fn(() => ({ outcome: "prepared" as const, delivery: frozen(work, plan) })),
      advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const })),
      claimConversationPageDelivery: vi.fn(({ delivery }) => ({ replyId: delivery.replyId, attemptId: "attempt", ownerId: "owner", fencingToken: 1, planHash: delivery.planHash, snapshotRevision: delivery.snapshotRevision })),
      checkpointConversationPageDelivery: vi.fn(() => true), acknowledgeConversationPageDelivery: vi.fn(() => true), failConversationPageDelivery: vi.fn(() => "retry" as const)
    };
    const engine = new RingDeliveryEngine({
      store: store as never, gateway: { prepare: vi.fn(), execute }, coldRecoveryEnabled: false,
      prepareSemanticDelivery
    });

    engine.start();
    engine.enqueue(work);
    await vi.waitFor(() => expect(prepareSemanticDelivery).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(engine.snapshot().activeDeliveries).toBe(0));
    expect(engine.snapshot()).toMatchObject({ cachedItems: 0, runnableRings: 0 });

    failPreparation = false;
    engine.enqueue(work);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await engine.stop();
  });

  it.each(["supersession", "claim"] as const)("releases the Ring grant when %s throws before Gateway execution", async (phase) => {
    const { bundle, delivery } = canonicalTurnCard();
    bundle.lifecycle.close();
    let failBeforeEffect = true;
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const store = {
      advanceSupersededHead: vi.fn(() => {
        if (failBeforeEffect && phase === "supersession") throw new Error("supersession exploded");
        return { outcome: "blocked" as const };
      }),
      claimConversationPageDelivery: vi.fn(({ delivery: candidate }) => {
        if (failBeforeEffect && phase === "claim") throw new Error("claim exploded");
        return { replyId: candidate.replyId, attemptId: "attempt", ownerId: "owner", fencingToken: 1, planHash: candidate.planHash, snapshotRevision: candidate.snapshotRevision };
      }),
      checkpointConversationPageDelivery: vi.fn(() => true), acknowledgeConversationPageDelivery: vi.fn(() => true), failConversationPageDelivery: vi.fn(() => "retry" as const)
    };
    const engine = new RingDeliveryEngine({ store: store as never, gateway: { prepare: vi.fn(), execute }, coldRecoveryEnabled: false });

    engine.start();
    engine.enqueue(delivery);
    await vi.waitFor(() => phase === "supersession"
      ? expect(store.advanceSupersededHead).toHaveBeenCalledOnce()
      : expect(store.claimConversationPageDelivery).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(engine.snapshot().activeDeliveries).toBe(0));
    expect(engine.snapshot()).toMatchObject({ cachedItems: 0, runnableRings: 0 });

    failBeforeEffect = false;
    engine.enqueue(delivery);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await engine.stop();
  });
});
