import { describe, expect, it, vi } from "vitest";
import { TurnCardWorkflow } from "../src/coordinator/turn-card-workflow.js";
import type { ConversationSegmentStore } from "../src/domain/ports/conversation-segment.js";
import type { SessionActivityStore } from "../src/domain/ports/session-activity.js";
import { TurnCardPayloadOverflowError } from "../src/cards/turn-card.js";

function fakeStore() {
  let snapshot = 0;
  const page = { id: "s:page:0", segmentId: "s", pageIndex: 0, messageId: "m", cardId: "c", elementId: "turn-card:s:page:0", state: "active" as const, sequence: 0, deliveredSequence: 0, startCursor: null, deliveredCursor: null, pendingCursor: null, pendingReplyId: null, createdAt: "now", updatedAt: "now" };
  const view = { segmentId: "s", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "space", paneToken: null, requestText: "hello", state: "working" as const, timelineItems: [], gapWarning: null, viewVersion: 1 };
  return { store: { loadCardView: () => view, getActivePage: () => page, listConversationSegmentPages: () => [page], reconcilePageDelivery: vi.fn(() => "ready" as const), reserveSnapshot: () => { snapshot++; return "reserved" as const; }, reserveContinuation: vi.fn(() => "reserved" as const), reserveFinish: vi.fn(() => "reserved" as const), reserveLateContinuation: vi.fn(() => "reserved" as const), checkpointPage: vi.fn(() => "checkpointed" as const), listActionableConversationSegmentIds: () => ["s"] } as unknown as ConversationSegmentStore, get snapshot() { return snapshot; } };
}

