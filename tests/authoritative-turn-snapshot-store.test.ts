import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoreEventEnvelope } from "../src/domain/core-event-inbox.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";
import { MAX_AUTHORITATIVE_SNAPSHOT_PAGE_BYTES, type SqliteAuthoritativeTurnSnapshotStore } from "../src/store/sqlite/authoritative-turn-snapshot-store.js";
import { coreEventSemanticHash } from "../src/store/sqlite/core-event-identity.js";

const identity = {
  agentKind: "traex" as const,
  sessionId: "session-1",
  turnId: "turn-1",
  requestedStartedAt: "2026-10-01T10:04:48.000Z"
};
const canonicalStartedAt = "2026-10-01T10:04:48.568Z";

describe("authoritative Turn snapshot staging", () => {
  it("accepts the cumulative count boundary and preserves cursor and gap evidence on overflow", () => {
    const stores = createTestStoreBundle(":memory:");
    let afterCursor = "";
    for (let page = 0; page < 8; page += 1) {
      const events = Array.from({ length: 128 }, (_, offset) => coreEvent(
        `bounded-${page}-${offset}`, `snapshot:${page * 128 + offset + 1}`,
        page === 0 && offset === 0 ? { type: "turn_started" } : { type: "message", message_id: `${page}-${offset}`, channel: "assistant", text: "x", truncated: false }
      ));
      const nextCursor = `snapshot:${(page + 1) * 128}`;
      expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
        identity, owner: { kind: "binding", id: "b1" }, afterCursor,
        batch: { outcome: "recovered", canonicalStartedAt, nextCursor, complete: false, events },
        observedAt: `2026-10-01T10:05:0${page}.000Z`
      })).toMatchObject({ outcome: "staged", nextCursor });
      afterCursor = nextCursor;
    }
    expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot(identity)).toMatchObject({ eventCount: 1024, nextCursor: afterCursor });
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity, owner: { kind: "binding", id: "b1" }, afterCursor,
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:1025", complete: false,
        events: [coreEvent("bounded-overflow", "snapshot:1025", { type: "message", message_id: "overflow", channel: "assistant", text: "x", truncated: false })] },
      observedAt: "2026-10-01T10:06:00.000Z"
    })).toMatchObject({ outcome: "ambiguous", failureCode: "snapshot_event_limit_exceeded", nextCursor: afterCursor });
    expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot(identity)).toMatchObject({ eventCount: 1024, nextCursor: afterCursor, state: "ambiguous" });
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity, owner: { kind: "binding", id: "b1" }, afterCursor,
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:retry", complete: false, events: [] },
      observedAt: "2026-10-01T10:07:00.000Z"
    })).toMatchObject({ outcome: "ambiguous", failureCode: "snapshot_event_limit_exceeded", nextCursor: afterCursor });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM authoritative_turn_snapshot_pages").get()).toEqual({ count: 8 });
    expect(stores.driver.database.prepare("SELECT failure_code FROM projection_gaps WHERE stage='turn_recovery' AND state='open'").get())
      .toEqual({ failure_code: "snapshot_event_limit_exceeded" });
    stores.lifecycle.close();
  });

  it("counts UTF-8 bytes and refuses an oversized page without persisting its payload", () => {
    const stores = createTestStoreBundle(":memory:");
    const text = "界".repeat(200_000);
    const events = Array.from({ length: 4 }, (_, index) => coreEvent(
      `oversized-${index}`, `snapshot:${index + 1}`,
      { type: "message", message_id: `large-${index}`, channel: "assistant", text, truncated: false }
    ));
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity, owner: { kind: "binding", id: "b1" }, afterCursor: "",
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:large", complete: false,
        events },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "ambiguous", failureCode: "snapshot_byte_limit_exceeded", nextCursor: "" });
    expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot(identity)).toMatchObject({ eventCount: 0, payloadBytes: 0, events: [] });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM authoritative_turn_snapshot_pages").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it("accounts duplicate event ids once within one page", () => {
    const stores = createTestStoreBundle(":memory:");
    const event = coreEvent("same", "snapshot:1", { type: "turn_started" });
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity, owner: { kind: "binding", id: "b1" }, afterCursor: "",
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:1", complete: false, events: [event, event] },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "staged" });
    expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot(identity)).toMatchObject({ eventCount: 1, events: [event] });
    stores.lifecycle.close();
  });

  it("accepts context snapshots in authoritative snapshot pages without changing the generic staging path", () => {
    const stores = createTestStoreBundle(":memory:");
    const start = coreEvent("context-start", "snapshot:1", { type: "turn_started" });
    const snapshot = coreEvent("context-snapshot", "snapshot:2", {
      type: "context_snapshot",
      model: "GPT-5.6-Sol",
      provider: "trae",
      permission_mode: "managed",
      current_date: "2026-10-22",
      timezone: "Etc/UTC",
      auto_compact_limit: 3_000
    });

    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity,
      owner: { kind: "binding", id: "b1" },
      afterCursor: "",
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:2", complete: false, events: [start, snapshot] },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "staged", nextCursor: "snapshot:2" });
    expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot(identity)).toMatchObject({
      eventCount: 2,
      events: [start, snapshot]
    });
    stores.lifecycle.close();
  });

  it("uses semantic identity when a skipped-record snapshot page is replayed with a new generated time", () => {
    const stores = createTestStoreBundle(":memory:");
    const start = coreEvent("start", "snapshot:1", { type: "turn_started" });
    const skipped = coreEvent("skipped", "snapshot:2", { type: "record_skipped", code: "record_too_large" });
    const first = {
      identity, owner: { kind: "binding" as const, id: "b1" }, afterCursor: "",
      batch: { outcome: "recovered" as const, canonicalStartedAt, nextCursor: "snapshot:2", complete: false, events: [start, skipped] },
      observedAt: "2026-10-01T10:05:00.000Z"
    };
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage(first)).toMatchObject({ outcome: "staged" });
    stores.driver.database.prepare(`UPDATE authoritative_turn_snapshot_pages SET page_hash='legacy-page-hash'
      WHERE agent_kind=? AND session_id=? AND turn_id=? AND requested_started_at=? AND after_cursor=''`)
      .run(identity.agentKind, identity.sessionId, identity.turnId, identity.requestedStartedAt);

    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      ...first,
      batch: {
        ...first.batch,
        events: [start, { ...skipped, sourceId: "replay", cursor: "replay:2", occurredAt: "2026-10-02T10:05:00.000Z" }]
      },
      observedAt: "2026-10-02T10:05:01.000Z"
    })).toMatchObject({ outcome: "duplicate", state: "staging" });
    stores.lifecycle.close();
  });

  it("fails a malformed snapshot event closed before staging payload evidence", () => {
    const stores = createTestStoreBundle(":memory:");
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity, owner: { kind: "binding", id: "b1" }, afterCursor: "",
      batch: {
        outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:1", complete: false,
        events: [coreEvent("malformed", "snapshot:1", {})]
      },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "ambiguous", failureCode: "snapshot_event_invalid" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM authoritative_turn_snapshot_pages").get())
      .toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it("preserves incomplete pages across restart without formal projection or outbox effects", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-turn-snapshot-"));
    const path = join(directory, "bridge.db");
    try {
      let stores = createTestStoreBundle(path);
      const events = [coreEvent("start", "c1", { type: "turn_started" })];
      expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
        identity,
        owner: { kind: "binding", id: "b1" },
        afterCursor: "",
        batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "c1", complete: false, events },
        observedAt: "2026-10-01T10:05:00.000Z"
      })).toMatchObject({ outcome: "staged", state: "staging", nextCursor: "c1" });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_turn_projection_events").get()).toEqual({ count: 0 });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
      stores.lifecycle.close();

      stores = createTestStoreBundle(path);
      expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot(identity)).toMatchObject({
        state: "staging",
        canonicalStartedAt,
        nextCursor: "c1",
        complete: false,
        events
      });
      expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
        identity,
        owner: { kind: "binding", id: "b1" },
        afterCursor: "",
        batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "c1", complete: false, events },
        observedAt: "2026-10-01T10:05:01.000Z"
      })).toMatchObject({ outcome: "duplicate", state: "staging", nextCursor: "c1" });
      expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot(identity)?.events).toEqual(events);
      stores.lifecycle.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts live A,C as an ordered subset of a complete A,B,C snapshot", () => {
    const stores = createTestStoreBundle(":memory:");
    const [a, b, c] = [
      coreEvent("a", "live:1", { type: "turn_started" }),
      coreEvent("b", "snapshot:2", { type: "message", message_id: "middle", channel: "assistant", text: "middle", truncated: false }),
      coreEvent("c", "live:2", { type: "turn_completed" })
    ];
    seedLive(stores, [a, c]);

    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity,
      owner: { kind: "binding", id: "b1" },
      afterCursor: "",
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:3", complete: true, events: [a, b, c] },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "ready", state: "ready", complete: true });
    expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot(identity)?.events.map(({ eventId }) => eventId)).toEqual(["a", "b", "c"]);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_turn_projection_events").get()).toEqual({ count: 2 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it.each([
    ["missing terminal event", [
      coreEvent("terminal-start", "snapshot:1", { type: "turn_started" }),
      coreEvent("terminal-answer", "snapshot:2", { type: "message", message_id: "answer", channel: "final", text: "answer", truncated: false })
    ]],
    ["multiple terminal events", [
      coreEvent("terminal-start", "snapshot:1", { type: "turn_started" }),
      coreEvent("terminal-completed", "snapshot:2", { type: "turn_completed" }),
      coreEvent("terminal-aborted", "snapshot:3", { type: "turn_aborted", reason: "interrupted" })
    ]],
    ["events after the terminal event", [
      coreEvent("terminal-start", "snapshot:1", { type: "turn_started" }),
      coreEvent("terminal-completed", "snapshot:2", { type: "turn_completed" }),
      coreEvent("terminal-late", "snapshot:3", { type: "message", message_id: "late", channel: "assistant", text: "late", truncated: false })
    ]]
  ] as const)("marks a completed snapshot with %s ambiguous", (_case, events) => {
    const stores = createTestStoreBundle(":memory:");
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity,
      owner: { kind: "binding", id: "b1" },
      afterCursor: "",
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:end", complete: true, events: [...events] },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "ambiguous", state: "ambiguous", failureCode: "terminal_event_invalid" });
    stores.lifecycle.close();
  });

  it("atomically replaces live order, preserves frozen pages, and reserves one prepared repair revision", async () => {
    const stores = createTestStoreBundle(":memory:");
    stores.driver.createPendingBinding({
      id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic",
      rootMessageId: "root", title: "Recovery"
    });
    stores.driver.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    const requestedPromptId = "prompt-repair";
    const queued = createQueuedRunCard({
      promptId: requestedPromptId, bindingId: "b1", title: "Recovery", workspaceId: "w1", spaceName: "repo", paneId: "w1:p1",
      requestText: "repair me", queuePosition: 0, occurredAt: identity.requestedStartedAt
    });
    const adopted = stores.driver.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: identity.turnId, startedAt: canonicalStartedAt, requestText: "repair me",
      externalPromptId: requestedPromptId, externalMessageId: "human", externalView: queued, answerCardFor: () => ({ old: true })
    });
    if (!adopted.prompt) throw new Error("expected external prompt adoption");
    const promptId = adopted.prompt.id;
    stores.driver.database.prepare(`UPDATE answer_pages
      SET message_id='frozen-message',card_id='frozen-card',element_id='frozen-element',state='frozen',updated_at=?
      WHERE prompt_id=? AND page_index=0`).run(identity.requestedStartedAt, promptId);
    const [a, b, c] = [
      coreEvent("a", "live:1", { type: "turn_started" }),
      coreEvent("b", "snapshot:2", { type: "message", message_id: "answer", channel: "final", text: "repaired answer", truncated: false }),
      coreEvent("c", "live:2", { type: "turn_completed" })
    ];
    seedLive(stores, [a, c]);
    compactLiveEvent(stores, a);
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity,
      owner: { kind: "binding", id: "b1" },
      afterCursor: "",
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:3", complete: true, events: [a, b, c] },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "ready" });
    const current = stores.driver.loadRunCard(promptId)!;
    let repaired = reduceRunCard(createQueuedRunCard({
      promptId, bindingId: "b1", title: current.title, workspaceId: current.workspaceId, spaceName: current.spaceName,
      paneId: current.paneId, requestText: "repair me", queuePosition: 0, occurredAt: identity.requestedStartedAt
    }), { type: "started", occurredAt: canonicalStartedAt });
    repaired = reduceRunCard(repaired, {
      type: "output", occurredAt: "2026-10-01T10:04:56.000Z", answerSnapshot: "repaired answer",
      progressEvents: [], timelineDeltas: [{ kind: "final_answer", id: "message:answer", sequence: 1, markdown: "repaired answer" }]
    });
    repaired = reduceRunCard(repaired, { type: "completed", occurredAt: "2026-10-01T10:04:56.000Z", answer: "repaired answer", replaceAnswer: true });
    repaired = {
      ...repaired,
      larkMessageId: current.larkMessageId,
      answerMessageId: current.answerMessageId,
      answerCardId: current.answerCardId,
      deliveredVersion: current.deliveredVersion,
      answerDeliveredVersion: current.answerDeliveredVersion,
      createdAt: current.createdAt,
      viewVersion: current.viewVersion + 1
    };
    const replace = (view = repaired) => stores.turnSnapshots.replaceAuthoritativeTurnSnapshot({
      identity,
      bindingId: "b1",
      expectedGeneration: 1,
      expectedPaneId: "w1:p1",
      projectionId: promptId,
      origin: "herdr",
      view,
      occurredAt: "2026-10-01T10:06:00.000Z",
      answerCardFor: (view) => ({ answer: view.answer, notice: view.notice }),
      mainCardFor: (view) => ({ phase: view.phase, version: view.viewVersion }),
      paneEntryCardFor: (view) => ({ phase: view.phase, version: view.viewVersion })
    });

    stores.driver.updateBinding("b1", { agentSessionValue: "session-other" });
    expect(replace()).toEqual({ outcome: "stale", outboxReserved: false });
    stores.driver.updateBinding("b1", { agentSessionValue: "session-1" });
    expect(replace({ ...repaired, phase: "running" })).toEqual({ outcome: "stale", outboxReserved: false });
    expect(stores.driver.database.prepare(`SELECT event_id FROM conversation_turn_projection_events
      WHERE agent_kind='traex' AND session_id='session-1' AND turn_id='turn-1' AND started_at=? ORDER BY sequence`).all(canonicalStartedAt))
      .toEqual([{ event_id: "a" }, { event_id: "c" }]);
    expect(stores.driver.database.prepare(`SELECT applied_at FROM authoritative_turn_snapshots
      WHERE agent_kind='traex' AND session_id='session-1' AND turn_id='turn-1' AND requested_started_at=?`).get(identity.requestedStartedAt))
      .toEqual({ applied_at: null });
    stores.outbox.setGatewayPlanPreparer((reply) => ({
      protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId, rendererRevision: 1,
      operation: "stream.create", intent: { kind: "stream.create", purpose: "primary-answer", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey }
    }));
    const handedOff = vi.fn();
    (stores.turnSnapshots as SqliteAuthoritativeTurnSnapshotStore).setPreparedDeliveryReservation(stores.outbox, { enqueuePreparedDelivery: handedOff });
    expect(replace()).toEqual({ outcome: "replaced", outboxReserved: true });
    await Promise.resolve();
    expect(stores.driver.database.prepare(`SELECT event_id FROM conversation_turn_projection_events
      WHERE agent_kind='traex' AND session_id='session-1' AND turn_id='turn-1' AND started_at=? ORDER BY sequence`).all(canonicalStartedAt))
      .toEqual([{ event_id: "a" }, { event_id: "b" }, { event_id: "c" }]);
    expect(stores.driver.database.prepare(`SELECT event_id,event_type,channel FROM core_event_inbox
      WHERE event_id IN ('a','b','c') ORDER BY event_id`).all()).toEqual([
      { event_id: "a", event_type: "turn_started", channel: null },
      { event_id: "b", event_type: "message", channel: "final" },
      { event_id: "c", event_type: "turn_completed", channel: null }
    ]);
    expect(stores.driver.loadRunCard(promptId)).toMatchObject({ phase: "completed", answer: "repaired answer", viewVersion: repaired.viewVersion });
    expect(stores.driver.database.prepare("SELECT state,message_id,card_id FROM answer_pages WHERE prompt_id=? AND page_index=0").get(promptId))
      .toEqual({ state: "frozen", message_id: "frozen-message", card_id: "frozen-card" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE work_class='history' AND prompt_id=?").get(promptId)).toEqual({ count: 1 });
    const repair = stores.driver.listPendingOutboundReplies().find((reply) => reply.workClass === "history" && reply.promptId === promptId)!;
    expect(repair).toMatchObject({ gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", paneId: "w1:p1" } });
    expect(handedOff).toHaveBeenCalledWith(expect.objectContaining({ replyId: repair.id }));
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE target_role='session_status' AND binding_id='b1'").get()).toEqual({ count: 1 });
    expect(replace()).toEqual({ outcome: "duplicate", outboxReserved: false });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE work_class='history' AND prompt_id=?").get(promptId)).toEqual({ count: 1 });
    stores.lifecycle.close();
  });

  it("rolls back before commit and reopens the committed projection with both repair intents", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-turn-replacement-"));
    const path = join(directory, "bridge.db");
    try {
      let stores = createTestStoreBundle(path);
      stores.driver.createPendingBinding({
        id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic",
        rootMessageId: "root", title: "Recovery"
      });
      stores.driver.updateBinding("b1", {
        state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1",
        agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
      });
      const queued = createQueuedRunCard({
        promptId: "prompt-crash", bindingId: "b1", title: "Recovery", workspaceId: "w1", spaceName: "repo", paneId: "w1:p1",
        requestText: "repair me", queuePosition: 0, occurredAt: identity.requestedStartedAt
      });
      const adopted = stores.driver.adoptExternalTurn({
        bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
        expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
        turnId: identity.turnId, startedAt: canonicalStartedAt, requestText: "repair me",
        externalPromptId: "prompt-crash", externalMessageId: "human", externalView: queued, answerCardFor: () => ({ old: true })
      });
      if (!adopted.prompt) throw new Error("expected external prompt adoption");
      const promptId = adopted.prompt.id;
      stores.driver.database.prepare(`UPDATE answer_pages
        SET message_id='frozen-message',card_id='frozen-card',element_id='frozen-element',state='frozen',updated_at=?
        WHERE prompt_id=? AND page_index=0`).run(identity.requestedStartedAt, promptId);
      const [a, b, c] = [
        coreEvent("crash-a", "live:1", { type: "turn_started" }),
        coreEvent("crash-b", "snapshot:2", { type: "message", message_id: "answer", channel: "final", text: "repaired after crash", truncated: false }),
        coreEvent("crash-c", "live:2", { type: "turn_completed" })
      ];
      seedLive(stores, [a, c]);
      expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
        identity, owner: { kind: "binding", id: "b1" }, afterCursor: "",
        batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:3", complete: true, events: [a, b, c] },
        observedAt: "2026-10-01T10:05:00.000Z"
      })).toMatchObject({ outcome: "ready" });
      const current = stores.driver.loadRunCard(promptId)!;
      let repaired = reduceRunCard(createQueuedRunCard({
        promptId, bindingId: "b1", title: current.title, workspaceId: current.workspaceId, spaceName: current.spaceName,
        paneId: current.paneId, requestText: "repair me", queuePosition: 0, occurredAt: identity.requestedStartedAt
      }), { type: "started", occurredAt: canonicalStartedAt });
      repaired = reduceRunCard(repaired, {
        type: "output", occurredAt: "2026-10-01T10:04:56.000Z", answerSnapshot: "repaired after crash",
        progressEvents: [], timelineDeltas: [{ kind: "final_answer", id: "message:answer", sequence: 1, markdown: "repaired after crash" }]
      });
      repaired = reduceRunCard(repaired, {
        type: "completed", occurredAt: "2026-10-01T10:04:56.000Z", answer: "repaired after crash", replaceAnswer: true
      });
      repaired = {
        ...repaired,
        larkMessageId: current.larkMessageId,
        answerMessageId: current.answerMessageId,
        answerCardId: current.answerCardId,
        deliveredVersion: current.deliveredVersion,
        answerDeliveredVersion: current.answerDeliveredVersion,
        createdAt: current.createdAt,
        viewVersion: current.viewVersion + 1
      };
      const replace = (mainCardFor: () => object) => stores.turnSnapshots.replaceAuthoritativeTurnSnapshot({
        identity, bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", projectionId: promptId,
        origin: "herdr", view: repaired, occurredAt: "2026-10-01T10:06:00.000Z",
        answerCardFor: (view) => ({ answer: view.answer }), mainCardFor,
        paneEntryCardFor: (view) => ({ phase: view.phase })
      });

      expect(() => replace(() => { throw new Error("simulated crash before commit"); })).toThrow("simulated crash before commit");
      expect(stores.driver.database.prepare("SELECT event_id FROM conversation_turn_projection_events ORDER BY sequence").all())
        .toEqual([{ event_id: "crash-a" }, { event_id: "crash-c" }]);
      expect(stores.driver.loadRunCard(promptId)).toMatchObject({ phase: "running", answer: "" });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE work_class='history'").get()).toEqual({ count: 0 });
      expect(stores.driver.database.prepare(`SELECT applied_at FROM authoritative_turn_snapshots
        WHERE agent_kind='traex' AND session_id='session-1' AND turn_id='turn-1' AND requested_started_at=?`).get(identity.requestedStartedAt))
        .toEqual({ applied_at: null });

      expect(replace((view) => ({ phase: (view as { phase: string }).phase }))).toEqual({ outcome: "replaced", outboxReserved: true });
      stores.lifecycle.close();

      stores = createTestStoreBundle(path);
      expect(stores.driver.database.prepare("SELECT event_id FROM conversation_turn_projection_events ORDER BY sequence").all())
        .toEqual([{ event_id: "crash-a" }, { event_id: "crash-b" }, { event_id: "crash-c" }]);
      expect(stores.driver.loadRunCard(promptId)).toMatchObject({ phase: "completed", answer: "repaired after crash" });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE work_class='history' AND prompt_id=?").get(promptId))
        .toEqual({ count: 1 });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE target_role='session_status' AND binding_id='b1'").get())
        .toEqual({ count: 1 });
      expect(stores.driver.database.prepare(`SELECT applied_projection_id FROM authoritative_turn_snapshots
        WHERE agent_kind='traex' AND session_id='session-1' AND turn_id='turn-1' AND requested_started_at=?`).get(identity.requestedStartedAt))
        .toEqual({ applied_projection_id: promptId });
      stores.lifecycle.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stages a unified direct Herdr snapshot from a canonical Human segment", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.driver.createPendingBinding({
      id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic",
      rootMessageId: "root", title: "Direct recovery"
    });
    stores.driver.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    const human = coreEvent("direct-human", "live:0", { type: "human_message", message_id: "direct-human", text: "direct input", truncated: false });
    stores.coreEvents.ingestBatch({ laneId: "live-lane", sourceId: "live-source", agentKind: "traex", sessionId: "session-1", afterCursor: "start", nextCursor: human.cursor, latestCursor: human.cursor, events: [human], ingestedAt: canonicalStartedAt });
    const [directStart, directAnswer, directCompleted] = [
      coreEvent("direct-start", "snapshot:1", { type: "turn_started" }),
      coreEvent("direct-answer", "snapshot:2", { type: "message", message_id: "answer", channel: "final", text: "direct repaired", truncated: false }),
      coreEvent("direct-completed", "snapshot:3", { type: "turn_completed" })
    ];
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity, owner: { kind: "binding", id: "b1" }, afterCursor: "",
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:3", complete: true, events: [directStart, directAnswer, directCompleted] },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "ready", state: "ready" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_turn_projections").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'turn-card:%'").get()).toEqual({ count: 1 });
    expect(stores.driver.capabilityModules().conversationSegments.listConversationSegmentsForProducer("lane:live-lane")).toHaveLength(1);
    stores.lifecycle.close();
  });

  it("rejects a discontinuous continuation without appending its events", () => {
    const stores = createTestStoreBundle(":memory:");
    const start = coreEvent("a", "snapshot:1", { type: "turn_started" });
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity,
      owner: { kind: "binding", id: "b1" },
      afterCursor: "",
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:1", complete: false, events: [start] },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "staged", nextCursor: "snapshot:1" });

    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity,
      owner: { kind: "binding", id: "b1" },
      afterCursor: "wrong-cursor",
      batch: {
        outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:2", complete: true,
        events: [coreEvent("c", "snapshot:2", { type: "turn_completed" })]
      },
      observedAt: "2026-10-01T10:05:01.000Z"
    })).toMatchObject({ outcome: "ambiguous", state: "ambiguous", failureCode: "page_discontinuity" });
    expect(stores.turnSnapshots.loadAuthoritativeTurnSnapshot(identity)?.events.map(({ eventId }) => eventId)).toEqual(["a"]);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it.each([
    ["extra live evidence", [coreEvent("a", "live:1", { type: "turn_started" }), coreEvent("extra", "live:2", { type: "tool_call", call_id: "extra", name: "extra", arguments: "{}", truncated: false }), coreEvent("c", "live:3", { type: "turn_completed" })], "live_event_missing"],
    ["conflicting live content", [coreEvent("a", "live:1", { type: "turn_started" }), coreEvent("b", "live:2", { type: "message", message_id: "middle", channel: "assistant", text: "conflict", truncated: false }), coreEvent("c", "live:3", { type: "turn_completed" })], "live_event_conflict"],
    ["reordered live evidence", [coreEvent("a", "live:1", { type: "turn_started" }), coreEvent("c", "live:2", { type: "turn_completed" }), coreEvent("b", "live:3", { type: "message", message_id: "middle", channel: "assistant", text: "middle", truncated: false })], "live_event_order_conflict"]
  ] as const)("marks %s ambiguous without changing formal projection", (_case, live, failureCode) => {
    const stores = createTestStoreBundle(":memory:");
    seedLive(stores, [...live]);
    const snapshot = [
      coreEvent("a", "snapshot:1", { type: "turn_started" }),
      coreEvent("b", "snapshot:2", { type: "message", message_id: "middle", channel: "assistant", text: "middle", truncated: false }),
      coreEvent("c", "snapshot:3", { type: "turn_completed" })
    ];
    const before = stores.driver.database.prepare("SELECT event_id, sequence FROM conversation_turn_projection_events ORDER BY sequence").all();

    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity,
      owner: { kind: "binding", id: "b1" },
      afterCursor: "",
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:3", complete: true, events: snapshot },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "ambiguous", state: "ambiguous", failureCode });
    expect(stores.driver.database.prepare("SELECT event_id, sequence FROM conversation_turn_projection_events ORDER BY sequence").all()).toEqual(before);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT failure_code FROM projection_gaps WHERE stage='turn_recovery' AND state='open'").get()).toEqual({ failure_code: failureCode });
    stores.lifecycle.close();
  });
});

