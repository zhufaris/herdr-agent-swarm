import { describe, expect, it } from "vitest";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import type { ConversationTurnIdentity } from "../src/domain/conversation-turn-projection.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

function setup() {
  const stores = createTestStoreBundle(":memory:");
  stores.driver.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Direct" });
  stores.driver.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "s1" });
  return stores;
}

function seedCanonicalHuman(stores: ReturnType<typeof setup>, identity: ConversationTurnIdentity, laneId = "lane-1") {
  const now = identity.startedAt;
  stores.coreEvents.ingestBatch({
    laneId,
    sourceId: "source",
    agentKind: identity.agentKind,
    sessionId: identity.sessionId,
    afterCursor: "",
    nextCursor: "1",
    latestCursor: "1",
    events: [{
      schemaVersion: 1,
      eventId: "human-1",
      cursor: "1",
      sourceId: "source",
      agentKind: identity.agentKind,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      occurredAt: now,
      payload: { type: "human_message", message_id: "message-1", text: "hello", truncated: false }
    }],
    ingestedAt: now
  });
  const segment = stores.driver.database.prepare("SELECT id FROM conversation_segments WHERE human_event_id='human-1'").get() as { id: string };
  return { laneId, segmentId: segment.id };
}

function view(identity: ConversationTurnIdentity) {
  let result = createQueuedRunCard({ promptId: `legacy:${identity.turnId}`, bindingId: "b1", bindingGeneration: 1, title: "Direct", workspaceId: "w1", spaceName: "repo", paneId: "p1", requestText: "hello", queuePosition: 0, occurredAt: identity.startedAt });
  result = reduceRunCard(result, { type: "started", occurredAt: identity.startedAt });
  return reduceRunCard(result, { type: "completed", occurredAt: new Date(Date.parse(identity.startedAt) + 1000).toISOString(), answer: "done", replaceAnswer: true });
}

const cards = { answerCardFor: (v: any) => ({ phase: v.phase }), mainCardFor: (v: any) => ({ phase: v.phase }), paneEntryCardFor: (v: any) => ({ phase: v.phase }) };