describe("TurnCardWorkflow", () => {
  it("does not reserve automatic late-recovery cards when the production switch is disabled", async () => {
    const reserveLateItemRecovery = vi.fn();
    const presentation = { turnCardPage: vi.fn() };
    const store = {
      loadActiveProjection: () => ({ view: {}, page: null, pendingPage: null, latestFrozenPage: null, cursorBase: 0, localStartCursor: null, startAnchor: null, itemPositions: [] }),
      nextLateItemRecovery: vi.fn(() => ({ segmentId: "s", recoveryId: 1, partIndex: 0, item: { kind: "status", id: "late", sequence: 1, label: "late", state: "completed" }, startCursor: null, anchorMessageId: "message", projectionKey: "turn-card-late-recovery:s:recovery:1:part:0:create" })),
      reserveLateItemRecovery,
      listActionableConversationSegmentIds: () => ["s"]
    } as unknown as ConversationSegmentStore;

    await new TurnCardWorkflow(store, vi.fn(), presentation as never, 9_000, undefined, undefined, undefined, 1, false).converge("s");

    expect(store.nextLateItemRecovery).not.toHaveBeenCalled();
    expect(reserveLateItemRecovery).not.toHaveBeenCalled();
  });

  it("reserves a provider-neutral semantic snapshot before waking Ring delivery", async () => {
    const page = { id: "s:page:0", segmentId: "s", pageIndex: 0, messageId: null, cardId: null, elementId: "turn-card:s:page:0", state: "creating" as const, sequence: 0, deliveredSequence: 0, startCursor: null, deliveredCursor: null, pendingCursor: null, pendingReplyId: null, deliveryCohort:"semantic" as const };
    const view = { segmentId: "s", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "space", projectLabel: "project", tabLabel: null, paneToken: null, requestText: "hello", state: "working" as const, timelineItems: [], gapWarning: null, viewVersion: 3 };
    const reserveSemanticSnapshot = vi.fn(() => "reserved" as const);
    const store = {
      loadActiveProjection: () => ({ view, page, pendingPage: null, latestFrozenPage: null, cursorBase: 0, localStartCursor: null, startAnchor: null, itemPositions: [] }),
      reserveSemanticSnapshot,
      listActionableConversationSegmentIds: () => ["s"]
    } as unknown as ConversationSegmentStore;
    const legacy = { turnCardPage: vi.fn() };
    const snapshot = {
      schemaVersion: 1, kind: "conversation-turn-card",
      pagePlan: { policyVersion: 1, budgetProfileVersion: 7, pageIndex: 0, startCursor: null, endCursor: null, hasContinuation: false },
      presentationBudget: { encodedBytes: 9_000, elementCount: 256, actionCount: 32, profileVersion: 7 },
      presentationMeasure: { encodedBytesUpperBound: 10, elementCount: 1, actionCount: 0 }
    };
    const policy = { plannerPolicyVersion: 1, rendererPolicyVersion: 1, plan: vi.fn(() => ({ pagePlan: snapshot.pagePlan, snapshot })), measure: vi.fn(), render: vi.fn() };
    const wake = vi.fn();

    await new TurnCardWorkflow(store, wake, legacy, 9_000, undefined, undefined, policy, 7).converge("s");

    expect(reserveSemanticSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      segmentId: "s", pageIndex: 0, snapshot, viewVersion: 3,
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 7
    }));
    expect(policy.plan).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ profileVersion: 7 }));
    expect(legacy.turnCardPage).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledOnce();
  });

  it("keeps an acknowledged semantic page on semantic reservation for later revisions", async () => {
    const page={ id:"s:page:0",segmentId:"s",pageIndex:0,messageId:"message",cardId:"card",elementId:"turn-card:s:page:0",state:"active" as const,sequence:1,deliveredSequence:1,startCursor:null,deliveredCursor:null,pendingCursor:null,pendingReplyId:null,deliveryCohort:"semantic" as const };
    const view={ segmentId:"s",ownerKind:"primary" as const,ownerLabel:"Primary",spaceName:"space",projectLabel:"project",tabLabel:null,paneToken:null,requestText:"hello",state:"working" as const,timelineItems:[],gapWarning:null,viewVersion:2 };
    const reserveSemanticSnapshot=vi.fn(()=>"reserved" as const); const reserveSnapshot=vi.fn();
    const store={ loadActiveProjection:()=>({ view,page,pendingPage:null,latestFrozenPage:null,cursorBase:0,localStartCursor:null,startAnchor:null,itemPositions:[] }),reserveSemanticSnapshot,reserveSnapshot,listActionableConversationSegmentIds:()=>["s"] } as unknown as ConversationSegmentStore;
    const snapshot={ schemaVersion:1,kind:"conversation-turn-card",pagePlan:{ policyVersion:1,budgetProfileVersion:1,pageIndex:0,startCursor:null,endCursor:null,hasContinuation:false },presentationBudget:{ encodedBytes:9_000,elementCount:256,actionCount:32,profileVersion:1 },presentationMeasure:{ encodedBytesUpperBound:10,elementCount:1,actionCount:0 } };
    const policy={ plannerPolicyVersion:1,rendererPolicyVersion:1,plan:vi.fn(()=>({ pagePlan:snapshot.pagePlan,snapshot })),measure:vi.fn(),render:vi.fn() };
    const legacy={ turnCardPage:vi.fn(()=>({ card:{ schema:"2.0" },items:[],nextCursor:null })) };

    await new TurnCardWorkflow(store,vi.fn(),legacy,9_000,undefined,undefined,policy).converge("s");

    expect(reserveSemanticSnapshot).toHaveBeenCalledWith(expect.objectContaining({ segmentId:"s",pageIndex:0,messageId:"message",snapshot,viewVersion:2 }));
    expect(reserveSnapshot).not.toHaveBeenCalled();
    expect(legacy.turnCardPage).not.toHaveBeenCalled();
  });

  it("finishes a choice-bearing semantic page through a semantic snapshot", async () => {
    const page = { id: "s:page:0", segmentId: "s", pageIndex: 0, messageId: "message", cardId: "card", elementId: "turn-card:s:page:0", state: "active" as const, sequence: 2, deliveredSequence: 2, startCursor: null, deliveredCursor: null, pendingCursor: null, pendingReplyId: null, deliveryCohort: "semantic" as const };
    const view = { segmentId: "s", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "space", projectLabel: "project", tabLabel: null, paneToken: null, requestText: "hello", state: "completed" as const, timelineItems: [], gapWarning: null, viewVersion: 3 };
    const actions = { state: "available" as const, id: "actions", ownerKind: "primary-segment" as const, ownerId: "s", ownerGeneration: 1, cardMessageId: "message", mentionOpenId: "user" };
    const reserveSemanticSnapshot = vi.fn(() => "reserved" as const);
    const reserveFinish = vi.fn();
    const store = {
      loadActiveProjection: () => ({ view, page, pendingPage: null, latestFrozenPage: null, cursorBase: 0, localStartCursor: null, startAnchor: null, itemPositions: [] }),
      loadCompletionRenderState: () => ({ mentionOpenId: "user", reason: "human_review" as const, completionActions: actions }),
      preparePrimarySegmentCompletionActionSet: vi.fn(() => actions), reserveSemanticSnapshot, reserveFinish,
      listActionableConversationSegmentIds: () => ["s"]
    } as unknown as ConversationSegmentStore;
    const snapshot = { schemaVersion: 1, kind: "conversation-turn-card", pagePlan: { policyVersion: 1, budgetProfileVersion: 1, pageIndex: 0, startCursor: null, endCursor: null, hasContinuation: false }, presentationBudget: { encodedBytes: 9_000, elementCount: 256, actionCount: 32, profileVersion: 1 }, presentationMeasure: { encodedBytesUpperBound: 10, elementCount: 1, actionCount: 3 } };
    const policy = { plannerPolicyVersion: 1, rendererPolicyVersion: 1, plan: vi.fn(() => ({ pagePlan: snapshot.pagePlan, snapshot })), measure: vi.fn(), render: vi.fn() };
    const legacy = { turnCardPage: vi.fn() };

    await new TurnCardWorkflow(store, vi.fn(), legacy, 9_000, undefined, undefined, policy).converge("s");

    expect(policy.plan).toHaveBeenLastCalledWith(view, expect.anything(), expect.objectContaining({ completionActions: actions }), expect.anything());
    expect(reserveSemanticSnapshot).toHaveBeenCalledWith(expect.objectContaining({ transition: "finish", messageId: "message", snapshot }));
    expect(reserveFinish).not.toHaveBeenCalled();
    expect(legacy.turnCardPage).not.toHaveBeenCalled();
  });

  it("freezes and continues a semantic page without producing a legacy payload", async () => {
    const active = { id: "s:page:0", segmentId: "s", pageIndex: 0, messageId: "message-0", cardId: "card-0", elementId: "turn-card:s:page:0", state: "active" as const, sequence: 2, deliveredSequence: 2, startCursor: null, deliveredCursor: null, pendingCursor: null, pendingReplyId: null, deliveryCohort: "semantic" as const };
    const frozen = { ...active, state: "frozen" as const, sequence: 3, deliveredSequence: 3, deliveredCursor: { itemIndex: 1, markdownOffset: 0 } };
    const view = { segmentId: "s", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "space", projectLabel: "project", tabLabel: null, paneToken: null, requestText: "hello", state: "working" as const, timelineItems: [{ kind: "agent_message" as const, id: "answer", sequence: 1, markdown: "answer", canonicalPosition: { laneSequence: 2, itemOrdinal: 0 } }], gapWarning: null, viewVersion: 3 };
    let continued = false;
    const reserveSemanticSnapshot = vi.fn((input: { transition: string }) => { if (input.transition === "freeze") continued = true; return "reserved" as const; });
    const reserveFreeze = vi.fn();
    const reserveLateContinuation = vi.fn();
    const store = {
      loadActiveProjection: () => continued
        ? { view, page: null, pendingPage: null, latestFrozenPage: frozen, cursorBase: 1, localStartCursor: { itemIndex: 0, markdownOffset: 0 }, startAnchor: { position: { laneSequence: 2, itemOrdinal: 0 }, inclusive: false }, itemPositions: [{ laneSequence: 2, itemOrdinal: 0 }] }
        : { view, page: active, pendingPage: null, latestFrozenPage: null, cursorBase: 0, localStartCursor: null, startAnchor: null, itemPositions: [{ laneSequence: 2, itemOrdinal: 0 }] },
      reserveSemanticSnapshot, reserveFreeze, reserveLateContinuation,
      listActionableConversationSegmentIds: () => ["s"]
    } as unknown as ConversationSegmentStore;
    const policy = {
      plannerPolicyVersion: 1, rendererPolicyVersion: 1,
      plan: vi.fn((_view: unknown, page: { pageIndex: number }) => {
        const endCursor = page.pageIndex === 0 ? { itemIndex: 1, markdownOffset: 0 } : null;
        const snapshot = { schemaVersion: 1, kind: "conversation-turn-card", pagePlan: { policyVersion: 1, budgetProfileVersion: 1, pageIndex: page.pageIndex, startCursor: null, endCursor, hasContinuation: endCursor !== null }, presentationBudget: { encodedBytes: 9_000, elementCount: 256, actionCount: 32, profileVersion: 1 }, presentationMeasure: { encodedBytesUpperBound: 10, elementCount: 1, actionCount: 0 } };
        return { pagePlan: snapshot.pagePlan, snapshot };
      }), measure: vi.fn(), render: vi.fn()
    };
    const legacy = { turnCardPage: vi.fn() };
    const workflow = new TurnCardWorkflow(store, vi.fn(), legacy, 9_000, undefined, undefined, policy);

    await workflow.converge("s");
    await workflow.converge("s");

    expect(reserveSemanticSnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({ transition: "freeze", pageIndex: 0, messageId: "message-0", cursor: { itemIndex: 1, markdownOffset: 0 } }));
    expect(reserveSemanticSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({ transition: "continuation", pageIndex: 0, nextPageIndex: 1, messageId: "message-0", nextStartCursor: frozen.deliveredCursor }));
    expect(reserveFreeze).not.toHaveBeenCalled();
    expect(reserveLateContinuation).not.toHaveBeenCalled();
    expect(legacy.turnCardPage).not.toHaveBeenCalled();
  });

  it("records shadow parity while reserving only the legacy Gateway effect", async () => {
    const page = { id:"s:page:0",segmentId:"s",pageIndex:0,messageId:null,cardId:null,elementId:"turn-card:s:page:0",state:"creating" as const,sequence:0,deliveredSequence:0,startCursor:null,deliveredCursor:null,pendingCursor:null,pendingReplyId:null,deliveryCohort:"legacy" as const };
    const view = { segmentId:"s",ownerKind:"primary" as const,ownerLabel:"Primary",spaceName:"space",projectLabel:"project",tabLabel:null,paneToken:null,requestText:"hello",state:"working" as const,timelineItems:[],gapWarning:null,viewVersion:3 };
    const reserveSnapshot=vi.fn(()=>"reserved" as const); const reserveSemanticSnapshot=vi.fn(()=>"reserved" as const); const recordSemanticDeliveryShadowEvidence=vi.fn();
    const delivery = { deliveryTarget:{kind:"card_reply",identityFingerprint:"target"},scopeOrder:{scopeFingerprint:"scope",ownerFingerprint:"owner",orderingIdentityFingerprint:"order"},idempotencyFingerprint:"idempotency",canonicalPageInterval:{pageIndex:0,startCursor:null,endCursor:null,hasContinuation:false} };
    const store={ loadActiveProjection:()=>({ view,page,pendingPage:null,latestFrozenPage:null,cursorBase:0,localStartCursor:null,startAnchor:null,itemPositions:[] }),reserveSnapshot,reserveSemanticSnapshot,
      previewSemanticShadowDelivery:vi.fn(()=>delivery),loadLegacyShadowDelivery:vi.fn(()=>delivery),
      getSemanticDeliveryRolloutPhase:()=>"shadow" as const,recordSemanticDeliveryShadowEvidence,listActionableConversationSegmentIds:()=>["s"] } as unknown as ConversationSegmentStore;
    const legacy={ turnCardPage:vi.fn(()=>({ card:{ schema:"2.0" },items:[],nextCursor:null })) };
    const snapshot={ schemaVersion:1,kind:"conversation-turn-card",pagePlan:{ policyVersion:1,budgetProfileVersion:1,pageIndex:0,startCursor:null,endCursor:null,hasContinuation:false },presentationBudget:{ encodedBytes:9_000,elementCount:256,actionCount:32,profileVersion:1 },presentationMeasure:{ encodedBytesUpperBound:10,elementCount:1,actionCount:0 } };
    const parity = { visibleStructureFingerprint:"same",deliveryTarget:{kind:"card_reply",identityFingerprint:"target"},scopeOrder:{scopeFingerprint:"scope",ownerFingerprint:"owner",orderingIdentityFingerprint:"order"},idempotencyFingerprint:"idempotency",canonicalPageInterval:{pageIndex:0,startCursor:null,endCursor:null,hasContinuation:false},committedBounds:{encodedBytes:10,elementCount:1,actionCount:0},recomputedBounds:{encodedBytes:10,elementCount:1,actionCount:0} };
    const policy={ plannerPolicyVersion:1,rendererPolicyVersion:1,plan:vi.fn(()=>({ pagePlan:snapshot.pagePlan,snapshot })),measure:vi.fn(()=>({ encodedBytesUpperBound:10,elementCount:1,actionCount:0 })),render:vi.fn(),compareLegacyPresentation:vi.fn(()=>({ legacy:parity,semantic:parity,matched:true,mismatches:[] })) };
    await new TurnCardWorkflow(store,vi.fn(),legacy,9_000,undefined,undefined,policy).converge("s");
    expect(recordSemanticDeliveryShadowEvidence).toHaveBeenCalledWith(expect.objectContaining({ matched:true }));
    expect(policy.compareLegacyPresentation).toHaveBeenCalledWith(expect.objectContaining({ legacyView:{ schema:"2.0" },semanticSnapshot:snapshot }));
    expect(reserveSnapshot).toHaveBeenCalledOnce();
    expect(reserveSnapshot.mock.invocationCallOrder[0]).toBeLessThan(recordSemanticDeliveryShadowEvidence.mock.invocationCallOrder[0]!);
    expect(reserveSemanticSnapshot).not.toHaveBeenCalled();
  });

  it("records a route-preview drift as unmatched only after the legacy reservation", async () => {
    const page = { id:"s:page:0",segmentId:"s",pageIndex:0,messageId:null,cardId:null,elementId:"turn-card:s:page:0",state:"creating" as const,sequence:0,deliveredSequence:0,startCursor:null,deliveredCursor:null,pendingCursor:null,pendingReplyId:null,deliveryCohort:"legacy" as const };
    const view = { segmentId:"s",ownerKind:"primary" as const,ownerLabel:"Primary",spaceName:"space",projectLabel:"project",tabLabel:null,paneToken:null,requestText:"hello",state:"working" as const,timelineItems:[],gapWarning:null,viewVersion:3 };
    const reserveSnapshot=vi.fn(()=>"reserved" as const); const recordSemanticDeliveryShadowEvidence=vi.fn();
    const legacyDelivery={ deliveryTarget:{kind:"card_reply",identityFingerprint:"target"},scopeOrder:{scopeFingerprint:"scope",ownerFingerprint:"owner",orderingIdentityFingerprint:"legacy-order"},idempotencyFingerprint:"idempotency",canonicalPageInterval:{pageIndex:0,startCursor:null,endCursor:null,hasContinuation:false} };
    const semanticDelivery={ ...legacyDelivery,scopeOrder:{...legacyDelivery.scopeOrder,orderingIdentityFingerprint:"semantic-drift"} };
    const store={ loadActiveProjection:()=>({ view,page,pendingPage:null,latestFrozenPage:null,cursorBase:0,localStartCursor:null,startAnchor:null,itemPositions:[] }),reserveSnapshot,
      previewSemanticShadowDelivery:vi.fn(()=>semanticDelivery),loadLegacyShadowDelivery:vi.fn(()=>legacyDelivery),
      getSemanticDeliveryRolloutPhase:()=>"shadow" as const,recordSemanticDeliveryShadowEvidence,listActionableConversationSegmentIds:()=>["s"] } as unknown as ConversationSegmentStore;
    const legacy={ turnCardPage:vi.fn(()=>({ card:{ schema:"2.0" },items:[],nextCursor:null })) };
    const snapshot={ schemaVersion:1,kind:"conversation-turn-card",pagePlan:{ policyVersion:1,budgetProfileVersion:1,pageIndex:0,startCursor:null,endCursor:null,hasContinuation:false },presentationBudget:{ encodedBytes:9_000,elementCount:256,actionCount:32,profileVersion:1 },presentationMeasure:{ encodedBytesUpperBound:10,elementCount:1,actionCount:0 } };
    const descriptor=(delivery:typeof legacyDelivery)=>({ visibleStructureFingerprint:"same",...delivery,committedBounds:{encodedBytes:10,elementCount:1,actionCount:0},recomputedBounds:{encodedBytes:10,elementCount:1,actionCount:0} });
    const policy={ plannerPolicyVersion:1,rendererPolicyVersion:1,plan:vi.fn(()=>({ pagePlan:snapshot.pagePlan,snapshot })),measure:vi.fn(),render:vi.fn(),compareLegacyPresentation:vi.fn(()=>({ legacy:descriptor(legacyDelivery),semantic:descriptor(semanticDelivery),matched:false,mismatches:["scopeOrder"] })) };

    await new TurnCardWorkflow(store,vi.fn(),legacy,9_000,undefined,undefined,policy).converge("s");

    expect(recordSemanticDeliveryShadowEvidence).toHaveBeenCalledWith(expect.objectContaining({ matched:false,details:expect.objectContaining({ mismatches:["scopeOrder"] }) }));
    expect(reserveSnapshot.mock.invocationCallOrder[0]).toBeLessThan(recordSemanticDeliveryShadowEvidence.mock.invocationCallOrder[0]!);
  });

  it("renders the bounded Session State read model only on the current page", async () => {
    const fake = fakeStore();
    const activity = {
      snapshot: {
        scopeKey: "pane:w:p", workspaceId: "w", paneId: "p", bindingId: "b", bindingGeneration: 1,
        sessionEpoch: 1, nativeSessionId: "session", revision: 1, currentModel: "GPT-5.6-Sol", currentGoal: null,
        lastTurnId: "turn", lastTurnState: "active" as const, compactionCount: 0, tokenUsage: null,
        contextUsage: null, updatedAt: "now"
      },
      items: []
    };
    const sessionState = { paneIdentity: null, modelUsage: { model: "GPT-5.6-Sol", contextRemainingPercent: null, inputTokens: null, outputTokens: null, waitMs: null, firstVisibleMs: null }, lastTurnState: "active" as const, tokenUsage: null, contextUsage: null, activeSubagents: [], compactionCount: null };
    const activityReader = { loadTurnSessionStateForCurrentSegment: vi.fn(() => sessionState) } as unknown as SessionActivityStore;
    const presentation = { turnCardPage: vi.fn(() => ({ card: { schema: "2.0" }, items: [], nextCursor: null })) };

    await new TurnCardWorkflow(fake.store, vi.fn(), presentation, 9_000, undefined, activityReader).converge("s");

    expect(activityReader.loadTurnSessionStateForCurrentSegment).toHaveBeenCalledWith("s");
    expect(presentation.turnCardPage).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      sessionState
    }), 9_000);
  });

  it("serializes concurrent convergence by segment id and is idempotent at the store boundary", async () => {
    const fake = fakeStore(); const wake = vi.fn(); const presentation = { turnCard: vi.fn(() => ({ schema: "2.0" })), turnCardPage: vi.fn(() => ({ card: { schema: "2.0" }, items: [], nextCursor: null })) };
    const workflow = new TurnCardWorkflow(fake.store, wake, presentation);
    await Promise.all([workflow.converge("s"), workflow.converge("s"), workflow.convergeActionable()]);
    expect(fake.snapshot).toBe(3); expect(presentation.turnCardPage).toHaveBeenCalled();
  });

  it("releases a recovered completion notification before requiring a renderable page", async () => {
    const wake = vi.fn();
    const store = {
      listActionableConversationSegmentIds: () => ["s"],
      recoverPrimarySegmentCompletionNotification: vi.fn(() => ({
        outcome: "released" as const, notificationReplyId: "notice-1"
      })),
      loadActiveProjection: () => null
    } as unknown as ConversationSegmentStore;

    await expect(new TurnCardWorkflow(store, wake, { turnCardPage: vi.fn() }).convergeActionable()).resolves.toEqual([]);
    expect(store.recoverPrimarySegmentCompletionNotification).toHaveBeenCalledWith("s");
    expect(wake).toHaveBeenCalledOnce();
  });

  it("propagates deterministic payload overflow without reserving delivery or replaying Agent Input", async () => {
    const fake = fakeStore(); const submit = vi.fn(() => { throw new Error("Agent Input/TraeX replay must not run"); });
    const presentation = { turnCardPage: vi.fn(() => { throw new TurnCardPayloadOverflowError(100, 101); }) };
    const workflow = new TurnCardWorkflow(fake.store, vi.fn(), presentation as never, 100);
    await expect(workflow.converge("s")).rejects.toBeInstanceOf(TurnCardPayloadOverflowError);
    expect(fake.snapshot).toBe(0); expect(submit).not.toHaveBeenCalled();
  });

  it("finalizes the current page as Completed before creating its continuation", async () => {
    const page = { id: "s:page:0", segmentId: "s", pageIndex: 0, messageId: "m", cardId: "c", elementId: "turn-card:s:page:0", state: "active" as const, sequence: 4, deliveredSequence: 4, startCursor: null, deliveredCursor: null, pendingCursor: null, pendingReplyId: null };
    const view = { segmentId: "s", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "project", projectLabel: "project", tabLabel: "tab", paneToken: "pane", requestText: "hello", state: "working" as const, timelineItems: [
      { kind: "agent_message" as const, id: "one", sequence: 1, markdown: "one", canonicalPosition: { laneSequence: 1, itemOrdinal: 0 } },
      { kind: "agent_message" as const, id: "two", sequence: 2, markdown: "two", canonicalPosition: { laneSequence: 2, itemOrdinal: 0 } },
      { kind: "agent_message" as const, id: "three", sequence: 3, markdown: "three", canonicalPosition: { laneSequence: 3, itemOrdinal: 0 } }
    ], gapWarning: null, viewVersion: 7 };
    const activityCursor = { itemIndex: 1, markdownOffset: 0 };
    const frozenCursor = { itemIndex: 2, markdownOffset: 0 };
    const reserveFreeze = vi.fn(() => "reserved" as const);
    const reserveContinuation = vi.fn(() => "reserved" as const);
    const store = {
      loadCardView: () => view, getActivePage: () => page, listConversationSegmentPages: () => [page],
      reconcilePageDelivery: vi.fn(() => "ready" as const), reserveFreeze, reserveContinuation,
      reserveSnapshot: vi.fn(), reserveFinish: vi.fn(), reserveLateContinuation: vi.fn(), checkpointPage: vi.fn(),
      listActionableConversationSegmentIds: () => ["s"]
    } as unknown as ConversationSegmentStore;
    const sessionState = { paneIdentity: null, modelUsage: { model: null, contextRemainingPercent: null, inputTokens: null, outputTokens: null, waitMs: null, firstVisibleMs: null }, lastTurnState: null, tokenUsage: null, contextUsage: null, activeSubagents: [], compactionCount: null };
    const presentation = { turnCardPage: vi.fn((cardView: typeof view, _page: unknown, options?: { sessionState?: unknown }) => ({
      card: { lifecycle: cardView.state, hasState: Boolean(options?.sessionState) }, items: [],
      nextCursor: options?.sessionState ? activityCursor : frozenCursor
    })) };
    const wake = vi.fn();

    await new TurnCardWorkflow(store, wake, presentation as never, 9_000, undefined, {
      loadTurnSessionStateForCurrentSegment: () => sessionState as never
    }).converge("s");

    expect(reserveFreeze).toHaveBeenCalledWith(expect.objectContaining({
      segmentId: "s", pageIndex: 0, messageId: "m", cardId: "c",
      elementId: "turn-card:s:page:0", cursor: frozenCursor,
      cursorAnchor: { position: { laneSequence: 3, itemOrdinal: 0 }, inclusive: true },
      card: { lifecycle: "completed", hasState: false }
    }));
    expect(presentation.turnCardPage).toHaveBeenCalledWith(view, expect.anything(), expect.objectContaining({ sessionState }), 9_000);
    expect(reserveContinuation).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledOnce();
  });

  it("freezes at the end-of-timeline cursor when only live activity overflows", async () => {
    const page = { id: "s:page:0", segmentId: "s", pageIndex: 0, messageId: "m", cardId: "c", elementId: "turn-card:s:page:0", state: "active" as const, sequence: 4, deliveredSequence: 4, startCursor: null, deliveredCursor: null, pendingCursor: null, pendingReplyId: null };
    const view = { segmentId: "s", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "project", projectLabel: "project", tabLabel: "tab", paneToken: "pane", requestText: "hello", state: "working" as const, timelineItems: [
      { kind: "agent_message" as const, id: "answer", sequence: 1, markdown: "done", canonicalPosition: { laneSequence: 7, itemOrdinal: 0 } }
    ], gapWarning: null, viewVersion: 7 };
    const reserveFreeze = vi.fn(() => "reserved" as const);
    const store = {
      loadCardView: () => view, getActivePage: () => page, listConversationSegmentPages: () => [page],
      reconcilePageDelivery: vi.fn(() => "ready" as const), reserveFreeze,
      reserveSnapshot: vi.fn(), reserveFinish: vi.fn(), reserveContinuation: vi.fn(), reserveLateContinuation: vi.fn(), checkpointPage: vi.fn(),
      listActionableConversationSegmentIds: () => ["s"]
    } as unknown as ConversationSegmentStore;
    const sessionState = { paneIdentity: null, modelUsage: { model: null, contextRemainingPercent: null, inputTokens: null, outputTokens: null, waitMs: null, firstVisibleMs: null }, lastTurnState: null, tokenUsage: null, contextUsage: null, activeSubagents: [], compactionCount: null };
    const presentation = { turnCardPage: vi.fn((_cardView: typeof view, _page: unknown, options?: { sessionState?: unknown }) => ({
      card: { hasState: Boolean(options?.sessionState) }, items: [],
      nextCursor: options?.sessionState ? { itemIndex: 1, markdownOffset: 0 } : null
    })) };

    await new TurnCardWorkflow(store, vi.fn(), presentation as never, 9_000, undefined, {
      loadTurnSessionStateForCurrentSegment: () => sessionState as never
    }).converge("s");

    expect(reserveFreeze).toHaveBeenCalledWith(expect.objectContaining({
      cursor: { itemIndex: 1, markdownOffset: 0 },
      cursorAnchor: { position: { laneSequence: 7, itemOrdinal: 0 }, inclusive: false },
      card: { hasState: false }
    }));
  });

  it("keeps the trusted completion mention off an overflow page that will be frozen", async () => {
    const page = { id: "s:page:0", segmentId: "s", pageIndex: 0, messageId: "m", cardId: "c", elementId: "turn-card:s:page:0", state: "active" as const, sequence: 4, deliveredSequence: 4, startCursor: null, deliveredCursor: null, pendingCursor: null, pendingReplyId: null };
    const view = { segmentId: "s", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "project", projectLabel: "project", tabLabel: "tab", paneToken: "pane", requestText: "hello", state: "completed" as const, timelineItems: [{ kind: "agent_message" as const, id: "answer", sequence: 1, markdown: "done", canonicalPosition: { laneSequence: 1, itemOrdinal: 0 } }], gapWarning: null, viewVersion: 7 };
    const cursor = { itemIndex: 1, markdownOffset: 0 };
    const reserveFreeze = vi.fn(() => "reserved" as const);
    const store = {
      loadCardView: () => view,
      loadCompletionRenderState: () => ({ mentionOpenId: "ou_requester" }),
      getActivePage: () => page,
      listConversationSegmentPages: () => [page],
      reconcilePageDelivery: vi.fn(() => "ready" as const),
      reserveFreeze,
      reserveSnapshot: vi.fn(), reserveFinish: vi.fn(), reserveContinuation: vi.fn(), reserveLateContinuation: vi.fn(), checkpointPage: vi.fn(),
      listActionableConversationSegmentIds: () => ["s"]
    } as unknown as ConversationSegmentStore;
    const presentation = { turnCardPage: vi.fn((_cardView: typeof view, _page: unknown, options?: { completionNotice?: { mentionOpenId: string } | null }) => ({
      card: { mentionOpenId: options?.completionNotice?.mentionOpenId ?? null }, items: [], nextCursor: cursor
    })) };

    await new TurnCardWorkflow(store, vi.fn(), presentation as never).converge("s");

    expect(reserveFreeze).toHaveBeenCalledWith(expect.objectContaining({
      card: { mentionOpenId: null }
    }));
  });

  it("keeps the trusted completion mention off a late continuation create revision", async () => {
    const frozen = { id: "s:page:0", segmentId: "s", pageIndex: 0, messageId: "m", cardId: "c", elementId: "turn-card:s:page:0", state: "frozen" as const, sequence: 4, deliveredSequence: 4, startCursor: null, deliveredCursor: { itemIndex: 1, markdownOffset: 0 }, pendingCursor: null, pendingReplyId: null };
    const view = { segmentId: "s", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "project", projectLabel: "project", tabLabel: "tab", paneToken: "pane", requestText: "hello", state: "completed" as const, timelineItems: [{ kind: "agent_message" as const, id: "answer", sequence: 1, markdown: "done", canonicalPosition: { laneSequence: 1, itemOrdinal: 0 } }], gapWarning: null, viewVersion: 7 };
    const reserveLateContinuation = vi.fn(() => "reserved" as const);
    const store = {
      loadCardView: () => view,
      loadCompletionRenderState: () => ({ mentionOpenId: "ou_requester" }),
      getActivePage: () => null,
      listConversationSegmentPages: () => [frozen],
      reconcilePageDelivery: vi.fn(() => "ready" as const),
      reserveLateContinuation,
      listActionableConversationSegmentIds: () => ["s"]
    } as unknown as ConversationSegmentStore;
    const presentation = { turnCardPage: vi.fn((_cardView: typeof view, _page: unknown, options?: { completionNotice?: { mentionOpenId: string } | null; completionNoticeBudget?: { mentionOpenId: string } | null }) => ({
      card: { mentionOpenId: options?.completionNotice?.mentionOpenId ?? null }, items: [], nextCursor: null
    })) };

    await new TurnCardWorkflow(store, vi.fn(), presentation as never).converge("s");

    expect(presentation.turnCardPage).toHaveBeenCalledWith(view, expect.anything(), expect.objectContaining({
      completionNotice: null,
      completionNoticeBudget: { mentionOpenId: "ou_requester" }
    }), 9_000);
    expect(reserveLateContinuation).toHaveBeenCalledWith(expect.objectContaining({
      card: { mentionOpenId: null }
    }));
  });

  it("keeps an already persisted legacy-inline Human Review actionable when CardKit has no card id", async () => {
    const page = { id: "s:page:0", segmentId: "s", pageIndex: 0, messageId: "m", cardId: null, elementId: "turn-card:s:page:0", state: "active" as const, sequence: 1, deliveredSequence: 1, startCursor: null, deliveredCursor: null, pendingCursor: null, pendingReplyId: null };
    const view = { segmentId: "s", ownerKind: "primary" as const, ownerLabel: "Primary", spaceName: "project", projectLabel: "project", tabLabel: "tab", paneToken: "pane", requestText: "hello", state: "completed" as const, timelineItems: [], gapWarning: null, viewVersion: 2 };
    const synthetic = { state: "available" as const, id: "synthetic", ownerKind: "primary-segment" as const, ownerId: "s", ownerGeneration: 1, cardMessageId: "m", mentionOpenId: "ou_requester" };
    const reserveFinish = vi.fn(() => "reserved" as const);
    const prepare = vi.fn(() => synthetic);
    const store = {
      loadCardView: () => view, loadCompletionRenderState: () => ({ mentionOpenId: "ou_requester", reason: "human_review" as const, completionActions: synthetic }),
      getActivePage: () => page, listConversationSegmentPages: () => [page], reconcilePageDelivery: vi.fn(() => "ready" as const),
      preparePrimarySegmentCompletionActionSet: prepare, reserveFinish, reserveSnapshot: vi.fn(), reserveFreeze: vi.fn(),
      reserveContinuation: vi.fn(), reserveLateContinuation: vi.fn(), checkpointPage: vi.fn(), listActionableConversationSegmentIds: () => ["s"]
    } as unknown as ConversationSegmentStore;
    const presentation = { turnCardPage: vi.fn((_view: unknown, _page: unknown, options: { completionNotice?: unknown; completionActions?: unknown }) => ({
      card: { completionNotice: options.completionNotice ?? null, completionActions: options.completionActions ?? null }, items: [], nextCursor: null
    })) };

    await new TurnCardWorkflow(store, vi.fn(), presentation as never).converge("s");

    expect(prepare).not.toHaveBeenCalled();
    expect(reserveFinish).toHaveBeenCalledWith(expect.objectContaining({
      card: { completionNotice: { mentionOpenId: "ou_requester", reason: "human_review" }, completionActions: synthetic }
    }));
  });
});