function coreEvent(eventId: string, cursor: string, payload: Record<string, unknown>): CoreEventEnvelope {
  return {
    schemaVersion: 1,
    eventId,
    cursor,
    sourceId: cursor.startsWith("live:") ? "live-source" : "snapshot-source",
    agentKind: "traex",
    sessionId: "session-1",
    turnId: "turn-1",
    occurredAt: payload.type === "turn_started" ? canonicalStartedAt : "2026-10-01T10:04:56.000Z",
    payload
  };
}

function seedLive(stores: ReturnType<typeof createTestStoreBundle>, events: CoreEventEnvelope[]): void {
  stores.driver.database.prepare(`INSERT OR IGNORE INTO conversation_turn_projections(
    agent_kind,session_id,turn_id,started_at,source_lane_id,projection_id,origin,binding_id,binding_generation,pane_id,
    state_json,answer_card_json,answer_message_id,answer_card_id,delivered_revision,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,?,?)`).run(
    "traex", "session-1", "turn-1", canonicalStartedAt, "live-lane", "historical-turn", "herdr", null, null, null, "{}", "{}", "2026-10-01T10:04:57.000Z", "2026-10-01T10:04:57.000Z"
  );
  stores.coreEvents.ingestBatch({
    laneId: "live-lane",
    sourceId: "live-source",
    agentKind: "traex",
    sessionId: "session-1",
    afterCursor: "start",
    nextCursor: events.at(-1)!.cursor,
    latestCursor: events.at(-1)!.cursor,
    events: events.map((item) => ({ ...item, sourceId: "live-source" })),
    ingestedAt: "2026-10-01T10:04:57.000Z"
  });
  stores.coreEvents.acknowledge("live-lane", events.map(({ eventId }) => eventId), "projected", "2026-10-01T10:04:57.100Z");
}

function compactLiveEvent(stores: ReturnType<typeof createTestStoreBundle>, event: CoreEventEnvelope): void {
  const eventJson = JSON.stringify(event);
  const payloadHash = coreEventSemanticHash(event);
  if (payloadHash === null) throw new Error("expected valid Core event semantic hash");
  stores.driver.database.prepare(`INSERT INTO audit_skeletons(
    source_kind,source_id,payload_hash,payload_bytes,lifecycle_state,owner_kind,owner_id,
    created_at,terminal_at,barrier_version,state,verified_at,compacted_at,relationship_hash
  ) VALUES('core_event',?,?,?,'settled','traex','session-1',?,?,1,'compacted',?,?,?)`).run(
    event.eventId, payloadHash, Buffer.byteLength(eventJson), event.occurredAt, event.occurredAt,
    event.occurredAt, event.occurredAt, "0".repeat(64)
  );
  stores.driver.database.prepare("UPDATE core_event_inbox SET event_json='null',payload_compacted_at=? WHERE event_id=?")
    .run(event.occurredAt, event.eventId);
}