describe("direct Herdr Core segment cutover", () => {
  it("settles canonical segment without legacy projection or Primary Answer", () => {
    const stores = setup();
    const identity: ConversationTurnIdentity = { agentKind: "traex", sessionId: "s1", turnId: "t1", startedAt: "2026-10-04T10:00:00.000Z" };
    const { laneId, segmentId } = seedCanonicalHuman(stores, identity);
    expect(stores.driver.database.prepare("SELECT root_message_id FROM conversation_segments WHERE id=?").get(segmentId)).toEqual({ root_message_id: "root" });
    expect(stores.driver.capabilityModules().conversationSegments.listActionableConversationSegmentIds()).toContain(segmentId);
    const input = { identity, origin: "herdr" as const, bindingId: "b1", expectedGeneration: 1, expectedPaneId: "p1", view: view(identity), settlement: { laneId, eventIds: ["human-1"], occurredAt: "2026-10-04T10:00:02.000Z", owner: { kind: "binding" as const, id: "b1" } }, ...cards };
    expect(stores.externalTurns.projectConversationTurn(input)).toMatchObject({ outcome: "projected", outboxReserved: true, projection: null });
    expect(stores.driver.database.prepare("SELECT owner_id,owner_generation,root_message_id,state FROM conversation_segments WHERE id=?").get(segmentId)).toEqual({ owner_id: "b1", owner_generation: 1, root_message_id: "root", state: "working" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages WHERE segment_id=?").get(segmentId)).toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_turn_projections").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM worker_turn_cards").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM worker_turn_card_pages").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM answer_segments").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'conversation-turn:%'").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'conversation-turn:%'").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT state,last_agent_state FROM bindings WHERE id='b1'").get()).toEqual({ state: "active", last_agent_state: "done" });
    expect(stores.externalTurns.projectConversationTurn(input)).toMatchObject({ outcome: "projected", projection: null });
  });

  it("does not acknowledge a direct turn when its exact canonical segment is absent", () => {
    const stores = setup();
    const identity: ConversationTurnIdentity = { agentKind: "traex", sessionId: "s1", turnId: "missing", startedAt: "2026-10-04T10:00:00.000Z" };
    stores.driver.database.prepare("INSERT INTO core_event_inbox(event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at) VALUES('e','source','traex','s1','missing','1',?,?,?)").run(identity.startedAt, JSON.stringify({ type: "human_message" }), identity.startedAt);
    stores.driver.database.prepare("INSERT INTO core_event_lane_items(lane_id,event_id,sequence,state,failure,created_at,updated_at) VALUES('lane-1','e',1,'pending',NULL,?,?)").run(identity.startedAt, identity.startedAt);
    const result = stores.externalTurns.projectConversationTurn({ identity, origin: "herdr", bindingId: "b1", expectedGeneration: 1, expectedPaneId: "p1", view: view(identity), settlement: { laneId: "lane-1", eventIds: ["e"], occurredAt: identity.startedAt, owner: { kind: "binding", id: "b1" } }, ...cards });
    expect(result).toMatchObject({ outcome: "stale", projection: null });
    expect(stores.driver.database.prepare("SELECT state FROM core_event_lane_items WHERE event_id='e'").get()).toEqual({ state: "pending" });
  });

  it("quarantines invalid Prepared Answers after their saved message target is rejected", () => {
    const stores = setup();
    const identity: ConversationTurnIdentity = { agentKind: "traex", sessionId: "s1", turnId: "legacy", startedAt: "2026-10-04T10:00:00.000Z" };
    const first = view(identity);
    const project = (current: typeof first) => stores.externalTurns.projectConversationTurn({
      identity,
      origin: "feishu",
      bindingId: "b1",
      expectedGeneration: 1,
      expectedPaneId: "p1",
      view: current,
      answerCardFor: (value) => ({ revision: value.viewVersion }),
      mainCardFor: (value) => ({ phase: value.phase }),
      paneEntryCardFor: (value) => ({ phase: value.phase })
    });

    expect(project(first)).toMatchObject({ outcome: "projected", outboxReserved: true });
    const create = stores.driver.listPendingOutboundReplies().find((reply) => reply.cardRole === "answer")!;
    stores.driver.markOutboundReplyDelivered(create.id, "legacy-answer", "legacy-card");
    const second = { ...first, viewVersion: first.viewVersion + 1, updatedAt: "2026-10-04T10:00:02.000Z" };
    expect(project(second)).toMatchObject({ outboxReserved: true });
    const failed = stores.driver.database.prepare(`SELECT id FROM outbound_replies
      WHERE projection_key=? AND kind='card_update' AND state='dead_letter'`).get(
      `conversation-turn:${second.promptId}:answer`
    ) as { id: string };
    expect(stores.driver.getOutboundReply(failed.id)).toMatchObject({
      state: "dead_letter",
      projectionKey: `conversation-turn:${second.promptId}:answer`,
      failureClass: "permanent",
      effectCertainty: "rejected",
      error: "Gateway plan preparation failed"
    });
    expect(stores.driver.database.prepare("SELECT answer_message_id FROM conversation_turn_projections WHERE projection_id=?").get(second.promptId)).toEqual({ answer_message_id: "legacy-answer" });
    expect(stores.driver.database.prepare(`SELECT 1 AS found FROM outbound_replies WHERE projection_key=? AND kind='card_update' AND state IN ('dead_letter','dismissed') AND failure_class='permanent' AND effect_certainty='rejected' AND error=?`).get(
      `conversation-turn:${second.promptId}:answer`,
      "Gateway plan preparation failed"
    )).toEqual({ found: 1 });
    const third = { ...second, viewVersion: second.viewVersion + 1, updatedAt: "2026-10-04T10:00:03.000Z" };

    expect(project(third)).toMatchObject({ outcome: "projected", outboxReserved: true });
    expect(stores.driver.listPendingOutboundReplies().filter((reply) => reply.cardRole === "answer")).toEqual([]);
    expect(stores.driver.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies
      WHERE projection_key=? AND kind='card_update' AND state='dead_letter'
        AND failure_class='permanent' AND effect_certainty='rejected'`).get(
      `conversation-turn:${second.promptId}:answer`
    )).toEqual({ count: 2 });
  });
});
