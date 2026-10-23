import { describe, expect, it, vi } from "vitest";
import type { CoreEventEnvelope } from "../src/domain/core-event-inbox.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteCoreEventInboxStore } from "../src/store/sqlite/core-event-inbox-store.js";
import { SqliteSubmissionIntentStore } from "../src/store/sqlite/submission-intent-store.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeConversationSegment } from "../src/domain/conversation-segment.js";
import { prepareOutboundGatewayIntent } from "../src/events/outbound-gateway-intent.js";
import { TurnCardWorkflow } from "../src/coordinator/turn-card-workflow.js";
import { planAndRenderTurnCard } from "../src/cards/turn-card.js";
import { turnCardPresentationPolicy } from "../src/gateways/feishu/turn-card-presentation-policy.js";
import { CardInteractionWorkflow } from "../src/coordinator/card-interaction-workflow.js";
import { AgentInputDrainer } from "../src/coordinator/agent-input-drainer.js";
import { parseCardActionCommand } from "../src/coordinator/card-action-command.js";
import { applicationPresentation } from "./helpers/presentation.js";
import { MAX_TURN_OUTPUT_CHARS, TURN_OUTPUT_TRUNCATION_MARKER } from "../src/runtime/bounded-turn-output.js";
import { completionChoiceSubmissionIdentity } from "../src/domain/completion-choice.js";
import { transferDeliveryPrerequisites } from "../src/store/sqlite/delivery-prerequisites.js";
import { SqliteCompletionReviewStore } from "../src/store/sqlite/completion-review-store.js";
import { feishuGatewayApplicationPresentation, materializeFeishuPresentationView } from "../src/gateways/feishu/presentation.js";
import { renderAnswerTimeline } from "../src/cards/answer-timeline.js";

function stores(path = ":memory:") {
  const context = new SqliteContext(path);
  const graph = new SqliteCapabilityGraph(context);
  connectPreparedGraph(graph, (view, page) => ({ state: view.state, ownerKind: view.ownerKind, requestText: view.requestText, pageIndex: page.pageIndex }));
  activatePrimary(graph, "binding-a", "session-1", "root-a");
  return { context, store: graph.conversationSegments, graph };
}

function connectPreparedGraph(graph: SqliteCapabilityGraph, renderer: (view: any, page: any) => object = (view) => ({ state: view.state })): void {
  graph.conversationSegments.setInitialTurnCardRenderer(renderer);
  graph.outbox.setGatewayPlanPreparer((reply) => {
    const intent = prepareOutboundGatewayIntent(graph.outbox, reply).intent;
    return { protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1, operation: intent.kind, intent };
  });
  graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery() {} });
}

function activatePrimary(graph: SqliteCapabilityGraph, id: string, sessionId: string, rootMessageId: string, paneId = `${id}-pane`): void {
  graph.bindings.createPendingBinding({ id, workspaceId: "workspace", chatId: "chat", topicId: `topic-${id}`, rootMessageId, title: id });
  graph.bindings.updateBinding(id, {
    state: "active", lifecycle: "active", attachment: "attached", paneId,
    agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: sessionId
  });
}
function insertSemanticSegmentPage(context: SqliteContext, input: { segmentId: string; state?: "active" | "frozen"; sequence?: number; deliveredSequence?: number }): void {
  const timestamp = "2026-10-10T00:00:00.000Z";
  const state = input.state ?? "active";
  const sequence = input.sequence ?? 2;
  const deliveredSequence = input.deliveredSequence ?? sequence;
  context.database.prepare(`INSERT INTO conversation_segments(
    id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
    start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
  ) VALUES(?,?,'primary','binding-a',1,'traex','session-1','request',1,0,'working',?,?,?,?)`)
    .run(input.segmentId, `lane:${input.segmentId}`, sequence, "root-a", timestamp, timestamp);
  context.database.prepare(`INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json)
    VALUES(?, 'answer', 2, 0, ?)`)
    .run(input.segmentId, JSON.stringify({ kind: "agent_message", id: "answer", sequence: 1, markdown: "answer", canonicalPosition: { laneSequence: 2, itemOrdinal: 0 } }));
  context.database.prepare(`INSERT INTO conversation_segment_pages(
    id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,
    start_cursor_json,delivered_cursor_json,pending_reply_id,delivery_cohort,created_at,updated_at
  ) VALUES(?,?,0,'message-0','card-0',?,?,?,?,NULL,NULL,NULL,'semantic',?,?)`)
    .run(`${input.segmentId}:page:0`, input.segmentId, `turn-card:${input.segmentId}:page:0`, state, sequence, deliveredSequence, timestamp, timestamp);
}
function event(n: number, payload: Record<string, unknown>, sessionId = "session-1"): CoreEventEnvelope {
  return { schemaVersion: 1, eventId: `event-${n}`, cursor: `core:${n}`, sourceId: "core", agentKind: "traex", sessionId, turnId: `turn-${n}`, occurredAt: `2026-10-04T00:00:0${n}.000Z`, payload };
}
function primaryActivityInvalidation(occurredAt: string, sessionEpoch = 1) {
  return {
    bindingId: "binding-a", bindingGeneration: 1, sessionEpoch, occurredAt,
    producer: { kind: "primary" as const, id: "binding-a", runtimeGeneration: 1, sessionGeneration: sessionEpoch, runtimePaneId: "binding-a-pane" }
  };
}
function human(n: number, submissionId?: string, sessionId?: string) { return event(n, { type: "human_message", message_id: `message-${n}`, text: `request-${n}`, truncated: false, ...(submissionId ? { submission_id: submissionId } : {}) }, sessionId); }
function admitChoiceInput(graph: ReturnType<typeof stores>["graph"], submissionId: string, actorId = "ou_choice_actor"): void {
  graph.agentInputs.admit({
    submissionId, ingressSource: "feishu:primary", sourceMessageKey: `source-${submissionId}`,
    actor: { kind: "human", id: actorId, gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" },
    text: "choose next", owner: { kind: "primary", id: "binding-a", generation: 1 },
    paneId: "binding-a-pane", terminalId: "terminal-a", expectedAgentKind: "traex", expectedSessionId: "session-1",
    recordedAt: "2026-10-04T00:00:00.000Z"
  });
}
function v3ReviewFence(question = "Which path?"): string {
  return `\`\`\`herdr-choice-list\n${JSON.stringify({ version: 3, choice: {
    question, defaultOption: { id: "approve", label: "Approve", submitText: "Approve" }, alternatives: []
  } })}\n\`\`\``;
}
function v3NoneFence(): string { return "```herdr-choice-list\n{\"version\":3}\n```"; }
function completionChoiceCount(context: SqliteContext): number {
  return (context.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications WHERE owner_kind='primary-segment'").get() as { count:number }).count;
}
async function completedChoiceSegment(options: {
  withFinalRequest?: boolean;
  finalEventId?: string;
  cardId?: string | null;
  databasePath?: string;
  semanticFinal?: boolean;
  freshReview?: boolean;
  embeddedV3?: boolean;
  commentaryProtocol?: boolean;
  beforeConverge?: (fixture: ReturnType<typeof stores>, segmentId: string) => void;
} = {}) {
  const {
    withFinalRequest = false,
    finalEventId = "event-2",
    cardId = "card-choice",
    databasePath = ":memory:",
    semanticFinal = false,
    freshReview = false,
    embeddedV3 = false,
    commentaryProtocol = false,
    beforeConverge,
  } = options;
  const fixture = stores(databasePath);
  fixture.context.database.prepare("UPDATE bindings SET traex_session_id='terminal-a' WHERE id='binding-a'").run();
  fixture.graph.agentInputs.admit({
    submissionId: "submission-choice", ingressSource: "feishu:primary", sourceMessageKey: "source-choice",
    actor: { kind: "human", id: "ou_choice_actor", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" },
    text: "choose next", owner: { kind: "primary", id: "binding-a", generation: 1 },
    paneId: "binding-a-pane", terminalId: "terminal-a", expectedAgentKind: "traex", expectedSessionId: "session-1",
    recordedAt: "2026-10-04T00:00:00.000Z"
  });
  const humanEvent = event(1, { type: "human_message", message_id: "human-choice", text: "choose next", truncated: false, submission_id: "submission-choice" });
  const finalText = `Choose a path.${withFinalRequest ? " @_user_1" : ""}`;
  const v3Choice = {
    version: 3,
    choice: {
      question: "Which path?",
      defaultOption: { id: "approve", label: "Approve", submitText: "Approve the trusted plan." },
      alternatives: [{ id: "revise", label: "Revise", submitText: "Please revise using the trusted server message." }]
    }
  };
  const commentaryEvent = commentaryProtocol ? { ...event(2, {
    type: "message", message_id: "commentary-choice", channel: "commentary",
    text: `Working before final.\n\n\`\`\`herdr-choice-list\n${JSON.stringify(v3Choice)}\n\`\`\``,
    truncated: false
  }), eventId: "commentary-choice", cursor: "core:commentary-choice", turnId: humanEvent.turnId } : null;
  const finalEvent = { ...event(commentaryProtocol ? 3 : 2, {
    type: "message", message_id: "final-choice", channel: "final",
    text: embeddedV3 ? `${finalText}\n\n\`\`\`herdr-choice-list\n${JSON.stringify(v3Choice)}\n\`\`\`` : finalText,
    truncated: false,
    ...(!embeddedV3 && !commentaryProtocol ? { completion_choice: { version: 2, intent: "human_review", question: "Which path?", default: "approve", options: [
      { id: "approve", label: "Approve", message: "default" },
      { id: "revise", label: "Revise", message: "Please revise using the trusted server message." }
    ] } } : {})
  }), eventId: finalEventId, cursor: `core:${commentaryProtocol ? 3 : 2}`, turnId: humanEvent.turnId };
  const terminalEvent = { ...event(commentaryProtocol ? 4 : 3, { type: "turn_completed" }), turnId: humanEvent.turnId };
  expect(fixture.graph.coreEvents.ingestBatch({ laneId: "lane-choice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [humanEvent, ...(commentaryEvent ? [commentaryEvent] : []), finalEvent, terminalEvent], ingestedAt: terminalEvent.occurredAt })).toBe("accepted");
  const segment = fixture.store.listConversationSegmentsForProducer("lane:lane-choice")[0]!;
  expect(fixture.context.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications WHERE owner_kind='primary-segment'").get()).toEqual({ count: 1 });
  const create = fixture.graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) => projectionKey === `turn-card:${segment.id}:page:0`)!;
  if (cardId) expect(fixture.graph.outbox.checkpointOutboundReplyCard(create.id, cardId)).not.toBeNull();
  fixture.graph.outbox.markOutboundReplyDelivered(create.id, "turn-choice", cardId ?? undefined);
  expect(fixture.store.reconcilePageDelivery(segment.id, 0)).toBe("adopted");
  if (!freshReview) {
    const choice = fixture.context.database.prepare(`SELECT id FROM completion_choice_specifications
      WHERE owner_kind='primary-segment' AND owner_id=? AND owner_generation=1`).get(segment.id) as { id: string };
    const timestamp = "2026-10-04T00:00:03.000Z";
    fixture.context.database.prepare(`INSERT INTO completion_action_sets(
      id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,card_id,card_message_id,
      mention_open_id,presentation_kind,presentation_generation,presentation_message_id,presentation_card_id,
      state,created_at,updated_at,choice_specification_id
    ) VALUES(?,'primary-segment',?,1,'binding-a',1,0,?,?,?,'legacy-inline',1,?,?, 'available',?,?,?)`).run(
      `primary-segment-action:${segment.id}:1`, segment.id, cardId ?? "turn-choice", "turn-choice", "ou_choice_actor",
      "turn-choice", cardId, timestamp, timestamp, choice.id
    );
  }
  if (semanticFinal) {
    fixture.context.database.exec("DROP TRIGGER conversation_segment_pages_delivery_cohort_immutable");
    fixture.context.database.prepare("UPDATE conversation_segment_pages SET delivery_cohort='semantic' WHERE segment_id=?").run(segment.id);
  }
  beforeConverge?.(fixture, segment.id);
  const workflow = new TurnCardWorkflow(fixture.store, () => {}, {
    turnCardPage: (view, page, options, limit) => planAndRenderTurnCard(view, page, options, limit),
    completionReview: feishuGatewayApplicationPresentation.completionReview
  }, 9_000, undefined, undefined, semanticFinal ? turnCardPresentationPolicy : undefined);
  await workflow.converge(segment.id);
  const finish = fixture.graph.outbox.listPendingOutboundReplies().find(({ idempotencyKey }) => idempotencyKey.startsWith(`segment:${segment.id}:page:0:finish:final:`))!;
  const actions = fixture.context.database.prepare("SELECT id,owner_kind,owner_id,state FROM completion_action_sets").all();
  expect(actions).toHaveLength(1);
  const action = actions[0] as { id:string };
  return { ...fixture, workflow, segment, finish, action };
}

function attachLegacyChoiceReminder(
  context: SqliteContext,
  graph: SqliteCapabilityGraph,
  input: { segmentId: string; presentationReplyId: string; reminderId: string },
): void {
  graph.outbox.enqueueOutboundReply({
    id: input.reminderId, idempotencyKey: input.reminderId, bindingId: "binding-a", bindingGeneration: 1,
    rootMessageId: "turn-choice", kind: "text", targetRole: "operation_result",
    payload: '<at user_id="ou_choice_actor">用户</at> 需要你的选择。'
  });
  context.database.prepare(`UPDATE completion_notification_obligations
    SET state='waiting_for_answer',notification_reply_id=?,updated_at='2026-10-04T00:00:05.000Z'
    WHERE owner_kind='primary-segment' AND owner_id=?`).run(input.reminderId, input.segmentId);
  context.database.prepare(`INSERT INTO outbound_reply_prerequisites(
    dependent_reply_id,prerequisite_reply_id,required_state,created_at
  ) VALUES(?,?,'delivered','2026-10-04T00:00:05.000Z')`).run(input.reminderId, input.presentationReplyId);
}

function segmentCardInteractions(graph: SqliteCapabilityGraph) {
  const resume = vi.fn(async (submissionId: string) => ({ outcome: "accepted" as const, submissionId, state: "observed" as const }));
  const convergeTurnCard = vi.fn(async () => undefined);
  const workflow = new CardInteractionWorkflow({
    store: graph.capabilityModules().cardInteraction,
    projects: [], adminOpenIds: [], sessionAdministration: { emitStatus: vi.fn() }, commands: { submit: vi.fn() } as never,
    bindingPrompts: { ignorePrimaryCompletionAction: vi.fn() }, agentInput: { resume }, convergeTurnCard,
    presentation: applicationPresentation, logger: { info: vi.fn(), warn: vi.fn() }
  });
  const invoke = (value: Record<string, unknown>, overrides: Partial<{ messageId: string; chatId: string; operatorOpenId: string }> = {}) => {
    const command = parseCardActionCommand(value);
    if (command.kind !== "completion-action") throw new Error("Expected completion action");
    return workflow.handle({ messageId: "turn-choice", chatId: "chat", operatorOpenId: "ou_choice_actor", value, ...overrides }, command);
  };
  return { invoke, resume, convergeTurnCard };
}


describe("conversation segment canonical projection", () => {
  it("reserves one never-attempted missing Turn Card at its exact original target as history work", () => {
    const fixture = stores();
    const timestamp = "2026-10-14T00:00:00.000Z";
    fixture.context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('segment-history-card','lane:history-card','primary','binding-a',1,'traex','session-1','restore',1,0,'completed',1,'root-a',?,?)`).run(timestamp, timestamp);
    fixture.context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,
      start_cursor_json,delivered_cursor_json,pending_reply_id,delivery_cohort,created_at,updated_at
    ) VALUES('segment-history-card:page:0','segment-history-card',0,NULL,NULL,'turn-card:segment-history-card:page:0','finished',1,0,NULL,NULL,NULL,'legacy',?,?)`).run(timestamp, timestamp);

    const [candidate] = fixture.store.listHistoricalMissingPageCandidates({ limit: 1 });
    expect(candidate).toMatchObject({
      segmentId: "segment-history-card", pageIndex: 0, viewVersion: 1,
      route: { ownerKind: "primary", ownerId: "binding-a", ownerGeneration: 1, gatewayId: "feishu:primary", rootMessageId: "root-a" }
    });
    expect(fixture.store.reserveHistoricalMissingPage({ candidate: candidate!, card: { restored: true }, cursor: null })).toBe("reserved");
    expect(fixture.graph.outbox.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      rootMessageId: "root-a", projectionKey: "turn-card:segment-history-card:page:0", kind: "card_reply", workClass: "history"
    })]);
    expect(fixture.context.database.prepare("SELECT state,pending_reply_id FROM conversation_segment_pages WHERE segment_id='segment-history-card'").get()).toMatchObject({
      state: "creating", pending_reply_id: expect.any(String)
    });
    fixture.context.close();
  });

  it("refuses missing Turn Card recovery after any prior effect or owner retirement", () => {
    const fixture = stores();
    const timestamp = "2026-10-14T00:00:00.000Z";
    fixture.context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('segment-history-refused','lane:history-refused','primary','binding-a',1,'traex','session-1','restore',1,0,'completed',1,'root-a',?,?)`).run(timestamp, timestamp);
    fixture.context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,
      start_cursor_json,delivered_cursor_json,pending_reply_id,delivery_cohort,created_at,updated_at
    ) VALUES('segment-history-refused:page:0','segment-history-refused',0,NULL,NULL,'turn-card:segment-history-refused:page:0','finished',1,0,NULL,NULL,NULL,'legacy',?,?)`).run(timestamp, timestamp);
    const [candidate] = fixture.store.listHistoricalMissingPageCandidates({ limit: 1 });
    fixture.graph.outbox.enqueueOutboundReply({
      id: "prior-history-effect", idempotencyKey: "prior-history-effect", bindingId: null,
      rootMessageId: "root-a", targetRole: "operation_result", kind: "card_reply", payload: "{}",
      projectionKey: "turn-card:segment-history-refused:page:0", snapshotRevision: 1, workClass: "history"
    });
    fixture.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',failure_class='unknown',
      effect_certainty='uncertain',error='Dismissed uncertain display delivery by bounded-skip policy'
      WHERE id='prior-history-effect'`).run();

    expect(fixture.store.listHistoricalMissingPageCandidates({ limit: 10 })).toEqual([]);
    expect(fixture.store.reserveHistoricalMissingPage({ candidate: candidate!, card: {}, cursor: null })).toBe("stale");
    expect(fixture.context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 1 });
    fixture.graph.bindings.updateBinding("binding-a", { state: "archived", lifecycle: "archived", attachment: "unattached" });
    expect(fixture.store.listHistoricalMissingPageCandidates({ limit: 10 })).toEqual([]);
    fixture.context.close();
  });


  it("keeps completion-choice identity fixed across long chained action inputs", () => {
    const chainedActionId = `primary-segment-action:${"segment:submission:".repeat(100)}:20`;
    const first = completionChoiceSubmissionIdentity(chainedActionId, "revise");

    expect(first).toMatch(/^completion-choice:v2:[a-f0-9]{64}$/);
    expect(first).toHaveLength("completion-choice:v2:".length + 64);
    expect(completionChoiceSubmissionIdentity(chainedActionId, "revise")).toBe(first);
    expect(first).not.toContain(chainedActionId);
  });

  it("rejects every legacy reservation method for a semantic-cohort page", () => {
    const { context, store } = stores();
    insertSemanticSegmentPage(context, { segmentId: "semantic-legacy-boundary" });
    const common = { segmentId: "semantic-legacy-boundary", pageIndex: 0, messageId: "message-0" };

    expect(store.reserveSnapshot({ ...common, cardId: "card-0", elementId: "turn-card:semantic-legacy-boundary:page:0", card: {}, cursor: null, viewVersion: 3 })).toBe("stale");
    expect(store.reserveFreeze({ ...common, cardId: "card-0", elementId: "turn-card:semantic-legacy-boundary:page:0", card: {}, cursor: { itemIndex: 1, markdownOffset: 0 }, cursorAnchor: { position: { laneSequence: 2, itemOrdinal: 0 }, inclusive: false } })).toBe("stale");
    expect(store.reserveFinish({ ...common, cardId: "card-0", elementId: "turn-card:semantic-legacy-boundary:page:0", card: {}, summary: "Completed", cursor: { itemIndex: 1, markdownOffset: 0 } })).toBe("stale");
    expect(store.reserveContinuation({ ...common, card: {}, nextPageIndex: 1, nextElementId: "turn-card:semantic-legacy-boundary:page:1", nextStartCursor: { itemIndex: 1, markdownOffset: 0 }, nextStartAnchor: { position: { laneSequence: 2, itemOrdinal: 0 }, inclusive: false } })).toBe("stale");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    context.close();
  });

  it("reopens a pending semantic freeze without replanning its frozen snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "semantic-page-reopen-"));
    const path = join(directory, "state.sqlite");
    const first = stores(path);
    insertSemanticSegmentPage(first.context, { segmentId: "semantic-reopen" });
    const snapshot = { schemaVersion: 1, kind: "conversation-turn-card", pagePlan: { policyVersion: 1, budgetProfileVersion: 1, pageIndex: 0, startCursor: null, endCursor: { itemIndex: 1, markdownOffset: 0 }, hasContinuation: true }, presentationBudget: { encodedBytes: 9_000, elementCount: 256, actionCount: 32, profileVersion: 1 }, presentationMeasure: { encodedBytesUpperBound: 100, elementCount: 2, actionCount: 0 } };
    expect(first.store.reserveSemanticSnapshot!({
      transition: "freeze", segmentId: "semantic-reopen", pageIndex: 0, messageId: "message-0", cardId: "card-0",
      elementId: "turn-card:semantic-reopen:page:0", snapshot, cursor: { itemIndex: 1, markdownOffset: 0 },
      cursorAnchor: { position: { laneSequence: 2, itemOrdinal: 0 }, inclusive: false },
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    })).toBe("reserved");
    const pendingReplyId = first.store.listConversationSegmentPages("semantic-reopen")[0]!.pendingReplyId!;
    first.context.close();

    const reopenedContext = new SqliteContext(path);
    const reopenedGraph = new SqliteCapabilityGraph(reopenedContext);
    connectPreparedGraph(reopenedGraph);
    const reopened = { context: reopenedContext, graph: reopenedGraph, store: reopenedGraph.conversationSegments };
    try {
      expect(reopened.graph.preparedDeliveries.hydrateDeliveryInput(pendingReplyId)).toMatchObject({
        status: "semantic-snapshot", preparationState: "reserved", input: { kind: "semantic-snapshot", snapshot }
      });
      const policy = { plannerPolicyVersion: 1, rendererPolicyVersion: 1, plan: vi.fn(), measure: vi.fn(), render: vi.fn() };
      await new TurnCardWorkflow(reopened.store, () => {}, { turnCardPage: vi.fn() }, 9_000, undefined, undefined, policy).converge("semantic-reopen");
      expect(policy.plan).not.toHaveBeenCalled();
      expect(reopened.store.listConversationSegmentPages("semantic-reopen")[0]).toMatchObject({ state: "frozen", pendingReplyId });
    } finally {
      reopened.context.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates a semantic continuation atomically against the exact frozen-page target", () => {
    const { context, store, graph } = stores();
    insertSemanticSegmentPage(context, { segmentId: "semantic-continuation", state: "frozen", sequence: 3, deliveredSequence: 3 });
    const snapshot = { schemaVersion: 1, kind: "conversation-turn-card", pagePlan: { policyVersion: 1, budgetProfileVersion: 1, pageIndex: 1, startCursor: { itemIndex: 0, markdownOffset: 0 }, endCursor: null, hasContinuation: false }, presentationBudget: { encodedBytes: 9_000, elementCount: 256, actionCount: 32, profileVersion: 1 }, presentationMeasure: { encodedBytesUpperBound: 100, elementCount: 2, actionCount: 0 } };

    expect(store.reserveSemanticSnapshot!({
      transition: "continuation", segmentId: "semantic-continuation", pageIndex: 0, messageId: "message-0",
      nextPageIndex: 1, nextElementId: "turn-card:semantic-continuation:page:1",
      nextStartCursor: { itemIndex: 1, markdownOffset: 0 }, nextStartAnchor: { position: { laneSequence: 2, itemOrdinal: 0 }, inclusive: false },
      snapshot, cursor: null, plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    })).toBe("reserved");

    const continuation = store.listConversationSegmentPages("semantic-continuation")[1]!;
    expect(continuation).toMatchObject({ pageIndex: 1, state: "creating", deliveryCohort: "semantic", startCursor: { itemIndex: 1, markdownOffset: 0 } });
    const row = context.database.prepare(`SELECT root_message_id,kind,payload,delivery_input_kind,subject_revision
      FROM outbound_replies WHERE id=?`).get(continuation.pendingReplyId) as Record<string, unknown>;
    expect(row).toEqual({ root_message_id: "message-0", kind: "card_reply", payload: "{}", delivery_input_kind: "semantic-snapshot", subject_revision: 1 });
    expect(graph.preparedDeliveries.hydrateDeliveryInput(continuation.pendingReplyId!)).toMatchObject({
      status: "semantic-snapshot", input: { kind: "semantic-snapshot", snapshot }
    });
    context.close();
  });

  it("keeps creation and notification prerequisites on a semantic choice-bearing finish", async () => {
    const { context, graph, segment, finish } = await completedChoiceSegment({ semanticFinal: true });
    expect(graph.preparedDeliveries.hydrateDeliveryInput(finish.id)).toMatchObject({
      status: "semantic-snapshot", input: { kind: "semantic-snapshot", subject: { kind: "conversation-page", segmentId: segment.id, pageIndex: 0 } }
    });
    const create = context.database.prepare(`SELECT id FROM outbound_replies
      WHERE projection_key=? AND kind='card_reply' AND state='delivered'`).get(`turn-card:${segment.id}:page:0`) as { id: string };
    const notification = context.database.prepare(`SELECT notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='primary-segment' AND owner_id=?`).get(segment.id) as { notification_reply_id: string };
    expect(context.database.prepare(`SELECT prerequisite_reply_id,required_state FROM outbound_reply_prerequisites
      WHERE dependent_reply_id=? ORDER BY prerequisite_reply_id`).all(finish.id)).toEqual([{ prerequisite_reply_id: create.id, required_state: "delivered" }]);
    expect(context.database.prepare(`SELECT prerequisite_reply_id,required_state FROM outbound_reply_prerequisites
      WHERE dependent_reply_id=?`).all(notification.notification_reply_id)).toEqual([{ prerequisite_reply_id: finish.id, required_state: "delivered" }]);
    context.close();
  });

  it("never persists a provider-materialized create payload after semantic cohort assignment", async () => {
    const { context, store } = stores();
    context.database.exec("DROP TRIGGER semantic_delivery_rollout_guarded_transition");
    context.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1 WHERE singleton_id=1").run();

    const projected = store.projectCanonicalEvent({ laneId: "semantic-create", laneSequence: 1, event: human(1), observedAt: "2026-10-10T00:00:01.000Z" });
    const segmentId = projected.segmentId!;
    expect(store.listConversationSegmentPages(segmentId)[0]).toMatchObject({ deliveryCohort: "semantic", pendingReplyId: null });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key=?").get(`turn-card:${segmentId}:page:0`)).toEqual({ count: 0 });

    await new TurnCardWorkflow(store, () => {}, { turnCardPage: vi.fn() }, 9_000, undefined, undefined, turnCardPresentationPolicy).converge(segmentId);

    const page = store.listConversationSegmentPages(segmentId)[0]!;
    expect(context.database.prepare(`SELECT payload,delivery_input_kind FROM outbound_replies WHERE id=?`).get(page.pendingReplyId))
      .toEqual({ payload: "{}", delivery_input_kind: "semantic-snapshot" });
    context.close();
  });

  it("reopens only the latest fenced Primary final page for Session Activity convergence", async () => {
    const { context, store, graph } = stores();
    const now = "2026-10-09T00:00:00.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES
      ('activity-old','lane:activity','primary','binding-a',1,'traex','session-1','old',1,0,'closed',5,'root-a',?,?),
      ('activity-current','lane:activity','primary','binding-a',1,'traex','session-1','current',2,0,'completed',5,'root-a',?,?)`)
      .run(now, now, now, now);
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
    ) VALUES
      ('activity-old:page:0','activity-old',0,'old-message','old-card','turn-card:activity-old:page:0','finished',5,5,?,?),
      ('activity-current:page:0','activity-current',0,'current-message','current-card','turn-card:activity-current:page:0','finished',5,5,?,?)`)
      .run(now, now, now, now);
    const notifications: unknown[] = [];
    store.setProjectionNotifier((notification) => { notifications.push(notification); });

    expect(store.invalidateCurrentPrimarySessionActivity(primaryActivityInvalidation("2026-10-09T00:00:01.000Z"))).toEqual({ segmentId: "activity-current", viewVersion: 6, urgency: "immediate" });
    expect(context.database.prepare("SELECT state,view_version FROM conversation_segments WHERE id='activity-current'").get())
      .toEqual({ state: "completed", view_version: 6 });
    expect(context.database.prepare("SELECT state,sequence FROM conversation_segment_pages WHERE segment_id='activity-current'").get())
      .toEqual({ state: "active", sequence: 5 });
    expect(context.database.prepare("SELECT state,sequence FROM conversation_segment_pages WHERE segment_id='activity-old'").get())
      .toEqual({ state: "finished", sequence: 5 });
    expect(notifications).toEqual([{ segmentId: "activity-current", viewVersion: 6, urgency: "immediate" }]);
    await new TurnCardWorkflow(store, () => {}, {
      turnCardPage: (view, page, options, limit) => planAndRenderTurnCard(view, page, options, limit)
    }).converge("activity-current");
    const pending = context.database.prepare("SELECT state,pending_reply_id FROM conversation_segment_pages WHERE segment_id='activity-current'")
      .get() as { state: string; pending_reply_id: string };
    expect(pending.state).toBe("finished");
    expect(pending.pending_reply_id).toBeTruthy();
    expect(store.getConversationSegment("activity-current")?.state).toBe("completed");

    expect(store.invalidateCurrentPrimarySessionActivity(primaryActivityInvalidation("2026-10-09T00:00:02.000Z"))).toEqual({ segmentId: "activity-current", viewVersion: 7, urgency: "immediate" });
    expect(graph.outbox.markOutboundReplyDelivered(pending.pending_reply_id, "current-message", "current-card")).toBe(true);
    expect(store.reconcilePageDelivery("activity-current", 0)).toBe("adopted");
    expect(context.database.prepare("SELECT state,pending_reply_id FROM conversation_segment_pages WHERE segment_id='activity-current'").get())
      .toEqual({ state: "active", pending_reply_id: null });
    expect(store.invalidateCurrentPrimarySessionActivity(primaryActivityInvalidation("2026-10-09T00:00:03.000Z", 2))).toBeNull();
    context.close();
  });

  it("does not fall back to an older final page when the newest Primary segment has no page", () => {
    const { context, store } = stores();
    const now = "2026-10-09T00:00:00.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES
      ('activity-old-page','lane:activity','primary','binding-a',1,'traex','session-1','old',1,0,'completed',5,'root-a',?,?),
      ('activity-new-page-less','lane:activity','primary','binding-a',1,'traex','session-1','new',2,0,'working',3,'root-a',?,?)`)
      .run(now, now, now, now);
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
    ) VALUES('activity-old-page:page:0','activity-old-page',0,'old-message','old-card','turn-card:activity-old-page:page:0','finished',5,5,?,?)`)
      .run(now, now);
    const notifications: unknown[] = [];
    store.setProjectionNotifier((notification) => { notifications.push(notification); });

    expect(store.invalidateCurrentPrimarySessionActivity(primaryActivityInvalidation("2026-10-09T00:00:01.000Z"))).toBeNull();
    expect(context.database.prepare("SELECT state,view_version FROM conversation_segments WHERE id='activity-old-page'").get())
      .toEqual({ state: "completed", view_version: 5 });
    expect(context.database.prepare("SELECT state,sequence FROM conversation_segment_pages WHERE segment_id='activity-old-page'").get())
      .toEqual({ state: "finished", sequence: 5 });
    expect(notifications).toEqual([]);
    context.close();
  });

  it("invalidates only the exact Worker producer when Workers share an observed timestamp", () => {
    const { context, store, graph } = stores();
    const timestamp = "2026-10-09T00:00:01.000Z";
    const workers = ["worker-a", "worker-b"].map((id) => {
      const created = graph.instances.createWorkerAgentInstance({
        id, projectId: "project", name: id, role: "worker", agentKind: "traex", model: null,
        desiredState: "running", parent: { bindingId: "binding-a", bindingGeneration: 1, paneId: "binding-a-pane", nativeSessionId: "session-1" },
        workspace: { id: `${id}-lease`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
      }, 8);
      expect(created.outcome).toBe("created");
      const attached = graph.instances.attachAgentInstanceRuntime({
        instanceId: id, expectedGeneration: created.instance.generation, herdrWorkspaceId: "workspace", paneId: `${id}-pane`, nativeSessionId: `${id}-session`
      });
      expect(attached).not.toBeNull();
      const segmentId = `${id}-segment`;
      context.database.prepare(`INSERT INTO conversation_segments(
        id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
        start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
      ) VALUES(?,?, 'worker',?,?, 'traex',?,'request',1,0,'completed',5,?,?,?)`).run(
        segmentId, `lane:${id}`, id, attached!.generation, `${id}-session`, `${id}-root`, timestamp, timestamp
      );
      context.database.prepare(`INSERT INTO conversation_segment_pages(
        id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
      ) VALUES(?,?,0,?,?,?,'finished',5,5,?,?)`).run(
        `${segmentId}:page:0`, segmentId, `${id}-message`, `${id}-card`, `turn-card:${segmentId}:page:0`, timestamp, timestamp
      );
      return attached!;
    });
    for (const worker of workers) {
      const context = {
        scope: { kind: "pane" as const, workspaceId: "workspace", paneId: "binding-a-pane" },
        ownerFence: { kind: "worker" as const, id: worker.id, generation: worker.generation, sessionGeneration: worker.workerSessionGeneration, parent: { id: "binding-a", generation: 1, sessionGeneration: 1 } },
        producer: { kind: "worker" as const, id: worker.id, runtimeGeneration: worker.generation, sessionGeneration: worker.workerSessionGeneration, runtimePaneId: worker.runtimeRef!.paneId }
      };
      expect(graph.sessionActivity.projectCanonicalEvent({
        context, laneId: `lane-${worker.id}`, laneSequence: 1, sourceId: "core", sourceEpoch: "epoch-1",
        event: event(1, { type: "agent_activity", agent_id: worker.id, display_name: worker.id, state: "running" }, `${worker.id}-session`), observedAt: timestamp
      }).visibleChanged).toBe(true);
    }

    const notifications: unknown[] = [];
    store.setProjectionNotifier((notification) => { notifications.push(notification); });
    expect(store.invalidateCurrentPrimarySessionActivity({
      bindingId: "binding-a", bindingGeneration: 1, sessionEpoch: 1,
      producer: { kind: "worker", id: workers[0]!.id, runtimeGeneration: workers[0]!.generation, sessionGeneration: workers[0]!.workerSessionGeneration, runtimePaneId: workers[0]!.runtimeRef!.paneId },
      occurredAt: timestamp
    })).toMatchObject({ segmentId: "worker-a-segment", viewVersion: 6, urgency: "immediate" });
    expect(notifications).toEqual([{ segmentId: "worker-a-segment", viewVersion: 6, urgency: "immediate" }]);
    expect(context.database.prepare("SELECT id,view_version FROM conversation_segments WHERE owner_kind='worker' ORDER BY id").all())
      .toEqual([{ id: "worker-a-segment", view_version: 6 }, { id: "worker-b-segment", view_version: 5 }]);
    context.close();
  });

  it("retains a pending current-final Session Activity refresh across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "turn-card-session-activity-"));
    const path = join(directory, "state.sqlite");
    const first = stores(path);
    const now = "2026-10-09T00:00:00.000Z";
    first.context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('activity-restart','lane:activity','primary','binding-a',1,'traex','session-1','current',1,0,'completed',5,'root-a',?,?)`)
      .run(now, now);
    first.context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
    ) VALUES('activity-restart:page:0','activity-restart',0,'answer-1','card-1','turn-card:activity-restart:page:0','finished',5,5,?,?)`)
      .run(now, now);
    expect(first.store.invalidateCurrentPrimarySessionActivity(primaryActivityInvalidation("2026-10-09T00:00:01.000Z"))?.segmentId).toBe("activity-restart");
    await new TurnCardWorkflow(first.store, () => {}, {
      turnCardPage: (view, page, options, limit) => planAndRenderTurnCard(view, page, options, limit)
    }).converge("activity-restart");
    const firstFinish = first.store.listConversationSegmentPages("activity-restart")[0]!.pendingReplyId!;
    expect(first.store.invalidateCurrentPrimarySessionActivity(primaryActivityInvalidation("2026-10-09T00:00:02.000Z"))?.viewVersion).toBe(7);
    first.context.close();

    const secondContext = new SqliteContext(path);
    try {
      const second = new SqliteCapabilityGraph(secondContext);
      connectPreparedGraph(second);
      expect(second.outbox.markOutboundReplyDelivered(firstFinish, "answer-1", "card-1")).toBe(true);
      expect(second.conversationSegments.reconcilePageDelivery("activity-restart", 0)).toBe("adopted");
      expect(second.conversationSegments.getActivePage("activity-restart")?.state).toBe("active");
      await new TurnCardWorkflow(second.conversationSegments, () => {}, {
        turnCardPage: (view, page, options, limit) => planAndRenderTurnCard(view, page, options, limit)
      }).converge("activity-restart");
      expect(second.conversationSegments.listConversationSegmentPages("activity-restart")[0]).toMatchObject({
        state: "finished", sequence: 8
      });
      expect(second.conversationSegments.getConversationSegment("activity-restart")?.state).toBe("completed");
    } finally {
      secondContext.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists, renders, and consumes the exact requester's canonical completion choice once", async () => {
    const { context, store, segment, finish, action } = await completedChoiceSegment();
    expect(context.database.prepare(`SELECT owner_kind,owner_id,owner_generation,question,default_option_id
      FROM completion_choice_specifications WHERE owner_kind='primary-segment'`).get()).toEqual({
      owner_kind: "primary-segment", owner_id: segment.id, owner_generation: 1,
      question: "Which path?", default_option_id: "approve"
    });
    const payload = JSON.stringify(JSON.parse(finish.payload));
    expect(payload).toContain("<at id=ou_choice_actor></at>");
    expect(payload.indexOf("Approve")).toBeLessThan(payload.indexOf("Revise"));
    expect(payload.indexOf("Revise")).toBeLessThan(payload.indexOf("忽略"));
    expect(() => store.acceptPrimarySegmentCompletionChoice({ actionSetId: action.id, optionId: "revise", ownerSegmentId: segment.id, ownerGeneration: 1, cardMessageId: "turn-choice", actorOpenId: "ou_wrong", chatId: "chat", occurredAt: "2026-10-04T00:00:04.000Z" })).toThrow("no longer available");
    expect(() => store.acceptPrimarySegmentCompletionChoice({ actionSetId: action.id, optionId: "missing", ownerSegmentId: segment.id, ownerGeneration: 1, cardMessageId: "turn-choice", actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: "2026-10-04T00:00:04.000Z" })).toThrow("no longer available");
    const accepted = store.acceptPrimarySegmentCompletionChoice({ actionSetId: action.id, optionId: "revise", ownerSegmentId: segment.id, ownerGeneration: 1, cardMessageId: "turn-choice", actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: "2026-10-04T00:00:04.000Z" });
    expect(accepted).toMatchObject({ segmentId: segment.id, inserted: true });
    expect(accepted.submissionId).toMatch(/^completion-choice:v2:[a-f0-9]{64}$/);
    expect(accepted.submissionId.length).toBeLessThanOrEqual(256);
    expect(store.acceptPrimarySegmentCompletionChoice({ actionSetId: action.id, optionId: "revise", ownerSegmentId: segment.id, ownerGeneration: 1, cardMessageId: "turn-choice", actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: "2026-10-04T00:00:05.000Z" })).toEqual({ ...accepted, inserted: false });
    expect(context.database.prepare(`SELECT ingress_source,source_message_key,input_json,text,actor_json,state
      FROM submission_intents WHERE submission_id=?`).get(accepted.submissionId)).toEqual({
      ingress_source: "feishu:primary", source_message_key: accepted.submissionId,
      input_json: JSON.stringify({ schemaVersion: 2, text: "Please revise using the trusted server message.", choice: { actionSetId: action.id, optionId: "revise", sourceMessageId: "turn-choice" } }),
      text: "Please revise using the trusted server message.",
      actor_json: JSON.stringify({ kind: "human", id: "ou_choice_actor", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" }),
      state: "recorded"
    });
    expect(context.database.prepare("SELECT state,selected_choice_option_id,result_source_key FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({
      state: "consumed", selected_choice_option_id: "revise", result_source_key: accepted.submissionId
    });
    expect(context.database.prepare("SELECT state FROM completion_notification_obligations WHERE owner_kind='primary-segment' AND owner_id=?").get(segment.id)).toEqual({ state: "suppressed" });
    context.close();
  });

  it("persists embedded v3 choices into durable action buttons and submits the real default text", async () => {
    const { context, store, segment, finish, action } = await completedChoiceSegment({ embeddedV3: true });
    expect(context.database.prepare(`SELECT option_id,label,message FROM completion_choice_options
      ORDER BY ordinal`).all()).toEqual([
      { option_id: "approve", label: "Approve", message: "Approve the trusted plan." },
      { option_id: "revise", label: "Revise", message: "Please revise using the trusted server message." }
    ]);
    const payload = JSON.stringify(JSON.parse(finish.payload));
    expect(payload).toContain('"optionId":"approve"');
    expect(payload).toContain('"optionId":"revise"');
    const accepted = store.acceptPrimarySegmentCompletionChoice({
      actionSetId: action.id, optionId: "approve", ownerSegmentId: segment.id, ownerGeneration: 1,
      cardMessageId: "turn-choice", actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: "2026-10-04T00:00:04.000Z"
    });
    expect(context.database.prepare("SELECT text FROM submission_intents WHERE submission_id=?").get(accepted.submissionId)).toEqual({ text: "Approve the trusted plan." });
    context.close();
  });

  it("recovers a complete choice protocol from commentary when the final event keeps only the answer", async () => {
    const { context, finish, action } = await completedChoiceSegment({ commentaryProtocol: true });
    expect(action).toMatchObject({ state: "available" });
    expect(context.database.prepare("SELECT question,default_option_id FROM completion_choice_specifications").get()).toEqual({ question: "Which path?", default_option_id: "approve" });
    expect(JSON.stringify(JSON.parse(finish.payload))).toContain('"optionId":"approve"');
    context.close();
  });

  it("replaces an older review with a durable Continue choice for later explicit none", () => {
    const { context, graph } = stores();
    graph.agentInputs.admit({
      submissionId: "submission-latest-none", ingressSource: "feishu:primary", sourceMessageKey: "source-latest-none",
      actor: { kind: "human", id: "ou_choice_actor", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" },
      text: "choose next", owner: { kind: "primary", id: "binding-a", generation: 1 },
      paneId: "binding-a-pane", terminalId: "terminal-a", expectedAgentKind: "traex", expectedSessionId: "session-1",
      recordedAt: "2026-10-04T00:00:00.000Z"
    });
    const humanEvent = event(1, { type: "human_message", message_id: "human-latest-none", text: "choose next", truncated: false, submission_id: "submission-latest-none" });
    const review = { ...event(2, {
      type: "message", message_id: "review-before-none", channel: "commentary", truncated: false,
      text: "```herdr-choice-list\n{\"version\":3,\"choice\":{\"question\":\"Which path?\",\"defaultOption\":{\"id\":\"approve\",\"label\":\"Approve\",\"submitText\":\"Approve\"},\"alternatives\":[]}}\n```"
    }), turnId: humanEvent.turnId };
    const none = { ...event(3, {
      type: "message", message_id: "none-after-review", channel: "commentary", truncated: false,
      text: "```herdr-choice-list\n{\"version\":3}\n```"
    }), turnId: humanEvent.turnId };
    const finalEvent = { ...event(4, { type: "message", message_id: "final-latest-none", channel: "final", text: "Done.", truncated: false }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(5, { type: "turn_completed" }), turnId: humanEvent.turnId };

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-latest-none", sourceId: "core", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor,
      events: [humanEvent, review, none, finalEvent, terminalEvent], ingestedAt: terminalEvent.occurredAt
    })).toBe("accepted");
    expect(context.database.prepare("SELECT question,default_option_id FROM completion_choice_specifications WHERE owner_kind='primary-segment'").get()).toEqual({ question: "是否继续？", default_option_id: "continue" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM completion_action_sets WHERE owner_kind='primary-segment'").get()).toEqual({ count: 0 });
    context.close();
  });

  it("selects a later explicit commentary review after none", () => {
    const { context, graph } = stores();
    admitChoiceInput(graph, "submission-latest-review");
    const humanEvent = event(1, { type: "human_message", message_id: "human-latest-review", text: "choose next", truncated: false, submission_id: "submission-latest-review" });
    const none = { ...event(2, { type: "message", message_id: "none-before-review", channel: "commentary", text: v3NoneFence(), truncated: false }), turnId: humanEvent.turnId };
    const review = { ...event(3, { type: "message", message_id: "review-after-none", channel: "commentary", text: v3ReviewFence("Later review?"), truncated: false }), turnId: humanEvent.turnId };
    const finalEvent = { ...event(4, { type: "message", message_id: "final-latest-review", channel: "final", text: "Done.", truncated: false }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(5, { type: "turn_completed" }), turnId: humanEvent.turnId };

    expect(graph.coreEvents.ingestBatch({ laneId: "lane-latest-review", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [humanEvent, none, review, finalEvent, terminalEvent], ingestedAt: terminalEvent.occurredAt })).toBe("accepted");
    expect(context.database.prepare("SELECT question FROM completion_choice_specifications WHERE owner_kind='primary-segment'").get()).toEqual({ question: "Later review?" });
    context.close();
  });

  it("uses Core lane sequence instead of timestamps or event IDs for commentary precedence", () => {
    const { context, graph } = stores();
    admitChoiceInput(graph, "submission-lane-order");
    const humanEvent = event(1, { type: "human_message", message_id: "human-lane-order", text: "choose next", truncated: false, submission_id: "submission-lane-order" });
    const review = { ...event(2, { type: "message", message_id: "review-lane-order", channel: "commentary", text: v3ReviewFence(), truncated: false }), eventId: "z-review", occurredAt: "2026-10-04T00:01:00.000Z", turnId: humanEvent.turnId };
    const none = { ...event(3, { type: "message", message_id: "none-lane-order", channel: "commentary", text: v3NoneFence(), truncated: false }), eventId: "a-none", occurredAt: "2026-10-04T00:00:00.000Z", turnId: humanEvent.turnId };
    const finalEvent = { ...event(4, { type: "message", message_id: "final-lane-order", channel: "final", text: "Done.", truncated: false }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(5, { type: "turn_completed" }), turnId: humanEvent.turnId };

    expect(graph.coreEvents.ingestBatch({ laneId: "lane-order", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [humanEvent, review, none, finalEvent, terminalEvent], ingestedAt: terminalEvent.occurredAt })).toBe("accepted");
    expect(completionChoiceCount(context)).toBe(1);
    context.close();
  });

  it("keeps a valid native final choice authoritative over textual evidence", () => {
    const { context, graph } = stores();
    admitChoiceInput(graph, "submission-native-wins");
    const humanEvent = event(1, { type: "human_message", message_id: "human-native-wins", text: "choose next", truncated: false, submission_id: "submission-native-wins" });
    const none = { ...event(2, { type: "message", message_id: "none-before-native", channel: "commentary", text: v3NoneFence(), truncated: false }), turnId: humanEvent.turnId };
    const finalEvent = { ...event(3, { type: "message", message_id: "final-native-wins", channel: "final", text: "Done.", truncated: false,
      completion_choice: { version: 2, intent: "human_review", question: "Native review?", default: "approve", options: [{ id: "approve", label: "Approve", message: "default" }] }
    }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(4, { type: "turn_completed" }), turnId: humanEvent.turnId };

    expect(graph.coreEvents.ingestBatch({ laneId: "lane-native-wins", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [humanEvent, none, finalEvent, terminalEvent], ingestedAt: terminalEvent.occurredAt })).toBe("accepted");
    expect(context.database.prepare("SELECT question FROM completion_choice_specifications WHERE owner_kind='primary-segment'").get()).toEqual({ question: "Native review?" });
    context.close();
  });

  it("fails closed when present native final metadata is malformed", () => {
    const { context, graph } = stores();
    admitChoiceInput(graph, "submission-malformed-native");
    const humanEvent = event(1, { type: "human_message", message_id: "human-malformed-native", text: "choose next", truncated: false, submission_id: "submission-malformed-native" });
    const review = { ...event(2, { type: "message", message_id: "review-before-malformed-native", channel: "commentary", text: v3ReviewFence(), truncated: false }), turnId: humanEvent.turnId };
    const finalEvent = { ...event(3, { type: "message", message_id: "final-malformed-native", channel: "final", text: "Done.", truncated: false,
      completion_choice: { version: 2, intent: "human_review", question: "Initial native review?", default: "approve", options: [{ id: "approve", label: "Approve", message: "default" }] }
    }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(4, { type: "turn_completed" }), turnId: humanEvent.turnId };

    expect(graph.coreEvents.ingestBatch({ laneId: "lane-malformed-native", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: finalEvent.cursor, latestCursor: finalEvent.cursor, events: [humanEvent, review, finalEvent], ingestedAt: finalEvent.occurredAt })).toBe("accepted");
    const storedFinal = context.database.prepare("SELECT event_json FROM core_event_inbox WHERE event_id=?").get(finalEvent.eventId) as { event_json:string };
    const malformed = JSON.parse(storedFinal.event_json) as { payload: Record<string, unknown> };
    malformed.payload.completion_choice = { version: 2 };
    context.database.prepare("UPDATE core_event_inbox SET event_json=? WHERE event_id=?").run(JSON.stringify(malformed), finalEvent.eventId);
    expect(graph.coreEvents.ingestBatch({ laneId: "lane-malformed-native", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: finalEvent.cursor, nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [terminalEvent], ingestedAt: terminalEvent.occurredAt })).toBe("accepted");
    expect(completionChoiceCount(context)).toBe(0);
    context.close();
  });

  it("fails closed when native final metadata is a text scalar containing a valid choice", () => {
    const { context, graph } = stores();
    admitChoiceInput(graph, "submission-string-native");
    const humanEvent = event(1, { type: "human_message", message_id: "human-string-native", text: "choose next", truncated: false, submission_id: "submission-string-native" });
    const review = { ...event(2, { type: "message", message_id: "review-before-string-native", channel: "commentary", text: v3ReviewFence(), truncated: false }), turnId: humanEvent.turnId };
    const nativeChoice = { version: 2, intent: "human_review", question: "String-wrapped review?", default: "approve", options: [{ id: "approve", label: "Approve", message: "default" }] };
    const finalEvent = { ...event(3, { type: "message", message_id: "final-string-native", channel: "final", text: "Done.", truncated: false,
      completion_choice: nativeChoice
    }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(4, { type: "turn_completed" }), turnId: humanEvent.turnId };

    expect(graph.coreEvents.ingestBatch({ laneId: "lane-string-native", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: finalEvent.cursor, latestCursor: finalEvent.cursor, events: [humanEvent, review, finalEvent], ingestedAt: finalEvent.occurredAt })).toBe("accepted");
    const storedFinal = context.database.prepare("SELECT event_json FROM core_event_inbox WHERE event_id=?").get(finalEvent.eventId) as { event_json:string };
    const malformed = JSON.parse(storedFinal.event_json) as { payload: Record<string, unknown> };
    malformed.payload.completion_choice = JSON.stringify(nativeChoice);
    context.database.prepare("UPDATE core_event_inbox SET event_json=? WHERE event_id=?").run(JSON.stringify(malformed), finalEvent.eventId);
    expect(graph.coreEvents.ingestBatch({ laneId: "lane-string-native", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: finalEvent.cursor, nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [terminalEvent], ingestedAt: terminalEvent.occurredAt })).toBe("accepted");
    expect(completionChoiceCount(context)).toBe(0);
    context.close();
  });

  it("excludes v1, truncated, and invalid textual choice evidence without clearing a valid review", () => {
    const excludedOnly = stores();
    admitChoiceInput(excludedOnly.graph, "submission-excluded-only");
    const excludedHuman = event(1, { type: "human_message", message_id: "human-excluded-only", text: "choose next", truncated: false, submission_id: "submission-excluded-only" });
    const v1 = { ...event(2, { type: "message", message_id: "v1-review", channel: "commentary", text: "```herdr-choice-list\n{\"version\":1,\"default\":\"approve\",\"options\":[{\"id\":\"approve\",\"label\":\"Approve\",\"message\":\"default\"},{\"id\":\"revise\",\"label\":\"Revise\",\"message\":\"Revise\"}]}\n```", truncated: false }), turnId: excludedHuman.turnId };
    const truncated = { ...event(3, { type: "message", message_id: "truncated-review", channel: "commentary", text: v3ReviewFence(), truncated: true }), turnId: excludedHuman.turnId };
    const invalid = { ...event(4, { type: "message", message_id: "invalid-review", channel: "commentary", text: "```herdr-choice-list\n{\"version\":3,\"choice\":{}}\n```", truncated: false }), turnId: excludedHuman.turnId };
    const excludedFinal = { ...event(5, { type: "message", message_id: "final-excluded-only", channel: "final", text: "Done.", truncated: false }), turnId: excludedHuman.turnId };
    const excludedTerminal = { ...event(6, { type: "turn_completed" }), turnId: excludedHuman.turnId };
    expect(excludedOnly.graph.coreEvents.ingestBatch({ laneId: "lane-excluded-only", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: excludedTerminal.cursor, latestCursor: excludedTerminal.cursor, events: [excludedHuman, v1, truncated, invalid, excludedFinal, excludedTerminal], ingestedAt: excludedTerminal.occurredAt })).toBe("accepted");
    expect(completionChoiceCount(excludedOnly.context)).toBe(0);
    excludedOnly.context.close();

    const retained = stores();
    admitChoiceInput(retained.graph, "submission-excluded-clear");
    const retainedHuman = event(1, { type: "human_message", message_id: "human-excluded-clear", text: "choose next", truncated: false, submission_id: "submission-excluded-clear" });
    const valid = { ...event(2, { type: "message", message_id: "valid-review", channel: "commentary", text: v3ReviewFence("Retained review?"), truncated: false }), turnId: retainedHuman.turnId };
    const v1None = { ...event(3, { type: "message", message_id: "v1-none", channel: "commentary", text: "```herdr-choice-list\n{\"version\":1}\n```", truncated: false }), turnId: retainedHuman.turnId };
    const truncatedNone = { ...event(4, { type: "message", message_id: "truncated-none", channel: "commentary", text: v3NoneFence(), truncated: true }), turnId: retainedHuman.turnId };
    const invalidNone = { ...event(5, { type: "message", message_id: "invalid-none", channel: "commentary", text: "```herdr-choice-list\n{\"version\":3,\"extra\":true}\n```", truncated: false }), turnId: retainedHuman.turnId };
    const retainedFinal = { ...event(6, { type: "message", message_id: "final-excluded-clear", channel: "final", text: "Done.", truncated: false }), turnId: retainedHuman.turnId };
    const retainedTerminal = { ...event(7, { type: "turn_completed" }), turnId: retainedHuman.turnId };
    expect(retained.graph.coreEvents.ingestBatch({ laneId: "lane-excluded-clear", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: retainedTerminal.cursor, latestCursor: retainedTerminal.cursor, events: [retainedHuman, valid, v1None, truncatedNone, invalidNone, retainedFinal, retainedTerminal], ingestedAt: retainedTerminal.occurredAt })).toBe("accepted");
    expect(retained.context.database.prepare("SELECT question FROM completion_choice_specifications WHERE owner_kind='primary-segment'").get()).toEqual({ question: "Retained review?" });
    retained.context.close();
  });

  it("uses only the trusted Submission Intent actor for a final marker notification", () => {
    const { context, graph } = stores();
    admitChoiceInput(graph, "submission-trusted-marker", "ou_trusted_actor");
    const humanEvent = event(1, { type: "human_message", message_id: "human-trusted-marker", text: "choose next", truncated: false, submission_id: "submission-trusted-marker" });
    const finalEvent = { ...event(2, { type: "message", message_id: "final-trusted-marker", channel: "final", text: "Done.\n<at id=ou_embedded_untrusted></at>", truncated: false }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(3, { type: "turn_completed" }), turnId: humanEvent.turnId };

    expect(graph.coreEvents.ingestBatch({ laneId: "lane-trusted-marker", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [humanEvent, finalEvent, terminalEvent], ingestedAt: terminalEvent.occurredAt })).toBe("accepted");
    expect(context.database.prepare("SELECT mention_open_id FROM completion_notification_obligations WHERE owner_kind='primary-segment'").get()).toEqual({ mention_open_id: "ou_trusted_actor" });
    context.close();
  });

  it("creates and activates one fresh authoritative Primary Segment review card", async () => {
    const { context, graph, segment, action } = await completedChoiceSegment({ finalEventId: "event:fresh-review:2", freshReview: true });
    const review = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
      projectionKey === `completion-review:${action.id}:surface:1`
    );
    const finalAnswer = context.database.prepare(`SELECT payload FROM outbound_replies
      WHERE projection_key=? ORDER BY delivery_order DESC LIMIT 1`).get(`turn-card:${segment.id}:page:0`) as { payload: string };

    expect(JSON.stringify(JSON.parse(finalAnswer.payload))).not.toContain("completion_action");
    expect(JSON.stringify(JSON.parse(finalAnswer.payload))).not.toContain("<at id=ou_choice_actor></at>");
    expect(review).toMatchObject({ kind: "card_reply", rootMessageId: "root-a", targetRole: "operation_result" });
    const frozenReview = JSON.parse(review!.payload);
    const reviewPayload = JSON.stringify(materializeFeishuPresentationView(frozenReview));
    expect(JSON.stringify(frozenReview)).not.toContain("<at");
    expect(reviewPayload).toContain("<at id=ou_choice_actor></at>");
    expect(reviewPayload).toContain("Which path?");
    expect(reviewPayload).toContain('"optionId":"approve"');
    expect(reviewPayload).toContain('"optionId":"revise"');
    expect(reviewPayload).toContain('"optionId":"ignore"');
    expect(reviewPayload).not.toContain("cardMessageId");
    expect(context.database.prepare(`SELECT presentation_kind,state,presentation_reply_id,presentation_message_id,presentation_card_id
      FROM completion_action_sets WHERE id=?`).get(action.id)).toEqual({
        presentation_kind: "fresh-card", state: "presenting", presentation_reply_id: review!.id,
        presentation_message_id: null, presentation_card_id: null
      });
    expect(graph.outbox.listPendingOutboundReplies().filter(({ kind }) => kind === "text")).toHaveLength(0);

    expect(graph.outbox.markOutboundReplyDelivered(review!.id, "review-message", "review-card")).toBe(true);
    expect(context.database.prepare(`SELECT state,presentation_message_id,presentation_card_id
      FROM completion_action_sets WHERE id=?`).get(action.id)).toEqual({
        state: "active", presentation_message_id: "review-message", presentation_card_id: "review-card"
      });

    const interactions = segmentCardInteractions(graph);
    await expect(interactions.invoke({ action: "completion_action", actionSetId: action.id, optionId: "approve" }, { messageId: "review-message" }))
      .resolves.toMatchObject({ toast: { type: "success", content: "已提交选择。" } });
    expect(interactions.resume).toHaveBeenCalledTimes(1);
    expect(context.database.prepare("SELECT state,selected_choice_option_id FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({
      state: "consumed", selected_choice_option_id: "approve"
    });
    context.close();
  });

  it("converges only an immutable exact fresh-card reservation replay", async () => {
    const { context, graph, segment, action } = await completedChoiceSegment({ finalEventId: "event:fresh-review-replay:2", freshReview: true });
    const linked = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
      projectionKey === `completion-review:${action.id}:surface:1`
    )!;
    const choice = context.database.prepare("SELECT choice_specification_id FROM completion_action_sets WHERE id=?").get(action.id) as { choice_specification_id: string };
    const reviews = new SqliteCompletionReviewStore(context);
    const exact = {
      segmentId: segment.id, ownerGeneration: 1, bindingId: "binding-a", bindingGeneration: 1,
      pageIndex: 0, mentionOpenId: "ou_choice_actor", choiceSpecificationId: choice.choice_specification_id,
      rootMessageId: "root-a", card: JSON.parse(linked.payload), reserveDelivery: graph.outbox
    };

    expect(reviews.reservePrimarySegment(exact)).toEqual({ actionSetId: action.id, receipt: null });
    const conflicts = [
      { ...exact, ownerGeneration: 2 },
      { ...exact, bindingId: "other-binding" },
      { ...exact, bindingGeneration: 2 },
      { ...exact, pageIndex: 1 },
      { ...exact, mentionOpenId: "ou_other" },
      { ...exact, choiceSpecificationId: "other-choice" },
      { ...exact, rootMessageId: "other-root" },
      { ...exact, card: { changed: true } }
    ];
    for (const conflict of conflicts) {
      expect(() => reviews.reservePrimarySegment(conflict)).toThrow("immutable replay conflict");
    }
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM completion_action_sets WHERE owner_kind='primary-segment' AND owner_id=?").get(segment.id)).toEqual({ count: 1 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key=?").get(linked.projectionKey)).toEqual({ count: 1 });
    context.close();
  });

  it("makes exact ACK replay convergent and rolls back conflicting ACK identity", async () => {
    const { context, graph, action } = await completedChoiceSegment({ finalEventId: "event:fresh-review-ack:2", freshReview: true });
    const review = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
      projectionKey === `completion-review:${action.id}:surface:1`
    )!;
    expect(graph.outbox.checkpointOutboundReplyCard(review.id, "review-card")).not.toBeNull();
    expect(() => graph.outbox.markOutboundReplyDelivered(review.id, "wrong-message", "wrong-card")).toThrow("Completion Review ACK identity conflict");
    expect(context.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(review.id)).toEqual({ state: "pending" });
    expect(context.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "presenting" });

    expect(graph.outbox.markOutboundReplyDelivered(review.id, "review-message", "review-card")).toBe(true);
    const reviews = new SqliteCompletionReviewStore(context);
    expect(reviews.activatePresentation({ replyId: review.id, messageId: "review-message", cardId: "review-card", occurredAt: "2026-10-04T00:00:05.000Z" }))
      .toEqual({ outcome: "already_active" });
    expect(graph.outbox.markOutboundReplyDelivered(review.id, "review-message", "review-card")).toBe(false);
    expect(() => graph.outbox.markOutboundReplyDelivered(review.id, "other-message", "review-card")).toThrow("Completion Review ACK identity conflict");
    expect(context.database.prepare("SELECT state,delivered_message_id,card_id_checkpoint FROM outbound_replies WHERE id=?").get(review.id)).toEqual({
      state: "delivered", delivered_message_id: "review-message", card_id_checkpoint: "review-card"
    });
    expect(context.database.prepare("SELECT state,presentation_message_id,presentation_card_id FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({
      state: "active", presentation_message_id: "review-message", presentation_card_id: "review-card"
    });
    context.close();
  });

  it("opens a durable projection gap after a Completion Review ACK identity conflict", async () => {
    const { context, graph, segment, action } = await completedChoiceSegment({ finalEventId: "event:fresh-review-ack-gap:2", freshReview: true });
    const review = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
      projectionKey === `completion-review:${action.id}:surface:1`
    )!;
    expect(graph.outbox.checkpointOutboundReplyCard(review.id, "review-card")).not.toBeNull();
    expect(() => graph.outbox.markOutboundReplyDelivered(review.id, "wrong-message", "wrong-card")).toThrow("Completion Review ACK identity conflict");

    expect(graph.outbox.markOutboundReplyFailedWithQuarantine(review.id, "Completion Review ACK identity conflict", {
      failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null
    })).not.toBeNull();
    expect(context.database.prepare(`SELECT stage,owner_kind,owner_id,state,source_item_id
      FROM projection_gaps WHERE source_item_id=?`).get(review.id)).toEqual({
        stage: "turn_recovery", owner_kind: "turn_card", owner_id: segment.id,
        state: "open", source_item_id: review.id
      });
    expect(context.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "presenting" });
    context.close();
  });

  it("adopts a delivered fresh-card row after restart without replaying the external effect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fresh-review-delivered-adoption-"));
    const databasePath = join(directory, "bridge.db");
    try {
      const first = await completedChoiceSegment({ finalEventId: "event:fresh-review-adopt:2", databasePath, freshReview: true });
      const review = first.graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
        projectionKey === `completion-review:${first.action.id}:surface:1`
      )!;
      first.context.database.prepare(`UPDATE outbound_replies SET state='delivered',delivered_message_id='review-message',
        card_id_checkpoint='review-card',attempt_count=1 WHERE id=?`).run(review.id);
      first.context.close();

      const reopened = new SqliteCapabilityGraph(databasePath);
      connectPreparedGraph(reopened);
      expect(reopened.conversationSegments.preparePrimarySegmentCompletionActionSet({
        segmentId: first.segment.id, pageIndex: 0, cardId: "card-choice", messageId: "turn-choice",
        card: JSON.parse(review.payload)
      })).not.toBeNull();
      expect(reopened.context.database.prepare("SELECT state,presentation_message_id,presentation_card_id FROM completion_action_sets WHERE id=?").get(first.action.id)).toEqual({
        state: "active", presentation_message_id: "review-message", presentation_card_id: "review-card"
      });
      expect(reopened.context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key=?").get(review.projectionKey)).toEqual({ count: 1 });
      reopened.context.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the fresh Action Set when its card Delivery Intent cannot be reserved", async () => {
    let captured: ReturnType<typeof stores> | null = null;
    await expect(completedChoiceSegment({
      finalEventId: "event:fresh-review-rollback:2",
      freshReview: true,
      beforeConverge: (fixture) => {
        captured = fixture;
        fixture.context.database.exec(`CREATE TEMP TRIGGER reject_completion_review BEFORE INSERT ON outbound_replies
          WHEN NEW.projection_key LIKE 'completion-review:%' BEGIN SELECT RAISE(ABORT, 'forced completion review rollback'); END`);
      },
    })).rejects.toThrow("forced completion review rollback");
    expect(captured).not.toBeNull();
    expect(captured!.context.database.prepare("SELECT COUNT(*) AS count FROM completion_action_sets").get()).toEqual({ count: 0 });
    expect(captured!.context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'completion-review:%'").get()).toEqual({ count: 0 });
    captured!.context.close();
  });

  it("rejects fresh review callbacks before ACK and from the wrong message, chat, actor, or option", async () => {
    const { context, graph, action } = await completedChoiceSegment({ finalEventId: "event:fresh-review-reject:2", freshReview: true });
    const review = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
      projectionKey === `completion-review:${action.id}:surface:1`
    )!;
    const interactions = segmentCardInteractions(graph);
    const value = { action: "completion_action", actionSetId: action.id, optionId: "approve" };

    await expect(interactions.invoke(value, { messageId: "review-message" })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(context.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "presenting" });
    expect(graph.outbox.markOutboundReplyDelivered(review.id, "review-message", "review-card")).toBe(true);
    await expect(interactions.invoke(value, { messageId: "wrong-message" })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(interactions.invoke(value, { messageId: "review-message", chatId: "wrong-chat" })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(interactions.invoke(value, { messageId: "review-message", operatorOpenId: "ou_other" })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(interactions.invoke({ ...value, optionId: "missing" }, { messageId: "review-message" })).resolves.toMatchObject({ toast: { type: "warning" } });
    context.database.prepare("UPDATE conversation_segments SET owner_generation=2 WHERE id=(SELECT owner_id FROM completion_action_sets WHERE id=?)").run(action.id);
    await expect(interactions.invoke(value, { messageId: "review-message" })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(context.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "active" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents WHERE source_message_key LIKE 'completion-choice:%'").get()).toEqual({ count: 0 });
    context.close();
  });

  it("consumes fresh review Ignore locally and preserves one pending card across restart or uncertain delivery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fresh-segment-review-restart-"));
    const databasePath = join(directory, "bridge.db");
    try {
      const first = await completedChoiceSegment({ finalEventId: "event:fresh-review-restart:2", databasePath, freshReview: true });
      const review = first.graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
        projectionKey === `completion-review:${first.action.id}:surface:1`
      )!;
      first.context.database.prepare("UPDATE outbound_replies SET effect_certainty='uncertain',attempt_count=1 WHERE id=?").run(review.id);
      first.context.close();

      const reopened = new SqliteCapabilityGraph(databasePath);
      connectPreparedGraph(reopened);
      const before = reopened.context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key=?").get(review.projectionKey);
      expect(reopened.conversationSegments.preparePrimarySegmentCompletionActionSet({
        segmentId: first.segment.id, pageIndex: 0, cardId: "card-choice", messageId: "turn-choice", card: JSON.parse(review.payload)
      })).not.toBeNull();
      expect(reopened.context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key=?").get(review.projectionKey)).toEqual(before);
      expect(reopened.outbox.markOutboundReplyDelivered(review.id, "review-message", "review-card")).toBe(true);

      const interactions = segmentCardInteractions(reopened);
      await expect(interactions.invoke({ action: "completion_action", actionSetId: first.action.id, optionId: "ignore" }, { messageId: "review-message" }))
        .resolves.toMatchObject({ toast: { type: "success", content: "已忽略。" } });
      expect(reopened.context.database.prepare("SELECT state,reason FROM completion_action_sets WHERE id=?").get(first.action.id)).toEqual({ state: "consumed", reason: "ignored" });
      expect(reopened.context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents WHERE source_message_key LIKE 'completion-choice:%'").get()).toEqual({ count: 0 });
      reopened.context.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns the exact consumed fresh-card result after Primary detach/session rotation and rejects a conflicting option", async () => {
    const { context, graph, segment, action } = await completedChoiceSegment({ finalEventId: "event:fresh-review-closed-duplicate:2", freshReview: true });
    const review = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
      projectionKey === `completion-review:${action.id}:surface:1`
    )!;
    expect(graph.outbox.markOutboundReplyDelivered(review.id, "review-message", "review-card")).toBe(true);
    const cardInteraction = graph.capabilityModules().cardInteraction;
    const decide = (overrides: Partial<{ messageId: string; chatId: string; actorOpenId: string }> = {}) => cardInteraction.decidePrimaryCompletionReview({
      actionSetId: action.id, optionId: "approve", messageId: "review-message",
      actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: "2026-10-04T00:00:04.000Z", ...overrides
    });
    expect(() => decide({ messageId: "wrong-message" })).toThrow("no longer available");
    expect(() => decide({ chatId: "wrong-chat" })).toThrow("no longer available");
    context.database.prepare("UPDATE bindings SET agent_session_value='rotated-session' WHERE id='binding-a'").run();
    expect(() => decide()).toThrow("no longer available");
    context.database.prepare("UPDATE bindings SET agent_session_value='session-1' WHERE id='binding-a'").run();
    const first = decide();
    expect(first).toMatchObject({ ownerKind: "primary-segment", kind: "submission", inserted: true });
    if (first.kind !== "submission") throw new Error("expected completion choice submission");
    expect(graph.agentInputs.get(first.submissionId)?.input).toEqual({
      schemaVersion: 2,
      text: "default",
      choice: { actionSetId: action.id, optionId: "approve", sourceMessageId: "review-message" }
    });
    const submit = vi.fn(async (input: { submissionId: string; paneId: string; terminalId: string; agentKind: "traex" | "pi"; sessionId: string | null }) => ({
      outcome: "receipt" as const,
      receipt: {
        submissionId: input.submissionId, paneId: input.paneId, terminalId: input.terminalId,
        agentKind: input.agentKind, sessionId: input.sessionId, state: "prepared" as const,
        turnId: null, startedAt: null, terminalState: null, createdAt: 1, updatedAt: 1
      }
    }));
    await expect(new AgentInputDrainer({
      store: graph.agentInputs,
      core: { capabilities: async () => ({ agentInputSubmissionV2: true, agentInputTypedMessageV1: true }), submit, queryReceipt: async () => ({ outcome: "absent" as const }) },
      now: () => "2026-10-04T00:00:04.500Z"
    }).drain(first.submissionId)).resolves.toMatchObject({ state: "prepared" });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      input: { schemaVersion: 2, text: "default", choice: { actionSetId: action.id, optionId: "approve", sourceMessageId: "review-message" } }
    }));
    context.database.prepare("UPDATE conversation_segments SET state='closed' WHERE id=?").run(segment.id);
    context.database.prepare(`UPDATE bindings SET attachment='unattached',session_epoch=2,
      traex_session_id='rotated-terminal',agent_session_value='rotated-session' WHERE id='binding-a'`).run();

    expect(graph.capabilityModules().cardInteraction.decidePrimaryCompletionReview({
      actionSetId: action.id, optionId: "approve", messageId: "review-message",
      actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: "2026-10-04T00:00:05.000Z"
    })).toEqual({ ...first, inserted: false });
    expect(() => graph.capabilityModules().cardInteraction.decidePrimaryCompletionReview({
      actionSetId: action.id, optionId: "approve", messageId: "review-message",
      actorOpenId: "ou_other", chatId: "chat", occurredAt: "2026-10-04T00:00:05.000Z"
    })).toThrow("no longer available");
    expect(() => graph.capabilityModules().cardInteraction.decidePrimaryCompletionReview({
      actionSetId: action.id, optionId: "revise", messageId: "review-message",
      actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: "2026-10-04T00:00:05.000Z"
    })).toThrow("no longer available");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents WHERE source_message_key LIKE 'completion-choice:%'").get()).toEqual({ count: 1 });
    context.close();
  });

  it.each([
    ["safe", "pending", "dismissed"],
    ["claimed", "pending", "pending"],
    ["uncertain", "pending", "pending"],
    ["delivered", "delivered", "delivered"]
  ] as const)("supersedes a fresh review while preserving %s delivery evidence", async (mode, initialState, expectedState) => {
    const fixture = await completedChoiceSegment({ finalEventId: `event:fresh-review-supersede-${mode}:2`, freshReview: true });
    const review = fixture.graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
      projectionKey === `completion-review:${fixture.action.id}:surface:1`
    )!;
    if (mode === "claimed") fixture.context.database.prepare(`UPDATE outbound_replies SET claim_attempt_id='claim',
      first_claimed_at='2026-10-04T00:00:04.000Z',claimed_at='2026-10-04T00:00:04.000Z' WHERE id=?`).run(review.id);
    if (mode === "uncertain") fixture.context.database.prepare("UPDATE outbound_replies SET attempt_count=1,effect_certainty='uncertain' WHERE id=?").run(review.id);
    if (mode === "delivered") fixture.context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='review-message',card_id_checkpoint='review-card' WHERE id=?").run(review.id);
    expect(fixture.context.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(review.id)).toEqual({ state: initialState });

    const next = event(4, { type: "human_message", message_id: `newer-${mode}`, text: "newer turn", truncated: false });
    expect(fixture.graph.coreEvents.ingestBatch({ laneId: "lane-choice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "core:3", nextCursor: next.cursor, latestCursor: next.cursor, events: [next], ingestedAt: next.occurredAt })).toBe("accepted");
    expect(fixture.context.database.prepare("SELECT state,reason FROM completion_action_sets WHERE id=?").get(fixture.action.id)).toEqual({ state: "superseded", reason: "newer-segment" });
    expect(fixture.context.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get(review.id)).toEqual({ state: expectedState });
    fixture.context.close();
  });

  it("uses the delivered message identity when a Primary Segment message-card has no CardKit card id", async () => {
    const { context, store, segment, finish, action } = await completedChoiceSegment({ finalEventId: "event:no-card-id", cardId: null });
    const payload = JSON.stringify(JSON.parse(finish.payload));

    expect(payload).toContain('"action":"completion_action"');
    expect(payload).toContain('"optionId":"approve"');
    expect(payload).toContain('"optionId":"revise"');
    expect(payload).toContain('"optionId":"ignore"');
    expect(context.database.prepare("SELECT card_id,card_message_id,state FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({
      card_id: "turn-choice", card_message_id: "turn-choice", state: "available"
    });
    expect(store.acceptPrimarySegmentCompletionChoice({
      actionSetId: action.id, optionId: "approve", ownerSegmentId: segment.id, ownerGeneration: 1,
      cardMessageId: "turn-choice", actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: "2026-10-04T00:00:04.000Z"
    })).toMatchObject({ segmentId: segment.id, inserted: true });
    context.close();
  });

  it("keeps Human Review inline without reserving a standalone choice reminder", async () => {
    const { context, store, graph, segment, finish, action } = await completedChoiceSegment({ withFinalRequest: true, finalEventId: "event:final:2" });
    expect(store.loadCompletionRenderState(segment.id)).toMatchObject({
      mentionOpenId: "ou_choice_actor", reason: "both"
    });
    expect(finish.payload.match(/<at id=ou_choice_actor><\/at>/g)).toHaveLength(1);
    expect(finish.payload).not.toContain("@_user_1");
    const delayedNotifications = graph.outbox.listPendingOutboundReplies().filter(({ kind }) => kind === "text");
    expect(delayedNotifications).toHaveLength(0);

    const laterFinal = { ...event(4, { type: "message", message_id: "later-final", channel: "final", text: "Late same-turn final.", truncated: false }), turnId: "turn-1" };
    expect(graph.coreEvents.ingestBatch({ laneId: "lane-choice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "core:3", nextCursor: laterFinal.cursor, latestCursor: laterFinal.cursor, events: [laterFinal], ingestedAt: laterFinal.occurredAt })).toBe("accepted");
    expect(graph.outbox.markOutboundReplyDelivered(finish.id, "turn-choice", "card-choice")).toBe(true);
    const notifications = graph.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("primary-segment-completion:"));
    expect(notifications).toHaveLength(0);
    expect(finish.idempotencyKey).toContain(encodeURIComponent("event:final:2"));
    const creation = context.database.prepare(`SELECT id FROM outbound_replies
      WHERE projection_key=? AND kind='card_reply' AND state='delivered' AND delivered_message_id=?`).get(finish.projectionKey,finish.rootMessageId) as { id:string };
    expect(context.database.prepare("SELECT prerequisite_reply_id,required_state FROM outbound_reply_prerequisites WHERE dependent_reply_id=?").all(finish.id)).toEqual([
      { prerequisite_reply_id:creation.id,required_state:"delivered" }
    ]);
    expect(graph.outbox.markOutboundReplyDelivered(finish.id, "turn-choice", "card-choice")).toBe(false);
    expect(graph.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("primary-segment-completion:"))).toHaveLength(0);
    expect(context.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='primary-segment' AND owner_id=?`).get(segment.id)).toMatchObject({
      state: "suppressed", notification_reply_id: null
    });
    expect(context.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "available" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_reply_prerequisites WHERE dependent_reply_id LIKE 'primary-segment-completion:%'").get()).toEqual({ count: 0 });
    context.close();
  });

  it("atomically retires a never-attempted legacy choice reminder and releases its prerequisite", async () => {
    const { context, store, graph, segment, finish, action } = await completedChoiceSegment({ withFinalRequest: true, finalEventId: "event:safe-retirement:2" });
    attachLegacyChoiceReminder(context, graph, {
      segmentId: segment.id, presentationReplyId: finish.id, reminderId: "legacy-choice-reminder-safe"
    });

    expect(graph.outbox.markOutboundReplyDelivered(finish.id, "turn-choice", "card-choice")).toBe(true);
    expect(context.database.prepare("SELECT state,error FROM outbound_replies WHERE id='legacy-choice-reminder-safe'").get()).toEqual({
      state: "dismissed", error: "Human Review mention became obsolete before first delivery attempt"
    });
    expect(context.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='primary-segment' AND owner_id=?`).get(segment.id)).toEqual({ state: "suppressed", notification_reply_id: null });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_reply_prerequisites WHERE dependent_reply_id='legacy-choice-reminder-safe'").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "available" });
    expect(store.loadCompletionRenderState(segment.id)).toMatchObject({
      mentionOpenId: "ou_choice_actor", completionActions: { id: action.id, state: "available" }
    });
    context.close();
  });

  it("preserves a standalone reminder when the exact delivered card omits the current Action Set", async () => {
    const { context, graph, segment, finish, action } = await completedChoiceSegment({ withFinalRequest: true, finalEventId: "event:stale-inline:2" });
    const stalePresentation = graph.outbox.enqueueOutboundReply({
      id: "stale-inline-presentation", idempotencyKey: "stale-inline-presentation",
      bindingId: "binding-a", bindingGeneration: 1, rootMessageId: finish.rootMessageId!,
      kind: "card_update", payload: finish.payload.replace(action.id, "stale-action-set"),
      projectionKey: finish.projectionKey!, snapshotRevision: 2
    });
    attachLegacyChoiceReminder(context, graph, {
      segmentId: segment.id, presentationReplyId: stalePresentation.id, reminderId: "legacy-choice-reminder-stale-inline"
    });

    expect(graph.outbox.markOutboundReplyDelivered(stalePresentation.id, "turn-choice", "card-choice")).toBe(true);
    expect(context.database.prepare("SELECT state,error FROM outbound_replies WHERE id='legacy-choice-reminder-stale-inline'").get()).toEqual({
      state: "pending", error: null
    });
    expect(context.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='primary-segment' AND owner_id=?`).get(segment.id)).toEqual({
      state: "waiting_for_answer", notification_reply_id: "legacy-choice-reminder-stale-inline"
    });
    expect(context.database.prepare("SELECT prerequisite_reply_id FROM outbound_reply_prerequisites WHERE dependent_reply_id='legacy-choice-reminder-stale-inline'").get()).toEqual({
      prerequisite_reply_id: stalePresentation.id
    });
    expect(context.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "available" });
    context.close();
  });

  it("preserves claimed, attempted, checkpointed, uncertain, and delivered reminder history unchanged", async () => {
    const cases: Array<{ label: string; mutate(context: SqliteContext, reminderId: string): void }> = [
      { label: "claimed", mutate: (context, id) => { context.database.prepare(`UPDATE outbound_replies SET
        claim_attempt_id='claim',claimed_owner_id='owner',claimed_fence=1,claimed_at='2026-10-04T00:00:06.000Z',first_claimed_at='2026-10-04T00:00:06.000Z'
        WHERE id=?`).run(id); } },
      { label: "attempted", mutate: (context, id) => { context.database.prepare("UPDATE outbound_replies SET attempt_count=1 WHERE id=?").run(id); } },
      { label: "card-checkpointed", mutate: (context, id) => { context.database.prepare("UPDATE outbound_replies SET card_id_checkpoint='card-remote' WHERE id=?").run(id); } },
      { label: "gateway-checkpointed", mutate: (context, id) => { context.database.prepare("UPDATE outbound_replies SET gateway_checkpoint_json='{}' WHERE id=?").run(id); } },
      { label: "uncertain", mutate: (context, id) => { context.database.prepare("UPDATE outbound_replies SET effect_certainty='uncertain' WHERE id=?").run(id); } },
      { label: "delivered", mutate: (context, id) => { context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='remote-message' WHERE id=?").run(id); } }
    ];
    for (const testCase of cases) {
      const fixture = await completedChoiceSegment({ withFinalRequest: true, finalEventId: `event:unsafe-${testCase.label}:2` });
      const reminderId = `legacy-choice-reminder-${testCase.label}`;
      attachLegacyChoiceReminder(fixture.context, fixture.graph, {
        segmentId: fixture.segment.id, presentationReplyId: fixture.finish.id, reminderId
      });
      testCase.mutate(fixture.context, reminderId);
      const beforeReply = fixture.context.database.prepare(`SELECT state,attempt_count,claim_attempt_id,first_claimed_at,
        delivered_message_id,card_id_checkpoint,gateway_checkpoint_json,effect_certainty FROM outbound_replies WHERE id=?`).get(reminderId);
      const beforeEdge = fixture.context.database.prepare("SELECT * FROM outbound_reply_prerequisites WHERE dependent_reply_id=?").get(reminderId);

      expect(fixture.graph.outbox.markOutboundReplyDelivered(fixture.finish.id, "turn-choice", "card-choice"), testCase.label).toBe(true);
      expect(fixture.context.database.prepare(`SELECT state,attempt_count,claim_attempt_id,first_claimed_at,
        delivered_message_id,card_id_checkpoint,gateway_checkpoint_json,effect_certainty FROM outbound_replies WHERE id=?`).get(reminderId)).toEqual(beforeReply);
      expect(fixture.context.database.prepare("SELECT * FROM outbound_reply_prerequisites WHERE dependent_reply_id=?").get(reminderId)).toEqual(beforeEdge);
      expect(fixture.context.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
        WHERE owner_kind='primary-segment' AND owner_id=?`).get(fixture.segment.id)).toEqual({
          state: "released", notification_reply_id: reminderId
        });
      fixture.context.close();
    }
  });

  it("does not recreate a suppressed choice reminder after restart or repeated exact ACK convergence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "segment-choice-restart-"));
    const databasePath = join(directory, "bridge.db");
    try {
      const first = await completedChoiceSegment({ withFinalRequest: true, finalEventId: "event:restart:2", databasePath });
      expect(first.graph.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) =>
        idempotencyKey.startsWith("primary-segment-completion:"))).toHaveLength(0);
      first.context.close();

      const reopened = new SqliteCapabilityGraph(databasePath);
      connectPreparedGraph(reopened);
      expect(reopened.outbox.markOutboundReplyDelivered(first.finish.id, "turn-choice", "card-choice")).toBe(true);
      expect(reopened.context.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
        WHERE owner_kind='primary-segment' AND owner_id=?`).get(first.segment.id)).toEqual({
          state: "suppressed", notification_reply_id: null
        });
      expect(reopened.conversationSegments.recoverPrimarySegmentCompletionNotification(first.segment.id)).toEqual({
        outcome: "not_ready", reason: "obligation_not_waiting"
      });
      expect(reopened.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) =>
        idempotencyKey.startsWith("primary-segment-completion:"))).toHaveLength(0);
      reopened.context.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a replacement inline choice card free of obsolete reminder prerequisites", async () => {
    const { context, graph, segment, finish, action } = await completedChoiceSegment({ withFinalRequest: true, finalEventId: "event:transfer:2" });
    const replacement = graph.outbox.enqueueOutboundReply({
      id: "exact-finish-replacement", idempotencyKey: "exact-finish-replacement", bindingId: "binding-a", bindingGeneration: 1,
      rootMessageId: finish.rootMessageId!, kind: "card_update", payload: finish.payload,
      projectionKey: finish.projectionKey!, snapshotRevision: 2
    });
    transferDeliveryPrerequisites(context, finish.id, replacement.id);
    expect(graph.outbox.markOutboundReplyDelivered(replacement.id, "turn-choice", "card-choice")).toBe(true);
    expect(context.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "available" });
    expect(context.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='primary-segment' AND owner_id=?`).get(segment.id)).toEqual({ state: "suppressed", notification_reply_id: null });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_reply_prerequisites WHERE dependent_reply_id LIKE 'primary-segment-completion:%'").get()).toEqual({ count: 0 });
    context.close();
  });

  it("does not recover a choice reminder after the page pointer is cleared", async () => {
    const { context, store, graph, workflow, segment, finish } = await completedChoiceSegment({ withFinalRequest: true, finalEventId: "event:final:2" });
    context.database.prepare(`UPDATE conversation_segment_pages SET pending_reply_id=NULL
      WHERE segment_id=? AND page_index=0 AND pending_reply_id=?`).run(segment.id, finish.id);

    expect(store.recoverPrimarySegmentCompletionNotification(segment.id)).toEqual({ outcome: "not_ready", reason: "obligation_not_waiting" });

    context.database.prepare(`UPDATE outbound_replies SET state='delivered',delivered_message_id='turn-choice',
      card_id_checkpoint='card-choice',updated_at='2026-10-04T00:00:05.000Z' WHERE id=?`).run(finish.id);
    expect(store.listActionableConversationSegmentIds()).not.toContain(segment.id);

    expect(await workflow.convergeActionable()).toEqual([]);
    expect(graph.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) =>
      idempotencyKey.startsWith("primary-segment-completion:"))).toHaveLength(0);
    expect(context.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='primary-segment' AND owner_id=?`).get(segment.id)).toEqual({
      state: "suppressed", notification_reply_id: null
    });
    expect(store.recoverPrimarySegmentCompletionNotification(segment.id)).toEqual({ outcome: "not_ready", reason: "obligation_not_waiting" });

    expect(await workflow.convergeActionable()).toEqual([]);
    expect(graph.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) =>
      idempotencyKey.startsWith("primary-segment-completion:"))).toHaveLength(0);
    context.close();
  });

  it("keeps repeated choice-reminder recovery suppressed without any outbox reservation", async () => {
    const { context, store, segment, finish } = await completedChoiceSegment({ withFinalRequest: true, finalEventId: "event:final:2" });
    context.database.prepare(`UPDATE conversation_segment_pages SET pending_reply_id=NULL
      WHERE segment_id=? AND page_index=0 AND pending_reply_id=?`).run(segment.id, finish.id);
    context.database.prepare(`UPDATE outbound_replies SET state='delivered',delivered_message_id='turn-choice',
      card_id_checkpoint='card-choice',updated_at='2026-10-04T00:00:05.000Z' WHERE id=?`).run(finish.id);
    expect(store.recoverPrimarySegmentCompletionNotification(segment.id)).toEqual({ outcome: "not_ready", reason: "obligation_not_waiting" });
    expect(context.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='primary-segment' AND owner_id=?`).get(segment.id)).toEqual({
      state: "suppressed", notification_reply_id: null
    });
    expect(context.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies
      WHERE idempotency_key LIKE 'primary-segment-completion:%'`).get()).toEqual({ count: 0 });
    context.close();
  });

  it("supersedes old Segment actions and their unreleased notice on a newer turn", async () => {
    const { context, store, graph, segment, action } = await completedChoiceSegment();
    const next = event(4, { type: "human_message", message_id: "newer-human", text: "newer turn", truncated: false });
    expect(graph.coreEvents.ingestBatch({ laneId: "lane-choice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "core:3", nextCursor: next.cursor, latestCursor: next.cursor, events: [next], ingestedAt: next.occurredAt })).toBe("accepted");
    expect(context.database.prepare("SELECT state,reason FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "superseded", reason: "newer-segment" });
    expect(store.loadCompletionRenderState(segment.id)).toBeNull();
    expect(context.database.prepare("SELECT state FROM completion_notification_obligations WHERE owner_kind='primary-segment' AND owner_id=?").get(segment.id)).toEqual({ state: "suppressed" });
    expect(() => store.acceptPrimarySegmentCompletionChoice({ actionSetId: action.id, optionId: "approve", ownerSegmentId: segment.id, ownerGeneration: 1, cardMessageId: "turn-choice", actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: next.occurredAt })).toThrow("no longer available");
    context.close();
  });

  it("removes superseded Segment actions after an in-flight final-card update is acknowledged", async () => {
    const { context, store, graph, workflow, segment, finish, action } = await completedChoiceSegment();
    const next = event(4, { type: "human_message", message_id: "newer-during-finish", text: "newer turn", truncated: false });
    expect(graph.coreEvents.ingestBatch({ laneId: "lane-choice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "core:3", nextCursor: next.cursor, latestCursor: next.cursor, events: [next], ingestedAt: next.occurredAt })).toBe("accepted");
    expect(context.database.prepare("SELECT state,reason FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "superseded", reason: "newer-segment" });
    expect(context.database.prepare("SELECT state,pending_reply_id FROM conversation_segment_pages WHERE segment_id=? AND page_index=0").get(segment.id)).toEqual({ state: "finished", pending_reply_id: finish.id });

    expect(graph.outbox.markOutboundReplyDelivered(finish.id, "turn-choice", "card-choice")).toBe(true);
    expect(store.reconcilePageDelivery(segment.id, 0)).toBe("adopted");
    expect(context.database.prepare("SELECT state,pending_reply_id FROM conversation_segment_pages WHERE segment_id=? AND page_index=0").get(segment.id)).toEqual({ state: "active", pending_reply_id: null });
    expect(store.listActionableConversationSegmentIds()).toContain(segment.id);

    await workflow.converge(segment.id);
    const replacement = graph.outbox.listPendingOutboundReplies().find(({ idempotencyKey }) => idempotencyKey.startsWith(`segment:${segment.id}:page:0:finish:`));
    expect(replacement?.payload).not.toContain("<at id=ou_choice_actor></at>");
    expect(replacement?.payload).not.toContain("completion_action");
    expect(context.database.prepare("SELECT state FROM completion_notification_obligations WHERE owner_kind='primary-segment' AND owner_id=?").get(segment.id)).toEqual({ state: "suppressed" });
    context.close();
  });

  it("does not materialize stale Segment actions when a newer turn arrives before the final card", async () => {
    const { context, store, graph } = stores();
    context.database.prepare("UPDATE bindings SET traex_session_id='terminal-a' WHERE id='binding-a'").run();
    graph.agentInputs.admit({
      submissionId: "submission-raced-choice", ingressSource: "feishu:primary", sourceMessageKey: "source-raced-choice",
      actor: { kind: "human", id: "ou_choice_actor", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" },
      text: "choose before the next turn", owner: { kind: "primary", id: "binding-a", generation: 1 },
      paneId: "binding-a-pane", terminalId: "terminal-a", expectedAgentKind: "traex", expectedSessionId: "session-1",
      recordedAt: "2026-10-04T00:00:00.000Z"
    });
    const humanEvent = event(1, { type: "human_message", message_id: "human-raced-choice", text: "choose before the next turn", truncated: false, submission_id: "submission-raced-choice" });
    const finalEvent = { ...event(2, { type: "message", message_id: "final-raced-choice", channel: "final", text: "Choose.", truncated: false,
      completion_choice: { version: 2, intent: "human_review", question: "Continue?", default: "yes", options: [{ id: "yes", label: "Yes", message: "default" }] } }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(3, { type: "turn_completed" }), turnId: humanEvent.turnId };
    expect(graph.coreEvents.ingestBatch({ laneId: "lane-raced-choice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [humanEvent, finalEvent, terminalEvent], ingestedAt: terminalEvent.occurredAt })).toBe("accepted");
    const segment = store.listConversationSegmentsForProducer("lane:lane-raced-choice")[0]!;
    const next = event(4, { type: "human_message", message_id: "newer-raced-human", text: "newer turn", truncated: false });
    expect(graph.coreEvents.ingestBatch({ laneId: "lane-raced-choice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: terminalEvent.cursor, nextCursor: next.cursor, latestCursor: next.cursor, events: [next], ingestedAt: next.occurredAt })).toBe("accepted");
    expect(store.getConversationSegment(segment.id)?.state).toBe("closed");

    const create = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) => projectionKey === `turn-card:${segment.id}:page:0`)!;
    expect(graph.outbox.checkpointOutboundReplyCard(create.id, "card-raced-choice")).not.toBeNull();
    expect(graph.outbox.markOutboundReplyDelivered(create.id, "turn-raced-choice", "card-raced-choice")).toBe(true);
    expect(store.reconcilePageDelivery(segment.id, 0)).toBe("adopted");
    const workflow = new TurnCardWorkflow(store, () => {}, { turnCardPage: (view, page, options, limit) => planAndRenderTurnCard(view, page, options, limit) });
    await workflow.converge(segment.id);

    expect(context.database.prepare("SELECT COUNT(*) AS count FROM completion_action_sets WHERE owner_kind='primary-segment' AND owner_id=?").get(segment.id)).toEqual({ count: 0 });
    const finish = graph.outbox.listPendingOutboundReplies().find(({ idempotencyKey }) => idempotencyKey === `segment:${segment.id}:page:0:finish`)!;
    expect(finish.payload).not.toContain("completion_action");
    expect(context.database.prepare("SELECT state FROM completion_notification_obligations WHERE owner_kind='primary-segment' AND owner_id=?").get(segment.id)).toEqual({ state: "suppressed" });
    context.close();
  });

  it("fails closed when the Primary runtime session changes after an Action Set is created", async () => {
    const { context, store, segment, action } = await completedChoiceSegment();
    context.database.prepare("UPDATE bindings SET agent_session_value='replacement-session' WHERE id='binding-a'").run();

    expect(store.preparePrimarySegmentCompletionActionSet({
      segmentId: segment.id, pageIndex: 0, cardId: "card-choice", messageId: "turn-choice", card: {}
    })).toBeNull();
    expect(store.loadCompletionRenderState(segment.id)).toBeNull();
    expect(() => store.acceptPrimarySegmentCompletionChoice({
      actionSetId: action.id,
      optionId: "approve",
      ownerSegmentId: segment.id,
      ownerGeneration: 1,
      cardMessageId: "turn-choice",
      actorOpenId: "ou_choice_actor",
      chatId: "chat",
      occurredAt: "2026-10-04T00:00:04.000Z"
    })).toThrow("no longer available");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents WHERE source_message_key LIKE 'completion-choice:v1:%'").get()).toEqual({ count: 0 });
    context.close();
  });

  it("consumes Segment Ignore locally without admitting Agent Input", async () => {
    const { context, store, segment, action } = await completedChoiceSegment();
    const before = context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents").get();
    const ignored = store.ignorePrimarySegmentCompletionChoice({ actionSetId: action.id, ownerSegmentId: segment.id, ownerGeneration: 1, cardMessageId: "turn-choice", actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: "2026-10-04T00:00:04.000Z" });
    expect(ignored).toEqual({ ownerId: segment.id, changed: true });
    expect(store.ignorePrimarySegmentCompletionChoice({ actionSetId: action.id, ownerSegmentId: segment.id, ownerGeneration: 1, cardMessageId: "turn-choice", actorOpenId: "ou_choice_actor", chatId: "chat", occurredAt: "2026-10-04T00:00:05.000Z" })).toEqual({ ownerId: segment.id, changed: false });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents").get()).toEqual(before);
    expect(context.database.prepare("SELECT state,reason FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "consumed", reason: "ignored" });
    context.close();
  });

  it("routes an exact Segment choice through CardInteraction once and fails closed on forged callbacks", async () => {
    const { context, graph, segment, action } = await completedChoiceSegment();
    const interactions = segmentCardInteractions(graph);
    const value = { action: "completion_action", actionSetId: action.id, optionId: "revise", ownerKind: "primary-segment", ownerId: segment.id, ownerGeneration: 1, cardMessageId: "turn-choice" };

    await expect(interactions.invoke(value, { operatorOpenId: "ou_wrong" })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(interactions.invoke(value, { messageId: "wrong-card" })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(interactions.invoke({ ...value, ownerGeneration: 2 })).resolves.toMatchObject({ toast: { type: "warning" } });
    await expect(interactions.invoke({ ...value, optionId: "missing" })).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents WHERE source_message_key LIKE 'completion-choice:v1:%'").get()).toEqual({ count: 0 });
    expect(interactions.resume).not.toHaveBeenCalled();

    await expect(interactions.invoke(value)).resolves.toMatchObject({ toast: { type: "success", content: "已提交选择。" } });
    await expect(interactions.invoke(value)).resolves.toMatchObject({ toast: { type: "success", content: "已提交选择。" } });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents WHERE source_message_key LIKE 'completion-choice:v2:%'").get()).toEqual({ count: 1 });
    expect(interactions.resume).toHaveBeenCalledTimes(2);
    expect(interactions.resume).toHaveBeenNthCalledWith(1, completionChoiceSubmissionIdentity(action.id, "revise"));
    expect(interactions.resume).toHaveBeenNthCalledWith(2, completionChoiceSubmissionIdentity(action.id, "revise"));
    expect(interactions.convergeTurnCard).toHaveBeenCalledTimes(1);
    context.close();
  });

  it("routes Segment Ignore through CardInteraction without admitting Agent Input", async () => {
    const { context, graph, segment, action } = await completedChoiceSegment();
    const interactions = segmentCardInteractions(graph);
    const value = { action: "completion_action", actionSetId: action.id, optionId: "ignore", ownerKind: "primary-segment", ownerId: segment.id, ownerGeneration: 1, cardMessageId: "turn-choice" };
    const before = context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents").get();

    await expect(interactions.invoke(value)).resolves.toMatchObject({ toast: { type: "success", content: "已忽略。" } });
    await expect(interactions.invoke(value)).resolves.toMatchObject({ toast: { type: "success", content: "已忽略。" } });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents").get()).toEqual(before);
    expect(interactions.resume).not.toHaveBeenCalled();
    expect(interactions.convergeTurnCard).toHaveBeenCalledTimes(1);
    context.close();
  });

  it("rejects a superseded Segment callback and suppresses its stale notice", async () => {
    const { context, graph, segment, action } = await completedChoiceSegment();
    const interactions = segmentCardInteractions(graph);
    const next = event(4, { type: "human_message", message_id: "newer-human", text: "newer turn", truncated: false });
    expect(graph.coreEvents.ingestBatch({ laneId: "lane-choice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "core:3", nextCursor: next.cursor, latestCursor: next.cursor, events: [next], ingestedAt: next.occurredAt })).toBe("accepted");
    const value = { action: "completion_action", actionSetId: action.id, optionId: "approve", ownerKind: "primary-segment", ownerId: segment.id, ownerGeneration: 1, cardMessageId: "turn-choice" };

    await expect(interactions.invoke(value)).resolves.toMatchObject({ toast: { type: "warning" } });
    expect(interactions.resume).not.toHaveBeenCalled();
    expect(context.database.prepare("SELECT state FROM completion_notification_obligations WHERE owner_kind='primary-segment' AND owner_id=?").get(segment.id)).toEqual({ state: "suppressed" });
    expect(context.database.prepare("SELECT state,reason FROM completion_action_sets WHERE id=?").get(action.id)).toEqual({ state: "superseded", reason: "newer-segment" });
    context.close();
  });
  it("routes a native mention request to the Submission Intent actor", () => {
    const { context, store, graph } = stores();
    graph.agentInputs.admit({
      submissionId: "submission-completion-notice",
      ingressSource: "feishu:primary",
      sourceMessageKey: "source-completion-notice",
      actor: {
        kind: "human",
        id: "ou_requester",
        gatewayId: "feishu:primary",
        chatId: "chat",
        topicId: "topic-binding-a",
        rootMessageId: "root-a"
      },
      text: "finish this request",
      owner: { kind: "primary", id: "binding-a", generation: 1 },
      paneId: "binding-a-pane",
      terminalId: "terminal-a",
      expectedAgentKind: "traex",
      expectedSessionId: "session-1",
      recordedAt: "2026-10-04T00:00:00.000Z"
    });
    const humanEvent = event(1, {
        type: "human_message",
        message_id: "message-completion-notice",
        text: "finish this request",
        truncated: false,
        submission_id: "submission-completion-notice"
    });
    const finalEvent = { ...event(2, {
      type: "message", message_id: "final-forged-native", channel: "final",
      text: "Done.\n<at id=ou_someone_else></at>\n\n$herdr-choice-list:herdr-choice-list", truncated: false
    }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(3, { type: "turn_completed" }), turnId: humanEvent.turnId };
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-completion-notice",
      sourceId: "core",
      agentKind: "traex",
      sessionId: "session-1",
      afterCursor: "",
      nextCursor: terminalEvent.cursor,
      latestCursor: terminalEvent.cursor,
      events: [humanEvent, finalEvent, terminalEvent],
      ingestedAt: "2026-10-04T00:00:03.000Z"
    })).toBe("accepted");
    const [segment] = store.listConversationSegmentsForProducer("lane:lane-completion-notice");

    expect(segment).toMatchObject({ state: "completed", submissionId: "submission-completion-notice" });
    expect(context.database.prepare(`SELECT mention_open_id,notice_kind,state FROM completion_notification_obligations`).get()).toEqual({
      mention_open_id: "ou_requester", notice_kind: "completion", state: "waiting_for_answer"
    });
    context.close();
  });

  it.each(["legacy", "semantic", "provider-neutral"] as const)("derives the trusted requester mention without a visible final marker for %s delivery", async (deliveryCohort) => {
    const directory = mkdtempSync(join(tmpdir(), "segment-completion-notice-"));
    const databasePath = join(directory, "swarm.db");
    try {
      const { context, store, graph } = stores(databasePath);
      graph.agentInputs.admit({
        submissionId: "submission-ack-notice", ingressSource: "feishu:primary", sourceMessageKey: "source-ack-notice",
        actor: { kind: "human", id: "ou_exact_requester", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" },
        text: "finish and notify me", owner: { kind: "primary", id: "binding-a", generation: 1 },
        paneId: "binding-a-pane", terminalId: "terminal-a", expectedAgentKind: "traex", expectedSessionId: "session-1",
        recordedAt: "2026-10-04T00:00:00.000Z"
      });
      const humanEvent = event(1, { type: "human_message", message_id: "message-ack-notice", text: "finish and notify me", truncated: false, submission_id: "submission-ack-notice" });
      const finalEvent = { ...event(2, { type: "message", message_id: "final-ack-notice", channel: "final", text: "Done.", truncated: false }), turnId: humanEvent.turnId };
      const terminalEvent = { ...event(3, { type: "turn_completed" }), turnId: humanEvent.turnId };
      expect(graph.coreEvents.ingestBatch({ laneId: "lane-ack-notice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [humanEvent, finalEvent, terminalEvent], ingestedAt: "2026-10-04T00:00:03.000Z" })).toBe("accepted");
      const segment = store.listConversationSegmentsForProducer("lane:lane-ack-notice")[0]!;
      const create = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) => projectionKey === `turn-card:${segment.id}:page:0`)!;
      expect(graph.outbox.markOutboundReplyDelivered(create.id, "turn-message", "turn-card")).toBe(true);
      expect(store.reconcilePageDelivery(segment.id, 0)).toBe("adopted");

      if (deliveryCohort === "semantic") {
        const cohortTrigger = context.database.prepare(`SELECT sql FROM sqlite_master
          WHERE type='trigger' AND name='conversation_segment_pages_delivery_cohort_immutable'`).get() as { sql: string };
        context.database.exec("DROP TRIGGER conversation_segment_pages_delivery_cohort_immutable");
        context.database.prepare("UPDATE conversation_segment_pages SET delivery_cohort='semantic' WHERE segment_id=?").run(segment.id);
        context.database.exec(cohortTrigger.sql);
      }

      const workflow = new TurnCardWorkflow(store, () => {}, {
        turnCardPage: (view, page, options, limit) => {
          const planned = planAndRenderTurnCard(view, page, options, limit);
          if (deliveryCohort !== "provider-neutral") return planned;
          return {
            ...planned,
            card: {
              schemaVersion: 1,
              fallbackText: "Completed · Done.",
              heading: { title: "Completed", subtitle: "Done.", tone: "green" },
              nodes: [{ kind: "mention", userId: "ou_exact_requester", content: "请查看本卡片。" }]
            }
          };
        }
      }, 9_000, undefined, undefined, deliveryCohort === "semantic" ? turnCardPresentationPolicy : undefined);
      await workflow.converge(segment.id);
      const finish = graph.outbox.listPendingOutboundReplies().find(({ idempotencyKey }) => idempotencyKey.startsWith(`segment:${segment.id}:page:0:finish:final:`))!;
      if (deliveryCohort === "semantic") {
        expect(graph.preparedDeliveries.hydrateDeliveryInput(finish.id)).toMatchObject({
          status: "semantic-snapshot",
          input: { snapshot: { options: { completionNotice: { mentionOpenId: "ou_exact_requester", reason: "final_request" } } } }
        });
      } else if (deliveryCohort === "legacy") {
        expect(finish.payload).toContain("<at id=ou_exact_requester></at>");
        expect(finish.payload).not.toContain("completion_action");
      } else {
        expect(JSON.parse(finish.payload)).toMatchObject({
          nodes: [{ kind: "mention", userId: "ou_exact_requester", content: "请查看本卡片。" }]
        });
      }
      expect(graph.outbox.listPendingOutboundReplies().filter(({ kind }) => kind === "text")).toHaveLength(0);
      expect(context.database.prepare(`SELECT state,notification_reply_id
        FROM completion_notification_obligations WHERE owner_kind='primary-segment' AND owner_id=?`).get(segment.id)).toEqual({
          state: "suppressed", notification_reply_id: null
        });

      expect(graph.outbox.markOutboundReplyDelivered(finish.id, "turn-message", "turn-card")).toBe(true);
      expect(graph.outbox.markOutboundReplyDelivered(finish.id, "turn-message", "turn-card")).toBe(false);
      const notifications = graph.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("primary-segment-completion:"));
      expect(notifications).toHaveLength(0);
      expect(context.database.prepare(`SELECT state,notification_reply_id
        FROM completion_notification_obligations WHERE owner_kind='primary-segment' AND owner_id=?`).get(segment.id)).toEqual({
          state: "suppressed", notification_reply_id: null
        });
      const nextHuman = event(4, { type: "human_message", message_id: "message-newer", text: "newer turn", truncated: false });
      expect(graph.coreEvents.ingestBatch({ laneId: "lane-ack-notice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: terminalEvent.cursor, nextCursor: nextHuman.cursor, latestCursor: nextHuman.cursor, events: [nextHuman], ingestedAt: nextHuman.occurredAt })).toBe("accepted");
      expect(store.getConversationSegment(segment.id)?.state).toBe("closed");
      context.close();

      const reopened = new SqliteCapabilityGraph(databasePath);
      connectPreparedGraph(reopened);
      expect(reopened.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("primary-segment-completion:"))).toHaveLength(0);
      reopened.context.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the standalone fallback when the exact final presentation omits the trusted mention", async () => {
    const { context, store, graph } = stores();
    graph.agentInputs.admit({
      submissionId: "submission-fallback-notice", ingressSource: "feishu:primary", sourceMessageKey: "source-fallback-notice",
      actor: { kind: "human", id: "ou_fallback_requester", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" },
      text: "finish with fallback", owner: { kind: "primary", id: "binding-a", generation: 1 },
      paneId: "binding-a-pane", terminalId: "terminal-a", expectedAgentKind: "traex", expectedSessionId: "session-1",
      recordedAt: "2026-10-04T00:00:00.000Z"
    });
    const humanEvent = event(1, { type: "human_message", message_id: "message-fallback-notice", text: "finish with fallback", truncated: false, submission_id: "submission-fallback-notice" });
    const finalEvent = { ...event(2, { type: "message", message_id: "final-fallback-notice", channel: "final", text: "Done. @_user_1", truncated: false }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(3, { type: "turn_completed" }), turnId: humanEvent.turnId };
    expect(graph.coreEvents.ingestBatch({ laneId: "lane-fallback-notice", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [humanEvent, finalEvent, terminalEvent], ingestedAt: terminalEvent.occurredAt })).toBe("accepted");
    const segment = store.listConversationSegmentsForProducer("lane:lane-fallback-notice")[0]!;
    const create = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) => projectionKey === `turn-card:${segment.id}:page:0`)!;
    expect(graph.outbox.markOutboundReplyDelivered(create.id, "turn-fallback", "card-fallback")).toBe(true);
    expect(store.reconcilePageDelivery(segment.id, 0)).toBe("adopted");

    const workflow = new TurnCardWorkflow(store, () => {}, {
      turnCardPage: (view, page, options, limit) => {
        const planned = planAndRenderTurnCard(view, page, options, limit);
        const card = JSON.parse(JSON.stringify(planned.card).replace("<at id=ou_fallback_requester></at>", "")) as object;
        return { ...planned, card };
      }
    });
    await workflow.converge(segment.id);
    const finish = graph.outbox.listPendingOutboundReplies().find(({ idempotencyKey }) => idempotencyKey.startsWith(`segment:${segment.id}:page:0:finish:final:`))!;
    expect(finish.payload).not.toContain("<at id=ou_fallback_requester></at>");
    const notifications = graph.outbox.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("primary-segment-completion:"));
    expect(notifications).toHaveLength(1);
    expect(context.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='primary-segment' AND owner_id=?`).get(segment.id)).toEqual({
        state: "waiting_for_answer", notification_reply_id: notifications[0]!.id
      });
    expect(context.database.prepare(`SELECT prerequisite_reply_id,required_state FROM outbound_reply_prerequisites
      WHERE dependent_reply_id=?`).all(notifications[0]!.id)).toEqual([{ prerequisite_reply_id: finish.id, required_state: "delivered" }]);
    context.close();
  });

  it.each([
    ["system actor", { kind: "system", id: "ou_requester", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" }],
    ["non-Feishu actor", { kind: "human", id: "ou_requester", gatewayId: "terminal:local", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" }],
    ["missing Feishu Open ID normalized to unknown", { kind: "human", id: "unknown", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" }],
    ["non-ou Feishu actor ID", { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" }],
    ["non-string Feishu actor ID", { kind: "human", id: 7, gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" }],
    ["invalid Feishu Open ID", { kind: "human", id: "invalid open id", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" }]
  ])("fails closed for a %s", (_label, actor) => {
    const { context, graph } = stores();
    graph.agentInputs.admit({
      submissionId: "submission-invalid-actor", ingressSource: actor.gatewayId, sourceMessageKey: "source-invalid-actor",
      actor: actor as never, text: "finish without authority", owner: { kind: "primary", id: "binding-a", generation: 1 },
      paneId: "binding-a-pane", terminalId: "terminal-a", expectedAgentKind: "traex", expectedSessionId: "session-1",
      recordedAt: "2026-10-04T00:00:00.000Z"
    });
    const humanEvent = event(1, { type: "human_message", message_id: "message-invalid-actor", text: "finish without authority", truncated: false, submission_id: "submission-invalid-actor" });
    const finalEvent = { ...event(2, { type: "message", message_id: "final-invalid-actor", channel: "final", text: "Done.", truncated: false }), turnId: humanEvent.turnId };
    const terminalEvent = { ...event(3, { type: "turn_completed" }), turnId: humanEvent.turnId };
    expect(graph.coreEvents.ingestBatch({ laneId: "lane-invalid-actor", sourceId: "core", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor, events: [humanEvent, finalEvent, terminalEvent], ingestedAt: terminalEvent.occurredAt })).toBe("accepted");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM completion_notification_obligations WHERE owner_kind='primary-segment'").get()).toEqual({ count: 0 });
    context.close();
  });
  it("performs no Conversation write for a byte-identical timeline delta", () => {
    const { context, store } = stores();
    const started = store.projectCanonicalEvent({ laneId: "delta-no-write", laneSequence: 1, event: human(1), observedAt: "2026-10-04T00:00:01.000Z" });
    const delta = { kind: "agent_message" as const, id: "agent:stable", sequence: 1, markdown: "stable", canonicalPosition: { laneSequence: 2, itemOrdinal: 0 } };
    expect(store.projectCanonicalEvent({ laneId: "delta-no-write", laneSequence: 2, event: event(2, { type: "assistant_message", text: "stable" }), observedAt: "2026-10-04T00:00:02.000Z", timelineDeltas: [delta] })).toMatchObject({ outcome: "projected", segmentId: started.segmentId });
    const before = (context.database.prepare("SELECT total_changes() AS count").get() as { count: number }).count;

    expect(store.projectCanonicalEvent({ laneId: "delta-no-write", laneSequence: 3, event: event(3, { type: "assistant_message", text: "stable" }), observedAt: "2026-10-04T00:00:03.000Z", timelineDeltas: [delta] })).toEqual({ outcome: "duplicate", segmentId: started.segmentId });
    const after = (context.database.prepare("SELECT total_changes() AS count").get() as { count: number }).count;

    expect(after - before).toBe(0);
    context.close();
  });

  it("uses an item-first lookup index for late Tool ownership", () => {
    const { context } = stores();
    const details = (context.database.prepare(`EXPLAIN QUERY PLAN
      SELECT i.segment_id,i.lane_sequence,i.item_ordinal,i.item_json
      FROM conversation_segment_items i
      JOIN conversation_segments s ON s.id=i.segment_id
      WHERE i.item_id=? AND s.agent_kind=? AND s.session_id=?`).all("tool:call", "traex", "session-1") as Array<{ detail: string }>)
      .map(({ detail }) => detail.toLowerCase());

    expect(details.some((detail) => detail.includes("conversation_segment_items_item_segment") && detail.includes("item_id=?"))).toBe(true);
    expect(details.some((detail) => /scan (i|conversation_segment_items)/.test(detail))).toBe(false);
    context.close();
  });

  it("keeps delta DML fixed with 10k prior items and issues zero DML for an exact replay", () => {
    const { context, store } = stores();
    const started = store.projectCanonicalEvent({ laneId: "large-delta", laneSequence: 1, event: human(1), observedAt: "2026-10-04T00:00:01.000Z" });
    const insert = context.database.prepare("INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json) VALUES(?,?,?,?,?)");
    for (let index = 0; index < 10_000; index += 1) insert.run(started.segmentId, `old:${index}`, index + 10, 0, JSON.stringify({ kind: "status", id: `old:${index}`, sequence: index, label: "old", state: "completed" }));
    context.database.prepare("UPDATE conversation_segments SET timeline_item_count=10001 WHERE id=?").run(started.segmentId);
    const delta = { kind: "agent_message" as const, id: "agent:new", sequence: 20_000, markdown: "new", canonicalPosition: { laneSequence: 20_010, itemOrdinal: 0 } };
    const beforeInsert = Number((context.database.prepare("SELECT total_changes() AS count").get() as { count:number }).count);
    expect(store.projectCanonicalEvent({ laneId: "large-delta", laneSequence: 20_010, event: event(2, { type: "assistant_message" }), observedAt: "2026-10-04T00:00:02.000Z", timelineDeltas: [delta] }).outcome).toBe("projected");
    const afterInsert = Number((context.database.prepare("SELECT total_changes() AS count").get() as { count:number }).count);
    expect(afterInsert - beforeInsert).toBe(2);

    const changed = { ...delta, markdown: "changed" };
    const beforeChange = Number((context.database.prepare("SELECT total_changes() AS count").get() as { count:number }).count);
    expect(store.projectCanonicalEvent({ laneId: "large-delta", laneSequence: 20_011, event: event(3, { type: "assistant_message" }), observedAt: "2026-10-04T00:00:03.000Z", timelineDeltas: [changed] }).outcome).toBe("projected");
    const afterChange = Number((context.database.prepare("SELECT total_changes() AS count").get() as { count:number }).count);
    expect(afterChange - beforeChange).toBe(2);

    const beforeReplay = Number((context.database.prepare("SELECT total_changes() AS count").get() as { count:number }).count);
    expect(store.projectCanonicalEvent({ laneId: "large-delta", laneSequence: 20_012, event: event(4, { type: "assistant_message" }), observedAt: "2026-10-04T00:00:04.000Z", timelineDeltas: [changed] }).outcome).toBe("duplicate");
    expect(Number((context.database.prepare("SELECT total_changes() AS count").get() as { count:number }).count) - beforeReplay).toBe(0);
    context.close();
  });

  it("does not issue an unbounded history read to classify projection urgency", () => {
    const { context, store } = stores();
    const started = store.projectCanonicalEvent({ laneId: "urgency", laneSequence: 1, event: human(1), observedAt: "2026-10-04T00:00:01.000Z" });
    context.database.prepare("UPDATE conversation_segments SET has_visible_assistant_content=1 WHERE id=?").run(started.segmentId);
    const prepare = vi.spyOn(context.database, "prepare");
    store.projectCanonicalEvent({ laneId: "urgency", laneSequence: 2, event: event(2, { type: "assistant_message" }), observedAt: "2026-10-04T00:00:02.000Z", timelineDeltas: [{ kind: "status", id: "status:2", sequence: 2, label: "working", state: "running" }] });
    const sql = prepare.mock.calls.map(([statement]) => String(statement).replace(/\s+/g, " ").toLowerCase());
    expect(sql.some((statement) => statement.includes("select * from conversation_segment_items where segment_id=? order by"))).toBe(false);
    prepare.mockRestore(); context.close();
  });

  it("pages creating or active conversation pages before frozen history without window materialization", () => {
    const { context, store } = stores();
    const insertSegment = (id: string, updatedAt: string, state: string, viewVersion: number, timelineItemCount: number) => {
      context.database.prepare(`INSERT INTO conversation_segments(
        id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
        state,view_version,root_message_id,timeline_item_count,created_at,updated_at
      ) VALUES(?,?,'primary','binding-a',1,'traex','session-1','request',?,?,?, ?,?,?)`).run(
        id, `lane:${id}`, state, viewVersion, "root-a", timelineItemCount, updatedAt, updatedAt
      );
    };
    const insertPage = (segmentId: string, pageIndex: number, state: "creating" | "active" | "frozen", sequence: number, deliveredItemIndex: number | null) => {
      const timestamp = "2026-10-20T00:00:00.000Z";
      context.database.prepare(`INSERT INTO conversation_segment_pages(
        id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,
        start_cursor_json,delivered_cursor_json,pending_cursor_json,pending_reply_id,created_at,updated_at
      ) VALUES(?,?,?,'message','card',?,?,?,0,NULL,?,NULL,NULL,?,?)`).run(
        `${segmentId}:page:${pageIndex}`, segmentId, pageIndex, `turn-card:${segmentId}:page:${pageIndex}`,
        state, sequence, deliveredItemIndex === null ? null : JSON.stringify({ itemIndex: deliveredItemIndex }), timestamp, timestamp
      );
    };

    insertSegment("creating", "2026-10-20T00:00:01.000Z", "working", 1, 0);
    insertPage("creating", 0, "creating", 0, null);
    insertSegment("frozen", "2026-10-20T00:00:02.000Z", "completed", 2, 1);
    insertPage("frozen", 0, "frozen", 2, 1);
    insertSegment("current-wins", "2026-10-20T00:00:03.000Z", "working", 2, 1);
    insertPage("current-wins", 0, "frozen", 0, 0);
    insertPage("current-wins", 1, "active", 2, 1);

    const prepare = vi.spyOn(context.database, "prepare");
    const page = store.listActionableConversationSegmentPage({ limit: 10, after: null, upperBound: null });

    expect(page.items).toEqual(["creating", "frozen"]);
    expect(page.upperBound).toEqual({ updatedAt: "2026-10-20T00:00:02.000Z", segmentId: "frozen" });
    const statements = prepare.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((statement) => statement.toLowerCase().includes("row_number"))).toBe(false);
    const upperBoundStatement = statements.find((statement) => statement.includes("ORDER BY s.updated_at DESC, s.id DESC"));
    if (!upperBoundStatement) throw new Error("expected actionable Conversation upper-bound query");
    const plan = (context.database.prepare(`EXPLAIN QUERY PLAN ${upperBoundStatement}`).all() as Array<{ detail: string }>)
      .map(({ detail }) => detail.toLowerCase());
    expect(plan.some((detail) => detail.includes("conversation_segments_actionable_page_keyset"))).toBe(true);
    expect(plan.some((detail) => detail.includes("materialize") || detail.includes("temp b-tree"))).toBe(false);
    prepare.mockRestore(); context.close();
  });

  it("keeps a finished page with a pending delivery reply actionable", () => {
    const { context, store, graph } = stores();
    const timestamp = "2026-10-20T00:00:04.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      state,view_version,root_message_id,timeline_item_count,created_at,updated_at
    ) VALUES('finished-pending','lane:finished-pending','primary','binding-a',1,'traex','session-1','request',?,?,?, ?,?,?)`).run(
      "completed", 2, "root-a", 1, timestamp, timestamp
    );
    const pendingReply = graph.outbox.enqueueOutboundReply({
      id: "pending-reply", idempotencyKey: "pending-reply", bindingId: null, rootMessageId: "root-a",
      kind: "card_update", targetRole: "operation_result", payload: "{}",
      projectionKey: "turn-card:finished-pending:page:0", snapshotRevision: 2
    });
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,
      start_cursor_json,delivered_cursor_json,pending_cursor_json,pending_reply_id,delivery_cohort,created_at,updated_at
    ) VALUES('finished-pending:page:0','finished-pending',0,'message','card','turn-card:finished-pending:page:0','finished',2,1,NULL,NULL,NULL,?,'legacy',?,?)`).run(pendingReply.id, timestamp, timestamp);

    const page = store.listActionableConversationSegmentPage({ limit: 10, after: null, upperBound: null });

    expect(page.items).toEqual(["finished-pending"]);
    expect(page.upperBound).toEqual({ updatedAt: timestamp, segmentId: "finished-pending" });
    context.close();
  });

  it("uses partial current-page and position-range indexes without a temporary sort", () => {
    const { context } = stores();
    const currentPlan = (context.database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM conversation_segment_pages
      WHERE segment_id=? AND state IN ('creating','active') ORDER BY page_index DESC LIMIT 1`).all("segment") as Array<{ detail:string }>).map(({ detail }) => detail.toLowerCase());
    const suffixPlan = (context.database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM conversation_segment_items INDEXED BY conversation_segment_items_position
      WHERE segment_id=? AND (lane_sequence,item_ordinal)>=(?,?)
      ORDER BY lane_sequence,item_ordinal,item_id`).all("segment", 100, 0) as Array<{ detail:string }>).map(({ detail }) => detail.toLowerCase());
    const historyPlan = (context.database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM conversation_segment_items INDEXED BY conversation_segment_items_position
      WHERE segment_id=? AND (lane_sequence,item_ordinal)>(?,?)
      ORDER BY lane_sequence,item_ordinal,item_id LIMIT ?`).all("segment", 100, 0, 501) as Array<{ detail:string }>).map(({ detail }) => detail.toLowerCase());
    expect(currentPlan.some((detail) => (detail.includes("conversation_segment_pages_current_lookup") || detail.includes("conversation_segment_pages_one_current")) && detail.includes("segment_id=?"))).toBe(true);
    for (const plan of [suffixPlan, historyPlan]) {
      expect(plan.some((detail) => detail.includes("conversation_segment_items_position") && detail.includes("(lane_sequence,item_ordinal)>(?,?)"))).toBe(true);
      expect(plan.some((detail) => detail.includes("scan conversation_segment_items") || detail.includes("temp b-tree"))).toBe(false);
    }
    context.close();
  });

  it("atomically creates the first Working Turn Card from an exact canonical Human Message", async () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    connectPreparedGraph(graph, (view: { state: string; ownerKind: string; requestText: string }, page: { pageIndex: number }) => ({
        lifecycle: view.state,
        ownerKind: view.ownerKind,
        requestText: view.requestText,
        pageIndex: page.pageIndex
      }));
    activatePrimary(graph, "binding-parent", "session-parent", "root-parent", "pane-parent");
    const created = graph.instances.createWorkerAgentInstance({
      id: "worker-7", projectId: "project", name: "worker-7", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-parent", bindingGeneration: 1, paneId: "pane-parent", nativeSessionId: "session-parent" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 3);
    if (created.outcome !== "created") throw new Error("expected worker");
    const worker = graph.instances.attachAgentInstanceRuntime({ instanceId: "worker-7", expectedGeneration: created.instance.generation, herdrWorkspaceId: "workspace", paneId: "pane-7", nativeSessionId: "session-7" });
    if (!worker) throw new Error("expected attached worker");
    const timestamp = "2026-10-04T00:00:00.000Z";
    context.database.prepare(`INSERT INTO worker_session_threads(
      id,publication_key,worker_id,worker_session_generation,parent_binding_id,parent_binding_generation,parent_pane_id,
      chat_id,mode,state,topic_id,root_message_id,created_at,activated_at,updated_at
    ) VALUES('thread-worker-7','thread:worker-7:1','worker-7',?,'binding-parent',1,'pane-parent',
      'chat','canonical-main','active','topic-worker','root-message',?,?,?)`).run(worker.workerSessionGeneration, timestamp, timestamp, timestamp);
    graph.agentInputs.admit({
      submissionId: "submission-canonical", ingressSource: "feishu:worker", sourceMessageKey: "source-message",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:worker", chatId: "chat", topicId: "topic", rootMessageId: "root-message" },
      text: "run the audit", owner: { kind: "worker", id: "worker-7", generation: worker.generation }, paneId: "pane-7", terminalId: "terminal-7",
      expectedAgentKind: "traex", expectedSessionId: "session-7", recordedAt: "2026-10-04T00:00:00.000Z"
    });
    graph.agentInputs.claimRecorded("submission-canonical", "2026-10-04T00:00:00.500Z");
    graph.agentInputs.recordReceipt("submission-canonical", {
      submissionId: "submission-canonical", paneId: "pane-7", terminalId: "terminal-7", agentKind: "traex", sessionId: "session-7",
      state: "prepared", turnId: null, startedAt: null, terminalState: null, createdAt: 1, updatedAt: 1
    });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });

    const inbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: (input) => graph.conversationSegments.projectCanonicalEvent(input),
      observeCanonicalHumanMessage: (input) => graph.agentInputs.observeCanonicalHumanMessage(input)
    });
    expect(inbox.ingestBatch({
      laneId: "worker-session-7", sourceId: "core", agentKind: "traex", sessionId: "session-7",
      afterCursor: "", nextCursor: "cursor-1", latestCursor: "cursor-1", ingestedAt: "2026-10-04T00:00:02.000Z",
      events: [{
        schemaVersion: 1, eventId: "human-event-1", cursor: "cursor-1", sourceId: "core", agentKind: "traex",
        sessionId: "session-7", turnId: "turn-7", occurredAt: "2026-10-04T00:00:01.000Z",
        payload: { type: "human_message", message_id: "human-message-1", text: "run the audit", truncated: false, submission_id: "submission-canonical" }
      }]
    })).toBe("accepted");

    const segment = context.database.prepare(`SELECT id,producer_key,owner_kind,owner_id,owner_generation,submission_id,
      human_event_id,agent_kind,session_id,request_text,state,view_version,root_message_id,start_lane_sequence,start_item_ordinal
      FROM conversation_segments`).get() as Record<string, unknown>;
    expect(segment).toMatchObject({
      producer_key: "lane:worker-session-7", owner_kind: "worker", owner_id: "worker-7", owner_generation: worker.generation,
      submission_id: "submission-canonical", human_event_id: "human-event-1", agent_kind: "traex", session_id: "session-7",
      request_text: "run the audit", state: "working", view_version: 1, root_message_id: "root-message",
      start_lane_sequence: 1, start_item_ordinal: 0
    });
    const projectionKey = `turn-card:${String(segment.id)}:page:0`;
    const page = context.database.prepare(`SELECT page_index,message_id,card_id,element_id,state,sequence,pending_reply_id
      FROM conversation_segment_pages`).get() as Record<string, unknown>;
    expect(page).toMatchObject({ page_index: 0, message_id: null, card_id: null, element_id: projectionKey, state: "creating", sequence: 1 });
    const reply = context.database.prepare(`SELECT id,idempotency_key,gateway_id,root_message_id,kind,card_role,target_role,payload,state,
      lane_key,projection_key,snapshot_revision,view_version FROM outbound_replies`).get() as Record<string, unknown>;
    expect(reply).toMatchObject({
      id: `${projectionKey}:create`, idempotency_key: `${projectionKey}:create`, gateway_id: "feishu:worker",
      root_message_id: "root-message", kind: "card_reply", card_role: null, target_role: "operation_result",
      state: "pending", lane_key: `gateway:feishu:worker:${projectionKey}`, projection_key: projectionKey, snapshot_revision: 1, view_version: 1
    });
    expect(JSON.parse(String(reply.payload))).toEqual({ lifecycle: "working", ownerKind: "worker", requestText: "run the audit", pageIndex: 0 });
    expect(page.pending_reply_id).toBe(reply.id);
    expect(inbox.getCheckpoint("worker-session-7")).toMatchObject({ readCursor: "cursor-1", latestCursor: "cursor-1" });
    expect(graph.agentInputs.get("submission-canonical")).toMatchObject({ state: "observed" });
    expect(graph.outbox.checkpointOutboundReplyCard(String(reply.id), "worker-turn-card")).not.toBeNull();
    expect(graph.outbox.markOutboundReplyDelivered(String(reply.id), "worker-turn-message", "worker-turn-card")).toBe(true);
    expect(graph.conversationSegments.reconcilePageDelivery(String(segment.id), 0)).toBe("adopted");
    expect(inbox.ingestBatch({
      laneId: "worker-session-7", sourceId: "core", agentKind: "traex", sessionId: "session-7",
      afterCursor: "cursor-1", nextCursor: "cursor-3", latestCursor: "cursor-3", ingestedAt: "2026-10-04T00:00:04.000Z",
      events: [
        {
          schemaVersion: 1, eventId: "worker-final-1", cursor: "cursor-2", sourceId: "core", agentKind: "traex",
          sessionId: "session-7", turnId: "turn-7", occurredAt: "2026-10-04T00:00:03.000Z",
          payload: { type: "message", message_id: "worker-final-message-1", channel: "final", text: "Choose.", truncated: false,
            completion_choice: { version: 2, intent: "human_review", question: "Continue?", default: "yes", options: [{ id: "yes", label: "Yes", message: "default" }] } }
        },
        {
          schemaVersion: 1, eventId: "worker-completed-1", cursor: "cursor-3", sourceId: "core", agentKind: "traex",
          sessionId: "session-7", turnId: "turn-7", occurredAt: "2026-10-04T00:00:04.000Z", payload: { type: "turn_completed" }
        }
      ]
    })).toBe("accepted");
    expect(context.database.prepare(`SELECT owner_kind,owner_id,binding_id,binding_generation,state
      FROM completion_notification_obligations WHERE owner_id=?`).get(String(segment.id))).toEqual({
      owner_kind: "primary-segment", owner_id: segment.id, binding_id: "binding-parent", binding_generation: 1, state: "waiting_for_answer"
    });
    const workflow = new TurnCardWorkflow(graph.conversationSegments, () => {}, {
      turnCardPage: (view, page, options, limit) => planAndRenderTurnCard(view, page, options, limit),
      completionReview: feishuGatewayApplicationPresentation.completionReview
    });
    await workflow.converge(String(segment.id));
    const action = context.database.prepare(`SELECT id,state,binding_id,binding_generation FROM completion_action_sets
      WHERE owner_kind='primary-segment' AND owner_id=?`).get(String(segment.id)) as {
        id: string; state: string; binding_id: string; binding_generation: number;
      };
    const review = graph.outbox.listPendingOutboundReplies().find((candidate) =>
      candidate.projectionKey === `completion-review:${action.id}:surface:1`
    )!;
    expect(review).toMatchObject({ rootMessageId: "root-message", workerId: "worker-7", workerSessionGeneration: worker.workerSessionGeneration });
    expect(JSON.stringify(review.payload)).toContain("worker-7");
    expect(action).toMatchObject({ state: "presenting", binding_id: "binding-parent", binding_generation: 1 });
    const lease = graph.leases.acquireInstanceLease("canonical-worker-review", "2026-10-04T00:00:05.000Z", "2099-01-01T00:00:00.000Z")!;
    graph.leases.activateWriteFence(lease.ownerId, lease.fencingToken);
    const predecessors = context.database.prepare(`SELECT id FROM outbound_replies
      WHERE scope_key=(SELECT scope_key FROM outbound_replies WHERE id=?)
        AND state='pending'
        AND delivery_order<(SELECT delivery_order FROM outbound_replies WHERE id=?)
      ORDER BY delivery_order`).all(review.id, review.id) as Array<{ id: string }>;
    for (const [index, predecessor] of predecessors.entries()) {
      const prepared = graph.preparedDeliveries.hydratePreparedDelivery(predecessor.id);
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") throw new Error("expected prepared predecessor");
      const predecessorClaim = graph.preparedDeliveries.claimPreparedDelivery({
        delivery: prepared.delivery, at: `2098-10-04T00:00:${String(5 + index).padStart(2, "0")}.000Z`, expiresAt: "2098-10-04T00:01:05.000Z"
      });
      expect(predecessorClaim).not.toBeNull();
      expect(graph.preparedDeliveries.acknowledgePreparedDelivery(predecessorClaim!, {
        messageId: `worker-predecessor-message-${index}`, surfaceId: `worker-predecessor-card-${index}`
      })).toBe(true);
    }
    const hydrated = graph.preparedDeliveries.hydratePreparedDelivery(review.id);
    expect(hydrated.status).toBe("prepared");
    if (hydrated.status !== "prepared") throw new Error("expected prepared canonical Worker review");
    graph.preparedDeliveries.loadOrInitializeCheckpoint({ scope: hydrated.delivery.scope, at: "2098-10-04T00:00:05.000Z" });
    const claim = graph.preparedDeliveries.claimPreparedDelivery({
      delivery: hydrated.delivery, at: "2098-10-04T00:00:05.000Z", expiresAt: "2098-10-04T00:01:05.000Z"
    });
    expect(claim).not.toBeNull();
    expect(graph.preparedDeliveries.acknowledgePreparedDelivery(claim!, {
      messageId: "worker-review-message", surfaceId: "worker-review-card"
    })).toBe(true);
    const firstDecision = graph.conversationSegments.decidePrimarySegmentCompletionReview({
      actionSetId: action.id, optionId: "yes", messageId: "worker-review-message",
      actorOpenId: "operator", chatId: "chat", occurredAt: "2026-10-04T00:00:05.000Z"
    });
    expect(firstDecision).toMatchObject({ kind: "submission", segmentId: segment.id, inserted: true });
    expect(context.database.prepare(`SELECT owner_kind,owner_id,owner_generation,pane_id,terminal_id,expected_session_id
      FROM submission_intents WHERE source_message_key=?`).get(
      completionChoiceSubmissionIdentity(action.id, "yes")
    )).toEqual({
      owner_kind: "worker", owner_id: "worker-7", owner_generation: worker.generation,
      pane_id: "pane-7", terminal_id: "session-7", expected_session_id: "session-7"
    });
    expect(graph.instances.terminateWorkerSession({
      instanceId: "worker-7", expectedGeneration: worker.generation, reason: "test worker termination"
    })).not.toBeNull();
    expect(graph.conversationSegments.decidePrimarySegmentCompletionReview({
      actionSetId: action.id, optionId: "yes", messageId: "worker-review-message",
      actorOpenId: "operator", chatId: "chat", occurredAt: "2026-10-04T00:00:06.000Z"
    })).toEqual({ ...firstDecision, inserted: false });
    expect(() => graph.conversationSegments.decidePrimarySegmentCompletionReview({
      actionSetId: action.id, optionId: "yes", messageId: "worker-review-message",
      actorOpenId: "forged-operator", chatId: "chat", occurredAt: "2026-10-04T00:00:07.000Z"
    })).toThrow("no longer available");
    context.close();
  });

  it("retains a pending canonical event and advances the Core cursor when first-card reservation fails", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    graph.conversationSegments.setInitialTurnCardRenderer(() => ({ schema: "2.0" }));
    graph.conversationSegments.setPreparedDeliveryReservation({ reservePreparedOutboundReply: () => { throw new Error("injected canonical card reservation failure"); } }, { enqueuePreparedDelivery() {} });
    activatePrimary(graph, "binding-rollback", "session-rollback", "root-rollback", "pane");
    graph.agentInputs.admit({
      submissionId: "submission-rollback", ingressSource: "feishu:primary", sourceMessageKey: "source-rollback",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root-rollback" },
      text: "rollback request", owner: { kind: "primary", id: "binding-rollback", generation: 1 }, paneId: "pane", terminalId: "terminal",
      expectedAgentKind: "traex", expectedSessionId: "session-rollback", recordedAt: "2026-10-04T00:00:00.000Z"
    });
    const inbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: (input) => graph.conversationSegments.projectCanonicalEvent(input),
      observeCanonicalHumanMessage: (input) => graph.agentInputs.observeCanonicalHumanMessage(input)
    });
    expect(inbox.ingestBatch({
      laneId: "lane-rollback", sourceId: "core", agentKind: "traex", sessionId: "session-rollback",
      afterCursor: "", nextCursor: "cursor-rollback", latestCursor: "cursor-rollback", ingestedAt: "2026-10-04T00:00:01.000Z",
      events: [event(1, { type: "human_message", message_id: "human-rollback", text: "rollback request", truncated: false, submission_id: "submission-rollback" }, "session-rollback")]
    })).toBe("accepted");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM core_event_inbox").get()).toEqual({ count: 1 });
    expect(context.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id='lane-rollback'").get()).toEqual({ state: "pending" });
    expect(inbox.getCheckpoint("lane-rollback")).toMatchObject({ readCursor: "cursor-rollback", latestCursor: "cursor-rollback" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    expect(graph.agentInputs.get("submission-rollback")).toMatchObject({ state: "recorded" });
    context.close();
  });

  it("exactly adopts a pending segment and closes it at the canonical boundary", () => {
    const { context, store } = stores();
    store.admitLegacyPending({ segmentId: "pending-a", submissionId: "submission-a", producerKey: "feishu:primary", owner: { kind: "primary", id: "binding-a", generation: 1 }, agentKind: "traex", expectedSessionId: "session-1", requestText: "request-1", rootMessageId: "root-a", card: {}, occurredAt: "2026-10-04T00:00:00.000Z" });
    const result = store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 8, event: human(1, "submission-a"), observedAt: "2026-10-04T00:00:08.000Z" });
    expect(result).toMatchObject({ outcome: "adopted", segmentId: "pending-a" });
    expect(store.getConversationSegment("pending-a")).toMatchObject({ state: "working", startAt: { laneSequence: 8, itemOrdinal: 0 } });
    expect(store.listConversationSegmentPages("pending-a")).toHaveLength(1);
    context.close();
  });

  it("creates two direct Human segments without requiring Assistant output", () => {
    const { context, store } = stores();
    const first = store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 7, event: human(1), observedAt: "2026-10-04T00:00:07.000Z" });
    const second = store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 8, event: human(2), observedAt: "2026-10-04T00:00:08.000Z" });
    expect(first.outcome).toBe("created"); expect(second.outcome).toBe("created");
    expect(store.getConversationSegment(first.segmentId!)).toMatchObject({ state: "working", endBefore: null });
    expect(store.listOpenSegments("lane:lane-a").map((segment) => segment.id)).toEqual([first.segmentId, second.segmentId]);
    context.close();
  });

  it("completes the latest Segment and closes earlier inputs when one Core turn contains multiple Human Messages", () => {
    const { context, store, graph } = stores();
    const notifications: Array<{ segmentId:string; viewVersion:number; urgency:string }> = [];
    store.setProjectionNotifier((notification) => { notifications.push(notification); });
    for (const [submissionId, text, recordedAt] of [
      ["submission-shared-first", "first request", "2026-10-04T00:00:00.000Z"],
      ["submission-shared-second", "second request", "2026-10-04T00:00:01.000Z"]
    ] as const) {
      graph.agentInputs.admit({
        submissionId, ingressSource: "feishu:primary", sourceMessageKey: `source:${submissionId}`,
        actor: { kind: "human", id: "ou_shared_actor", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-binding-a", rootMessageId: "root-a" },
        text, owner: { kind: "primary", id: "binding-a", generation: 1 }, paneId: "binding-a-pane", terminalId: "terminal-a",
        expectedAgentKind: "traex", expectedSessionId: "session-1", recordedAt
      });
    }
    const firstHuman = event(1, {
      type: "human_message", message_id: "human-shared-first", text: "first request", truncated: false,
      submission_id: "submission-shared-first"
    });
    const secondHuman = {
      ...event(2, {
        type: "human_message", message_id: "human-shared-second", text: "second request", truncated: false,
        submission_id: "submission-shared-second"
      }),
      turnId: firstHuman.turnId
    };
    const finalEvent = {
      ...event(3, {
        type: "message", message_id: "final-shared", channel: "final", text: "One final answer.", truncated: false,
        completion_choice: {
          version: 2, intent: "human_review", question: "Continue?", default: "yes",
          options: [{ id: "yes", label: "Continue", message: "default" }]
        }
      }),
      turnId: firstHuman.turnId
    };
    const terminalEvent = { ...event(4, { type: "turn_completed" }), turnId: firstHuman.turnId };

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-shared-turn", sourceId: "core", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: terminalEvent.cursor, latestCursor: terminalEvent.cursor,
      events: [firstHuman, secondHuman, finalEvent, terminalEvent], ingestedAt: terminalEvent.occurredAt
    })).toBe("accepted");

    const [first, second] = store.listConversationSegmentsForProducer("lane:lane-shared-turn");
    expect(first).toMatchObject({ state: "closed", endBefore: { laneSequence: 2, itemOrdinal: 0 } });
    expect(second).toMatchObject({ state: "completed", endBefore: null });
    expect(context.database.prepare(`SELECT owner_id,question,default_option_id FROM completion_choice_specifications
      WHERE owner_kind='primary-segment'`).all()).toEqual([{
        owner_id: second!.id, question: "Continue?", default_option_id: "yes"
      }]);
    expect(context.database.prepare(`SELECT owner_id,state FROM completion_notification_obligations
      WHERE owner_kind='primary-segment' AND notice_kind='completion'`).all()).toEqual([{
        owner_id: second!.id, state: "waiting_for_answer"
      }]);
    expect(notifications.filter((notification) => notification.viewVersion === 2)).toHaveLength(2);
    expect(notifications.filter((notification) => notification.viewVersion === 2)).toEqual(expect.arrayContaining([
      { segmentId: first!.id, viewVersion: 2, urgency: "immediate" },
      { segmentId: second!.id, viewVersion: 2, urgency: "immediate" }
    ]));
    context.close();
  });

  it("keeps a delivered completed Segment terminal when a later Human Message arrives", async () => {
    const { context, store, graph, segment, finish } = await completedChoiceSegment({ finalEventId: "event:completed-before-next:2" });
    expect(graph.outbox.markOutboundReplyDelivered(finish.id, "turn-choice", "card-choice")).toBe(true);
    expect(store.reconcilePageDelivery(segment.id, 0)).toBe("adopted");
    expect(store.getConversationSegment(segment.id)?.state).toBe("completed");

    const next = event(4, { type: "human_message", message_id: "human-after-completed", text: "next request", truncated: false });
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-choice", sourceId: "core", agentKind: "traex", sessionId: "session-1",
      afterCursor: "core:3", nextCursor: next.cursor, latestCursor: next.cursor, events: [next], ingestedAt: next.occurredAt
    })).toBe("accepted");

    expect(store.getConversationSegment(segment.id)?.state).toBe("completed");
    expect(store.listConversationSegmentsForProducer("lane:lane-choice").at(-1)).toMatchObject({ state: "working", requestText: "next request" });
    expect(graph.outbox.listPendingOutboundReplies().filter(({ payload }) => payload.includes("已并入后续输入"))).toHaveLength(0);
    context.close();
  });

  it("closes every earlier working member of a three-Human turn without terminal replay effects", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    const notifications: Array<{ segmentId:string; viewVersion:number; urgency:string }> = [];
    graph.conversationSegments.setProjectionNotifier((notification) => { notifications.push(notification); });
    const first = human(1);
    const second = { ...human(2), turnId: first.turnId };
    const third = { ...human(3), turnId: first.turnId };
    const terminal = { ...event(4, { type: "turn_completed" }), turnId: first.turnId };
    const batch = {
      laneId: "lane-three-human", sourceId: "core", agentKind: "traex" as const, sessionId: "session-1",
      afterCursor: "", nextCursor: terminal.cursor, latestCursor: terminal.cursor,
      events: [first, second, third, terminal], ingestedAt: terminal.occurredAt
    };

    expect(graph.coreEvents.ingestBatch(batch)).toBe("accepted");
    const segments = graph.conversationSegments.listConversationSegmentsForProducer("lane:lane-three-human");
    expect(segments.map(({ state, endBefore }) => ({ state, endBefore }))).toEqual([
      { state: "closed", endBefore: { laneSequence: 2, itemOrdinal: 0 } },
      { state: "closed", endBefore: { laneSequence: 3, itemOrdinal: 0 } },
      { state: "completed", endBefore: null }
    ]);
    expect(notifications.filter((notification) => notification.viewVersion === 2)).toEqual(segments.map((segment) => ({
      segmentId: segment.id, viewVersion: 2, urgency: "immediate"
    })));
    const notificationCount = notifications.length;
    expect(graph.coreEvents.ingestBatch(batch)).toBe("stale_rebase");
    expect(graph.conversationSegments.listConversationSegmentsForProducer("lane:lane-three-human").map(({ state, endBefore }) => ({ state, endBefore }))).toEqual([
      { state: "closed", endBefore: { laneSequence: 2, itemOrdinal: 0 } },
      { state: "closed", endBefore: { laneSequence: 3, itemOrdinal: 0 } },
      { state: "completed", endBefore: null }
    ]);
    expect(notifications).toHaveLength(notificationCount);
    graph.database.close();
  });

  it.each(["failed", "closed"] as const)("fails closed without changing an earlier working member when the latest shared-turn owner is %s", (latestState) => {
    const { context, store, graph } = stores();
    const first = human(1);
    const second = { ...human(2), turnId: first.turnId };
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-stale-shared", sourceId: "core", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: second.cursor, latestCursor: second.cursor,
      events: [first, second], ingestedAt: second.occurredAt
    })).toBe("accepted");
    const [earlier, latest] = store.listConversationSegmentsForProducer("lane:lane-stale-shared");
    context.database.prepare("UPDATE conversation_segments SET state=? WHERE id=?").run(latestState, latest!.id);
    const notifications: Array<{ segmentId:string }> = [];
    store.setProjectionNotifier((notification) => { notifications.push(notification); });

    expect(store.projectCanonicalEvent({
      laneId: "lane-stale-shared", laneSequence: 3, observedAt: "2026-10-04T00:00:03.000Z",
      event: { ...event(3, { type: "turn_completed" }), turnId: first.turnId }
    })).toEqual({ outcome: "ignored", segmentId: latest!.id });
    expect(store.getConversationSegment(earlier!.id)).toMatchObject({ state: "working", endBefore: null });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM completion_action_sets").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM completion_notification_obligations").get()).toEqual({ count: 0 });
    expect(notifications).toEqual([]);
    context.close();
  });

  it("closes the earlier shared-turn Segment on abort without creating completion review state", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    const notifications: Array<{ segmentId:string; viewVersion:number; urgency:string }> = [];
    graph.conversationSegments.setProjectionNotifier((notification) => { notifications.push(notification); });
    const first = human(1);
    const second = { ...human(2), turnId: first.turnId };
    const aborted = { ...event(3, { type: "turn_aborted", reason: "operator cancelled" }), turnId: first.turnId };
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-shared-abort", sourceId: "core", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: aborted.cursor, latestCursor: aborted.cursor,
      events: [first, second, aborted], ingestedAt: aborted.occurredAt
    })).toBe("accepted");
    expect(graph.conversationSegments.listConversationSegmentsForProducer("lane:lane-shared-abort").map(({ state, endBefore }) => ({ state, endBefore }))).toEqual([
      { state: "closed", endBefore: { laneSequence: 2, itemOrdinal: 0 } },
      { state: "cancelled", endBefore: null }
    ]);
    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications").get()).toEqual({ count: 0 });
    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM completion_action_sets").get()).toEqual({ count: 0 });
    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM completion_notification_obligations").get()).toEqual({ count: 0 });
    const segments = graph.conversationSegments.listConversationSegmentsForProducer("lane:lane-shared-abort");
    expect(notifications.filter((notification) => notification.viewVersion === 2)).toEqual(segments.map((segment) => ({
      segmentId: segment.id, viewVersion: 2, urgency: "immediate"
    })));
    graph.database.close();
  });

  it("keeps a working Answer Segment alive and routes late output by exact turn after a queued Human Message", () => {
    const { context, store, graph } = stores();
    const firstHuman = human(1);
    const firstOutput = { ...event(2, { type: "message", message_id: "assistant-first", channel: "assistant", text: "working", truncated: false }), turnId: firstHuman.turnId };
    const secondHuman = human(3);
    const lateOutput = { ...event(4, { type: "message", message_id: "assistant-first-late", channel: "assistant", text: "still working", truncated: false }), turnId: firstHuman.turnId };
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-queue", sourceId: "core", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: lateOutput.cursor, latestCursor: lateOutput.cursor,
      events: [firstHuman, firstOutput, secondHuman, lateOutput], ingestedAt: lateOutput.occurredAt
    })).toBe("accepted");
    const [first, second] = store.listConversationSegmentsForProducer("lane:lane-queue");
    expect(first?.state).toBe("working");
    expect(store.listConversationSegmentItems(first!.id).map(({ item }) => "markdown" in item ? item.markdown : "")).toContain("still working");
    expect(store.listConversationSegmentItems(second!.id).map(({ item }) => "markdown" in item ? item.markdown : "")).not.toContain("still working");
    context.close();
  });

  it("keeps reserved system Human envelopes out of visible Conversation Segments", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    const envelopes = [
      "<goal_context>finish all approved work</goal_context>",
      "<codex_internal_context source=\"goal\">continue the active goal</codex_internal_context>",
      "<scheduled-task id=\"37942489\">observe status</scheduled-task>",
      "<environment_context>\n  <cwd>/workspace/project</cwd>\n  <subagents>\n    - reviewer: Curie\n  </subagents>\n</environment_context>",
      "# AGENTS.md instructions for /workspace/project\n\n<INSTRUCTIONS>\nUse the repository workflow.\n</INSTRUCTIONS>\n\n<environment_context>\n  <cwd>/workspace/project</cwd>\n</environment_context>"
    ];
    const events = envelopes.map((text, index) => event(index + 1, {
      type: "human_message", message_id: `system-${index}`, text, truncated: false
    }));

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-system", sourceId: "core", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: events.at(-1)!.cursor, latestCursor: events.at(-1)!.cursor,
      events, ingestedAt: "2026-10-04T00:00:09.000Z"
    })).toBe("accepted");
    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM core_event_inbox").get()).toEqual({ count: envelopes.length });
    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 0 });
    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 0 });
    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    graph.database.close();
  });

  it("does not let a reserved system envelope close the current real Human segment", () => {
    const { context, store } = stores();
    const started = store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 1, event: human(1), observedAt: "2026-10-04T00:00:01.000Z" });
    expect(store.projectCanonicalEvent({
      laneId: "lane-a", laneSequence: 2,
      event: event(2, { type: "human_message", message_id: "scheduled", text: "<scheduled-task id=\"task-1\">run monitor</scheduled-task>", truncated: false }),
      observedAt: "2026-10-04T00:00:02.000Z"
    })).toEqual({ outcome: "ignored", segmentId: null });
    expect(store.projectCanonicalEvent({
      laneId: "lane-a", laneSequence: 3,
      event: event(3, { type: "message", message_id: "answer-1", channel: "final", text: "done", truncated: false }),
      observedAt: "2026-10-04T00:00:03.000Z",
      timelineDeltas: [{ kind: "agent_message", id: "agent:after-system", sequence: 1, markdown: "still on the real turn" }]
    })).toMatchObject({ outcome: "projected", segmentId: started.segmentId });
    expect(store.listConversationSegmentsForProducer("lane:lane-a")).toHaveLength(1);
    expect(store.getConversationSegment(started.segmentId!)).toMatchObject({ state: "working", endBefore: null });
    expect(store.listConversationSegmentItems(started.segmentId!).map(({ itemId }) => itemId)).toContain("agent:after-system");
    context.close();
  });

  it.each([
    "Please read AGENTS.md before changing the code",
    "This mentions <goal_context> without being an envelope",
    "This mentions <codex_internal_context source=\"goal\"> without being an envelope",
    "prefix <codex_internal_context source=\"goal\">continue</codex_internal_context>",
    "<codex_internal_context source=\"goal\">partial only",
    "prefix <scheduled-task id=\"task-1\">monitor</scheduled-task>",
    "These names came from <environment_context>, not my input",
    "<environment_context>partial only",
    "# AGENTS.md instructions for /workspace/project\n\n<INSTRUCTIONS>partial only"
  ])("keeps ordinary direct-Herdr text visible: %s", (text) => {
    const { context, store } = stores();
    const result = store.projectCanonicalEvent({
      laneId: "lane-visible", laneSequence: 1,
      event: event(1, { type: "human_message", message_id: "visible", text, truncated: false }),
      observedAt: "2026-10-04T00:00:01.000Z"
    });
    expect(result.outcome).toBe("created");
    expect(store.getConversationSegment(result.segmentId!)).toMatchObject({ requestText: text, state: "working" });
    context.close();
  });

  it("routes an unmatched direct-Herdr Human Message to the exact active Primary thread", () => {
    const { context, store } = stores();
    context.database.prepare(`INSERT INTO bindings(id,workspace_id,chat_id,title,runtime,state,last_agent_state,created_at,updated_at)
      VALUES('binding-direct','workspace','chat','Direct Primary','traex','active','idle',?,?)`).run(
      "2026-10-04T00:00:00.000Z", "2026-10-04T00:00:00.000Z"
    );
    context.database.prepare(`UPDATE bindings SET gateway_id='feishu:primary',root_message_id='root-direct',
      agent_kind='traex',agent_session_source='herdr:traex',agent_session_agent='traex',agent_session_kind='id',
      agent_session_value='session-direct',lifecycle='active',attachment='attached',pane_id='pane-direct' WHERE id='binding-direct'`).run();

    const result = store.projectCanonicalEvent({
      laneId: "direct-primary", laneSequence: 4, observedAt: "2026-10-04T00:00:04.000Z",
      event: event(4, { type: "human_message", message_id: "direct-human", text: "direct request", truncated: false }, "session-direct")
    });

    expect(store.getConversationSegment(result.segmentId!)).toMatchObject({
      ownerKind: "primary", ownerId: "binding-direct", ownerGeneration: 1,
      state: "working", rootMessageId: "root-direct"
    });
    const page = store.listConversationSegmentPages(result.segmentId!)[0]!;
    expect(page).toMatchObject({ state: "creating", sequence: 1 });
    const reply = context.database.prepare(`SELECT gateway_id,root_message_id,kind,projection_key,payload
      FROM outbound_replies`).get() as { gateway_id: string; root_message_id: string; kind: string; projection_key: string; payload: string };
    expect(reply).toMatchObject({
      gateway_id: "feishu:primary", root_message_id: "root-direct", kind: "card_reply",
      projection_key: page.elementId
    });
    expect(JSON.parse(reply.payload)).toMatchObject({ state: "working", ownerKind: "primary", requestText: "direct request" });
    expect(page.pendingReplyId).not.toBeNull();
    context.close();
  });

  it("loads explicit Project, Tab, and Pane presentation fields from authoritative Primary state", () => {
    const { context, store } = stores();
    const timestamp = "2026-10-04T00:00:00.000Z";
    context.database.prepare(`INSERT INTO bindings(
      id,project_id,workspace_id,chat_id,title,runtime,state,last_agent_state,pane_token,generation,created_at,updated_at
    ) VALUES('binding-identity','herdr-agent-swarm','workspace','chat','herdr-agent-swarm / stale-title','traex','active','idle','binding-token',1,?,?)`).run(timestamp, timestamp);
    context.database.prepare("INSERT INTO topic_views(binding_id,state_json,updated_at) VALUES(?,?,?)").run(
      "binding-identity",
      JSON.stringify({
        title: "herdr-agent-swarm / a1j3",
        spaceName: "herdr-agent-swarm",
        tabId: "wN:t3M",
        paneName: "a1j3",
        paneToken: "9e2u",
        model: "GPT-5.4"
      }),
      timestamp
    );
    context.database.prepare("UPDATE bindings SET lifecycle='active',attachment='attached',pane_id='pane-identity' WHERE id='binding-identity'").run();
    store.admitLegacyPending({
      segmentId: "segment-identity", submissionId: "submission-identity", producerKey: "feishu:primary",
      owner: { kind: "primary", id: "binding-identity", generation: 1 }, agentKind: "traex",
      expectedSessionId: "session-identity", requestText: "inspect identity", rootMessageId: "root-identity",
      card: {}, occurredAt: timestamp
    });

    expect(store.loadCardView("segment-identity")).toMatchObject({
      ownerLabel: "herdr-agent-swarm / a1j3",
      spaceName: "herdr-agent-swarm",
      projectLabel: "herdr-agent-swarm",
      tabLabel: "a1j3",
      paneToken: "9e2u",
      model: "GPT-5.4"
    });
    context.close();
  });

  it("routes a Worker canonical Human Message through the same segment and first-card transition", () => {
    const { context, store } = stores();
    const timestamp = "2026-10-04T00:00:00.000Z";
    context.database.prepare(`INSERT INTO bindings(id,workspace_id,chat_id,title,runtime,state,last_agent_state,created_at,updated_at)
      VALUES('binding-worker','workspace','chat','Worker Parent','traex','active','idle',?,?)`).run(timestamp, timestamp);
    context.database.prepare(`UPDATE bindings SET gateway_id='feishu:worker',root_message_id='root-parent',
      lifecycle='active',attachment='attached',pane_id='pane-primary' WHERE id='binding-worker'`).run();
    context.database.prepare(`INSERT INTO agent_instances(
      id,project_id,name,role,agent_kind,parent_binding_id,parent_binding_generation,parent_pane_id,
      worker_session_lifecycle,worker_session_generation,desired_state,observed_state,workspace_lease_id,generation,
      herdr_workspace_id,pane_id,native_session_id,created_at,updated_at
    ) VALUES('worker-route','project','worker-route','worker','traex','binding-worker',1,'pane-primary',
      'active',2,'running','idle','workspace-worker-route',4,'workspace','pane-worker','session-worker',?,?)`).run(timestamp, timestamp);
    context.database.prepare(`INSERT INTO worker_session_threads(
      id,publication_key,worker_id,worker_session_generation,parent_binding_id,parent_binding_generation,parent_pane_id,
      chat_id,mode,state,topic_id,root_message_id,created_at,activated_at,updated_at
    ) VALUES('thread-worker','thread:worker-route:2','worker-route',2,'binding-worker',1,'pane-primary',
      'chat','canonical-main','active','topic-worker','root-worker',?,?,?)`).run(timestamp, timestamp, timestamp);

    const result = store.projectCanonicalEvent({
      laneId: "worker-route", laneSequence: 5, observedAt: "2026-10-04T00:00:05.000Z",
      event: event(5, { type: "human_message", message_id: "worker-human", submission_id: "worker-turn-1", text: "worker request", truncated: false }, "session-worker")
    });

    expect(store.getConversationSegment(result.segmentId!)).toMatchObject({
      ownerKind: "worker", ownerId: "worker-route", ownerGeneration: 4,
      submissionId: "worker-turn-1", state: "working", rootMessageId: "root-worker"
    });
    const page = store.listConversationSegmentPages(result.segmentId!)[0]!;
    const reply = context.database.prepare("SELECT gateway_id,root_message_id,kind,projection_key FROM outbound_replies").get();
    expect(reply).toEqual({ gateway_id: "feishu:worker", root_message_id: "root-worker", kind: "card_reply", projection_key: page.elementId });
    expect(page.pendingReplyId).not.toBeNull();
    context.close();
  });

  it("converges duplicate Core delivery across SQLite handles on one segment and create effect", () => {
    const directory = mkdtempSync(join(tmpdir(), "segment-competing-")); const path = join(directory, "bridge.db");
    const left = new SqliteCapabilityGraph(path); const right = new SqliteCapabilityGraph(path);
    const render = (view: { state: string }) => ({ state: view.state });
    left.conversationSegments.setInitialTurnCardRenderer(render as never);
    right.conversationSegments.setInitialTurnCardRenderer(render as never);
    connectPreparedGraph(left, render as never);
    connectPreparedGraph(right, render as never);
    activatePrimary(left, "binding-shared", "session-shared", "root-shared", "pane");
    left.agentInputs.admit({
      submissionId: "submission-shared", ingressSource: "feishu:primary", sourceMessageKey: "source-shared",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root-shared" },
      text: "shared request", owner: { kind: "primary", id: "binding-shared", generation: 1 }, paneId: "pane", terminalId: "terminal",
      expectedAgentKind: "traex", expectedSessionId: "session-shared", recordedAt: "2026-10-04T00:00:00.000Z"
    });
    const batch = {
      laneId: "lane-shared", sourceId: "core", agentKind: "traex" as const, sessionId: "session-shared",
      afterCursor: "", nextCursor: "cursor-shared", latestCursor: "cursor-shared", ingestedAt: "2026-10-04T00:00:01.000Z",
      events: [event(1, { type: "human_message", message_id: "human-shared", text: "shared request", truncated: false, submission_id: "submission-shared" }, "session-shared")]
    };
    expect(left.coreEvents.ingestBatch(batch)).toBe("accepted");
    expect(right.coreEvents.ingestBatch(batch)).toBe("stale_rebase");
    expect(left.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 1 });
    expect(left.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 1 });
    expect(left.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'turn-card:%'").get()).toEqual({ count: 1 });
    right.database.close(); left.database.close(); rmSync(directory, { recursive: true, force: true });
  });

  it("selects and lists canonical segments only by Core lane position", () => {
    const { context, store } = stores();
    const first = store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 7, event: human(1), observedAt: "2026-10-04T00:00:07.000Z" });
    const second = store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 8, event: human(2), observedAt: "2026-10-04T00:00:08.000Z" });
    store.admitLegacyPending({ segmentId: "pending-a", submissionId: "submission-pending", producerKey: "lane:lane-a", owner: { kind: "primary", id: "binding-a", generation: 1 }, agentKind: "traex", expectedSessionId: "session-1", requestText: "pending", rootMessageId: "root-a", card: {}, occurredAt: "2025-01-01T00:00:00.000Z" });
    context.database.prepare("UPDATE conversation_segments SET created_at='2030-01-01T00:00:00.000Z', state='working', end_lane_sequence=NULL, end_item_ordinal=NULL WHERE id=?").run(first.segmentId);
    context.database.prepare("UPDATE conversation_segments SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(second.segmentId);

    expect(store.listConversationSegmentsForProducer("lane:lane-a").map(({ id }) => id)).toEqual([first.segmentId, second.segmentId]);
    const delta = { kind: "agent_message" as const, id: "agent:latest", sequence: 1, canonicalPosition: { laneSequence: 9, itemOrdinal: 0 }, markdown: "latest" };
    expect(store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 9, event: event(3, { type: "assistant_message", text: "latest" }), observedAt: "2026-10-04T00:00:09.000Z", timelineDeltas: [delta] })).toMatchObject({ outcome: "projected", segmentId: second.segmentId });
    expect(store.listConversationSegmentItems(first.segmentId!).map(({ itemId }) => itemId)).not.toContain("agent:latest");
    expect(store.listConversationSegmentItems(second.segmentId!).map(({ itemId }) => itemId)).toContain("agent:latest");
    context.close();
  });

  it("persists the latest canonical update_plan as the Turn Card Task List", () => {
    const directory = mkdtempSync(join(tmpdir(), "segment-task-list-"));
    const path = join(directory, "bridge.db");
    let graph = new SqliteCapabilityGraph(path);
    const started = human(1);
    const plan = event(2, {
      type: "tool_call",
      call_id: "plan-1",
      name: "update_plan",
      arguments: JSON.stringify({ plan: [
        { step: "Inspect canonical state", status: "completed" },
        { step: "Deploy the fix", status: "in_progress" }
      ] }),
      truncated: false
    });

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-plan", sourceId: "core", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: plan.cursor, latestCursor: plan.cursor,
      events: [started, plan], ingestedAt: "2026-10-04T00:00:03.000Z"
    })).toBe("accepted");
    const [segment] = graph.conversationSegments.listConversationSegmentsForProducer("lane:lane-plan");
    expect(graph.conversationSegments.loadCardView(segment!.id)).toMatchObject({
      viewVersion: 2,
      taskList: [
        { label: "Inspect canonical state", state: "done" },
        { label: "Deploy the fix", state: "active" }
      ]
    });

    graph.database.close();
    graph = new SqliteCapabilityGraph(path);
    expect(graph.conversationSegments.loadCardView(segment!.id)?.taskList).toEqual([
      { label: "Inspect canonical state", state: "done" },
      { label: "Deploy the fix", state: "active" }
    ]);
    const unchanged = graph.conversationSegments.projectCanonicalEvent({
      laneId: "lane-plan", laneSequence: 2, event: plan,
      observedAt: "2026-10-04T00:00:04.000Z",
      taskList: [
        { label: "Inspect canonical state", state: "done" },
        { label: "Deploy the fix", state: "active" }
      ]
    });
    expect(unchanged.outcome).toBe("duplicate");
    expect(graph.conversationSegments.loadCardView(segment!.id)?.viewVersion).toBe(2);

    const cleared = graph.conversationSegments.projectCanonicalEvent({
      laneId: "lane-plan", laneSequence: 3,
      event: event(3, { type: "tool_call", call_id: "plan-2", name: "update_plan", arguments: JSON.stringify({ plan: [] }), truncated: false }),
      observedAt: "2026-10-04T00:00:05.000Z", taskList: []
    });
    expect(cleared.outcome).toBe("projected");
    expect(graph.conversationSegments.loadCardView(segment!.id)).toMatchObject({ viewVersion: 3, taskList: [] });
    graph.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("carries the current canonical Task List into the next Human segment", () => {
    const { context, store } = stores();
    const first = store.projectCanonicalEvent({ laneId: "lane-plan-carry", laneSequence: 1, event: human(1), observedAt: "2026-10-05T00:00:01.000Z" });
    expect(store.projectCanonicalEvent({
      laneId: "lane-plan-carry", laneSequence: 2,
      event: event(2, { type: "tool_call", call_id: "plan-carry", name: "update_plan", arguments: "{}", truncated: false }),
      observedAt: "2026-10-05T00:00:02.000Z",
      taskList: [{ label: "Keep current plan", state: "active" }, { label: "Verify next turn", state: "pending" }]
    })).toMatchObject({ outcome: "projected", segmentId: first.segmentId });

    const second = store.projectCanonicalEvent({ laneId: "lane-plan-carry", laneSequence: 3, event: human(3), observedAt: "2026-10-05T00:00:03.000Z" });

    expect(store.loadCardView(second.segmentId!)?.taskList).toEqual([
      { label: "Keep current plan", state: "active" },
      { label: "Verify next turn", state: "pending" }
    ]);
    context.close();
  });

  it("persists the latest canonical Goal in the compact Turn Card section", () => {
    const directory = mkdtempSync(join(tmpdir(), "segment-current-goal-"));
    const path = join(directory, "bridge.db");
    let graph = new SqliteCapabilityGraph(path);
    const activeGoal = event(2, {
      type: "goal_changed", goal_id: "goal-1", objective: "Ship safely", status: "active",
      source_updated_at: 20, truncated: false
    });

    graph.coreEvents.ingestBatch({
      laneId: "lane-goal", sourceId: "core", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: activeGoal.cursor, latestCursor: activeGoal.cursor,
      events: [human(1), activeGoal], ingestedAt: "2026-10-04T00:00:03.000Z"
    });
    const [segment] = graph.conversationSegments.listConversationSegmentsForProducer("lane:lane-goal");
    expect(graph.conversationSegments.loadCardView(segment!.id)).toMatchObject({
      currentGoal: { objective: "Ship safely", status: "active" }
    });

    graph.database.close();
    graph = new SqliteCapabilityGraph(path);
    expect(graph.conversationSegments.loadCardView(segment!.id)).toMatchObject({
      currentGoal: { objective: "Ship safely", status: "active" }
    });
    const beforeStale = graph.conversationSegments.loadCardView(segment!.id)!.viewVersion;
    expect(graph.conversationSegments.projectCanonicalEvent({
      laneId: "lane-goal", laneSequence: 3,
      event: event(3, { type: "goal_changed", goal_id: "goal-1", objective: "stale", status: "paused", source_updated_at: 19, truncated: false }),
      observedAt: "2026-10-04T00:00:04.000Z",
      goalChanges: [{ goalId: "goal-1", objective: "stale", status: "paused", sourceUpdatedAt: 19, occurredAt: "2026-10-04T00:00:04.000Z", sourceId: "recovery", sourceSequence: 3, sourceEventId: "stale-goal", nativeSessionId: "session-1" }]
    })).toMatchObject({ outcome: "duplicate", segmentId: segment!.id });
    expect(graph.conversationSegments.loadCardView(segment!.id)).toMatchObject({
      viewVersion: beforeStale, currentGoal: { objective: "Ship safely", status: "active" }
    });

    expect(graph.conversationSegments.projectCanonicalEvent({
      laneId: "lane-goal", laneSequence: 4,
      event: event(4, { type: "goal_changed", goal_id: "goal-1", objective: "Wait for operator", status: "blocked", source_updated_at: 21, truncated: false }),
      observedAt: "2026-10-04T00:00:05.000Z",
      goalChanges: [{ goalId: "goal-1", objective: "Wait for operator", status: "blocked", sourceUpdatedAt: 21, occurredAt: "2026-10-04T00:00:05.000Z", sourceId: "recovery", sourceSequence: 4, sourceEventId: "newer-goal", nativeSessionId: "session-1" }]
    })).toMatchObject({ outcome: "projected", segmentId: segment!.id });
    const next = graph.conversationSegments.projectCanonicalEvent({
      laneId: "lane-goal", laneSequence: 5, event: human(5), observedAt: "2026-10-04T00:00:06.000Z"
    });
    expect(graph.conversationSegments.loadCardView(next.segmentId!)).toMatchObject({
      currentGoal: { objective: "Wait for operator", status: "blocked" }
    });

    expect(graph.conversationSegments.projectCanonicalEvent({
      laneId: "lane-goal", laneSequence: 6,
      event: event(6, { type: "goal_changed", goal_id: "goal-1", objective: "Wait for operator", status: "completed", source_updated_at: 22, truncated: false }),
      observedAt: "2026-10-04T00:00:07.000Z",
      goalChanges: [{ goalId: "goal-1", objective: "Wait for operator", status: "completed", sourceUpdatedAt: 22, occurredAt: "2026-10-04T00:00:07.000Z", sourceId: "recovery", sourceSequence: 6, sourceEventId: "completed-goal", nativeSessionId: "session-1" }]
    })).toMatchObject({ outcome: "projected", segmentId: next.segmentId });
    expect(graph.conversationSegments.loadCardView(next.segmentId!)?.currentGoal).toBeNull();
    graph.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("fails closed on a wrong-session pending submission", () => {
    const { context, store } = stores();
    store.admitLegacyPending({ segmentId: "pending-a", submissionId: "submission-a", producerKey: "feishu:primary", owner: { kind: "primary", id: "binding-a", generation: 1 }, agentKind: "traex", expectedSessionId: "session-1", requestText: "request", rootMessageId: "root-a", card: {}, occurredAt: "2026-10-04T00:00:00.000Z" });
    expect(store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 8, event: human(1, "submission-a", "wrong-session"), observedAt: "2026-10-04T00:00:08.000Z" })).toEqual({ outcome: "ignored", segmentId: null });
    expect(store.getConversationSegment("pending-a")?.state).toBe("pending");
    context.close();
  });

  it("fails closed when a canonical Human reuses a Submission Intent with changed immutable text", () => {
    const { context, store } = stores();
    const intents = new SqliteSubmissionIntentStore(context, { enqueue: (() => undefined) as never, conversationSegments: store });
    intents.admit({
      submissionId: "submission-conflict", ingressSource: "feishu:primary", sourceMessageKey: "source-conflict",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root-conflict" },
      text: "expected text", owner: { kind: "primary", id: "binding-conflict", generation: 2 }, paneId: "pane", terminalId: "terminal",
      expectedAgentKind: "traex", expectedSessionId: "session-1", recordedAt: "2026-10-04T00:00:00.000Z"
    });

    expect(store.projectCanonicalEvent({
      laneId: "lane-conflict", laneSequence: 8,
      event: event(1, { type: "human_message", message_id: "message-conflict", text: "changed text", truncated: false, submission_id: "submission-conflict" }),
      observedAt: "2026-10-04T00:00:08.000Z"
    })).toEqual({ outcome: "conflict", segmentId: null });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    context.close();
  });

  it("converges duplicate live/recovery replay and preserves a Tool position on update", () => {
    const { context, store } = stores();
    const started = store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 3, event: human(1), observedAt: "2026-10-04T00:00:03.000Z" });
    store.projectCanonicalEvent({ laneId: "lane-recovery", laneSequence: 77, event: human(1), observedAt: "2026-10-04T00:00:03.500Z" });
    const call = event(2, { type: "tool_call", call_id: "call-1", name: "exec", arguments: "{}" });
    const running = { kind: "tool" as const, id: "tool:call-1", sequence: 1, canonicalPosition: { laneSequence: 4, itemOrdinal: 0 }, category: "tool" as const, label: "exec", state: "running" as const };
    store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 4, event: call, observedAt: "2026-10-04T00:00:04.000Z", timelineDeltas: [running] });
    store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 5, event: event(3, { type: "tool_result", call_id: "call-1", text: "done", is_error: false }), observedAt: "2026-10-04T00:00:06.000Z", timelineDeltas: [{ ...running, state: "succeeded", result: "done" }] });
    const items = store.listConversationSegmentItems(started.segmentId!);
    expect(items.filter((item) => item.itemId === "tool:call-1")).toHaveLength(1);
    expect(items.find((item) => item.itemId === "tool:call-1")?.position).toEqual({ laneSequence: 4, itemOrdinal: 0 });
    context.close();
  });

  it("terminalizes the exact open segment from the canonical turn result", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    const humanEvent = human(1);
    const terminalEvent = { ...event(2, { type: "turn_completed" }), turnId: humanEvent.turnId };
    graph.coreEvents.ingestBatch({
      laneId: "lane-a",
      sourceId: "core",
      agentKind: "traex",
      sessionId: "session-1",
      afterCursor: "",
      nextCursor: terminalEvent.cursor,
      latestCursor: terminalEvent.cursor,
      events: [humanEvent, terminalEvent],
      ingestedAt: "2026-10-04T00:00:02.000Z"
    });

    const [segment] = graph.conversationSegments.listConversationSegmentsForProducer("lane:lane-a");
    expect(segment).toMatchObject({
      state: "completed",
      viewVersion: 2
    });
    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM completion_notification_obligations WHERE owner_kind='primary-segment'").get()).toEqual({ count: 0 });
    graph.database.close();
  });

  it("retains Agent tool history and cancellation without rendering skipped-record diagnostics", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    const humanEvent = human(1);
    const inTurn = (n: number, payload: Record<string, unknown>) => ({ ...event(n, payload), turnId: humanEvent.turnId });
    const events = [
      humanEvent,
      inTurn(2, { type: "tool_call", call_id: "spawn-1", name: "collaboration__spawn_agent", arguments: JSON.stringify({ task_name: "reviewer", model: "GPT-5.4", message: "review" }), truncated: false }),
      inTurn(3, { type: "agent_activity", agent_id: "/root/reviewer", display_name: "reviewer", state: "started" }),
      inTurn(4, { type: "agent_activity", agent_id: "/root/reviewer", display_name: "reviewer", state: "running", content: "Inspecting the exact failure.", content_truncated: false }),
      inTurn(5, { type: "agent_activity", agent_id: "/root/reviewer", display_name: "reviewer", state: "blocked" }),
      inTurn(6, { type: "agent_activity", agent_id: "/root/reviewer", display_name: "reviewer", state: "completed" }),
      inTurn(7, { type: "record_skipped", code: "malformed_private_detail" }),
      inTurn(8, { type: "record_skipped", code: "oversized_private_detail" }),
      inTurn(9, { type: "turn_aborted", reason: "operator cancelled api_key=live-secret" })
    ];

    graph.coreEvents.ingestBatch({
      laneId: "lane-lifecycle", sourceId: "core", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: events.at(-1)!.cursor, latestCursor: events.at(-1)!.cursor,
      events, ingestedAt: "2026-10-04T00:00:09.000Z"
    });

    const [segment] = graph.conversationSegments.listConversationSegmentsForProducer("lane:lane-lifecycle");
    const items = graph.conversationSegments.listConversationSegmentItems(segment!.id);
    expect(segment?.state).toBe("cancelled");
    expect(graph.database.prepare("SELECT COUNT(*) AS count FROM completion_notification_obligations WHERE owner_kind='primary-segment'").get()).toEqual({ count: 0 });
    expect(items.map(({ itemId }) => itemId)).toEqual([
      "human:message-1", "tool:spawn-1", "turn-aborted:event-9"
    ]);
    expect(items.find(({ itemId }) => itemId === "tool:spawn-1")).toMatchObject({
      position: { laneSequence: 2, itemOrdinal: 0 },
      item: { kind: "tool", state: "running", label: "reviewer" }
    });
    expect(items.some(({ itemId }) => itemId === "agent:reviewer")).toBe(false);
    expect(items.some(({ itemId }) => itemId === "integrity:record-skipped")).toBe(false);
    expect(items.find(({ itemId }) => itemId === "turn-aborted:event-9")?.position).toEqual({ laneSequence: 9, itemOrdinal: 0 });
    const rendered = JSON.stringify(graph.conversationSegments.loadCardView(segment!.id));
    expect(rendered).not.toContain("malformed_private_detail");
    expect(rendered).not.toContain("oversized_private_detail");
    expect(rendered).not.toContain("live-secret");
    graph.database.close();
  });

  it("rejects an equal strict segment boundary", () => {
    const { context, store } = stores();
    const result = store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 1, event: human(1), observedAt: "2026-10-04T00:00:01.000Z" });
    const segment = store.getConversationSegment(result.segmentId!)!;
    expect(() => closeConversationSegment(segment, { laneSequence: 1, itemOrdinal: 0 }, "2026-10-04T00:00:02.000Z")).toThrow();
    context.close();
  });

  it("rehydrates a result-only replay after reopening SQLite and deduplicates it", () => {
    const directory = mkdtempSync(join(tmpdir(), "segment-rehydrate-")); const path = join(directory, "bridge.db");
    let graph = new SqliteCapabilityGraph(path);
    const humanResult = graph.conversationSegments.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 1, event: human(1), observedAt: "2026-10-04T00:00:01.000Z" });
    const call = event(2, { type: "tool_call", call_id: "call-restart", name: "exec", arguments: "{}", truncated: false });
    graph.conversationSegments.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 2, event: call, observedAt: "2026-10-04T00:00:02.000Z", timelineDeltas: [{ kind: "tool", id: "tool:call-restart", sequence: 1, canonicalPosition: { laneSequence: 2, itemOrdinal: 0 }, category: "tool", label: "exec", state: "running" }] });
    graph.database.close();
    graph = new SqliteCapabilityGraph(path);
    const notifications: unknown[] = [];
    graph.conversationSegments.setProjectionNotifier((notification) => { notifications.push(notification); });
    const beforeRecoveryVersion = graph.conversationSegments.getConversationSegment(humanResult.segmentId!)!.viewVersion;
    const result = event(3, { type: "tool_result", call_id: "call-restart", text: `api_key=live-secret\n${"x".repeat(MAX_TURN_OUTPUT_CHARS)}`, is_error: false, truncated: false });
    expect(graph.conversationSegments.recoverToolResult({ laneId: "lane-a", laneSequence: 3, event: result, observedAt: "2026-10-04T00:00:03.000Z" })).toMatchObject({ outcome: "projected", segmentId: humanResult.segmentId });
    expect(graph.conversationSegments.getConversationSegment(humanResult.segmentId!)!.viewVersion).toBe(beforeRecoveryVersion + 1);
    expect(notifications).toEqual([expect.objectContaining({ segmentId: humanResult.segmentId, viewVersion: beforeRecoveryVersion + 1 })]);
    expect(graph.conversationSegments.recoverToolResult({ laneId: "lane-a", laneSequence: 3, event: result, observedAt: "2026-10-04T00:00:04.000Z" })).toMatchObject({ outcome: "duplicate", segmentId: humanResult.segmentId });
    expect(notifications).toHaveLength(1);
    const item = graph.conversationSegments.listConversationSegmentItems(humanResult.segmentId!).find(({ itemId }) => itemId === "tool:call-restart");
    expect(item).toMatchObject({ position: { laneSequence: 2, itemOrdinal: 0 }, item: { state: "succeeded" } });
    const recoveredResult = item?.item.kind === "tool" ? item.item.result : undefined;
    expect(recoveredResult).toHaveLength(MAX_TURN_OUTPUT_CHARS);
    expect(recoveredResult).toContain("api_key=[REDACTED]");
    expect(recoveredResult).not.toContain("live-secret");
    expect(recoveredResult?.endsWith(TURN_OUTPUT_TRUNCATION_MARKER)).toBe(true);
    graph.database.close(); rmSync(directory, { recursive: true, force: true });
  });

  it("reloads semantic Tool fields unchanged and renders older Tool JSON through the fallback", () => {
    const directory = mkdtempSync(join(tmpdir(), "segment-tool-semantics-")); const path = join(directory, "bridge.db");
    let graph = new SqliteCapabilityGraph(path);
    const started = graph.conversationSegments.projectCanonicalEvent({ laneId: "lane-tool-semantics", laneSequence: 1, event: human(1), observedAt: "2026-10-04T00:00:01.000Z" });
    const semantic = {
      kind: "tool" as const, id: "tool:semantic", sequence: 1, canonicalPosition: { laneSequence: 2, itemOrdinal: 0 },
      category: "command" as const, label: "legacy build", action: "Build", target: "npm run build",
      resultSummary: { outcome: "timeout" as const, text: "deadline exceeded" }, state: "failed" as const
    };
    const legacy = {
      kind: "tool" as const, id: "tool:legacy", sequence: 2, canonicalPosition: { laneSequence: 2, itemOrdinal: 1 },
      category: "command" as const, label: "legacy checks", command: "npm test", state: "succeeded" as const
    };
    graph.conversationSegments.projectCanonicalEvent({
      laneId: "lane-tool-semantics", laneSequence: 2,
      event: event(2, { type: "tool_call", call_id: "tool-semantics", name: "exec", arguments: "{}", truncated: false }),
      observedAt: "2026-10-04T00:00:02.000Z", timelineDeltas: [semantic, legacy]
    });

    graph.database.close();
    graph = new SqliteCapabilityGraph(path);
    const items = graph.conversationSegments.listConversationSegmentItems(started.segmentId!).map(({ item }) => item);
    expect(items).toContainEqual(semantic);
    expect(items).toContainEqual(legacy);
    expect(renderAnswerTimeline(items).at(-1)).toMatchObject({
      tag: "collapsible_panel", header: { title: { content: "⚙️ Ran npm test" } }
    });

    graph.database.close(); rmSync(directory, { recursive: true, force: true });
  });

  it("keeps a frozen legacy Tool page snapshot unchanged while later semantic Tool activity uses compact rendering", () => {
    const { context, graph, store } = stores();
    const segmentId = "semantic-tool-freeze";
    insertSemanticSegmentPage(context, { segmentId });
    const legacy = { kind: "tool" as const, id: "tool:legacy-frozen", sequence: 1, canonicalPosition: { laneSequence: 2, itemOrdinal: 1 }, category: "command" as const, label: "legacy checks", command: "npm test", state: "succeeded" as const };
    context.database.prepare(`INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json)
      VALUES(?,?,?,?,?)`).run(segmentId, legacy.id, 2, 1, JSON.stringify(legacy));
    const frozenSnapshot = { schemaVersion: 1, elements: renderAnswerTimeline([legacy]) };
    expect(store.reserveSemanticSnapshot!({
      transition: "freeze", segmentId, pageIndex: 0, messageId: "message-0", cardId: "card-0",
      elementId: `turn-card:${segmentId}:page:0`, snapshot: frozenSnapshot,
      cursor: { itemIndex: 2, markdownOffset: 0 }, cursorAnchor: { position: { laneSequence: 2, itemOrdinal: 1 }, inclusive: false },
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    })).toBe("reserved");
    const frozenReplyId = store.listConversationSegmentPages(segmentId)[0]!.pendingReplyId!;
    const semantic = { kind: "tool" as const, id: "tool:semantic-later", sequence: 2, canonicalPosition: { laneSequence: 3, itemOrdinal: 0 }, category: "command" as const, label: "legacy build", action: "Build", target: "npm run build", state: "succeeded" as const };
    store.projectCanonicalEvent({ laneId: segmentId, laneSequence: 3, event: event(3, { type: "tool_call", call_id: "later", name: "exec", arguments: "{}", truncated: false }), observedAt: "2026-10-04T00:00:03.000Z", timelineDeltas: [semantic] });

    expect(graph.preparedDeliveries.hydrateDeliveryInput(frozenReplyId)).toMatchObject({ input: { snapshot: frozenSnapshot } });
    expect(store.listConversationSegmentPages(segmentId)[0]).toMatchObject({ state: "frozen", pendingReplyId: frozenReplyId });
    expect(renderAnswerTimeline([semantic])).toEqual([{ tag: "markdown", content: "⚙️ Build · npm run build · ✓ 完成" }]);
    context.close();
  });

  it("redacts and bounds a result recovered through canonical projection", () => {
    const { context, store } = stores();
    const humanResult = store.projectCanonicalEvent({ laneId: "lane-a", laneSequence: 1, event: human(1), observedAt: "2026-10-04T00:00:01.000Z" });
    store.projectCanonicalEvent({
      laneId: "lane-a", laneSequence: 2,
      event: event(2, { type: "tool_call", call_id: "call-canonical", name: "collaboration__list_agents", arguments: "{}", truncated: false }),
      observedAt: "2026-10-04T00:00:02.000Z",
      timelineDeltas: [{ kind: "tool", id: "tool:call-canonical", sequence: 1, canonicalPosition: { laneSequence: 2, itemOrdinal: 0 }, category: "step", label: "list_agents", state: "running" }]
    });
    const result = store.projectCanonicalEvent({
      laneId: "lane-a", laneSequence: 3,
      event: event(3, { type: "tool_result", call_id: "call-canonical", text: JSON.stringify({ exit_code: 0, output: "token=live-secret" }), is_error: false, truncated: true }),
      observedAt: "2026-10-04T00:00:03.000Z"
    });
    expect(result).toMatchObject({ outcome: "projected", segmentId: humanResult.segmentId });
    const item = store.listConversationSegmentItems(humanResult.segmentId!).find(({ itemId }) => itemId === "tool:call-canonical");
    const recoveredResult = item?.item.kind === "tool" ? item.item.result : undefined;
    expect(recoveredResult).toBe("token=[REDACTED]\n\n… source event truncated");
    expect(recoveredResult).not.toContain("live-secret");
    context.close();
  });
});
