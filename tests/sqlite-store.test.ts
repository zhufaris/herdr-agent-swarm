import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBridgeEvent } from "../src/domain/create-bridge-event.js";
import { initialTopicView, reduceTopicView } from "../src/domain/topic-view.js";
import { answerElementId, createQueuedRunCard } from "../src/domain/run-card-view.js";
import { renderRequestAnswerCard } from "../src/cards/run-card.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

let store: SqliteBindingStore | undefined;
let temporaryDirectory: string | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("SQLite store", () => {
  it("adds the Session operation inbox to an existing database", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-session-operation-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.database.exec("DROP TABLE session_operations");
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);

    expect(store.database.prepare("PRAGMA table_info(session_operations)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "interaction_id" }),
      expect.objectContaining({ name: "binding_generation" }),
      expect.objectContaining({ name: "state" })
    ]));
    expect(store.database.prepare("PRAGMA index_list(session_operations)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "session_operations_claim" }),
      expect.objectContaining({ name: "session_operations_recovery" })
    ]));
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("adds static delivery mode before backfilling legacy Answer pages", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-answer-page-delivery-mode-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root", answerCard: {} });
    store.database.exec(`
      DROP TABLE answer_pages;
      CREATE TABLE answer_pages(
        prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id), page_index INTEGER NOT NULL, message_id TEXT, card_id TEXT, element_id TEXT NOT NULL,
        source_start INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN ('creating','active','frozen','finished')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(prompt_id, page_index)
      );
    `);
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);

    expect(store.database.prepare("PRAGMA table_info(answer_pages)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "delivery_mode" })]));
    expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ deliveryMode: "streaming" })]);
  });

  it("atomically adopts the unique queued prompt matching an external Herdr turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", generation: 3, paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const queued = createQueuedRunCard({ promptId: "queued", bindingId: "b1", bindingGeneration: 3, title: "Work", workspaceId: "w1", paneId: "w1:p1", requestText: "line 1\r\nline 2", queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "queued", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "line 1\r\nline 2" }, view: queued, rootMessageId: "root", answerCard: {} });
    const startedAt = new Date(Date.now() + 1_000).toISOString();

    const result = store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 3, expectedPaneId: "w1:p1", expectedSession: { source: "traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-1", startedAt, requestText: "line 1\nline 2", externalPromptId: "external", externalMessageId: "herdr-turn:session-1:turn-1",
      externalView: { ...queued, promptId: "external" }, answerCardFor: renderRequestAnswerCard
    });

    expect(result).toMatchObject({ outcome: "adopted_queued", prompt: { id: "queued", executionOrigin: "herdr", state: "running", observationState: "attached", transcriptTurnId: "turn-1" }, supersededPromptIds: [], outboxReserved: true });
    expect(store.getPrompt("external")).toBeNull();
  });

  it("updates an already delivered queued Answer Card after external adoption", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const queued = createQueuedRunCard({ promptId: "queued", bindingId: "b1", title: "Work", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "queued", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view: queued, rootMessageId: "root", answerCard: {} });
    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "answer-1", "card-1");
    const startedAt = new Date(Date.now() + 1_000).toISOString();

    const result = store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-1", startedAt, requestText: "work", externalPromptId: "external", externalMessageId: "herdr-turn:session-1:turn-1",
      externalView: { ...queued, promptId: "external" }, answerCardFor: renderRequestAnswerCard
    });

    expect(result).toMatchObject({ outcome: "adopted_queued", outboxReserved: false });
    expect(store.loadRunCard("queued")).toMatchObject({ phase: "queued", answerMessageId: "answer-1", answerCardId: "card-1" });
  });

  it("creates an independently rendered Answer Card when no queued prompt uniquely matches", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", generation: 2, paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const externalView = createQueuedRunCard({ promptId: "external", bindingId: "b1", bindingGeneration: 2, title: "Direct work", workspaceId: "w1", paneId: "w1:p1", requestText: "direct work", queuePosition: 0, occurredAt: "2026-08-31T10:00:01.000Z" });

    const result = store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 2, expectedPaneId: "w1:p1", expectedSession: { source: "traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-2", startedAt: "2026-08-31T10:00:01.000Z", requestText: "direct work", externalPromptId: "external", externalMessageId: "herdr-turn:session-1:turn-2",
      externalView, answerCardFor: renderRequestAnswerCard
    });

    expect(result).toMatchObject({ outcome: "created_external", prompt: { id: "external", executionOrigin: "herdr", state: "running", observationState: "attached", transcriptTurnId: "turn-2" }, outboxReserved: true });
    expect(store.loadRunCard("external")).toMatchObject({ phase: "queued", queuePosition: 0, startedAt: null });
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([expect.objectContaining({ promptId: "external", kind: "stream_card_create", cardRole: "answer" })]));
  });

  it("atomically supersedes an exact-owned detached prompt with a later external turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const oldView = createQueuedRunCard({ promptId: "old", bindingId: "b1", title: "Old", workspaceId: "w1", paneId: "w1:p1", requestText: "old work", queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "old", bindingId: "b1", larkMessageId: "m-old", actorOpenId: "u1", body: "old work" }, view: oldView, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'attached' WHERE id = 'old'").run();
    store.database.prepare("UPDATE run_cards SET phase = 'running' WHERE prompt_id = 'old'").run();
    store.markPromptDispatched("old", "2026-08-31T10:00:01.000Z");
    expect(store.claimPromptTranscriptTurn({ promptId: "old", bindingId: "b1", turnId: "old-turn", startedAt: "2026-08-31T10:00:01.250Z" })).toMatchObject({ state: "claimed" });
    store.markPromptObservationDetached("old", "uncertain");
    const externalView = createQueuedRunCard({ promptId: "external", bindingId: "b1", title: "New", workspaceId: "w1", paneId: "w1:p1", requestText: "new work", queuePosition: 0, occurredAt: "2026-08-31T10:00:02.000Z" });

    const result = store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "new-turn", startedAt: "2026-08-31T10:00:02.000Z", requestText: "new work", externalPromptId: "external", externalMessageId: "herdr-turn:session-1:new-turn",
      supersede: { promptId: "old", turnId: "old-turn", startedAt: "2026-08-31T10:00:01.250Z" }, externalView, answerCardFor: renderRequestAnswerCard
    });

    expect(result).toMatchObject({ outcome: "created_external", supersededPromptIds: ["old"], prompt: { id: "external", transcriptTurnId: "new-turn" }, outboxReserved: true });
    expect(store.getPrompt("old")).toMatchObject({ state: "failed", observationState: "completed", transcriptTurnId: "old-turn" });
    expect(store.loadRunCard("old")).toMatchObject({ phase: "failed", notice: expect.stringContaining("newer Herdr turn") });
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([expect.objectContaining({ promptId: "external", cardRole: "answer" })]));
  });

  it("rejects supersession when the detached prompt fence does not match", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    store.database.prepare("INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, state, observation_state, dispatched_at, transcript_turn_id, transcript_turn_started_at, attempt_count, created_at, updated_at) VALUES ('old','b1','m-old','u1','old','turn','running','detached','2026-08-31T10:00:01.000Z','old-turn','2026-08-31T10:00:01.250Z',1,'2026-08-31T10:00:00.000Z','2026-08-31T10:00:01.250Z')").run();
    const externalView = createQueuedRunCard({ promptId: "external", bindingId: "b1", title: "New", workspaceId: "w1", paneId: "w1:p1", requestText: "new", queuePosition: 0, occurredAt: "2026-08-31T10:00:02.000Z" });
    const result = store.adoptExternalTurn({ bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "traex", agent: "traex", kind: "id", value: "session-1" }, turnId: "new-turn", startedAt: "2026-08-31T10:00:02.000Z", requestText: "new", externalPromptId: "external", externalMessageId: "external", supersede: { promptId: "old", turnId: "wrong-turn", startedAt: "2026-08-31T10:00:01.250Z" }, externalView, answerCardFor: renderRequestAnswerCard });
    expect(result.outcome).toBe("conflict");
    expect(store.getPrompt("old")).toMatchObject({ state: "running", observationState: "detached" });
    expect(store.getPrompt("external")).toBeNull();
  });

  it("does not reuse queued Feishu work when superseding an interrupted Herdr turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    for (const [id, body] of [["old", "old"], ["queued", "new"]] as const) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: body, queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body }, view, rootMessageId: "root", answerCard: {} });
    }
    store.database.prepare("UPDATE prompt_jobs SET state='running', observation_state='detached', dispatched_at='2026-08-31T10:00:01.000Z', transcript_turn_id='old-turn', transcript_turn_started_at='2026-08-31T10:00:01.000Z' WHERE id='old'").run();
    store.database.prepare("UPDATE run_cards SET phase='running' WHERE prompt_id='old'").run();
    const externalView = createQueuedRunCard({ promptId: "external", bindingId: "b1", title: "new", workspaceId: "w1", paneId: "w1:p1", requestText: "new", queuePosition: 0, occurredAt: "2026-08-31T10:00:02.000Z" });
    const result = store.adoptExternalTurn({ bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "traex", agent: "traex", kind: "id", value: "session-1" }, turnId: "new-turn", startedAt: "2026-08-31T10:00:02.000Z", requestText: "new", externalPromptId: "external", externalMessageId: "external", supersede: { promptId: "old", turnId: "old-turn", startedAt: "2026-08-31T10:00:01.000Z" }, externalView, answerCardFor: renderRequestAnswerCard });
    expect(result).toMatchObject({ outcome: "created_external", prompt: { id: "external" } });
    expect(store.getPrompt("queued")).toMatchObject({ state: "queued", observationState: "not_started", executionOrigin: "bridge" });
  });

  it("persists dispatch and exact transcript ownership provenance", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Prompt", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });

    expect(store.getPrompt("p1")).toMatchObject({ dispatchedAt: null, transcriptTurnId: null, transcriptTurnStartedAt: null });
    expect(store.claimNextDispatchablePrompt("b1")?.prompt).toMatchObject({ id: "p1", observationState: "not_started" });
    const dispatchedAt = "2026-08-30T00:00:01.000Z";
    store.markPromptDispatched("p1", dispatchedAt);

    const dispatched = store.getPrompt("p1")!;
    expect(dispatched).toMatchObject({ observationState: "attached", transcriptTurnId: null, transcriptTurnStartedAt: null });
    expect(dispatched.dispatchedAt).toBe(dispatchedAt);
    expect(dispatched.updatedAt).not.toBe(dispatchedAt);
    expect(() => store!.markPromptDispatched("p1", "not-an-iso-timestamp")).toThrow("Invalid prompt dispatch timestamp");
  });

  it("claims one eligible transcript turn without allowing replacement", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Prompt", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    store.claimNextDispatchablePrompt("b1");
    store.markPromptDispatched("p1", new Date().toISOString());
    const dispatched = store.getPrompt("p1")!;
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const startedAt = new Date(Date.parse(dispatched.dispatchedAt!) + 250).toISOString();
    const claim = { promptId: "p1", bindingId: "b1", turnId, startedAt };

    expect(store.claimPromptTranscriptTurn({ ...claim, startedAt: new Date(Date.parse(dispatched.dispatchedAt!) - 1_001).toISOString() })).toMatchObject({ state: "ineligible", prompt: { transcriptTurnId: null } });
    expect(store.claimPromptTranscriptTurn(claim)).toMatchObject({ state: "claimed", prompt: { transcriptTurnId: turnId, transcriptTurnStartedAt: startedAt } });
    expect(store.claimPromptTranscriptTurn(claim)).toMatchObject({ state: "matched", prompt: { transcriptTurnId: turnId, transcriptTurnStartedAt: startedAt } });
    expect(store.claimPromptTranscriptTurn({ ...claim, turnId: "01a052d3-9c14-70e1-a375-397e2ecb55ea" })).toMatchObject({ state: "conflict", prompt: { transcriptTurnId: turnId, transcriptTurnStartedAt: startedAt } });
    store.markPromptObservationDetached("p1", "recovering");
    expect(store.claimPromptTranscriptTurn(claim)).toMatchObject({ state: "matched", prompt: { observationState: "detached", transcriptTurnId: turnId } });
    store.database.prepare("UPDATE prompt_jobs SET dispatched_at = 'unusable-dispatch-time', transcript_turn_started_at = 'unusable-stored-start' WHERE id = 'p1'").run();
    expect(store.claimPromptTranscriptTurn({ ...claim, startedAt: "unusable-input-start" })).toMatchObject({ state: "matched", prompt: { observationState: "detached", transcriptTurnId: turnId } });
    expect(store.claimPromptTranscriptTurn({ ...claim, turnId: "01a052d3-9c14-70e1-a375-397e2ecb55ea", startedAt: "unusable-input-start" })).toMatchObject({ state: "conflict", prompt: { observationState: "detached", transcriptTurnId: turnId } });
  });

  it("preserves transcript provenance when recovering attached prompts as detached", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    for (const id of ["owned", "legacy"]) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "root", answerCard: {} });
      store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'attached', dispatched_at = ? WHERE id = ?").run("2026-08-30T00:00:01.000Z", id);
    }
    expect(store.claimPromptTranscriptTurn({ promptId: "owned", bindingId: "b1", turnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", startedAt: "2026-08-30T00:00:01.250Z" })).toMatchObject({ state: "claimed" });

    expect(store.recoverRunningPrompts()).toBe(2);
    expect(store.getPrompt("owned")).toMatchObject({ observationState: "detached", dispatchedAt: "2026-08-30T00:00:01.000Z", transcriptTurnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptTurnStartedAt: "2026-08-30T00:00:01.250Z" });
    expect(store.getPrompt("legacy")).toMatchObject({ observationState: "detached", dispatchedAt: "2026-08-30T00:00:01.000Z", transcriptTurnId: null, transcriptTurnStartedAt: null });
  });

  it.each([
    ["queued", "turn", "not_started", 0],
    ["running steering", "steering", "attached", 0],
    ["completed", "turn", "completed", 0],
    ["already detached", "turn", "detached", 1]
  ] as const)("does not make a first transcript claim for a %s prompt", (_label, dispatchKind, observationState, wasDetached) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Prompt", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    const state = observationState === "not_started" ? "queued" : observationState === "completed" ? "delivered" : "running";
    store.database.prepare("UPDATE prompt_jobs SET dispatch_kind = ?, state = ?, observation_state = ?, was_detached = ?, dispatched_at = ? WHERE id = 'p1'").run(dispatchKind, state, observationState, wasDetached, "2026-08-30T00:00:00.000Z");

    expect(store.claimPromptTranscriptTurn({ promptId: "p1", bindingId: "b1", turnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", startedAt: "2026-08-30T00:00:00.250Z" })).toMatchObject({ state: "ineligible", prompt: { transcriptTurnId: null } });
  });

  it("adds nullable transcript provenance to legacy prompt rows without changing state", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-turn-provenance-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "legacy", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "legacy", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    store.database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX prompt_jobs_source_prompt_once;
      CREATE TABLE prompt_jobs_legacy(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE NOT NULL,
        actor_open_id TEXT NOT NULL, body TEXT NOT NULL, dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering')), parent_prompt_id TEXT,
        steering_origin TEXT CHECK(steering_origin IN ('explicit','automatic','converted')), source_prompt_id TEXT REFERENCES prompt_jobs_legacy(id), was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1)),
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed','cancelled')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO prompt_jobs_legacy(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, state, observation_state, attempt_count, error, created_at, updated_at)
        SELECT id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, state, observation_state, attempt_count, error, created_at, updated_at FROM prompt_jobs;
      DROP TABLE prompt_jobs;
      ALTER TABLE prompt_jobs_legacy RENAME TO prompt_jobs;
      PRAGMA foreign_keys = ON;
    `);
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);
    expect(store.getPrompt("legacy")).toMatchObject({ state: "queued", observationState: "not_started", dispatchedAt: null, transcriptTurnId: null, transcriptTurnStartedAt: null });
  });

  it("fences Primary capabilities to an attached binding generation with exactly one active ordinary prompt", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3 });
    const view = createQueuedRunCard({ promptId: "parent", bindingId: "b1", bindingGeneration: 3, title: "parent", workspaceId: "w1", paneId: "w1:p1", requestText: "coordinate", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "m-parent", actorOpenId: "u1", body: "coordinate" }, view, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("parent", "running");

    expect(store.setBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 3, capabilityHash: "hash" })).toBe(true);
    expect(store.verifyBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 3, capabilityHash: "hash" })).toBe(true);
    expect(store.getActiveOrdinaryPrompt("b1", 3)).toMatchObject({ id: "parent", dispatchKind: "turn", state: "running" });
    expect(store.verifyBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 2, capabilityHash: "hash" })).toBe(false);
    expect(store.setBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 4, capabilityHash: "next-hash" })).toBe(true);
    expect(store.verifyBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 3, capabilityHash: "hash" })).toBe(true);

    store.updateBinding("b1", { attachment: "orphaned" });
    expect(store.verifyBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 3, capabilityHash: "hash" })).toBe(false);
    expect(store.getActiveOrdinaryPrompt("b1", 3)).toBeNull();
  });

  it("does not treat a running prompt from an earlier binding generation as active", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 1 });
    const view = createQueuedRunCard({ promptId: "generation-1", bindingId: "b1", bindingGeneration: 1, title: "parent", workspaceId: "w1", paneId: "w1:p1", requestText: "coordinate", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "generation-1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "coordinate" }, view, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("generation-1", "running");
    store.updateBinding("b1", { generation: 2 });

    expect(store.getActiveOrdinaryPrompt("b1", 2)).toBeNull();
  });

  it("atomically revokes the retained generation capability when attaching an unproven pane", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "orphaned", lifecycle: "active", attachment: "orphaned", paneId: "w1:old" });
    store.setBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 1, capabilityHash: "hash" });

    store.attachBindingPane("b1", { paneId: "w1:selected", terminalId: "term-selected", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"] }, false);

    expect(store.hasBindingPrimaryToolCapability("b1", 1)).toBe(false);
  });

  it("recreates only legacy instance-keyed Primary capabilities during schema convergence", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "primary-capability-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "preserved-binding", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Preserved" });
    store.createAgentInstance({ id: "preserved-worker", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "preserved-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    store.database.exec("DROP TABLE primary_tool_capabilities; CREATE TABLE primary_tool_capabilities(instance_id TEXT PRIMARY KEY REFERENCES agent_instances(id) ON DELETE CASCADE, instance_generation INTEGER NOT NULL, capability_hash TEXT NOT NULL, created_at TEXT NOT NULL)");
    store.database.prepare("INSERT INTO primary_tool_capabilities VALUES (?, ?, ?, ?)").run("preserved-worker", 1, "ephemeral-secret", "2026-08-30T00:00:00.000Z");
    store.close(); store = undefined;

    store = new SqliteBindingStore(path);
    const columns = store.database.prepare("PRAGMA table_info(primary_tool_capabilities)").all() as Array<{ name: string; pk: number }>;
    expect(columns.map(({ name }) => name)).toEqual(["binding_id", "binding_generation", "capability_hash", "created_at"]);
    expect(columns.filter(({ pk }) => pk > 0).map(({ name }) => name)).toEqual(["binding_id", "binding_generation"]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM primary_tool_capabilities").get()).toEqual({ count: 0 });
    expect(store.getBinding("preserved-binding")).not.toBeNull();
    expect(store.getAgentInstance("preserved-worker")).not.toBeNull();
    expect(store.getWorkspaceLease("preserved-workspace")).not.toBeNull();
  });

  it("creates instance hot-path indexes and paginates equal-timestamp history without gaps", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    for (let index = 0; index < 7; index += 1) store.acceptInstanceTurn({ id: `turn-${index}`, idempotencyKey: `turn-${index}`, actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: "i1", instanceGeneration: 1, kind: "turn", text: `work ${index}` });
    store.database.prepare("UPDATE instance_turns SET created_at = '2026-08-30T00:00:00.000Z'").run();

    const first = store.listInstanceTurns("i1", { limit: 3 });
    const second = store.listInstanceTurns("i1", { limit: 3, after: first.nextCursor! });
    const third = store.listInstanceTurns("i1", { limit: 3, after: second.nextCursor! });
    expect([...first.items, ...second.items, ...third.items].map(({ id }) => id)).toEqual(Array.from({ length: 7 }, (_, index) => `turn-${index}`));
    expect(first.nextCursor).toEqual({ createdAt: "2026-08-30T00:00:00.000Z", id: "turn-2" });
    expect(third.nextCursor).toBeNull();

    const indexNames = (store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'instance_%'").all() as Array<{ name: string }>).map(({ name }) => name);
    expect(indexNames).toEqual(expect.arrayContaining(["instance_turns_observable", "instance_turns_instance_history", "instance_events_instance_id"]));
    const historyPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT * FROM instance_turns INDEXED BY instance_turns_instance_history WHERE instance_id = ? ORDER BY created_at, id LIMIT 10").all("i1") as Array<{ detail: string }>;
    const observablePlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT * FROM instance_turns INDEXED BY instance_turns_observable WHERE state IN ('dispatching','running','blocked','dispatch-uncertain') ORDER BY created_at, id").all() as Array<{ detail: string }>;
    const eventPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT * FROM instance_events INDEXED BY instance_events_instance_id WHERE instance_id = ? AND id > ? ORDER BY id LIMIT 100").all("i1", 0) as Array<{ detail: string }>;
    expect(historyPlan.some(({ detail }) => detail.includes("instance_turns_instance_history"))).toBe(true);
    expect(observablePlan.some(({ detail }) => detail.includes("instance_turns_observable"))).toBe(true);
    expect(eventPlan.some(({ detail }) => detail.includes("instance_events_instance_id"))).toBe(true);
  });

  it("persists exact approval identity and consumes a matching grant once", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const identity = { actorId: "user-1", projectId: "project-a", instanceId: "i1", instanceGeneration: 1, actionFingerprint: "sha256:action", resourceScope: "repo/acme#new", policyVersion: "policy-v1" };
    const request = store.createApprovalRequest({ id: "request-1", ...identity, expiresAt: "2026-08-28T16:00:00.000Z" });
    expect(request).toMatchObject({ ...identity, state: "pending", tier: "remote-confirmation" });

    expect(store.resolveApprovalRequest({ requestId: request.id, actorId: "other", approved: true, now: "2026-08-28T15:00:00.000Z", grantId: "grant-x" }).outcome).toBe("unauthorized");
    expect(store.resolveApprovalRequest({ requestId: request.id, actorId: "user-1", approved: true, now: "2026-08-28T15:00:00.000Z", grantId: "grant-1" })).toMatchObject({ outcome: "approved", grant: { id: "grant-1", ...identity, consumedAt: null } });
    expect(store.resolveApprovalRequest({ requestId: request.id, actorId: "user-1", approved: true, now: "2026-08-28T15:01:00.000Z", grantId: "grant-2" }).outcome).toBe("duplicate");
    expect(store.consumeApprovalGrant({ grantId: "grant-1", ...identity, actionFingerprint: "sha256:changed", now: "2026-08-28T15:02:00.000Z" })).toBe("mismatch");
    expect(store.consumeApprovalGrant({ grantId: "grant-1", ...identity, now: "2026-08-28T15:02:00.000Z" })).toBe("consumed");
    expect(store.consumeApprovalGrant({ grantId: "grant-1", ...identity, now: "2026-08-28T15:03:00.000Z" })).toBe("used");
  });

  it("atomically creates and reads an agent instance with its workspace lease", () => {
    store = new SqliteBindingStore(":memory:");

    const created = store.createAgentInstance({
      id: "i1", projectId: "project-a", name: "reviewer", role: "worker", agentKind: "claude-code", model: null,
      desiredState: "stopped", workspace: { id: "ws1", kind: "git-worktree", cwd: "/work/reviewer", branch: "worker/reviewer", baseCommit: "abc123" }
    });

    expect(created).toMatchObject({ id: "i1", projectId: "project-a", name: "reviewer", role: "worker", generation: 1, observedState: "unprovisioned", workspaceLeaseId: "ws1" });
    expect(store.getAgentInstance("i1")).toEqual(created);
    expect(store.getWorkspaceLease("ws1")).toMatchObject({ instanceId: "i1", kind: "git-worktree", state: "allocating", branch: "worker/reviewer" });
  });

  it("enforces one primary per project and switches it atomically", () => {
    store = new SqliteBindingStore(":memory:");
    const create = (id: string, name: string) => store!.createAgentInstance({
      id, projectId: "project-a", name, role: "worker", agentKind: "traex", model: null, desiredState: "stopped",
      workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "abc123" }
    });
    create("i1", "one");
    create("i2", "two");

    expect(store.setPrimaryAgentInstance("project-a", "i1")).toMatchObject({ id: "i1", role: "primary" });
    expect(store.setPrimaryAgentInstance("project-a", "i2")).toMatchObject({ id: "i2", role: "primary" });
    expect(store.listAgentInstances("project-a").map(({ id, role }) => ({ id, role }))).toEqual([
      { id: "i1", role: "worker" }, { id: "i2", role: "primary" }
    ]);
  });

  it("allows Worker listings to exclude a preserved legacy Primary row", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "legacy-primary", projectId: "project-a", name: "legacy", role: "primary", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws-primary", kind: "main-checkout", cwd: "/repo", branch: null, baseCommit: "abc123" } });
    store.createAgentInstance({ id: "worker", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws-worker", kind: "git-worktree", cwd: "/repo/.worktree/worker", branch: "swarm/worker", baseCommit: "abc123" } });

    expect(store.listAgentInstances("project-a").filter(({ role }) => role === "worker").map(({ id }) => id)).toEqual(["worker"]);
    expect(store.getAgentInstance("legacy-primary")).toMatchObject({ id: "legacy-primary", role: "primary" });
  });

  it("atomically enforces the Worker limit while ignoring legacy Primary rows", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "legacy-primary", projectId: "project-a", name: "legacy", role: "primary", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws-primary", kind: "main-checkout", cwd: "/repo", branch: null, baseCommit: "abc123" } });
    const worker = (id: string) => ({ id, projectId: "project-a", name: id, role: "worker" as const, agentKind: "traex" as const, model: null, desiredState: "stopped" as const, workspace: { id: `ws-${id}`, kind: "git-worktree" as const, cwd: `/repo/.worktree/${id}`, branch: `swarm/${id}`, baseCommit: "abc123" } });

    expect(store.createWorkerAgentInstance(worker("one"), 1)).toMatchObject({ outcome: "created", instance: { id: "one", role: "worker" } });
    expect(store.createWorkerAgentInstance(worker("two"), 1)).toEqual({ outcome: "limit-reached" });
    expect(store.listAgentInstances("project-a").map(({ id }) => id)).toEqual(["legacy-primary", "one"]);
    expect(store.getWorkspaceLease("ws-two")).toBeNull();
  });

  it("allows only one of two competing Worker inserts at the last slot", async () => {
    store = new SqliteBindingStore(":memory:");
    const worker = (id: string) => ({ id, projectId: "project-a", name: id, role: "worker" as const, agentKind: "traex" as const, model: null, desiredState: "stopped" as const, workspace: { id: `ws-${id}`, kind: "git-worktree" as const, cwd: `/repo/.worktree/${id}`, branch: `swarm/${id}`, baseCommit: "abc123" } });

    const outcomes = await Promise.all(["one", "two"].map(async (id) => store!.createWorkerAgentInstance(worker(id), 1)));
    expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(["created", "limit-reached"]);
    expect(store.listAgentInstances("project-a").filter(({ role }) => role === "worker")).toHaveLength(1);
  });

  it("rejects stale runtime attachment without changing the instance", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({
      id: "i1", projectId: "project-a", name: "coder", role: "worker", agentKind: "codex", model: null, desiredState: "running",
      workspace: { id: "ws1", kind: "git-worktree", cwd: "/work/coder", branch: "worker/coder", baseCommit: "abc123" }
    });

    expect(store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 2, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "s1" })).toBeNull();
    expect(store.getAgentInstance("i1")).toMatchObject({ generation: 1, runtimeRef: null, observedState: "unprovisioned" });
    expect(store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "s1" })).toMatchObject({
      generation: 2, observedState: "idle", runtimeRef: { paneId: "w1:p1", generation: 2 }
    });
  });

  it("recovers only pre-dispatch instance claims back to the FIFO queue", () => {
    store = new SqliteBindingStore(":memory:");
    const createRunning = (id: string) => {
      store!.createAgentInstance({
        id, projectId: "project-a", name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running",
        workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "abc123" }
      });
      return store!.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: `w1:${id}`, nativeSessionId: null })!;
    };
    const actor = { kind: "human" as const, userId: "u1" };
    const claimedInstance = createRunning("claimed-worker");
    const uncertainInstance = createRunning("uncertain-worker");
    store.acceptInstanceTurn({ id: "claimed-turn", idempotencyKey: "claimed-turn", actor, projectId: "project-a", instanceId: claimedInstance.id, instanceGeneration: claimedInstance.generation, kind: "turn", text: "safe to retry" });
    store.acceptInstanceTurn({ id: "uncertain-turn", idempotencyKey: "uncertain-turn", actor, projectId: "project-a", instanceId: uncertainInstance.id, instanceGeneration: uncertainInstance.generation, kind: "turn", text: "must not replay" });
    store.claimNextInstanceTurn(claimedInstance.id, claimedInstance.generation);
    store.claimNextInstanceTurn(uncertainInstance.id, uncertainInstance.generation);
    store.updateInstanceTurn({ turnId: "uncertain-turn", expectedGeneration: uncertainInstance.generation, state: "dispatching", eventKind: "turn.dispatching" });

    expect(store.recoverInterruptedInstanceTurns()).toEqual({
      requeuedTurnIds: ["claimed-turn"],
      observableTurns: [expect.objectContaining({ id: "uncertain-turn", state: "dispatching" })]
    });
    expect(store.getInstanceTurn("claimed-turn")).toMatchObject({ state: "queued" });
    expect(store.getInstanceTurn("uncertain-turn")).toMatchObject({ state: "dispatching" });
  });

  it("scopes active turn fencing to the current runtime generation", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const first = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: null })!;
    const actor = { kind: "human" as const, userId: "u1" };
    store.acceptInstanceTurn({ id: "old", idempotencyKey: "old", actor, projectId: "project-a", instanceId: "i1", instanceGeneration: first.generation, kind: "turn", text: "old" });
    store.claimNextInstanceTurn("i1", first.generation);
    store.updateInstanceTurn({ turnId: "old", expectedGeneration: first.generation, state: "dispatch-uncertain", eventKind: "turn.dispatch-uncertain" });
    store.detachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: first.generation, reason: "pane replaced" });
    const detached = store.getAgentInstance("i1")!;
    const current = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: detached.generation, herdrWorkspaceId: "w1", paneId: "w1:p2", nativeSessionId: null })!;
    store.acceptInstanceTurn({ id: "new", idempotencyKey: "new", actor, projectId: "project-a", instanceId: "i1", instanceGeneration: current.generation, kind: "turn", text: "new" });

    expect(store.claimNextInstanceTurn("i1", current.generation)).toMatchObject({ id: "new", state: "claimed" });
    expect(store.getInstanceTurn("old")).toMatchObject({ state: "dispatch-uncertain", instanceGeneration: first.generation });
    expect(store.getInstanceTurnDiagnostics()).toEqual({ queuedTurns: 0, activeTurns: 1, uncertainTurns: 0 });
  });

  it("reserves stop only when the current generation has no active or uncertain turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const instance = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: null })!;
    store.acceptInstanceTurn({ id: "turn", idempotencyKey: "turn", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: "i1", instanceGeneration: instance.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn("i1", instance.generation);

    expect(store.reserveAgentInstanceStop("i1", instance.generation)).toEqual({ outcome: "busy" });
    store.updateInstanceTurn({ turnId: "turn", expectedGeneration: instance.generation, state: "completed", eventKind: "turn.completed" });
    expect(store.reserveAgentInstanceStop("i1", instance.generation)).toMatchObject({ outcome: "reserved", instance: { desiredState: "stopped", runtimeRef: { paneId: "w1:p1" } } });
    expect(store.updateAgentInstanceObservation({ instanceId: "i1", expectedGeneration: instance.generation, observedState: "idle" })).toMatchObject({ desiredState: "stopped", observedState: "idle" });
    expect(store.claimNextInstanceTurn("i1", instance.generation)).toBeNull();
    expect(store.finishAgentInstanceStop("i1", instance.generation)).toMatchObject({ desiredState: "stopped", observedState: "stopped", runtimeRef: null });
  });

  it("projects a legacy binding as a TraeX instance without creating durable work", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Legacy" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "terminal-1", state: "active", lifecycle: "active", attachment: "attached", generation: 3, lastAgentState: "working" });

    expect(store.projectLegacyBindingAsAgentInstance("b1")).toMatchObject({
      id: "legacy:b1", projectId: "project-a", name: "Legacy", role: "worker", agentKind: "traex", generation: 3, observedState: "working",
      runtimeRef: { herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "terminal-1", generation: 3 }
    });
    expect(store.listAgentInstances("project-a")).toEqual([]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
  });

  it("persists creator identity and consumes scoped card interactions once", () => {
    store = new SqliteBindingStore(":memory:");
    const binding = store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "creator" });
    expect(binding.creatorOpenId).toBe("creator");
    store.createCardInteraction({ id: "i1", bindingId: "b1", bindingGeneration: 1, actorOpenId: "user", actionKind: "supplement", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });

    expect(store.consumeCardInteraction({ id: "i1", actorOpenId: "other", bindingId: "b1", bindingGeneration: 1, now: "2026-08-27T00:00:00.000Z", resultCode: "ok" }).outcome).toBe("unauthorized");
    expect(store.consumeCardInteraction({ id: "i1", actorOpenId: "user", bindingId: "b1", bindingGeneration: 2, now: "2026-08-27T00:00:00.000Z", resultCode: "ok" }).outcome).toBe("stale");
    expect(store.consumeCardInteraction({ id: "i1", actorOpenId: "user", bindingId: "b1", bindingGeneration: 1, now: "2026-08-27T00:00:00.000Z", resultCode: "ok" })).toMatchObject({ outcome: "consumed", interaction: { resultCode: "ok" } });
    expect(store.consumeCardInteraction({ id: "i1", actorOpenId: "user", bindingId: "b1", bindingGeneration: 1, now: "2026-08-27T00:00:00.000Z", resultCode: "ignored" })).toMatchObject({ outcome: "duplicate", interaction: { resultCode: "ok" } });
  });

  it("atomically accepts a durable Session operation with its card interaction", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    store.createCardInteraction({ id: "i1", bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });

    const input = {
      id: "op-1", idempotencyKey: "interaction:i1:rename", interactionId: "i1", actorOpenId: "member",
      bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1",
      kind: "rename" as const, argument: "New title", now: "2026-08-31T00:00:00.000Z"
    };

    expect(store.acceptSessionOperation(input)).toMatchObject({ outcome: "accepted", operation: { id: "op-1", state: "accepted", kind: "rename", argument: "New title" } });
    expect(store.getCardInteraction("i1")).toMatchObject({ state: "consumed", resultCode: "rename" });
    expect(store.acceptSessionOperation({ ...input, id: "op-duplicate" })).toMatchObject({ outcome: "duplicate", operation: { id: "op-1" } });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM session_operations").get()).toEqual({ count: 1 });
    expect(store.acceptSessionOperation({ ...input, id: "op-unauthorized", actorOpenId: "other" })).toEqual({ outcome: "unauthorized", operation: null });
    expect(() => store.acceptSessionOperation({ ...input, id: "op-invalid", idempotencyKey: "invalid", kind: "archive", argument: "unexpected" })).toThrow(/does not accept an argument/);
  });

  it("does not consume invalid Session operation interactions", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    const create = (id: string, expiresAt = "2099-01-01T00:00:00.000Z") => store!.createCardInteraction({ id, bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt });
    create("unauthorized"); create("stale"); create("expired", "2026-01-01T00:00:00.000Z");
    const input = (interactionId: string) => ({ id: `op-${interactionId}`, idempotencyKey: `interaction:${interactionId}:rename`, interactionId, actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "rename" as const, argument: "Title", now: "2026-08-31T00:00:00.000Z" });

    expect(store.acceptSessionOperation({ ...input("unauthorized"), actorOpenId: "other" }).outcome).toBe("unauthorized");
    expect(store.acceptSessionOperation({ ...input("stale"), bindingGeneration: 2 }).outcome).toBe("stale");
    expect(store.acceptSessionOperation(input("expired")).outcome).toBe("expired");
    expect(store.getCardInteraction("unauthorized")?.state).toBe("active");
    expect(store.getCardInteraction("stale")?.state).toBe("active");
    expect(store.getCardInteraction("expired")?.state).toBe("expired");
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM session_operations").get()).toEqual({ count: 0 });
  });

  it("does not accept a legacy session-control interaction as new durable work", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    store.createCardInteraction({ id: "legacy-control", bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "session_control", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });

    expect(store.acceptSessionOperation({ id: "op-legacy-control", idempotencyKey: "interaction:legacy-control:rename", interactionId: "legacy-control", actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "rename", argument: "Title", now: "2026-08-31T00:00:00.000Z" })).toEqual({ outcome: "stale", operation: null });
    expect(store.getCardInteraction("legacy-control")?.state).toBe("active");
  });

  it("does not consume Session interactions whose operations are ineligible for the current binding state", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    store.createCardInteraction({ id: "i1", bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });

    expect(store.acceptSessionOperation({ id: "op-1", idempotencyKey: "interaction:i1:resume", interactionId: "i1", actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "resume", argument: null, now: "2026-08-31T00:00:00.000Z" })).toEqual({ outcome: "stale", operation: null });
    expect(store.getCardInteraction("i1")).toMatchObject({ state: "active" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM session_operations").get()).toEqual({ count: 0 });
  });

  it("does not report an old consumed interaction as a durable duplicate", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    store.createCardInteraction({ id: "legacy", bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
    store.consumeCardInteraction({ id: "legacy", actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, now: "2026-08-30T00:00:00.000Z", resultCode: "rename" });

    expect(store.acceptSessionOperation({ id: "op-legacy", idempotencyKey: "interaction:legacy:rename", interactionId: "legacy", actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "rename", argument: "Title", now: "2026-08-31T00:00:00.000Z" })).toEqual({ outcome: "stale", operation: null });
  });

  it("claims durable Session operations in FIFO order and preserves unresolved recovery rows", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    for (const [index, kind] of (["rename", "archive"] as const).entries()) {
      const interactionId = `i${index + 1}`;
      store.createCardInteraction({ id: interactionId, bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
      store.acceptSessionOperation({ id: `op-${index + 1}`, idempotencyKey: `interaction:${interactionId}:${kind}`, interactionId, actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind, argument: kind === "rename" ? "Title" : null, now: `2026-08-31T00:00:0${index}.000Z` });
    }

    expect(store.claimNextSessionOperation()).toMatchObject({ id: "op-1", state: "running", attemptCount: 1 });
    expect(store.claimNextSessionOperation()).toMatchObject({ id: "op-2", state: "running", attemptCount: 1 });
    expect(store.claimNextSessionOperation()).toBeNull();
    expect(store.listRecoverableSessionOperations().map(({ id }) => id)).toEqual(["op-1", "op-2"]);
    expect(store.finishSessionOperation("op-1", "uncertain", "outcome unknown")).toMatchObject({ state: "uncertain" });
  });

  it("reports Session operation backlog without exposing arguments and prunes only terminal history", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    for (const id of ["accepted", "terminal"]) {
      store.createCardInteraction({ id: `i-${id}`, bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
      store.acceptSessionOperation({ id, idempotencyKey: `interaction:i-${id}:rename`, interactionId: `i-${id}`, actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "rename", argument: "private title", now: "2026-08-01T00:00:00.000Z" });
    }
    store.claimNextSessionOperation();
    store.finishSessionOperation("accepted", "succeeded");
    store.database.prepare("UPDATE session_operations SET updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'accepted'").run();

    const summary = store.getOperationalSummary();
    expect(summary.sessionOperations).toMatchObject({ states: { accepted: 1, succeeded: 1 } });
    expect(JSON.stringify(summary)).not.toContain("private title");
    expect(store.pruneTerminalSessionOperations("2026-08-15T00:00:00.000Z", 10)).toBe(1);
    expect(store.getSessionOperation("accepted")).toBeNull();
    expect(store.getSessionOperation("terminal")).toMatchObject({ state: "accepted" });
  });

  it("atomically reconciles a pane-derived binding title with its main-card intent", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "legacy title" });
    store.updateBinding("b1", { paneId: "w1:p1", generation: 1, statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached" });
    const event = createBridgeEvent("b1", "BindingRenamed", "herdr", { title: "repo / task-ab12" });
    const view = reduceTopicView({ ...initialTopicView("b1"), title: "legacy title", workspaceId: "w1", paneId: "w1:p1", phase: "ready" }, event);

    expect(store.reconcileBindingTitleWithProjection({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, title: "repo / task-ab12", view, rootMessageId: "root", card: { title: "repo / task-ab12" }
    })).toMatchObject({ outcome: "projected", binding: { title: "repo / task-ab12" }, outboxReserved: true });
    expect(store.loadTopicView("b1")).toMatchObject({ title: "repo / task-ab12", lastEventId: event.eventId });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ bindingId: "b1", targetRole: "session_status", kind: "card_update" })]);

    expect(store.reconcileBindingTitleWithProjection({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, title: "repo / task-ab12", view, rootMessageId: "root", card: {}
    })).toMatchObject({ outcome: "unchanged", outboxReserved: false });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);

    expect(store.reconcileBindingTitleWithProjection({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 2, title: "repo / stale", view: { ...view, title: "repo / stale", viewVersion: 2 }, rootMessageId: "root", card: {}
    })).toMatchObject({ outcome: "stale_binding", outboxReserved: false });
    expect(store.getBinding("b1")?.title).toBe("repo / task-ab12");
    expect(store.loadTopicView("b1")?.title).toBe("repo / task-ab12");
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
  });

  it("atomically and idempotently degrades an unregistered Agent without orphaning it", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", generation: 1, state: "active", lifecycle: "active", attachment: "attached" });
    const view = { ...initialTopicView("b1"), title: "Task", workspaceId: "w1", paneId: "w1:p1", phase: "degraded" as const, notice: "TraeX is not registered as a Herdr Agent", viewVersion: 1 };

    expect(store.degradeBindingWithProjection({ bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, view, rootMessageId: "root", mainCard: {} }))
      .toMatchObject({ outcome: "degraded", binding: { state: "active", attachment: "degraded" }, outboxReserved: true });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "degraded", notice: view.notice });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);

    expect(store.degradeBindingWithProjection({ bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, view, rootMessageId: "root", mainCard: {} }))
      .toMatchObject({ outcome: "unchanged", binding: { attachment: "degraded" }, outboxReserved: false });
    expect(store.getBinding("b1")).toMatchObject({ attachment: "degraded", degradationCount: 0 });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
  });

  it("atomically projects a confirmed missing pane across binding, run cards, and card intents", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", generation: 1, state: "active", lifecycle: "active", attachment: "attached" });
    const seed = (promptId: string, phase: "running" | "blocked" | "queued", answerMessageId: string | null) => {
      const queued = createQueuedRunCard({ promptId, bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-08-27T00:00:00.000Z" });
      store!.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `${promptId}-message`, actorOpenId: "u1", body: promptId }, view: { ...queued, phase, answerMessageId, viewVersion: phase === "queued" ? 1 : 2 }, rootMessageId: "root", answerCard: {} });
    };
    seed("running", "running", "answer-running");
    seed("blocked", "blocked", "answer-blocked");
    seed("queued", "queued", null);
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'attached' WHERE id IN ('running', 'blocked')").run();
    const pendingBeforeOrphan = store.listPendingOutboundReplies().length;
    const view = { ...initialTopicView("b1"), title: "Task", workspaceId: "w1", paneId: "w1:p1", phase: "orphaned" as const, notice: "Herdr pane w1:p1 no longer exists", viewVersion: 1 };

    const result = store.orphanBindingWithProjection({ bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, occurredAt: "2026-08-27T00:01:00.000Z", reason: "Herdr pane w1:p1 no longer exists", view, rootMessageId: "root", mainCard: {}, renderRunCard: (run) => ({ phase: run.phase }) });

    expect(result).toMatchObject({ outcome: "orphaned", updatedPromptIds: ["blocked", "queued", "running"] });
    expect(store.getBinding("b1")).toMatchObject({ state: "orphaned", attachment: "orphaned" });
    expect(store.loadRunCard("running")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.loadRunCard("blocked")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.loadRunCard("queued")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.getPrompt("running")).toMatchObject({ state: "failed", observationState: "completed" });
    expect(store.getPrompt("blocked")).toMatchObject({ state: "failed", observationState: "completed" });
    expect(store.getPrompt("queued")).toMatchObject({ state: "cancelled", observationState: "completed" });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "orphaned" });
    expect(store.listPendingOutboundReplies().filter((reply) => reply.kind === "card_update" && reply.cardRole === "answer")).toHaveLength(2);
    expect(store.listPendingOutboundReplies().find((reply) => reply.promptId === "queued" && reply.kind === "stream_card_create")?.payload).toContain('\"phase\":\"failed\"');

    expect(store.orphanBindingWithProjection({ bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, occurredAt: "2026-08-27T00:01:01.000Z", reason: "Herdr pane w1:p1 no longer exists", view, rootMessageId: "root", mainCard: {}, renderRunCard: () => ({}) })).toMatchObject({ outcome: "unchanged" });
    expect(store.listPendingOutboundReplies()).toHaveLength(pendingBeforeOrphan + 3);
  });

  it("reports a healthy database through the bounded integrity seam", () => {
    store = new SqliteBindingStore(":memory:");

    expect(store.inspectIntegrity(20)).toEqual({ quickCheck: "ok", issues: [], truncated: false });
  });

  it("detects dangling business references and contradictory outbox lane state without exposing identifiers", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "sensitive-binding", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Secret title" });
    store.enqueueOutboundReply({ id: "sensitive-reply", idempotencyKey: "integrity-reply", bindingId: "sensitive-binding", promptId: "missing-prompt", selectionId: "missing-selection", rootMessageId: "private-card", kind: "text", payload: "private payload" });
    store.database.prepare("DELETE FROM outbox_lane_heads").run();

    const inspection = store.inspectIntegrity(20);

    expect(inspection.quickCheck).toBe("ok");
    expect(inspection.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "outbound_prompt_reference", table: "outbound_replies", count: 1 }),
      expect.objectContaining({ rule: "outbound_selection_reference", table: "outbound_replies", count: 1 }),
      expect.objectContaining({ rule: "outbox_lane_missing_head", table: "outbox_lane_heads", count: 1 })
    ]));
    expect(JSON.stringify(inspection)).not.toMatch(/sensitive|missing-prompt|missing-selection|private/);
  });

  it("caps integrity issue records while preserving a truncated signal", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "reply", idempotencyKey: "integrity", promptId: "missing-prompt", selectionId: "missing-selection", rootMessageId: "card", kind: "text", payload: "hidden" });

    expect(store.inspectIntegrity(1)).toEqual({ quickCheck: "ok", truncated: true, issues: [
      { rule: "outbound_prompt_reference", table: "outbound_replies", count: 1 }
    ] });
  });

  it("detects foreign-key, active-turn, lane-head, and quarantine contradictions", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "one" });
    store.enqueuePrompt({ id: "p2", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "two" });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running'").run();
    store.enqueueOutboundReply({ id: "head", idempotencyKey: "head", bindingId: "b1", rootMessageId: "card", kind: "text", payload: "hidden" });
    store.database.prepare("UPDATE outbox_lane_heads SET delivery_order = delivery_order + 1").run();
    store.database.exec("PRAGMA foreign_keys = OFF");
    store.database.prepare("INSERT INTO topic_views(binding_id, state_json, updated_at) VALUES ('missing-binding', '{}', 'now')").run();
    store.database.exec("PRAGMA foreign_keys = ON");
    store.database.prepare("INSERT INTO outbox_lane_quarantines(lane_key, failed_reply_id, lane_class, failure_class, state, action, reason, created_at, updated_at) SELECT lane_key, id, 'immutable', 'permanent', 'active', 'blocked', 'hidden', 'now', 'now' FROM outbound_replies WHERE id = 'head'").run();

    expect(store.inspectIntegrity(20).issues.map((issue) => issue.rule)).toEqual(expect.arrayContaining([
      "sqlite_foreign_key", "multiple_running_turns", "outbox_lane_head_mismatch", "quarantined_lane_has_head"
    ]));
  });

  it("atomically supersedes and consumes pane-close confirmations", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    store.createPaneCloseRequest({ id: "r1", bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "old-hash", expiresAt: "2099-01-01T00:00:00.000Z" });
    store.createPaneCloseRequest({ id: "r2", bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "new-hash", expiresAt: "2099-01-01T00:00:00.000Z" });

    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "old-hash", now: "2026-08-23T00:00:00.000Z" })).toEqual({ outcome: "invalid" });
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "other", codeHash: "new-hash", now: "2026-08-23T00:00:00.000Z" })).toEqual({ outcome: "unauthorized" });
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "new-hash", now: "2026-08-23T00:00:00.000Z" })).toEqual({ outcome: "consumed", operationId: "r2", paneId: "w1:p1" });
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "new-hash", now: "2026-08-23T00:00:00.000Z" })).toEqual({ outcome: "stale" });
    expect(store.database.prepare("SELECT state FROM pane_close_requests WHERE id = 'r2'").get()).toEqual({ state: "executing" });
    store.finishPaneCloseRequest("r2", "succeeded");
    expect(store.database.prepare("SELECT state, detail FROM pane_close_requests WHERE id = 'r2'").get()).toEqual({ state: "succeeded", detail: null });
  });

  it("keeps topic ownership intact until a reset candidate is ready, then cuts over atomically", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "old", projectId: "alpha", workspaceId: "w1", chatId: "c1", topicId: "topic-1", rootMessageId: "root-1", title: "Old" });
    store.updateBinding("old", { paneId: "w1:old", traexSessionId: "term-old", state: "active", lifecycle: "active", attachment: "attached" });
    store.enqueuePrompt({ id: "queued", bindingId: "old", larkMessageId: "message-queued", actorOpenId: "u1", body: "later" });
    store.enqueueOutboundReply({ id: "outbound", idempotencyKey: "old-update", bindingId: "old", rootMessageId: "root-1", kind: "text", payload: "old update" });

    const candidate = store.createResetCandidate({ oldBindingId: "old", newBindingId: "new", title: "Fresh", actorOpenId: "u1", resetMessageId: "reset-1" });
    expect(candidate.created).toBe(true);
    expect(candidate.previous).toMatchObject({ id: "old", state: "active", topicId: "topic-1" });
    expect(candidate.replacement).toMatchObject({ id: "new", topicId: null, reservedTopicId: "topic-1", replacesBindingId: "old", lifecycle: "provisioning" });
    expect(store.database.prepare("SELECT state FROM prompt_jobs WHERE id = 'queued'").get()).toEqual({ state: "queued" });
    expect(store.listPendingOutboundReplies().map((item) => item.id)).toContain("outbound");

    store.updateBinding("new", { paneId: "w1:new", traexSessionId: "term-new" });
    store.transitionBinding("new", { type: "pane_created" });
    store.transitionBinding("new", { type: "runtime_started" });
    const handoff = store.cutoverResetCandidate({ oldBindingId: "old", newBindingId: "new", cleanupOperationId: "cleanup-1", actorOpenId: "u1", expectedCwd: "/repo" });

    expect(handoff.cancelledPromptIds).toEqual(["queued"]);
    expect(handoff.previous).toMatchObject({ id: "old", state: "archived", lifecycle: "archived", topicId: null, rootMessageId: null, retiredTopicId: "topic-1", retiredRootMessageId: "root-1" });
    expect(handoff.replacement).toMatchObject({ id: "new", projectId: "alpha", topicId: "topic-1", rootMessageId: "root-1", state: "active", lifecycle: "active" });
    expect(handoff.cleanup).toMatchObject({ id: "cleanup-1", oldBindingId: "old", replacementBindingId: "new", paneId: "w1:old", state: "pending" });
    expect(store.findBindingByLarkScope("topic-1", "root-1")?.id).toBe("new");
    expect(store.listPendingOutboundReplies().map((item) => item.id)).not.toContain("outbound");
  });

  it("preserves an uncertain pane-close operation without replaying it", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    store.createPaneCloseRequest({ id: "r1", bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", now: "2026-08-23T00:00:00.000Z" }).outcome).toBe("consumed");
    store.finishPaneCloseRequest("r1", "uncertain", "verification timeout");

    expect(store.database.prepare("SELECT state, detail FROM pane_close_requests WHERE id = 'r1'").get()).toEqual({ state: "uncertain", detail: "verification timeout" });
    expect(store.listUnresolvedPaneCloseOperations()).toEqual([{ id: "r1", bindingId: "b1", paneId: "w1:p1", state: "uncertain" }]);
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", now: "2026-08-23T00:00:01.000Z" })).toEqual({ outcome: "stale" });
  });

  it("expires a pane-close confirmation without consuming another request", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    store.createPaneCloseRequest({ id: "r1", bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", expiresAt: "2026-08-23T00:01:00.000Z" });

    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", now: "2026-08-23T00:01:00.000Z" })).toEqual({ outcome: "expired" });
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", now: "2026-08-23T00:01:01.000Z" })).toEqual({ outcome: "stale" });
  });

  it("durably creates, links, and atomically claims a project selection", () => {
    store = new SqliteBindingStore(":memory:");
    const selection = store.createProjectSelection({
      id: "s1", commandMessageId: "cmd-1", chatId: "c1", topicId: "t1", rootMessageId: "root-1",
      actorOpenId: "u1", requestedTitle: "Fix login", expiresAt: "2099-01-01T00:00:00.000Z", card: { schema: "2.0" }
    });
    const duplicate = store.createProjectSelection({
      id: "other", commandMessageId: "cmd-1", chatId: "c1", topicId: "t1", rootMessageId: "root-1",
      actorOpenId: "u1", requestedTitle: null, expiresAt: "2099-01-01T00:00:00.000Z", card: {}
    });

    expect(selection).toMatchObject({ id: "s1", state: "pending", selectorMessageId: null });
    expect(duplicate.id).toBe("s1");
    expect(store.listPendingOutboundReplies()).toMatchObject([{ selectionId: "s1", kind: "card_reply", rootMessageId: "root-1" }]);
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "selector-1");
    expect(store.getProjectSelection("s1")).toMatchObject({ selectorMessageId: "selector-1" });

    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "bridge", messageId: "wrong", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "invalid" });
    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "bridge", messageId: "selector-1", chatId: "c1", actorOpenId: "other", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "unauthorized" });
    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "unknown", messageId: "selector-1", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "invalid" });
    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "bridge", messageId: "selector-1", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "claimed", selection: { state: "processing", selectedProjectId: "bridge" } });
    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "bridge", messageId: "selector-1", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "processing" });
  });

  it("expires stale selections and fails interrupted processing without replay", () => {
    store = new SqliteBindingStore(":memory:");
    store.createProjectSelection({ id: "expired", commandMessageId: "cmd-old", chatId: "c1", topicId: null, rootMessageId: "root-old", actorOpenId: "u1", requestedTitle: null, expiresAt: "2000-01-01T00:00:00.000Z", card: {} });
    const outbound = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(outbound.id, "selector-old");
    expect(store.claimProjectSelection({ selectionId: "expired", projectId: "bridge", messageId: "selector-old", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "expired" });

    store.createProjectSelection({ id: "processing", commandMessageId: "cmd-new", chatId: "c1", topicId: null, rootMessageId: "root-new", actorOpenId: "u1", requestedTitle: null, expiresAt: "2099-01-01T00:00:00.000Z", card: {} });
    const next = store.listPendingOutboundReplies().find((reply) => reply.selectionId === "processing")!;
    store.markOutboundReplyDelivered(next.id, "selector-new");
    expect(store.claimProjectSelection({ selectionId: "processing", projectId: "bridge", messageId: "selector-new", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] }).outcome).toBe("claimed");
    expect(store.recoverProcessingProjectSelections()).toBe(1);
    expect(store.getProjectSelection("processing")).toMatchObject({ state: "failed" });
  });

  it("persists bindings, FIFO jobs, deduplication, and view snapshots", () => {
    store = new SqliteBindingStore(":memory:");
    const binding = store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding(binding.id, { paneId: "w1:p2", state: "active" });
    expect(store.findBindingByLarkScope("unknown-thread", "m1")?.id).toBe("b1");
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "first" });
    store.enqueuePrompt({ id: "p2", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "second" });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'not_started', attempt_count = 1 WHERE id = 'p1'").run();
    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.listQueuedTurnPromptIds("b1")).toEqual(["p1", "p2"]);
    expect(store.listQueuedTurnRunCards("b1")).toEqual([]);
    const inbound = { eventId: "e1", messageId: "m2", chatId: "c1", topicId: "t1", rootMessageId: "m1", actorOpenId: "u1", text: "first", mentionsBot: false, isRootMessage: false };
    expect(store.recordInboundMessage(inbound)).toBe(true);
    expect(store.recordInboundMessage(inbound)).toBe(false);
    expect(store.recordInboundMessage({ ...inbound, eventId: "retried-event" })).toBe(false);
    expect(store.claimNextInboundMessage()).toEqual(inbound);
    expect(store.recoverProcessingInboundMessages()).toBe(1);
    expect(store.claimNextInboundMessage()).toEqual(inbound);
    store.markInboundMessageAccepted(inbound.eventId);
    expect(store.claimNextInboundMessage()).toBeNull();
    const outbound = store.enqueueOutboundReply({ id: "o1", idempotencyKey: "event:e1:thread-text", bindingId: null, rootMessageId: "m1", kind: "text", payload: "received" });
    const duplicate = store.enqueueOutboundReply({ id: "o2", idempotencyKey: "event:e1:thread-text", bindingId: null, rootMessageId: "m1", kind: "text", payload: "duplicate" });
    expect(duplicate.id).toBe(outbound.id);
    store.markOutboundReplyFailed(outbound.id, "temporary");
    expect(store.listPendingOutboundReplies()).toMatchObject([{ id: "o1", error: "temporary", attemptCount: 1 }]);
    store.markOutboundReplyDelivered(outbound.id, "sent-1");
    expect(store.listPendingOutboundReplies()).toEqual([]);
    const view = { ...initialTopicView("b1"), title: "Task" };
    store.saveTopicView(view);
    expect(store.loadTopicView("b1")).toEqual(view);
  });

  it("loads queued ordinary-turn cards in durable FIFO order", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const first = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "first", workspaceId: "w1", paneId: "w1:p1", requestText: "first", queuePosition: 1, occurredAt: "2026-01-01T00:00:00.000Z" });
    const second = createQueuedRunCard({ promptId: "p2", bindingId: "b1", title: "second", workspaceId: "w1", paneId: "w1:p1", requestText: "second", queuePosition: 2, occurredAt: "2026-01-01T00:00:01.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "first" }, view: first, rootMessageId: "root", answerCard: {} });
    store.acceptPrompt({ prompt: { id: "p2", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "second" }, view: second, rootMessageId: "root", answerCard: {} });
    store.acceptPrompt({ prompt: { id: "s1", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "steer", dispatchKind: "steering", parentPromptId: "p1" }, view: { ...second, promptId: "s1" }, rootMessageId: "root", answerCard: {} });

    expect(store.listQueuedTurnRunCards("b1").map((view) => view.promptId)).toEqual(["p1", "p2"]);
  });

  it("queries bindings and run cards by their exact reconciliation scope", () => {
    store = new SqliteBindingStore(":memory:");
    for (const id of ["b2", "b1", "b3"]) {
      store.createPendingBinding({ id, workspaceId: "w1", chatId: "c1", topicId: `t-${id}`, rootMessageId: `m-${id}`, title: id });
    }
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    store.updateBinding("b2", { paneId: "w1:p2", state: "active" });

    expect(store.getBinding("b1")).toMatchObject({ id: "b1", state: "active" });
    expect(store.getBinding("missing")).toBeNull();
    const active = store.listBindingsByState("active");
    expect(active.map(({ id }) => id).sort()).toEqual(["b1", "b2"]);
    expect(active.map(({ createdAt, id }) => `${createdAt}:${id}`)).toEqual(
      [...active].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).map(({ createdAt, id }) => `${createdAt}:${id}`)
    );
    expect(store.listBindingsByState("pending").map(({ id }) => id)).toEqual(["b3"]);

    for (const [promptId, phase] of [["p3", "completed"], ["p1", "running"], ["p2", "queued"]] as const) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-08-23T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "m-b1", answerCard: {} });
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase });
    }
    expect(store.listRunCardsByPhases("b1", ["queued", "running"]).map(({ promptId }) => promptId)).toEqual(["p1", "p2"]);
    expect(store.listRunCardsByPhases("b1", [])).toEqual([]);
    expect(store.listRunCardsByPhases("b2", ["queued", "running", "completed"])).toEqual([]);
  });

  it("backfills and persists orthogonal pane/thread lifecycle state", () => {
    store = new SqliteBindingStore(":memory:");
    const pending = store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: null, rootMessageId: null, title: "Task" });
    expect(pending).toMatchObject({
      lifecycle: "provisioning", attachment: "unattached", generation: 1,
      provisioningCheckpoint: "selected", degradationCount: 0, hasCompletedTurn: false
    });

    const active = store.updateBinding("b1", {
      paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached",
      provisioningCheckpoint: "activated", traexSessionId: "session-1", lastObservedAt: "2026-08-22T10:00:00.000Z"
    });
    expect(active).toMatchObject({
      lifecycle: "active", attachment: "attached", generation: 1, provisioningCheckpoint: "activated",
      traexSessionId: "session-1", lastObservedAt: "2026-08-22T10:00:00.000Z"
    });
    expect(store.transitionBinding("b1", { type: "archive_requested", hasActiveTurn: true })).toMatchObject({ lifecycle: "draining", state: "active" });
    expect(store.transitionBinding("b1", { type: "drain_completed" })).toMatchObject({ lifecycle: "archived", state: "archived" });
    expect(() => store.transitionBinding("b1", { type: "pane_created" })).toThrow(/pane_created.*archived/i);
  });

  it("persists native Agent session identity separately from terminal identity", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "native-session", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const binding = store.updateBinding("native-session", {
      paneId: "w1:p1", traexSessionId: "term-1", agentSessionSource: "codex-hook",
      agentSessionAgent: "codex", agentSessionKind: "id", agentSessionValue: "conversation-1"
    });

    expect(binding).toMatchObject({
      traexSessionId: "term-1", agentSessionSource: "codex-hook", agentSessionAgent: "codex",
      agentSessionKind: "id", agentSessionValue: "conversation-1"
    });
  });

  it("replaces only the owned pane_created provisioning generation", () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "provisioning", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "Task" });
    binding = store.updateBindingMetadata(binding.id, { paneId: "w1:p1", traexSessionId: "term-1" });
    binding = store.transitionBinding(binding.id, { type: "pane_created" });
    const replacement = { paneId: "w1:p2", terminalId: "term-2", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle" as const, foregroundExecutables: ["traex"] };

    expect(store.replaceProvisioningPane({ bindingId: binding.id, expectedPaneId: "w1:p1", expectedGeneration: 1, pane: replacement })).toMatchObject({
      paneId: "w1:p2", traexSessionId: "term-2", generation: 2, lifecycle: "provisioning", provisioningCheckpoint: "pane_created"
    });
    expect(() => store.replaceProvisioningPane({ bindingId: binding.id, expectedPaneId: "w1:p1", expectedGeneration: 1, pane: replacement })).toThrow(/lost ownership/);
    store.close();
  });

  it("atomically applies an authoritative pane observation behind binding identity fences", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", traexSessionId: "term-1", agentSessionSource: "traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "session-1", state: "active", lifecycle: "active", attachment: "degraded", degradationCount: 1
    });

    const applied = store.applyRuntimeObservation({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1,
      pane: { paneId: "w1:p1", terminalId: "term-2", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "working", foregroundExecutables: ["traex"], agentSession: { source: "traex", agent: "traex", kind: "id", value: "session-1" } }
    });

    expect(applied).toMatchObject({ outcome: "applied", terminalIdentityRefreshed: true, nativeSessionMismatch: false });
    expect(store.getBinding("b1")).toMatchObject({ traexSessionId: "term-2", lastAgentState: "working", attachment: "attached", degradationCount: 0, agentSessionValue: "session-1" });

    expect(store.applyRuntimeObservation({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 0,
      pane: { paneId: "w1:p1", terminalId: "term-3", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }
    })).toEqual({ outcome: "stale_binding" });
    expect(store.getBinding("b1")).toMatchObject({ traexSessionId: "term-2", lastAgentState: "working" });
  });

  it("atomically cancels queued turns and steering with terminal delivery intents", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const seed = (id: string, kind: "turn" | "steering" = "turn") => {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: "2026-08-29T00:00:00.000Z" });
      store!.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id, dispatchKind: kind, parentPromptId: kind === "steering" ? "running" : null }, view, rootMessageId: "m1", answerCard: { phase: "queued", id } });
      return store!.listPendingOutboundReplies().find((reply) => reply.promptId === id)!;
    };
    const runningCreate = seed("running");
    store.markOutboundReplyDelivered(runningCreate.id, "answer-running", "card-running");
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("running");
    const pendingCreate = seed("pending");
    const checkpointedCreate = seed("checkpointed", "steering");
    store.checkpointOutboundReplyCard(checkpointedCreate.id, "card-checkpointed");
    const deliveredCreate = seed("delivered");
    store.markOutboundReplyDelivered(deliveredCreate.id, "answer-delivered");
    const cardTargetCreate = seed("card-target");
    store.markOutboundReplyDelivered(cardTargetCreate.id, "answer-card-target", "card-target");
    const pendingBefore = store.listPendingOutboundReplies().find((reply) => reply.id === pendingCreate.id)!;
    const checkpointedBefore = store.listPendingOutboundReplies().find((reply) => reply.id === checkpointedCreate.id)!;

    const result = store.cancelQueuedPromptsWithProjection({
      bindingId: "b1", reason: "Topic archived", occurredAt: "2026-08-29T01:02:03.000Z", rootMessageId: "m1",
      renderRunCard: (view) => ({ phase: view.phase, notice: view.notice, version: view.viewVersion })
    });

    expect(result).toEqual({ cancelledPromptIds: ["pending", "checkpointed", "delivered", "card-target"], outboxReserved: true });
    expect(store.getPrompt("running")).toMatchObject({ state: "running" });
    for (const id of result.cancelledPromptIds) {
      expect(store.getPrompt(id)).toMatchObject({ state: "cancelled", observationState: "completed", error: "Topic archived", updatedAt: "2026-08-29T01:02:03.000Z" });
      expect(store.loadRunCard(id)).toMatchObject({ phase: "failed", notice: "Topic archived", queuePosition: 0, finishedAt: "2026-08-29T01:02:03.000Z", activityAt: "2026-08-29T01:02:03.000Z", updatedAt: "2026-08-29T01:02:03.000Z" });
    }
    const pendingAfter = store.listPendingOutboundReplies().find((reply) => reply.id === pendingCreate.id)!;
    expect(pendingAfter).toMatchObject({ idempotencyKey: "run-card:create:pending:answer", kind: "stream_card_create", viewVersion: 2 });
    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(pendingAfter.id)).toEqual({ lane_key: "answer:pending" });
    expect(pendingAfter.payload).toBe(JSON.stringify({ phase: "failed", notice: "Topic archived", version: 2 }));
    expect(store.listPendingOutboundReplies().filter((reply) => reply.promptId === "pending")).toHaveLength(1);
    expect(store.listPendingOutboundReplies().find((reply) => reply.id === checkpointedCreate.id)).toMatchObject({ payload: checkpointedBefore.payload, viewVersion: checkpointedBefore.viewVersion, cardIdCheckpoint: "card-checkpointed" });
    expect(store.listPendingOutboundReplies()).toContainEqual(expect.objectContaining({ idempotencyKey: "run-card:update:delivered:answer:2", kind: "card_update", rootMessageId: "answer-delivered" }));
    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE idempotency_key = ?").get("run-card:update:delivered:answer:2")).toEqual({ lane_key: "answer:delivered" });
    expect(store.listPendingOutboundReplies().filter((reply) => reply.promptId === "card-target")).toEqual([]);
    expect(store.getOperationalSummary().prompts.cancelled).toBe(4);
    expect(store.countPendingPrompts("b1")).toBe(1);
    expect(store.cancelQueuedPromptsWithProjection({ bindingId: "b1", reason: "again", occurredAt: "later", rootMessageId: "m1", renderRunCard: () => ({}) })).toEqual({ cancelledPromptIds: [], outboxReserved: false });
    expect(store.loadRunCard("pending")?.viewVersion).toBe(2);
    expect(pendingBefore.id).toBe(pendingAfter.id);
  });

  it("rolls back every queued cancellation when terminal outbox projection fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    for (const id of ["p1", "p2"]) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: "start" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "m1", answerCard: {} });
    }
    store.database.exec(`CREATE TRIGGER fail_second_cancel_outbox BEFORE UPDATE ON outbound_replies WHEN OLD.prompt_id = 'p2' BEGIN SELECT RAISE(ABORT, 'injected cancellation outbox failure'); END`);

    expect(() => store!.cancelQueuedPromptsWithProjection({ bindingId: "b1", reason: "archive", occurredAt: "later", rootMessageId: "m1", renderRunCard: (view) => ({ phase: view.phase }) })).toThrow("injected cancellation outbox failure");

    for (const id of ["p1", "p2"]) {
      expect(store.getPrompt(id)).toMatchObject({ state: "queued", observationState: "not_started", error: null });
      expect(store.loadRunCard(id)).toMatchObject({ phase: "queued", viewVersion: 1, notice: null });
      expect(store.listPendingOutboundReplies().find((reply) => reply.promptId === id)).toMatchObject({ viewVersion: 1, payload: "{}" });
    }
  });

  it("summarizes durable failures without exposing prompt bodies or outbox payloads", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "private prompt body" });
    store.updatePrompt("p1", "failed", "x".repeat(800));
    store.enqueueOutboundReply({ id: "o1", idempotencyKey: "o1", bindingId: "b1", promptId: "p1", rootMessageId: "m1", kind: "card_update", payload: "private card payload" });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("o1", "delivery failed " + "y".repeat(800));

    const summary = store.getOperationalSummary();
    const serialized = JSON.stringify(summary);
    expect(summary).toMatchObject({
      bindings: { pending: 1 }, prompts: { failed: 1 }, promptDispatch: { turn: 1 },
      outbound: { dead_letter: 1 }, pendingOutbox: 0, deadLetters: 1,
      recentFailedPrompt: { promptId: "p1", bindingId: "b1" },
      recentDeadLetter: { replyId: "o1", bindingId: "b1", promptId: "p1", attemptCount: 5 }
    });
    expect(summary).toMatchObject({ lifecycle: { provisioning: 1 }, attachment: { unattached: 1 }, recoverableProvisioning: 0, archivedPanesPresent: 0 });
    expect(summary.recentFailedPrompt?.error.length).toBeLessThanOrEqual(500);
    expect(summary.recentDeadLetter?.error.length).toBeLessThanOrEqual(500);
    expect(serialized).not.toContain("private prompt body");
    expect(serialized).not.toContain("private card payload");
  });

  it("summarizes durable inbound backlog without exposing message payloads", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:10:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    const first = { eventId: "inbound-1", messageId: "message-1", chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "user", text: "private inbound body", mentionsBot: false, isRootMessage: false };
    const second = { ...first, eventId: "inbound-2", messageId: "message-2" };
    store.recordInboundMessage(first);
    store.recordInboundMessage(second);
    store.database.prepare("UPDATE inbound_messages SET created_at = '2026-08-31T12:00:00.000Z' WHERE event_id = 'inbound-1'").run();
    expect(store.claimNextInboundMessage()).toMatchObject({ eventId: "inbound-1" });
    store.releaseInboundMessage("inbound-1", "temporary failure " + "x".repeat(800));

    const summary = store.getOperationalSummary().inbound;
    expect(summary).toMatchObject({
      states: { received: 2, processing: 0, accepted: 0 }, retryable: 1,
      oldestPendingAt: "2026-08-31T12:00:00.000Z", oldestPendingAgeSeconds: 600,
      recentFailure: { eventId: "inbound-1", error: expect.stringContaining("temporary failure") }
    });
    expect(summary.recentFailure!.error.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(summary)).not.toContain("private inbound body");
    vi.useRealTimers();
  });

  it("summarizes bounded prompt latency without exposing prompt content", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    for (const id of ["completed", "failed", "running"]) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: `private ${id}`, queuePosition: 1, occurredAt: "2026-08-28T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: `private ${id}` }, view, rootMessageId: "m1", answerCard: {} });
    }
    store.database.prepare("UPDATE prompt_jobs SET state = 'delivered', created_at = '2026-08-28T00:00:00.000Z' WHERE id = 'completed'").run();
    store.database.prepare("UPDATE run_cards SET started_at = '2026-08-28T00:00:02.000Z', finished_at = '2026-08-28T00:00:12.000Z', updated_at = '2026-08-28T00:00:15.000Z' WHERE prompt_id = 'completed'").run();
    store.enqueueOutboundReply({ id: "finish-completed", idempotencyKey: "finish-completed", bindingId: "b1", promptId: "completed", rootMessageId: "m1", kind: "stream_finish", payload: "{}" });
    store.database.prepare("UPDATE outbound_replies SET state = 'delivered', updated_at = '2026-08-28T00:00:15.000Z' WHERE id = 'finish-completed'").run();
    store.database.prepare("UPDATE prompt_jobs SET state = 'failed', created_at = '2026-08-28T00:01:00.000Z' WHERE id = 'failed'").run();
    store.database.prepare("UPDATE run_cards SET started_at = '2026-08-28T00:01:04.000Z', finished_at = '2026-08-28T00:01:10.000Z', updated_at = '2026-08-28T00:01:11.000Z' WHERE prompt_id = 'failed'").run();
    store.enqueueOutboundReply({ id: "finish-failed", idempotencyKey: "finish-failed", bindingId: "b1", promptId: "failed", rootMessageId: "m1", kind: "stream_finish", payload: "{}" });
    store.database.prepare("UPDATE outbound_replies SET state = 'delivered', updated_at = '2026-08-28T00:01:11.000Z' WHERE id = 'finish-failed'").run();
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', created_at = '2026-08-28T00:02:00.000Z' WHERE id = 'running'").run();
    store.database.prepare("UPDATE run_cards SET started_at = '2026-08-28T00:02:01.000Z', finished_at = NULL WHERE prompt_id = 'running'").run();

    const summary = store.getOperationalSummary();
    expect(summary.promptLatency).toEqual({
      windowSize: 100, sampleCount: 2,
      queue: { sampleCount: 2, averageMs: 3000, maxMs: 4000 },
      execution: { sampleCount: 2, averageMs: 8000, maxMs: 10000 },
      delivery: { sampleCount: 2, averageMs: 2000, maxMs: 3000 }
    });
    expect(JSON.stringify(summary.promptLatency)).not.toContain("private");
  });

  it("reports empty prompt latency phases without synthetic zero durations", () => {
    store = new SqliteBindingStore(":memory:");
    expect(store.getOperationalSummary().promptLatency).toEqual({
      windowSize: 100, sampleCount: 0,
      queue: { sampleCount: 0, averageMs: null, maxMs: null },
      execution: { sampleCount: 0, averageMs: null, maxMs: null },
      delivery: { sampleCount: 0, averageMs: null, maxMs: null }
    });
  });

  it("reports bounded quarantine and stalled-lane diagnostics without payload data", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:10:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "blocked", idempotencyKey: "blocked", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "private card payload" });
    store.database.prepare("UPDATE outbound_replies SET created_at = ?, next_attempt_at = ? WHERE id = 'blocked'").run("2026-08-26T00:00:00.000Z", "2026-08-26T00:00:00.000Z");
    store.enqueueOutboundReply({ id: "failed", idempotencyKey: "failed", bindingId: "b1", rootMessageId: "root-2", kind: "card_reply", payload: "another private payload" });
    store.markOutboundReplyFailedWithQuarantine("failed", "invalid target " + "x".repeat(800), { failureClass: "permanent", httpStatus: 400, larkErrorCode: null });

    const summary = store.getOperationalSummary();
    expect(summary.outboxLanes).toMatchObject({ stalled: 1, oldestStalledAgeSeconds: 600 });
    expect(summary.outboxQuarantines).toMatchObject({
      active: 1, released: 0, byLaneClass: { immutable: 1 }, byFailureClass: { permanent: 1 },
      latest: { replyId: "failed", replyKind: "card_reply", laneClass: "immutable", failureClass: "permanent", action: "blocked" }
    });
    expect(summary.outboxQuarantines.latest!.reason.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(summary)).not.toMatch(/private card payload|another private payload/);
    vi.useRealTimers();
  });

  it("commits prompt completion and terminal projections atomically before lifecycle delivery", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Task", workspaceId: "w1", paneId: "w1:p1", phase: "running", activePromptId: "p1" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Work", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-24T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const answerCreate = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(answerCreate.id, "answer-1", "card-1");
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("p1");
    store.transitionBinding("b1", { type: "pane_observed", runtime: "working" });

    store.completeTurn({ promptId: "p1", bindingId: "b1", answer: "done", outputFingerprint: "fingerprint", occurredAt: "2026-08-24T00:01:00Z" });

    expect(store.getPrompt("p1")).toMatchObject({ state: "delivered", observationState: "completed" });
    expect(store.getBinding("b1")).toMatchObject({ lastAgentState: "done", lastOutputFingerprint: "fingerprint", hasCompletedTurn: true });
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "completed", answer: "done", answerMessageId: "answer-1" });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "done", answer: "done", activePromptId: null });
  });

  it("keeps the Main Card running when a steering prompt completes", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Task", workspaceId: "w1", paneId: "w1:p1", phase: "running", agentState: "working", activePromptId: "parent" });
    const steering = createQueuedRunCard({ promptId: "steering", bindingId: "b1", title: "Supplement", workspaceId: "w1", paneId: "w1:p1", requestText: "add tests", queuePosition: 0, occurredAt: "2026-08-24T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "steering", bindingId: "b1", larkMessageId: "m-steering", actorOpenId: "u1", body: "add tests", dispatchKind: "steering", parentPromptId: "parent" }, view: steering, rootMessageId: "root-1", answerCard: {} });
    store.updatePrompt("steering", "running");

    store.completeSteering({ promptId: "steering", notice: "已加入当前执行", occurredAt: "2026-08-24T00:01:00Z" });

    expect(store.loadRunCard("steering")).toMatchObject({ phase: "completed", notice: "已加入当前执行" });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "running", agentState: "working", activePromptId: "parent" });
  });

  it("reopens a completed turn without lifecycle replay or prompt duplication", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-terminal-projection-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Task", workspaceId: "w1", paneId: "w1:p1", phase: "running", activePromptId: "p1" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Work", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-24T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("p1");
    store.transitionBinding("b1", { type: "pane_observed", runtime: "working" });
    store.completeTurn({ promptId: "p1", bindingId: "b1", answer: "durable answer", outputFingerprint: "fp", occurredAt: "2026-08-24T00:01:00Z" });
    store.close();

    store = new SqliteBindingStore(path);
    expect(store.getPrompt("p1")).toMatchObject({ state: "delivered", attemptCount: 1 });
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "completed", answer: "durable answer" });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "done", answer: "durable answer" });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });

  it("scopes sessions and dead-letter actions to a chat without replaying prompts", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Visible" });
    store.createPendingBinding({ id: "b2", workspaceId: "w2", chatId: "c2", topicId: "t2", rootMessageId: "m2", title: "Hidden" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "p-m1", actorOpenId: "u1", body: "private" });
    store.updatePrompt("p1", "failed", "prompt failed");
    store.enqueueOutboundReply({ id: "o1", idempotencyKey: "o1", bindingId: "b1", promptId: "p1", rootMessageId: "m1", kind: "card_update", payload: "{}" });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("o1", "send failed");

    expect(store.listSessions("c1")).toHaveLength(1);
    expect(store.listFailures("c1")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "outbound", id: "o1" }), expect.objectContaining({ kind: "prompt", id: "p1" })]));
    expect(store.retryDeadLetter("o1", "c2", "u2")).toBe("unauthorized");
    expect(store.retryDeadLetter("o1", "c1", "u1")).toBe("retried");
    expect(store.retryDeadLetter("o1", "c1", "u1")).toBe("stale");
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ id: "o1" })]);
    expect(store.getOperationalSummary().prompts.failed).toBe(1);

    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("o1", "send failed again");
    expect(store.dismissDeadLetter("o1", "c1", "u1")).toBe("dismissed");
    expect(store.listFailures("c1").some((failure) => failure.kind === "outbound")).toBe(false);
    expect(store.getOperationalSummary().outbound.dismissed).toBe(1);
  });

  it("atomically accepts one streaming answer card and claims before its card identity is delivered", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", bindingGeneration: 3, conversionParentPromptId: "parent-prompt", title: "First", workspaceId: "w1", paneId: "w1:p1", requestText: "first **request**", queuePosition: 1, occurredAt: "2026-08-22T10:00:00.000Z" });
    const accepted = store.acceptPrompt({
      prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-m1", actorOpenId: "u1", body: "first" },
      view, rootMessageId: "m1", answerCard: { card: "answer" }
    });
    const duplicate = store.acceptPrompt({
      prompt: { id: "other", bindingId: "b1", larkMessageId: "user-m1", actorOpenId: "u1", body: "first" },
      view: { ...view, promptId: "other" }, rootMessageId: "m1", taskCard: {}, answerCard: {}
    });

    expect(accepted.inserted).toBe(true);
    expect(duplicate).toMatchObject({ inserted: false, prompt: { id: "p1" }, view: { promptId: "p1" } });
    expect(store.listPendingOutboundReplies()).toMatchObject([
      { promptId: "p1", viewVersion: 1, kind: "stream_card_create", cardRole: "answer", payload: JSON.stringify({ card: "answer" }) }
    ]);
    expect(store.listQueuedTurnPromptIds("b1")).toEqual(["p1"]);
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("p1");
    expect(store.listQueuedTurnPromptIds("b1")).toEqual([]);

    const [answerCreate] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(answerCreate!.id, "answer-card-m1", "cardkit-1");
    expect(store.loadRunCard("p1")).toMatchObject({
      bindingGeneration: 3, conversionParentPromptId: "parent-prompt", larkMessageId: null, answerMessageId: "answer-card-m1", answerCardId: "cardkit-1", requestText: "first **request**", answerDeliveredVersion: 1
    });
    expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({
      promptId: "p1", pageIndex: 0, messageId: "answer-card-m1", cardId: "cardkit-1", elementId: answerElementId("p1", 0), sourceStart: 0, sequence: 0, state: "active"
    })]);
    store.markPromptDispatched("p1");
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "First complete\n\nSecond draft", answerSegments: ["First complete"], answerDraft: "Second draft", answerDraftTransient: false });
    expect(store.loadRunCard("p1")).toMatchObject({
      answer: "First complete\n\nSecond draft", answerSegments: ["First complete"], answerDraft: "Second draft", answerDraftTransient: false
    });
    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.listDetachedPrompts()).toMatchObject([{ id: "p1", state: "running", observationState: "detached" }]);
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "running", notice: "Bridge 已重连，正在观察原 TraeX 任务；不会重复发送请求", queuePosition: 0, viewVersion: 2 });
    expect(store.getPrompt("p1")).toMatchObject({ steeringOrigin: null, sourcePromptId: null, wasDetached: true });
  });

  it("atomically accepts an eligible classified prompt as automatic steering", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", generation: 3, lastAgentState: "working" });
    const parentView = createQueuedRunCard({ promptId: "parent", bindingId: "b1", bindingGeneration: 3, title: "Parent", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-29T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "m-parent", actorOpenId: "u1", body: "work" }, view: parentView, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("parent", "running");
    store.markPromptDispatched("parent");
    store.saveRunCard({ ...store.loadRunCard("parent")!, phase: "running", activityAt: "2026-08-29T10:04:00.000Z" });
    const ordinaryView = createQueuedRunCard({ promptId: "next", bindingId: "b1", bindingGeneration: 3, title: "Next", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 99, occurredAt: "old" });
    const answerCardFor = vi.fn(() => ({ card: "answer" }));

    const accepted = store.acceptClassifiedPrompt({
      prompt: { id: "next", bindingId: "b1", larkMessageId: "m-next", actorOpenId: "u1", body: "继续" },
      ordinaryView, steeringView: { ...ordinaryView, title: "Steering" }, rootMessageId: "root", maxQueueDepth: 20,
      expectedBindingGeneration: 3, candidateParentPromptId: "parent", activeAfter: "2026-08-29T10:00:00.000Z", acceptedAt: "2026-08-29T10:05:00.000Z", answerCardFor
    });

    expect(accepted).toMatchObject({ inserted: true, decision: "automatic_steering", fallbackReason: null, prompt: { dispatchKind: "steering", parentPromptId: "parent", steeringOrigin: "automatic", sourcePromptId: null, wasDetached: false }, view: { title: "Steering", queuePosition: 0, activityAt: "2026-08-29T10:05:00.000Z", createdAt: "2026-08-29T10:05:00.000Z", updatedAt: "2026-08-29T10:05:00.000Z" } });
    expect(answerCardFor).toHaveBeenCalledWith(expect.objectContaining({ title: "Steering", queuePosition: 0 }));
    expect(store.listPendingOutboundReplies()).toHaveLength(2);
    expect(store.acceptClassifiedPrompt({
      prompt: { id: "duplicate", bindingId: "b1", larkMessageId: "m-next", actorOpenId: "u1", body: "changed" },
      ordinaryView: { ...ordinaryView, promptId: "duplicate" }, steeringView: { ...ordinaryView, promptId: "duplicate" }, rootMessageId: "root", maxQueueDepth: 20,
      expectedBindingGeneration: 99, candidateParentPromptId: null, activeAfter: "2099-01-01T00:00:00.000Z", acceptedAt: "2026-08-29T10:06:00.000Z", answerCardFor: () => ({})
    })).toMatchObject({ inserted: false, decision: "automatic_steering", prompt: { id: "next" } });
    expect(store.listPendingOutboundReplies()).toHaveLength(2);
    expect(store.database.prepare("SELECT created_at, updated_at FROM prompt_jobs WHERE id = 'next'").get()).toEqual({ created_at: "2026-08-29T10:05:00.000Z", updated_at: "2026-08-29T10:05:00.000Z" });
    expect(store.database.prepare("SELECT created_at, updated_at FROM answer_pages WHERE prompt_id = 'next'").get()).toEqual({ created_at: "2026-08-29T10:05:00.000Z", updated_at: "2026-08-29T10:05:00.000Z" });
    expect(store.database.prepare("SELECT created_at, updated_at, next_attempt_at FROM outbound_replies WHERE prompt_id = 'next'").get()).toEqual({ created_at: "2026-08-29T10:05:00.000Z", updated_at: "2026-08-29T10:05:00.000Z", next_attempt_at: "2026-08-29T10:05:00.000Z" });
  });

  it("atomically rejects an ordinary fallback when the queue is full", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", generation: 3, lastAgentState: "working" });
    const parentView = createQueuedRunCard({ promptId: "parent", bindingId: "b1", title: "Parent", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-29T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "m-parent", actorOpenId: "u1", body: "work" }, view: parentView, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("parent", "running");
    store.markPromptDispatched("parent");
    store.saveRunCard({ ...store.loadRunCard("parent")!, phase: "running", activityAt: "2026-08-29T10:04:00.000Z" });
    const queuedView = createQueuedRunCard({ promptId: "queued", bindingId: "b1", title: "Queued", workspaceId: "w1", paneId: "w1:p1", requestText: "queued", queuePosition: 1, occurredAt: "2026-08-29T10:04:30.000Z" });
    store.acceptPrompt({ prompt: { id: "queued", bindingId: "b1", larkMessageId: "m-queued", actorOpenId: "u1", body: "queued" }, view: queuedView, rootMessageId: "root", answerCard: {} });
    store.markPromptObservationDetached("parent", "test race");
    const nextView = createQueuedRunCard({ promptId: "next", bindingId: "b1", title: "Next", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 2, occurredAt: "2026-08-29T10:05:00.000Z" });

    const accepted = store.acceptClassifiedPrompt({
      prompt: { id: "next", bindingId: "b1", larkMessageId: "m-next", actorOpenId: "u1", body: "继续" },
      ordinaryView: nextView, steeringView: nextView, rootMessageId: "root", maxQueueDepth: 1,
      expectedBindingGeneration: 3, candidateParentPromptId: "parent", activeAfter: "2026-08-29T10:00:00.000Z", acceptedAt: "2026-08-29T10:05:00.000Z", answerCardFor: () => ({})
    });

    expect(accepted).toEqual({ inserted: false, decision: "queue_full", fallbackReason: "parent_detached" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE lark_message_id = 'm-next'").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM run_cards WHERE prompt_id = 'next'").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE prompt_id = 'next'").get()).toEqual({ count: 0 });
  });

  it("projects changed queued run cards in one batch with per-card answer lanes", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const views = ["p1", "p2", "p3"].map((promptId, index) => createQueuedRunCard({
      promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: index + 1, occurredAt: "start"
    }));
    for (const view of views) {
      store.acceptPrompt({ prompt: { id: view.promptId, bindingId: "b1", larkMessageId: `m-${view.promptId}`, actorOpenId: "u1", body: view.promptId }, view, rootMessageId: "root", answerCard: {} });
      const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === view.promptId)!;
      store.markOutboundReplyDelivered(create.id, `answer-${view.promptId}`, `card-${view.promptId}`);
    }
    const first = store.loadRunCard("p1")!;
    const third = store.loadRunCard("p3")!;
    const firstNext = { ...first, queuePosition: 2, viewVersion: first.viewVersion + 1, updatedAt: "later" };
    const thirdNext = { ...third, queuePosition: 4, viewVersion: third.viewVersion + 1, updatedAt: "later" };

    expect(store.projectQueuedRunCards({
      bindingId: "b1",
      projections: [
        { expectedViewVersion: first.viewVersion, view: firstNext, card: { promptId: "p1" } },
        { expectedViewVersion: third.viewVersion, view: thirdNext, card: { promptId: "p3" } }
      ]
    })).toEqual({ projected: [firstNext, thirdNext], stalePromptIds: [], outboxReserved: true });
    expect(store.loadRunCard("p1")).toMatchObject({ queuePosition: 2, viewVersion: first.viewVersion + 1 });
    expect(store.loadRunCard("p2")).toMatchObject({ queuePosition: 2, viewVersion: views[1]!.viewVersion });
    expect(store.loadRunCard("p3")).toMatchObject({ queuePosition: 4, viewVersion: third.viewVersion + 1 });
    expect(store.database.prepare("SELECT idempotency_key, lane_key FROM outbound_replies WHERE kind = 'card_update' ORDER BY prompt_id").all()).toEqual([
      { idempotency_key: `run-card:update:p1:answer:${first.viewVersion + 1}`, lane_key: "answer:p1" },
      { idempotency_key: `run-card:update:p3:answer:${third.viewVersion + 1}`, lane_key: "answer:p3" }
    ]);
  });

  it("skips stale queued card projections while committing valid siblings", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const cards = ["stale", "valid"].map((promptId, index) => {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: index + 1, occurredAt: "start" });
      view.answerMessageId = `answer-${promptId}`;
      store!.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `m-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "root", answerCard: {} });
      return view;
    });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, `delivered-${reply.promptId}`, `card-${reply.promptId}`);

    const result = store.projectQueuedRunCards({ bindingId: "b1", projections: cards.map((view) => ({ expectedViewVersion: view.promptId === "stale" ? 0 : 1, view: { ...view, queuePosition: 9, viewVersion: 2 }, card: {} })) });

    expect(result).toMatchObject({ projected: [expect.objectContaining({ promptId: "valid" })], stalePromptIds: ["stale"], outboxReserved: true });
    expect(store.loadRunCard("stale")).toMatchObject({ queuePosition: 1, viewVersion: 1 });
    expect(store.loadRunCard("valid")).toMatchObject({ queuePosition: 9, viewVersion: 2 });
  });

  it("projects a queued card without reserving outbox work when no answer message exists", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const initial = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view: initial, rootMessageId: "root", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "card-1");

    expect(store.projectQueuedRunCards({ bindingId: "b1", projections: [{ expectedViewVersion: 1, view: { ...initial, queuePosition: 2, viewVersion: 2 }, card: {} }] })).toMatchObject({
      projected: [expect.objectContaining({ promptId: "p1", queuePosition: 2 })], stalePromptIds: [], outboxReserved: false
    });
    expect(store.listPendingOutboundReplies()).toHaveLength(0);
  });

  it("rolls back every queued card and outbox intent when one batch insert fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const cards = ["p1", "p2"].map((promptId, index) => {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: index + 1, occurredAt: "start" });
      view.answerMessageId = `answer-${promptId}`;
      store!.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `m-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "root", answerCard: {} });
      return view;
    });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, `delivered-${reply.promptId}`, `card-${reply.promptId}`);
    store.database.exec("CREATE TEMP TRIGGER reject_second_queue_card BEFORE INSERT ON outbound_replies WHEN NEW.kind = 'card_update' AND NEW.prompt_id = 'p2' BEGIN SELECT RAISE(ABORT, 'reject second outbox'); END");

    try {
      expect(() => store!.projectQueuedRunCards({ bindingId: "b1", projections: cards.map((view) => ({ expectedViewVersion: 1, view: { ...view, queuePosition: view.queuePosition + 1, viewVersion: 2 }, card: {} })) })).toThrow("reject second outbox");
      expect(store.loadRunCard("p1")).toMatchObject({ queuePosition: 1, viewVersion: 1 });
      expect(store.loadRunCard("p2")).toMatchObject({ queuePosition: 2, viewVersion: 1 });
      expect(store.listPendingOutboundReplies()).toHaveLength(0);
    } finally {
      store.database.exec("DROP TRIGGER IF EXISTS reject_second_queue_card");
    }
  });

  it.each([
    ["no_candidate", null, 3, "working", "attached", false, "2026-08-29T10:04:00.000Z"],
    ["binding_changed", "parent", 2, "working", "attached", false, "2026-08-29T10:04:00.000Z"],
    ["parent_inactive", "parent", 3, "working", "attached", false, "2026-08-29T10:04:00.000Z"],
    ["parent_detached", "parent", 3, "working", "detached", true, "2026-08-29T10:04:00.000Z"],
    ["parent_state", "parent", 3, "idle", "attached", false, "2026-08-29T10:04:00.000Z"],
    ["parent_stale", "parent", 3, "working", "attached", false, "2026-08-29T09:59:59.000Z"]
  ] as const)("falls back atomically for %s", (reason, candidateParentPromptId, expectedGeneration, agentState, observationState, wasDetached, activityAt) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", generation: 3, lastAgentState: agentState });
    const parentView = createQueuedRunCard({ promptId: "parent", bindingId: "b1", title: "Parent", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: activityAt });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "m-parent", actorOpenId: "u1", body: "work" }, view: parentView, rootMessageId: "root", answerCard: {} });
    if (reason !== "parent_inactive") {
      store.updatePrompt("parent", "running");
      if (observationState === "attached") store.markPromptDispatched("parent");
      else store.database.prepare("UPDATE prompt_jobs SET observation_state = 'detached', was_detached = ? WHERE id = 'parent'").run(wasDetached ? 1 : 0);
    } else store.updatePrompt("parent", "delivered");
    const queuedAhead = createQueuedRunCard({ promptId: "ahead", bindingId: "b1", title: "Ahead", workspaceId: "w1", paneId: "w1:p1", requestText: "ahead", queuePosition: 1, occurredAt: "2026-08-29T10:04:30.000Z" });
    store.acceptPrompt({ prompt: { id: "ahead", bindingId: "b1", larkMessageId: "m-ahead", actorOpenId: "u1", body: "ahead" }, view: queuedAhead, rootMessageId: "root", answerCard: {} });
    const ordinaryView = createQueuedRunCard({ promptId: "next", bindingId: "b1", title: "Next", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 99, occurredAt: "old" });

    const first = store.acceptClassifiedPrompt({ prompt: { id: "next", bindingId: "b1", larkMessageId: "m-next", actorOpenId: "u1", body: "继续" }, ordinaryView, steeringView: { ...ordinaryView, title: "Steering" }, rootMessageId: "root", maxQueueDepth: 20, expectedBindingGeneration: expectedGeneration, candidateParentPromptId, activeAfter: "2026-08-29T10:00:00.000Z", acceptedAt: "2026-08-29T10:05:00.000Z", answerCardFor: () => ({}) });
    const duplicate = store.acceptClassifiedPrompt({ prompt: { id: "other", bindingId: "b1", larkMessageId: "m-next", actorOpenId: "u1", body: "changed" }, ordinaryView: { ...ordinaryView, promptId: "other" }, steeringView: { ...ordinaryView, promptId: "other" }, rootMessageId: "root", maxQueueDepth: 20, expectedBindingGeneration: 3, candidateParentPromptId: "parent", activeAfter: "1900-01-01T00:00:00.000Z", acceptedAt: "2026-08-29T10:06:00.000Z", answerCardFor: () => ({}) });

    expect(first).toMatchObject({ inserted: true, decision: "ordinary", fallbackReason: reason, prompt: { dispatchKind: "turn", parentPromptId: null, steeringOrigin: null }, view: { queuePosition: 2 } });
    expect(duplicate).toMatchObject({ inserted: false, decision: "ordinary", prompt: { id: "next" }, view: { promptId: "next", queuePosition: 2 } });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE lark_message_id = 'm-next'").get()).toEqual({ count: 1 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE prompt_id = 'next'").get()).toEqual({ count: 1 });
  });

  it("filters recent eligible ordinary durations and enriches the initial ordinary card atomically", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", generation: 3, lastAgentState: "idle" });
    for (const [index, duration] of [30, 60, 90, 120].entries()) {
      const id = `history-${index}`;
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: `2026-08-29T09:0${index}:00.000Z` });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "root", answerCard: {} });
      store.database.prepare("UPDATE prompt_jobs SET state = 'delivered', observation_state = 'completed', was_detached = 0 WHERE id = ?").run(id);
      store.database.prepare("UPDATE run_cards SET phase = 'completed', started_at = ?, finished_at = ? WHERE prompt_id = ?").run(`2026-08-29T09:0${index}:00.000Z`, new Date(Date.parse(`2026-08-29T09:0${index}:00.000Z`) + duration * 1_000).toISOString(), id);
    }
    store.database.prepare("UPDATE prompt_jobs SET was_detached = 1 WHERE id = 'history-0'").run();
    const invalid = createQueuedRunCard({ promptId: "invalid", bindingId: "b1", title: "invalid", workspaceId: "w1", paneId: "w1:p1", requestText: "invalid", queuePosition: 1, occurredAt: "2026-08-29T09:04:00.000Z" });
    store.acceptPrompt({ prompt: { id: "invalid", bindingId: "b1", larkMessageId: "m-invalid", actorOpenId: "u1", body: "invalid" }, view: invalid, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET state = 'delivered', observation_state = 'completed' WHERE id = 'invalid'").run();
    store.database.prepare("UPDATE run_cards SET phase = 'completed', started_at = '2026-08-29T09:05:00.000Z', finished_at = '2026-08-29T09:05:00.000Z' WHERE prompt_id = 'invalid'").run();
    expect(store.listCompletedOrdinaryTurnDurations("b1", 20)).toEqual([120_000, 90_000, 60_000]);

    const active = createQueuedRunCard({ promptId: "active", bindingId: "b1", title: "active", workspaceId: "w1", paneId: "w1:p1", requestText: "active", queuePosition: 1, occurredAt: "2026-08-29T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "active", bindingId: "b1", larkMessageId: "m-active", actorOpenId: "u1", body: "active" }, view: active, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("active", "running");
    store.markPromptDispatched("active");
    store.database.prepare("UPDATE run_cards SET phase = 'running', started_at = '2026-08-29T10:00:00.000Z' WHERE prompt_id = 'active'").run();
    const ahead = createQueuedRunCard({ promptId: "ahead", bindingId: "b1", title: "ahead", workspaceId: "w1", paneId: "w1:p1", requestText: "ahead", queuePosition: 1, occurredAt: "2026-08-29T10:00:10.000Z" });
    store.acceptPrompt({ prompt: { id: "ahead", bindingId: "b1", larkMessageId: "m-ahead", actorOpenId: "u1", body: "ahead" }, view: ahead, rootMessageId: "root", answerCard: {} });
    const next = createQueuedRunCard({ promptId: "next", bindingId: "b1", title: "next", workspaceId: "w1", paneId: "w1:p1", requestText: "next", queuePosition: 99, occurredAt: "old" });
    const answerCardFor = vi.fn(renderRequestAnswerCard);
    const accepted = store.acceptClassifiedPrompt({ prompt: { id: "next", bindingId: "b1", larkMessageId: "m-next", actorOpenId: "u1", body: "next" }, ordinaryView: next, steeringView: next, rootMessageId: "root", maxQueueDepth: 20, expectedBindingGeneration: 3, candidateParentPromptId: null, activeAfter: "2026-08-29T09:00:00.000Z", acceptedAt: "2026-08-29T10:00:20.000Z", answerCardFor });
    expect(accepted.view.queueFeedback).toMatchObject({ aheadCount: 1, activeElapsedSeconds: 20, sampleCount: 3, estimateLowerSeconds: 60, estimateUpperSeconds: 240 });
    expect(answerCardFor).toHaveBeenCalledWith(expect.objectContaining({ queuePosition: 2, queueFeedback: expect.objectContaining({ aheadCount: 1, activeElapsedSeconds: 20 }) }));
    expect(store.listPendingOutboundReplies().find((reply) => reply.promptId === "next")!.payload).toContain("⏳ 已排队 · 前方 1 条\\n当前任务已运行 20 秒\\n预计等待约 1–4 分钟");
  });

  it.each([
    ["detached", false],
    ["recovered but previously detached", true]
  ] as const)("omits active queue timing for a %s running prompt", (_label, recover) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const active = createQueuedRunCard({ promptId: "active", bindingId: "b1", title: "active", workspaceId: "w1", paneId: "w1:p1", requestText: "active", queuePosition: 1, occurredAt: "2026-08-29T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "active", bindingId: "b1", larkMessageId: "m-active", actorOpenId: "u1", body: "active" }, view: active, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("active", "running");
    store.markPromptDispatched("active");
    store.database.prepare("UPDATE run_cards SET phase = 'running', started_at = '2026-08-29T10:00:00.000Z' WHERE prompt_id = 'active'").run();
    store.markPromptObservationDetached("active", "observer interrupted");
    if (recover) store.markPromptDispatched("active");

    expect(store.loadQueueFeedbackInputs("b1").activeStartedAt).toBeNull();
  });

  it.each([
    ["archived binding", { state: "archived", lifecycle: "archived", attachment: "attached" }],
    ["degraded attachment", { state: "active", lifecycle: "active", attachment: "degraded" }]
  ] as const)("falls back when the %s is not dispatchable", (_label, bindingState) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", generation: 3, lastAgentState: "working", ...bindingState });
    const parentView = createQueuedRunCard({ promptId: "parent", bindingId: "b1", title: "Parent", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-29T10:04:00.000Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "m-parent", actorOpenId: "u1", body: "work" }, view: parentView, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("parent", "running");
    store.markPromptDispatched("parent");
    const ordinaryView = createQueuedRunCard({ promptId: "next", bindingId: "b1", title: "Next", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 99, occurredAt: "old" });

    expect(store.acceptClassifiedPrompt({ prompt: { id: "next", bindingId: "b1", larkMessageId: "m-next", actorOpenId: "u1", body: "继续" }, ordinaryView, steeringView: ordinaryView, rootMessageId: "root", maxQueueDepth: 20, expectedBindingGeneration: 3, candidateParentPromptId: "parent", activeAfter: "2026-08-29T10:00:00.000Z", acceptedAt: "2026-08-29T10:05:00.000Z", answerCardFor: () => ({}) })).toMatchObject({ decision: "ordinary", fallbackReason: "parent_inactive", prompt: { dispatchKind: "turn" } });
  });

  it("migrates prompt provenance and run-card activity idempotently", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-classified-prompt-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "legacy", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: null, requestText: "legacy", queuePosition: 1, occurredAt: "2026-08-29T09:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "legacy", bindingId: "b1", larkMessageId: "m-legacy", actorOpenId: "u1", body: "legacy" }, view, rootMessageId: "root", answerCard: {} });
    store.database.exec("DROP INDEX prompt_jobs_source_prompt_once; DROP VIEW run_cards_view; ALTER TABLE prompt_jobs DROP COLUMN steering_origin; ALTER TABLE prompt_jobs DROP COLUMN source_prompt_id; ALTER TABLE prompt_jobs DROP COLUMN was_detached; ALTER TABLE run_cards DROP COLUMN activity_at; ALTER TABLE run_cards DROP COLUMN queue_feedback_json;");
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);
    expect(store.getPrompt("legacy")).toMatchObject({ steeringOrigin: null, sourcePromptId: null, wasDetached: false });
    expect(store.loadRunCard("legacy")?.activityAt).toBe("2026-08-29T09:00:00.000Z");
    expect(store.loadRunCard("legacy")?.queueFeedback).toBeNull();
    expect(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'prompt_jobs_source_prompt_once'").get()).toEqual({ name: "prompt_jobs_source_prompt_once" });
  });

  it("derives cumulative progress before trimming legacy run-card history", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-progress-summary-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "legacy-progress", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: null, requestText: "legacy", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "legacy-progress", bindingId: "b1", larkMessageId: "m-legacy-progress", actorOpenId: "u1", body: "legacy" }, view, rootMessageId: "root", answerCard: {} });
    const events = Array.from({ length: 10 }, (_, index) => ({ key: `step:${index}`, kind: "step", label: `step ${index}`, state: index < 6 ? "done" : "active", occurredAt: "now" }));
    store.database.prepare("UPDATE run_cards SET progress_events_json = ? WHERE prompt_id = 'legacy-progress'").run(JSON.stringify(events));
    store.database.exec("DELETE FROM schema_migrations WHERE version = 6; DROP VIEW run_cards_view; ALTER TABLE run_cards DROP COLUMN progress_summary_json");
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);
    const migrated = store.loadRunCard("legacy-progress")!;
    expect(migrated.progressEvents.map((event) => event.key)).toEqual(Array.from({ length: 8 }, (_, index) => `step:${index + 2}`));
    expect(migrated.progressSummary).toEqual({ total: 10, stepTotal: 10, stepDone: 6 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 6").get()).toEqual({ version: 6 });
  });

  it("drops a stale run-card view before migrating legacy tables", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-stale-run-card-view-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.close();
    store = undefined;

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP VIEW run_cards_view;
      DROP INDEX card_interactions_expiry;
      ALTER TABLE card_interactions RENAME TO card_interactions_current;
      CREATE TABLE card_interactions(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL, actor_open_id TEXT NOT NULL,
        action_kind TEXT NOT NULL CHECK(action_kind IN ('supplement','convert_queued_prompt','more_actions','session_control')),
        parent_prompt_id TEXT, target_prompt_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','claimed','consumed','expired')),
        expires_at TEXT NOT NULL, result_code TEXT, created_at TEXT NOT NULL, claimed_at TEXT, consumed_at TEXT
      );
      DROP TABLE card_interactions_current;
      CREATE INDEX card_interactions_expiry ON card_interactions(state, expires_at);
      ALTER TABLE run_cards DROP COLUMN steering_failure_kind;
      ALTER TABLE run_cards DROP COLUMN steering_origin;
      CREATE VIEW run_cards_view AS SELECT *, json_object(
        'promptId', prompt_id, 'steeringOrigin', steering_origin, 'steeringFailureKind', steering_failure_kind
      ) AS state_json FROM run_cards;
    `);
    legacy.close();

    expect(() => { store = new SqliteBindingStore(path); }).not.toThrow();
    expect(store!.database.prepare("PRAGMA table_info(run_cards)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "steering_origin" }),
      expect.objectContaining({ name: "steering_failure_kind" })
    ]));
    expect(store!.database.prepare("SELECT state_json FROM run_cards_view LIMIT 1").all()).toEqual([]);
  });

  it("enforces one conversion source and preserves activity across presentation-only changes", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const source = createQueuedRunCard({ promptId: "source", bindingId: "b1", title: "Source", workspaceId: "w1", paneId: null, requestText: "source", queuePosition: 1, occurredAt: "2026-08-29T09:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "source", bindingId: "b1", larkMessageId: "m-source", actorOpenId: "u1", body: "source" }, view: source, rootMessageId: "root", answerCard: {} });
    const converted = createQueuedRunCard({ promptId: "converted", bindingId: "b1", title: "Converted", workspaceId: "w1", paneId: null, requestText: "converted", queuePosition: 2, occurredAt: "2026-08-29T09:01:00.000Z" });
    expect(store.acceptPrompt({ prompt: { id: "converted", bindingId: "b1", larkMessageId: "m-converted", actorOpenId: "u1", body: "converted", steeringOrigin: "converted", sourcePromptId: "source" }, view: converted, rootMessageId: "root", answerCard: {} }).prompt).toMatchObject({ steeringOrigin: "converted", sourcePromptId: "source" });
    expect(() => store!.acceptPrompt({ prompt: { id: "duplicate-source", bindingId: "b1", larkMessageId: "m-duplicate-source", actorOpenId: "u1", body: "duplicate", steeringOrigin: "converted", sourcePromptId: "source" }, view: { ...converted, promptId: "duplicate-source" }, rootMessageId: "root", answerCard: {} })).toThrow();

    const originalActivity = store.loadRunCard("converted")!.activityAt;
    store.saveRunCard({ ...store.loadRunCard("converted")!, queuePosition: 1, updatedAt: "2026-08-29T09:02:00.000Z" });
    expect(store.loadRunCard("converted")?.activityAt).toBe(originalActivity);
  });

  it("preserves prompt provenance while rebuilding the legacy prompt state constraint", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-prompt-state-provenance-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const source = createQueuedRunCard({ promptId: "source", bindingId: "b1", title: "Source", workspaceId: "w1", paneId: null, requestText: "source", queuePosition: 1, occurredAt: "2026-08-29T09:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "source", bindingId: "b1", larkMessageId: "m-source", actorOpenId: "u1", body: "source" }, view: source, rootMessageId: "root", answerCard: {} });
    const converted = createQueuedRunCard({ promptId: "converted", bindingId: "b1", title: "Converted", workspaceId: "w1", paneId: null, requestText: "converted", queuePosition: 2, occurredAt: "2026-08-29T09:01:00.000Z" });
    store.acceptPrompt({ prompt: { id: "converted", bindingId: "b1", larkMessageId: "m-converted", actorOpenId: "u1", body: "converted", steeringOrigin: "converted", sourcePromptId: "source", wasDetached: true }, view: converted, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET dispatched_at = ?, transcript_turn_id = ?, transcript_turn_started_at = ? WHERE id = 'converted'")
      .run("2026-08-29T09:01:01.000Z", "01a052d3-9c14-70e1-a375-397e2ecb55e9", "2026-08-29T09:01:01.250Z");
    store.database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX prompt_jobs_source_prompt_once;
      CREATE TABLE prompt_jobs_legacy(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE NOT NULL,
        actor_open_id TEXT NOT NULL, body TEXT NOT NULL, dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering')), parent_prompt_id TEXT,
        steering_origin TEXT CHECK(steering_origin IN ('explicit','automatic','converted')), source_prompt_id TEXT REFERENCES prompt_jobs_legacy(id), was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1)),
        dispatched_at TEXT, transcript_turn_id TEXT, transcript_turn_started_at TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO prompt_jobs_legacy(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, dispatched_at, transcript_turn_id, transcript_turn_started_at, state, observation_state, attempt_count, error, created_at, updated_at)
        SELECT id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, dispatched_at, transcript_turn_id, transcript_turn_started_at, state, observation_state, attempt_count, error, created_at, updated_at FROM prompt_jobs;
      DROP TABLE prompt_jobs;
      ALTER TABLE prompt_jobs_legacy RENAME TO prompt_jobs;
      PRAGMA foreign_keys = ON;
    `);
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);
    expect(store.getPrompt("converted")).toMatchObject({
      steeringOrigin: "converted", sourcePromptId: "source", wasDetached: true,
      dispatchedAt: "2026-08-29T09:01:01.000Z", transcriptTurnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptTurnStartedAt: "2026-08-29T09:01:01.250Z"
    });
  });

  it("atomically reserves Answer content, continuation, and terminal finish intents", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    const elementId = answerElementId("p1", 0);

    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId, content: "page one" })).toBe("reserved");
    expect(store.getActiveAnswerPage("p1")?.sequence).toBe(1);
    expect(store.loadRunCard("p1")?.answerSequence).toBe(1);
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "stream_content", viewVersion: 1 })]);
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId, content: "page one" })).toBe("waiting");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");

    expect(store.reserveAnswerContinuation({ promptId: "p1", pageIndex: 0, cardId: "card-1", summary: "Continued", nextPageIndex: 1, nextPageStart: 9_000, nextElementId: answerElementId("p1", 1), rootMessageId: "root-1", viewVersion: 2, card: {} })).toBe("reserved");
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "active", sequence: 2 }),
      expect.objectContaining({ pageIndex: 1, state: "creating", sequence: 0 })
    ]);
    expect(store.listPendingOutboundReplies().map((reply) => reply.kind)).toEqual(["stream_finish", "stream_card_create"]);
  });

  it("rolls back an Answer reservation when its outbox insert fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    store.database.exec("CREATE TEMP TRIGGER reject_answer_content BEFORE INSERT ON outbound_replies WHEN NEW.kind = 'stream_content' BEGIN SELECT RAISE(ABORT, 'forced_answer_outbox_failure'); END");

    expect(() => store!.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: answerElementId("p1", 0), content: "new" })).toThrow("forced_answer_outbox_failure");

    expect(store.getActiveAnswerPage("p1")?.sequence).toBe(0);
    expect(store.loadRunCard("p1")?.answerSequence).toBe(0);
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });

  it("recovers only queued answer cards dead-lettered by the legacy element id format", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "legacy-id", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({
      prompt: { id: "legacy-id", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" },
      view: { ...view, answerElementId: "answer_content_legacy_identifier_that_is_too_long_0" }, rootMessageId: "m1",
      answerCard: { schema: "2.0", body: { elements: [{ tag: "markdown", element_id: "answer_content_legacy_identifier_that_is_too_long_0", content: "waiting" }] } }
    });
    const [legacyReply] = store.listPendingOutboundReplies();
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed(legacyReply!.id, "ElementID answer_content_legacy_identifier_that_is_too_long_0: Code 1002: elementID format error");

    store.enqueueOutboundReply({ id: "unrelated", idempotencyKey: "unrelated", bindingId: "b1", rootMessageId: "m1", kind: "text", payload: "hello" });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("unrelated", "network unavailable");

    expect(store.recoverLegacyElementIdDeadLetters()).toBe(1);
    const [recovered] = store.listPendingOutboundReplies();
    expect(recovered).toMatchObject({ id: legacyReply!.id, state: "pending", attemptCount: 0, error: null });
    expect(store.loadRunCard("legacy-id")?.answerElementId).toBe(answerElementId("legacy-id", 0));
    expect(JSON.parse(recovered!.payload)).toMatchObject({ body: { elements: [{ element_id: answerElementId("legacy-id", 0) }] } });
    expect(store.getOperationalSummary().deadLetters).toBe(1);
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("legacy-id");

    store.markOutboundReplyDelivered(legacyReply!.id, "answer-1", "cardkit-1");
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
  });

  it("canonicalizes pending continuation metadata with its card payload", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "card-1");
    const legacyId = "answer_content_legacy_identifier_that_is_too_long_1";
    store.database.exec("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1'");
    store.database.prepare("INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 1, NULL, NULL, ?, 20000, 0, 'creating', 'streaming', 'now', 'now')").run(legacyId);
    store.database.prepare("UPDATE run_cards SET answer_element_id = ?, answer_page_index = 1, answer_page_start = 20000 WHERE prompt_id = 'p1'").run(legacyId);
    store.enqueueOutboundReply({ id: "page-2", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "m1", kind: "stream_card_create", payload: JSON.stringify({ card: { body: { elements: [{ element_id: legacyId }] } }, stream: { pageIndex: 1, pageStart: 20_000, elementId: legacyId } }) });

    expect(store.recoverLegacyElementIdDeadLetters()).toBe(0);

    const repaired = store.listPendingOutboundReplies().find((reply) => reply.id === "page-2")!;
    const payload = JSON.parse(repaired.payload);
    expect(store.loadRunCard("p1")?.answerElementId).toBe(answerElementId("p1", 1));
    expect(payload.stream.elementId).toBe(store.loadRunCard("p1")?.answerElementId);
    expect(payload.card.body.elements[0].element_id).toBe(payload.stream.elementId);
  });

  it("canonicalizes persisted answer targets before startup outbox draining", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-element-id-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    const legacyId = "answer_content_legacy_identifier_that_is_too_long_0";
    store.database.prepare("UPDATE run_cards SET answer_element_id = ? WHERE prompt_id = 'p1'").run(legacyId);
    store.database.prepare("UPDATE outbound_replies SET payload = ? WHERE prompt_id = 'p1'").run(JSON.stringify({ body: { elements: [{ element_id: legacyId }] } }));
    store.database.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    store.close();

    store = new SqliteBindingStore(path);

    expect(store.loadRunCard("p1")?.answerElementId).toBe(answerElementId("p1", 0));
    expect(JSON.parse(store.listPendingOutboundReplies()[0]!.payload)).toMatchObject({ body: { elements: [{ element_id: answerElementId("p1", 0) }] } });
  });

  it("repairs answer payloads when the persisted run-card id is already canonical", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-element-payload-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    const canonicalId = store.loadRunCard("p1")!.answerElementId;
    const legacyId = "answer_content_legacy_identifier_that_is_too_long_0";
    store.database.prepare("UPDATE outbound_replies SET payload = ? WHERE prompt_id = 'p1'").run(JSON.stringify({ body: { elements: [{ element_id: legacyId }] }, stream: { pageIndex: 0, pageStart: 0, elementId: legacyId } }));
    store.enqueueOutboundReply({ id: "unrelated", idempotencyKey: "unrelated", rootMessageId: "m1", kind: "text", payload: legacyId });
    store.database.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    store.close();

    store = new SqliteBindingStore(path);
    const payload = JSON.parse(store.listPendingOutboundReplies()[0]!.payload);
    expect(store.loadRunCard("p1")?.answerElementId).toBe(canonicalId);
    expect(payload.body.elements[0].element_id).toBe(canonicalId);
    expect(payload.stream.elementId).toBe(canonicalId);
    expect(store.listPendingOutboundReplies().find((reply) => reply.id === "unrelated")?.payload).toBe(legacyId);
  });

  it("uses the prompt-oriented index for Answer payload migration lookups", () => {
    store = new SqliteBindingStore(":memory:");
    const plan = store.database.prepare("EXPLAIN QUERY PLAN SELECT id, kind, payload FROM outbound_replies INDEXED BY outbound_replies_prompt_role_state WHERE prompt_id = ? AND card_role = 'answer' AND state IN ('pending','dead_letter')").all("p1") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("outbound_replies_prompt_role_state");
  });

  it("uses a binding status index when checking whether a Main Card version is already reserved", () => {
    store = new SqliteBindingStore(":memory:");

    const columns = store.database.prepare("PRAGMA index_info(outbound_replies_binding_target_version)").all() as Array<{ name: string }>;
    const plan = store.database.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND view_version >= ? LIMIT 1").all("b1", 1) as Array<{ detail: string }>;

    expect(columns.map((column) => column.name)).toEqual(["binding_id", "target_role", "view_version"]);
    expect(plan.map((row) => row.detail).join(" ")).toContain("outbound_replies_binding_target_version");
  });

  it("uses a prompt delivery index for operational latency summaries", () => {
    store = new SqliteBindingStore(":memory:");

    const columns = store.database.prepare("PRAGMA index_info(outbound_replies_prompt_kind_state_updated)").all() as Array<{ name: string }>;
    const plan = store.database.prepare("EXPLAIN QUERY PLAN SELECT MIN(updated_at) FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_finish' AND state = 'delivered' AND updated_at >= ?").all("p1", "2026-08-29T00:00:00.000Z") as Array<{ detail: string }>;

    expect(columns.map((column) => column.name)).toEqual(["prompt_id", "kind", "state", "updated_at"]);
    expect(plan.map((row) => row.detail).join(" " )).toContain("outbound_replies_prompt_kind_state_updated");
  });

  it("uses ordered retention indexes for bounded history pruning", () => {
    store = new SqliteBindingStore(":memory:");

    const outboundColumns = store.database.prepare("PRAGMA index_info(outbound_replies_retention)").all() as Array<{ name: string }>;
    const inboundColumns = store.database.prepare("PRAGMA index_info(inbound_messages_retention)").all() as Array<{ name: string }>;
    const outboundPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT id FROM outbound_replies WHERE state IN ('delivered', 'dismissed') AND updated_at < ? ORDER BY updated_at, delivery_order LIMIT ?").all("2026-08-12T00:00:00.000Z", 100) as Array<{ detail: string }>;
    const inboundPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT event_id FROM inbound_messages WHERE state = 'accepted' AND updated_at < ? ORDER BY updated_at, event_id LIMIT ?").all("2026-08-12T00:00:00.000Z", 100) as Array<{ detail: string }>;

    expect(outboundColumns.map((column) => column.name)).toEqual(["state", "updated_at", "delivery_order"]);
    expect(inboundColumns.map((column) => column.name)).toEqual(["state", "updated_at", "event_id"]);
    expect(outboundPlan.map((row) => row.detail).join(" " )).toContain("outbound_replies_retention");
    expect(inboundPlan.map((row) => row.detail).join(" " )).toContain("inbound_messages_retention");
  });

  it("creates the ordinary prompt queue index with the exact column order", () => {
    store = new SqliteBindingStore(":memory:");

    const columns = store.database.prepare("PRAGMA index_info(prompt_jobs_queue_kind)").all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toEqual(["binding_id", "state", "dispatch_kind", "created_at"]);
  });

  it("repairs a missing ordinary prompt queue index without changing schema on later reopens", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-prompt-queue-index-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.database.exec("DROP INDEX IF EXISTS prompt_jobs_queue_kind");
    store.close();

    store = new SqliteBindingStore(path);
    const repaired = store.database.prepare("PRAGMA index_info(prompt_jobs_queue_kind)").all() as Array<{ name: string }>;
    expect(repaired.map((column) => column.name)).toEqual(["binding_id", "state", "dispatch_kind", "created_at"]);
    store.close();

    store = new SqliteBindingStore(path);
    const before = store.database.prepare("PRAGMA schema_version").get() as { schema_version: number };
    store.close();
    store = new SqliteBindingStore(path);
    const after = store.database.prepare("PRAGMA schema_version").get() as { schema_version: number };
    expect(after.schema_version).toBe(before.schema_version);
  });

  it("uses the queue-kind index for ordinary prompt hot paths under mixed queue load", () => {
    store = new SqliteBindingStore(":memory:");
    for (let bindingIndex = 0; bindingIndex < 4; bindingIndex += 1) {
      const bindingId = `queue-plan-${bindingIndex}`;
      store.createPendingBinding({ id: bindingId, workspaceId: `w${bindingIndex}`, chatId: "c1", topicId: `t${bindingIndex}`, rootMessageId: `root-${bindingIndex}`, title: bindingId });
      store.updateBinding(bindingId, { state: "active", lifecycle: "active", attachment: "attached", paneId: `w${bindingIndex}:p1`, lastAgentState: "idle" });
    }
    const insertPrompt = store.database.prepare(`
      INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, state, observation_state, attempt_count, error, created_at, updated_at)
      VALUES (?, ?, ?, 'u1', 'fixture', ?, NULL, NULL, NULL, 0, ?, 'not_started', 0, NULL, ?, ?)
    `);
    const insertRunCard = store.database.prepare(`
      INSERT INTO run_cards(prompt_id, binding_id, answer_message_id, answer_card_id, phase, title, workspace_id, pane_id, answer, progress_events_json, queue_position, activity_at, view_version, delivered_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'fixture', ?, ?, '', '[]', 1, ?, 1, 0, ?, ?)
    `);
    store.database.exec("BEGIN");
    for (let index = 0; index < 1_600; index += 1) {
      const bindingIndex = index % 4;
      const bindingId = `queue-plan-${bindingIndex}`;
      const promptId = `queue-plan-prompt-${index}`;
      const dispatchKind = Math.floor(index / 4) % 2 === 0 ? "turn" : "steering";
      const state = Math.floor(index / 8) % 20 < 2 ? "queued" : "delivered";
      const timestamp = `2026-08-29T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.${String(index).padStart(4, "0")}Z`;
      insertPrompt.run(promptId, bindingId, `queue-plan-message-${index}`, dispatchKind, state, timestamp, timestamp);
      insertRunCard.run(promptId, bindingId, `answer-${index}`, `card-${index}`, state === "queued" ? "queued" : "completed", `w${bindingIndex}`, `w${bindingIndex}:p1`, timestamp, timestamp, timestamp);
    }
    store.database.exec("COMMIT; ANALYZE");

    const explain = (sql: string, ...parameters: string[]) => (store!.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{ detail: string }>)
      .map((row) => row.detail.toLowerCase().replace(/\s+/g, " "));
    const expectQueueKindSearch = (details: string[]) => {
      expect(details.some((detail) => detail.includes("prompt_jobs_queue_kind")
        && detail.includes("binding_id=?")
        && detail.includes("state=?") && detail.includes("dispatch_kind=?")), details.join(" | ")).toBe(true);
    };

    expectQueueKindSearch(explain(
      "SELECT id FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' AND dispatch_kind = 'turn' ORDER BY created_at, rowid",
      "queue-plan-0"
    ));
    expectQueueKindSearch(explain(`
      SELECT p.* FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state = 'queued' AND p.dispatch_kind = 'turn'
        AND c.answer_message_id IS NOT NULL AND (c.answer_card_id IS NOT NULL OR c.lark_message_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM prompt_jobs active WHERE active.binding_id = p.binding_id AND active.state = 'running')
        AND NOT EXISTS (SELECT 1 FROM pane_control_operations control WHERE control.binding_id = p.binding_id AND control.kind = 'model' AND control.state IN ('accepted','running','applied'))
      ORDER BY p.created_at, p.rowid LIMIT 1
    `, "queue-plan-0"));
    expectQueueKindSearch(explain(`
      SELECT DISTINCT p.binding_id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
      WHERE p.state = 'queued' AND p.dispatch_kind = 'turn'
        AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM prompt_jobs active WHERE active.binding_id = p.binding_id AND active.state = 'running')
      ORDER BY p.binding_id
    `));
  });

  it("does not change the SQLite schema version on a no-op reopen", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-schema-idempotency-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.close();
    store = new SqliteBindingStore(path);
    const before = store.database.prepare("PRAGMA schema_version").get() as { schema_version: number };
    store.close();
    store = new SqliteBindingStore(path);
    const after = store.database.prepare("PRAGMA schema_version").get() as { schema_version: number };
    expect(after.schema_version).toBe(before.schema_version);
  });

  it("removes obsolete bridge-reported session columns without losing bindings", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-session-column-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.database.exec("ALTER TABLE bindings ADD COLUMN reported_traex_session_id TEXT");
    store.database.exec("ALTER TABLE bindings ADD COLUMN reported_traex_session_at TEXT");
    store.database.prepare("UPDATE bindings SET reported_traex_session_id = ?, reported_traex_session_at = ? WHERE id = ?").run("legacy-session", "2026-08-27T12:00:00.000Z", "b1");
    store.close();

    store = new SqliteBindingStore(path);
    const names = (store.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map(({ name }) => name);
    expect(names).not.toContain("reported_traex_session_id");
    expect(names).not.toContain("reported_traex_session_at");
    expect(store.getBinding("b1")).toMatchObject({ id: "b1", title: "Task" });
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("atomically persists a Main Card view with one versioned delivery intent", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = { ...initialTopicView("b1"), title: "Visible", viewVersion: 1 };

    expect(store.reserveMainCard(view, "root-1", { version: 1 })).toBe("reserved");
    expect(store.reserveMainCard(view, "root-1", { version: 1 })).toBe("waiting");
    expect(store.loadTopicView("b1")).toMatchObject({ title: "Visible", viewVersion: 1, deliveredVersion: 0 });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "card_reply", bindingId: "b1", viewVersion: 1, targetRole: "session_status" })]);
  });

  it("rolls back a Main Card projection when its outbox reservation fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.database.exec("CREATE TEMP TRIGGER reject_main_card BEFORE INSERT ON outbound_replies WHEN NEW.target_role = 'session_status' BEGIN SELECT RAISE(ABORT, 'forced_main_card_failure'); END");

    expect(() => store!.reserveMainCard({ ...initialTopicView("b1"), title: "Never committed", viewVersion: 1 }, "root-1", {})).toThrow("forced_main_card_failure");

    expect(store.loadTopicView("b1")).toBeNull();
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });

  it("does not recreate or wake a dead-lettered Main Card version", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = { ...initialTopicView("b1"), title: "Visible", viewVersion: 1 };
    expect(store.reserveMainCard(view, "root-1", { version: 1 })).toBe("reserved");
    const [reply] = store.listPendingOutboundReplies();
    store.markOutboundReplyDeadLetter(reply!.id, "permanent failure", { failureClass: "permanent" });

    expect(store.reserveMainCard(view, "root-1", { version: 1 })).toBe("waiting");
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.getOutboundReply(reply!.id)).toMatchObject({ state: "dead_letter", attemptCount: 1 });
  });

  it("normalizes legacy Main Card versions and checkpoints delivery monotonically", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const legacy = initialTopicView("b1") as Partial<ReturnType<typeof initialTopicView>>;
    delete legacy.worktreeName; delete legacy.recentProgress; delete legacy.liveStatus; delete legacy.viewVersion; delete legacy.deliveredVersion;
    store.database.prepare("INSERT INTO topic_views(binding_id, state_json, updated_at) VALUES (?, ?, ?)").run("b1", JSON.stringify(legacy), "now");
    const normalized = store.loadTopicView("b1")!;
    expect(normalized).toMatchObject({ worktreeName: null, recentProgress: [], liveStatus: null, viewVersion: 1, deliveredVersion: 0 });
    expect(store.reserveMainCard(normalized, "root-1", { version: 1 })).toBe("reserved");
    const [reply] = store.listPendingOutboundReplies();

    store.markOutboundReplyDelivered(reply!.id, "main-card-1");
    store.markOutboundReplyDelivered(reply!.id, "main-card-1");

    expect(store.getBinding("b1")?.statusMessageId).toBe("main-card-1");
    expect(store.loadTopicView("b1")).toMatchObject({ viewVersion: 1, deliveredVersion: 1 });
  });

  it("marks legacy terminal Answer pages finished before startup convergence", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-answer-finish-migration-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(databasePath);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "First", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    const [create] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(create!.id, "answer-1", "card-1");
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"] });
    store.enqueueOutboundReply({ id: "legacy-finish", idempotencyKey: "legacy-finish", bindingId: "b1", promptId: "p1", viewVersion: 7, cardRole: "answer", rootMessageId: "card-1", kind: "stream_finish", payload: JSON.stringify({ summary: "Completed", sequence: 7 }) });
    store.markOutboundReplyDelivered("legacy-finish", "card-1");
    store.database.prepare("UPDATE answer_pages SET state = 'active' WHERE prompt_id = 'p1' AND page_index = 0").run();
    store.enqueueOutboundReply({ id: "late-content", idempotencyKey: "late-content", bindingId: "b1", promptId: "p1", viewVersion: 8, cardRole: "answer", rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: "done", sequence: 8 }) });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("late-content", "legacy page rejected");
    store.database.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
    store.close();

    store = new SqliteBindingStore(databasePath);

    expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "finished", sequence: 7 })]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'late-content'").get()).toEqual({ state: "dismissed" });
  });

  it("dismisses superseded Answer dead letters when upgrading a database that already applied migration 3", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-answer-dead-letter-migration-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(databasePath);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "First", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'p1' AND page_index = 0").run();
    store.enqueueOutboundReply({ id: "late-content", idempotencyKey: "late-content", bindingId: "b1", promptId: "p1", viewVersion: 8, cardRole: "answer", rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: "done", sequence: 8 }) });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("late-content", "legacy page rejected");
    store.database.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
    store.close();

    store = new SqliteBindingStore(databasePath);

    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'late-content'").get()).toEqual({ state: "dismissed" });
    expect(store.database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 4").get()).toEqual({ applied: 1 });
  });

  it("does not let a late continuation delivery roll the active page backward", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "card-1");
    store.enqueueOutboundReply({ id: "page-2", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "m1", kind: "stream_card_create", payload: JSON.stringify({ card: {}, stream: { pageIndex: 1, pageStart: 20_000, elementId: answerElementId("p1", 1) } }) });
    store.database.exec("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1'; INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 2, 'answer-3', 'card-3', 'answer_content_p1_2', 40000, 0, 'active', 'streaming', 'now', 'now'); UPDATE run_cards SET answer_message_id = 'answer-3', answer_card_id = 'card-3', answer_element_id = 'answer_content_p1_2', answer_page_index = 2, answer_page_start = 40000 WHERE prompt_id = 'p1';");

    store.markOutboundReplyDelivered("page-2", "late-answer-2", "late-card-2");

    expect(store.loadRunCard("p1")).toMatchObject({ answerMessageId: "answer-3", answerCardId: "card-3", answerElementId: answerElementId("p1", 2), answerPageIndex: 2, answerPageStart: 40_000 });
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen", cardId: "card-1" }),
      expect.objectContaining({ pageIndex: 1, state: "frozen", cardId: null }),
      expect.objectContaining({ pageIndex: 2, state: "active", cardId: "card-3" })
    ]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });

  it("backfills original request text when migrating an existing run-card database", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-lark-bridge-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: null, requestText: "legacy **request**", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "legacy **request**" }, view, rootMessageId: "m1", taskCard: {}, answerCard: {} });
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "legacy answer", answerSegments: ["legacy answer"] });
    store.close();
    store = undefined;

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP VIEW run_cards_view;
      ALTER TABLE run_cards DROP COLUMN answer_draft_transient;
      ALTER TABLE run_cards DROP COLUMN answer_draft;
      ALTER TABLE run_cards DROP COLUMN answer_segments_json;
      ALTER TABLE run_cards DROP COLUMN request_text;
      ALTER TABLE run_cards DROP COLUMN conversion_parent_prompt_id;
      ALTER TABLE run_cards DROP COLUMN binding_generation;
    `);
    legacy.close();

    store = new SqliteBindingStore(path);
    expect(store.loadRunCard("p1")).toMatchObject({
      bindingGeneration: 1, conversionParentPromptId: null, requestText: "legacy **request**", answer: "legacy answer", answerSegments: ["legacy answer"], answerDraft: "", answerDraftTransient: false
    });
  });

  it("migrates an outbox whose optional columns were appended in legacy order", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-outbox-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.close();
    store = undefined;
    const database = new DatabaseSync(path);
    database.exec(`
      DROP TABLE outbound_replies;
      CREATE TABLE outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT, root_message_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT,
        next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, prompt_id TEXT, view_version INTEGER, selection_id TEXT, card_role TEXT
      );
      INSERT INTO outbound_replies VALUES ('o1','key',NULL,'root','card_reply','{}','dead_letter',5,'failed',NULL,'now','now','now',NULL,NULL,NULL,NULL);
    `);
    database.close();

    store = new SqliteBindingStore(path);
    expect(store.getOperationalSummary().outbound).toMatchObject({ dead_letter: 1, dismissed: 0 });
    expect(store.database.prepare("SELECT delivery_order, lane_key FROM outbound_replies WHERE id = 'o1'").get()).toEqual({ delivery_order: 1, lane_key: "reply:o1" });
    store.enqueueOutboundReply({ id: "o2", idempotencyKey: "key-2", rootMessageId: "root-2", kind: "card_reply", payload: "{}" });
    expect(store.database.prepare("SELECT delivery_order, lane_key FROM outbound_replies WHERE id = 'o2'").get()).toEqual({ delivery_order: 2, lane_key: "reply:o2" });
  });

  it("adds streaming run-card columns before rebuilding a legacy outbox", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-streaming-migration-order-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.close();
    store = undefined;

    const database = new DatabaseSync(path);
    database.exec(`
      DROP VIEW run_cards_view;
      ALTER TABLE run_cards DROP COLUMN answer_page_start;
      ALTER TABLE run_cards DROP COLUMN answer_page_index;
      ALTER TABLE run_cards DROP COLUMN answer_sequence;
      ALTER TABLE run_cards DROP COLUMN answer_element_id;
      ALTER TABLE run_cards DROP COLUMN answer_card_id;
      CREATE VIEW run_cards_view AS SELECT *, json_object('answerCardId', answer_card_id) AS state_json FROM run_cards;
      DROP TABLE outbound_replies;
      CREATE TABLE outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT, prompt_id TEXT, view_version INTEGER, selection_id TEXT, card_role TEXT,
        root_message_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update')), payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT,
        next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    database.close();

    expect(() => { store = new SqliteBindingStore(path); }).not.toThrow();
    expect(store!.loadRunCard("missing")).toBeNull();
  });

  it("does not duplicate the single answer-card create operation", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "legacy", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "legacy" }, view, rootMessageId: "root-1", taskCard: {}, answerCard: {} });
    store.ensureAnswerCard("p1", "root-1", { card: "answer" });
    store.ensureAnswerCard("p1", "root-1", { card: "duplicate" });

    expect(store.listPendingOutboundReplies()).toMatchObject([{
      promptId: "p1", cardRole: "answer", kind: "stream_card_create", payload: JSON.stringify({})
    }]);
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("p1");
    const answerCreate = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(answerCreate.id, "answer-card", "cardkit-1");
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
  });

  it("selects bounded durable lane heads without letting later rows bypass backoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    for (let index = 0; index < 8; index += 1) {
      store.enqueueOutboundReply({ id: `head-${index}`, idempotencyKey: `head-${index}`, rootMessageId: `card-${index}`, kind: "card_update", payload: "{}" });
    }
    store.enqueueOutboundReply({ id: "same-lane-later", idempotencyKey: "same-lane-later", rootMessageId: "card-0", kind: "card_update", payload: "{}" });
    store.markOutboundReplyFailed("head-0", "temporary", 60_000);

    expect(store.listOutboundLaneHeads(4, new Date().toISOString()).map((reply) => reply.id)).toEqual(["head-1", "head-2", "head-3", "head-4"]);
    expect(store.listOutboundLaneHeads(4, null).map((reply) => reply.id)).toEqual(["head-0", "head-1", "head-2", "head-3"]);
    expect(store.listOutboundLaneHeads(4, null, ["message:card-0"]).map((reply) => reply.id)).toEqual(["head-1", "head-2", "head-3", "head-4"]);
    vi.setSystemTime(new Date("2026-08-24T00:00:10.500Z"));
    expect(store.getOperationalSummary().outboxLanes).toEqual({
      pending: 8, eligible: 7, blocked: 1,
      nextAttemptAt: "2026-08-24T00:01:00.000Z",
      oldestHeadAt: "2026-08-24T00:00:00.000Z", oldestHeadAgeSeconds: 10,
      stalled: 0, oldestStalledAgeSeconds: null
    });
    expect(store.getNextOutboundLaneHeadAttemptAt()).toBe(store.listPendingOutboundReplies()[1]!.nextAttemptAt);
    vi.useRealTimers();
  });

  it("maintains lane heads across coalescing, delivery, retry, dismissal, and dead-letter recovery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "head", idempotencyKey: "head", rootMessageId: "card-1", kind: "card_update", payload: "head" });
    store.enqueueOutboundReply({ id: "later", idempotencyKey: "later", rootMessageId: "card-1", kind: "card_update", payload: "later" });
    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["head"]);

    store.markOutboundReplyFailed("head", "temporary", 60_000);
    expect(store.listOutboundLaneHeads(1, new Date().toISOString())).toEqual([]);
    expect(store.getNextOutboundLaneHeadAttemptAt()).toBe("2026-08-24T00:01:00.000Z");

    store.markOutboundReplyDeadLetter("head", "permanent");
    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["later"]);
    store.markOutboundReplyDeadLetter("later", "temporary", { failureClass: "transient" });
    expect(store.listOutboundLaneHeads(1, null)).toEqual([]);

    vi.setSystemTime(new Date("2026-08-24T00:06:00.000Z"));
    expect(store.recoverEligibleDeadLetters("2026-08-24T00:05:00.000Z", 1).map((reply) => reply.id)).toEqual(["later"]);
    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["later"]);
    vi.useRealTimers();
  });

  it("quarantines a failed Answer sequence without letting later stream work bypass it", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const [create] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(create!.id, "answer-1", "cardkit-1");
    for (const sequence of [1, 2, 3]) store.enqueueOutboundReply({
      id: `content-${sequence}`, idempotencyKey: `content-${sequence}`, bindingId: "b1", promptId: "p1", viewVersion: sequence, cardRole: "answer",
      rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: `snapshot-${sequence}`, sequence })
    });
    store.enqueueOutboundReply({ id: "finish-4", idempotencyKey: "finish-4", bindingId: "b1", promptId: "p1", viewVersion: 4, cardRole: "answer", rootMessageId: "cardkit-1", kind: "stream_finish", payload: JSON.stringify({ pageIndex: 0, summary: "Completed", sequence: 4 }) });
    store.markOutboundReplyDelivered("content-1", "cardkit-1");

    const transition = store.markOutboundReplyFailedWithQuarantine("content-2", "invalid sequence", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "200740" });

    expect(transition).toMatchObject({ state: "dead_letter", action: "blocked", laneClass: "answer_stream", promptId: "p1" });
    expect(store.listOutboundLaneHeads(10, null).filter((reply) => reply.promptId === "p1")).toEqual([]);
    expect(store.listPendingOutboundReplies().filter((reply) => reply.promptId === "p1")).toEqual([]);
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1, released: 0, byLaneClass: { answer_stream: 1 } } });
  });

  it("keeps an exhausted unknown Answer content failure quarantined without automatic recovery", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "cardkit-1");
    store.enqueueOutboundReply({ id: "content", idempotencyKey: "content", bindingId: "b1", promptId: "p1", viewVersion: 1, cardRole: "answer", rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: "snapshot", sequence: 1 }) });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.markOutboundReplyFailedWithQuarantine("content", "unclassified rejection", { failureClass: "unknown", httpStatus: 400, larkErrorCode: null });
    }

    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1, released: 0, byLaneClass: { answer_stream: 1 }, byFailureClass: { unknown: 1 } } });
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, terminalizedQuarantines: 0 });
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });

  it("releases only terminal Answer quarantines whose lanes have no pending work", () => {
    store = new SqliteBindingStore(":memory:");
    for (const promptId of ["terminal", "running", "pending-lane"]) {
      const bindingId = `binding-${promptId}`;
      store.createPendingBinding({ id: bindingId, workspaceId: "w1", chatId: "c1", topicId: `topic-${promptId}`, rootMessageId: `root-${promptId}`, title: "Task" });
      const view = createQueuedRunCard({ promptId, bindingId, title: "Answer", workspaceId: "w1", paneId: `w1:${promptId}`, requestText: "go", queuePosition: 1, occurredAt: "now" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId, larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: "go" }, view, rootMessageId: `root-${promptId}`, answerCard: {} });
      store.markOutboundReplyDelivered(store.listPendingOutboundReplies().find((reply) => reply.promptId === promptId)!.id, `answer-${promptId}`, `card-${promptId}`);
      store.enqueueOutboundReply({
        id: `content-${promptId}`, idempotencyKey: `content-${promptId}`, bindingId, promptId, viewVersion: 1, cardRole: "answer",
        rootMessageId: `card-${promptId}`, kind: "stream_content",
        payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId(promptId, 0), content: "snapshot", sequence: 1 })
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        store.markOutboundReplyFailedWithQuarantine(`content-${promptId}`, "unclassified rejection", { failureClass: "unknown", httpStatus: 400, larkErrorCode: null });
      }
    }
    for (const promptId of ["terminal", "pending-lane"]) {
      store.updatePrompt(promptId, "delivered");
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase: "completed", answer: "done", answerSegments: ["done"] });
    }
    store.updatePrompt("running", "running");
    store.enqueueOutboundReply({
      id: "pending-finish", idempotencyKey: "pending-finish", bindingId: "binding-pending-lane", promptId: "pending-lane", viewVersion: 2, cardRole: "answer",
      rootMessageId: "card-pending-lane", kind: "stream_finish", payload: JSON.stringify({ pageIndex: 0, summary: "done", sequence: 2 })
    });

    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(3);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, terminalizedQuarantines: 1
    });
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = 'content-terminal'").get()).toEqual({
      state: "released", action: "startup_terminalized"
    });
    expect(store.database.prepare("SELECT state, error FROM outbound_replies WHERE id = 'content-terminal'").get()).toEqual({
      state: "dead_letter", error: "unclassified rejection"
    });
    expect(store.database.prepare("SELECT failed_reply_id, state FROM outbox_lane_quarantines WHERE state = 'active' ORDER BY failed_reply_id").all()).toEqual([
      { failed_reply_id: "content-pending-lane", state: "active" },
      { failed_reply_id: "content-running", state: "active" }
    ]);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, terminalizedQuarantines: 0
    });
  });

  it("keeps an immutable failed reply quarantined without blocking independent successors", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "create", idempotencyKey: "create", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "later", idempotencyKey: "later", bindingId: "b1", rootMessageId: "root-1", kind: "text", payload: "later" });

    expect(store.markOutboundReplyFailedWithQuarantine("create", "invalid target", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null })).toMatchObject({ action: "blocked", laneClass: "immutable" });
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["later"]);
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1, released: 0 } });

    expect(store.retryDeadLetter("create", "c1", "u1")).toBe("retried");
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["create", "later"]);
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 0, released: 1, latest: { action: "manual_retry" } } });
  });

  it("isolates independent replies to the same root message", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "first", idempotencyKey: "first", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "second", idempotencyKey: "second", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });

    expect(store.markOutboundReplyFailedWithQuarantine("first", "invalid card", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "230099" }))
      .toMatchObject({ action: "blocked", laneClass: "immutable" });
    expect(store.database.prepare("SELECT id, lane_key FROM outbound_replies ORDER BY delivery_order").all()).toEqual([
      { id: "first", lane_key: "reply:first" },
      { id: "second", lane_key: "reply:second" }
    ]);
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["second"]);
  });

  it("migrates legacy shared reply lanes without losing quarantine audit history", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-independent-reply-lanes-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.enqueueOutboundReply({ id: "failed", idempotencyKey: "failed", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "later", idempotencyKey: "later", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.database.exec(`
      DELETE FROM schema_migrations WHERE version = 7;
      UPDATE outbound_replies SET lane_key = 'message:root-1' WHERE id IN ('failed', 'later');
    `);
    store.markOutboundReplyFailedWithQuarantine("failed", "invalid card", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "230099" });
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT id, lane_key, state FROM outbound_replies WHERE id IN ('failed', 'later') ORDER BY delivery_order").all()).toEqual([
      { id: "failed", lane_key: "reply:failed", state: "dead_letter" },
      { id: "later", lane_key: "reply:later", state: "pending" }
    ]);
    expect(store.database.prepare("SELECT lane_key, failed_reply_id, state FROM outbox_lane_quarantines WHERE failed_reply_id = 'failed'").get()).toEqual({
      lane_key: "reply:failed", failed_reply_id: "failed", state: "active"
    });
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toContain("later");
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 7").get()).toEqual({ version: 7 });
  });

  it.each([
    { id: "answer-create", cardRole: "answer" as const, targetRole: null, kind: "stream_card_create" as const },
    { id: "main-create", cardRole: null, targetRole: "session_status" as const, kind: "card_reply" as const }
  ])("keeps $id classified as immutable card creation", ({ id, cardRole, targetRole, kind }) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    let replyId = id;
    if (cardRole) {
      const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
      store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
      replyId = store.listPendingOutboundReplies()[0]!.id;
    } else {
      store.enqueueOutboundReply({ id, idempotencyKey: id, bindingId: "b1", promptId: null, viewVersion: 1, cardRole, targetRole, rootMessageId: "root-1", kind, payload: "{}" });
    }

    expect(store.markOutboundReplyFailedWithQuarantine(replyId, "invalid target", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null })).toMatchObject({
      action: "blocked", laneClass: "immutable"
    });
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1, byLaneClass: { immutable: 1 } } });
  });

  it("keeps a repeated failure callback idempotent after quarantine", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "create", idempotencyKey: "create", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    const metadata = { failureClass: "permanent" as const, httpStatus: 400, larkErrorCode: null };

    expect(store.markOutboundReplyFailedWithQuarantine("create", "invalid target", metadata)).toMatchObject({ action: "blocked", reply: { attemptCount: 1 } });
    expect(store.markOutboundReplyFailedWithQuarantine("create", "duplicate callback", metadata)).toMatchObject({ action: "blocked", reply: { attemptCount: 1 } });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbox_lane_quarantines").get()).toEqual({ count: 1 });
  });

  it("releases only a strictly newer Main Card snapshot after a permanent failure", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const first = { ...initialTopicView("b1"), title: "First", viewVersion: 1 };
    expect(store.reserveMainCard(first, "root-1", { version: 1 })).toBe("reserved");
    const [create] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(create!.id, "main-card-1");
    const second = { ...first, title: "Second", viewVersion: 2 };
    expect(store.reserveMainCard(second, "root-1", { version: 2 })).toBe("reserved");
    const [failed] = store.listPendingOutboundReplies();

    expect(store.markOutboundReplyFailedWithQuarantine(failed!.id, "invalid card", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "bad_card" })).toMatchObject({
      action: "released_newer_snapshot", laneClass: "main_card"
    });
    expect(store.reserveMainCard(second, "root-1", { version: 2 })).toBe("waiting");
    expect(store.listOutboundLaneHeads(10, null)).toEqual([]);

    const third = { ...second, title: "Third", viewVersion: 3 };
    expect(store.reserveMainCard(third, "root-1", { version: 3 })).toBe("reserved");
    expect(store.listOutboundLaneHeads(10, null)).toEqual([expect.objectContaining({ targetRole: "session_status", viewVersion: 3 })]);
  });

  it("rolls a locked Main Card over to the newest snapshot without clearing its current pointer early", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "locked-main" });
    const second = { ...initialTopicView("b1"), title: "Second", viewVersion: 2, deliveredVersion: 1 };
    expect(store.reserveMainCard(second, "root-1", { version: 2 })).toBe("reserved");
    const [failed] = store.listPendingOutboundReplies();
    const third = { ...second, title: "Third", viewVersion: 3 };
    expect(store.reserveMainCard(third, "root-1", { version: 3 })).toBe("reserved");

    expect(store.markOutboundReplyFailedWithQuarantine(failed!.id, "card action is lock", { failureClass: "unknown", httpStatus: 400, larkErrorCode: "230099" })).toMatchObject({
      action: "rebuild_main", laneClass: "main_card", reply: { attemptCount: 1, state: "dead_letter" }
    });
    expect(store.getBinding("b1")?.statusMessageId).toBe("locked-main");
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      kind: "card_reply", targetRole: "session_status", rootMessageId: "root-1", viewVersion: 3, payload: JSON.stringify({ version: 3 })
    })]);
    expect(store.reserveMainCard({ ...third, title: "Fourth", viewVersion: 4 }, "root-1", { version: 4 })).toBe("waiting");
  });

  it("releases only the newest coalesced replaceable-card successor", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "head", idempotencyKey: "head", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "head" });
    store.enqueueOutboundReply({ id: "middle", idempotencyKey: "middle", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "middle" });
    store.enqueueOutboundReply({ id: "latest", idempotencyKey: "latest", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "latest" });

    expect(store.listPendingOutboundReplies().map((reply) => reply.id)).toEqual(["head", "latest"]);
    expect(store.markOutboundReplyFailedWithQuarantine("head", "invalid card", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null })).toMatchObject({
      action: "released_newer_snapshot", laneClass: "replaceable_card"
    });
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["latest"]);
  });

  it("allows one cooled transient recovery but never bypasses the resulting immutable quarantine", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "create", idempotencyKey: "create", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.markOutboundReplyFailedWithQuarantine("create", "unavailable", { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
    }

    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 0 } });
    expect(store.recoverEligibleDeadLetters("2099-01-01T00:00:00.000Z", 10)).toMatchObject([{ id: "create", state: "pending", autoRecoveryCount: 1 }]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.markOutboundReplyFailedWithQuarantine("create", "still unavailable", { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
    }
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1 } });
    expect(store.recoverEligibleDeadLetters("2099-01-01T00:00:00.000Z", 10)).toEqual([]);
    expect(store.listOutboundLaneHeads(10, null)).toEqual([]);
    vi.useRealTimers();
  });

  it("reopens a quarantined Answer card creation once more while preserving its failure history", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const initialCreate = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(initialCreate.id, "answer-1", "card-1");
    expect(store.reserveAnswerContinuation({
      promptId: "p1", pageIndex: 0, cardId: "card-1", summary: "continued", nextPageIndex: 1, nextPageStart: 1,
      nextElementId: answerElementId("p1", 1), rootMessageId: "root-1", viewVersion: 2,
      card: { body: { elements: [{ tag: "markdown", element_id: answerElementId("p1", 1), content: "x".repeat(10_000) }] } }
    })).toBe("reserved");
    const create = store.listPendingOutboundReplies().find((reply) => reply.kind === "stream_card_create")!;
    store.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = ?").run(create.id);
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailedWithQuarantine(create.id, "timeout", { failureClass: "transient", httpStatus: 504, larkErrorCode: "2200" });

    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(1);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: ["p1"], rolledBackAnswerPromptIds: [], dismissedNotices: 0, terminalizedQuarantines: 0 });
    expect(store.database.prepare("SELECT state, attempt_count, auto_recovery_count FROM outbound_replies WHERE id = ?").get(create.id)).toEqual({ state: "dead_letter", attempt_count: 5, auto_recovery_count: 1 });
    const replacement = store.listPendingOutboundReplies().find((reply) => reply.kind === "stream_card_create")!;
    expect(replacement.idempotencyKey).toBe(`startup-lite:${create.id}`);
    expect(replacement.autoRecoveryCount).toBe(2);
    expect(replacement.payload.length).toBeLessThan(create.payload.length);
    expect(replacement.payload).toContain("正在恢复本页内容");
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = ?").get(create.id)).toEqual({ state: "released", action: "startup_rebuild" });
    expect(store.getOperationalSummary().deadLetters).toBe(1);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, terminalizedQuarantines: 0 });
  });

  it("rolls back an invalid recovery page reserved across dead-lettered canonical content", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-0", "card-0");
    const canonicalAnswer = "x".repeat(130_000);
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: canonicalAnswer, answerSegments: [canonicalAnswer], viewVersion: 20 });
    store.database.prepare("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1'").run();
    store.database.prepare("INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 13, 'answer-13', 'card-13', ?, 109267, 1, 'frozen', 'streaming', 'now', 'now')").run(answerElementId("p1", 13));
    store.database.prepare("INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 14, NULL, NULL, ?, 109267, 0, 'creating', 'streaming', 'now', 'now')").run(answerElementId("p1", 14));
    store.database.prepare("UPDATE run_cards SET answer_message_id = 'answer-13', answer_card_id = 'card-13', answer_element_id = ?, answer_page_index = 13, answer_page_start = 109267 WHERE prompt_id = 'p1'").run(answerElementId("p1", 13));
    store.enqueueOutboundReply({ id: "content-13", idempotencyKey: "stream:p1:card-13:1", bindingId: "b1", promptId: "p1", viewVersion: 1, cardRole: "answer", rootMessageId: "card-13", kind: "stream_content", payload: JSON.stringify({ pageIndex: 13, elementId: answerElementId("p1", 13), content: "canonical", sequence: 1 }) });
    store.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = 'content-13'").run();
    store.markOutboundReplyDeadLetter("content-13", "timeout", { failureClass: "transient", httpStatus: 504, larkErrorCode: "2200" });
    store.enqueueOutboundReply({ id: "rebuild-14", idempotencyKey: "stream-rebuild:p1:14", bindingId: "b1", promptId: "p1", viewVersion: 20, cardRole: "answer", rootMessageId: "root-1", kind: "stream_card_create", payload: JSON.stringify({ card: {}, stream: { pageIndex: 14, pageStart: 109267, elementId: answerElementId("p1", 14) } }) });
    store.markOutboundReplyFailedWithQuarantine("rebuild-14", "Answer continuation target mismatch for prompt p1", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null });

    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: ["p1"], rolledBackAnswerPromptIds: ["p1"], dismissedNotices: 0, terminalizedQuarantines: 0 });
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen" }),
      expect.objectContaining({ pageIndex: 13, sourceStart: 109267, state: "active", messageId: "answer-13", cardId: "card-13" })
    ]);
    expect(store.database.prepare("SELECT state, error FROM outbound_replies WHERE id = 'content-13'").get()).toEqual({ state: "dead_letter", error: "timeout" });
    expect(store.database.prepare("SELECT state, error FROM outbound_replies WHERE id = 'rebuild-14'").get()).toEqual({ state: "dismissed", error: "Answer continuation target mismatch for prompt p1" });
    const replacement = store.listPendingOutboundReplies().find((reply) => reply.idempotencyKey === "startup-lite-content:content-13");
    expect(replacement).toMatchObject({ kind: "stream_content", rootMessageId: "card-13", autoRecoveryCount: 2 });
    expect(JSON.parse(replacement!.payload)).toMatchObject({ pageIndex: 13, elementId: answerElementId("p1", 13), sequence: 2, sourceEnd: expect.any(Number) });
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = 'rebuild-14'").get()).toEqual({ state: "released", action: "startup_rollback" });
    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(0);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, terminalizedQuarantines: 0 });
  });

  it("replaces an exhausted active-page content update with one bounded canonical chunk", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-0", "card-0");
    const canonicalAnswer = "x".repeat(12_000);
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: canonicalAnswer, answerSegments: [canonicalAnswer], viewVersion: 3 });
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-0", elementId: answerElementId("p1", 0), content: canonicalAnswer })).toBe("reserved");
    const failed = store.listPendingOutboundReplies()[0]!;
    store.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = ?").run(failed.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.markOutboundReplyFailedWithQuarantine(failed.id, "timeout", { failureClass: "transient", httpStatus: 504, larkErrorCode: "2200" });
    }

    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: ["p1"], rolledBackAnswerPromptIds: [], dismissedNotices: 0, terminalizedQuarantines: 0 });
    const replacement = store.listPendingOutboundReplies()[0]!;
    const payload = JSON.parse(replacement.payload) as { content: string; sourceEnd: number; sequence: number };
    expect(replacement).toMatchObject({ idempotencyKey: `startup-lite-content:${failed.id}`, kind: "stream_content", autoRecoveryCount: 2 });
    expect(payload.content.length).toBeLessThanOrEqual(4_000);
    expect(payload.sourceEnd).toBeGreaterThan(0);
    expect(payload.sourceEnd).toBeLessThan(canonicalAnswer.length);
    expect(payload.sequence).toBe(2);
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = ?").get(failed.id)).toEqual({ state: "released", action: "startup_rebuild" });
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, terminalizedQuarantines: 0 });
  });

  it("dismisses stale disconnected-topic notices but preserves unrelated immutable quarantines", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "notice", idempotencyKey: "disconnected-topic:message-1", rootMessageId: "message-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "other", idempotencyKey: "important:message-2", rootMessageId: "message-2", kind: "card_reply", payload: "{}" });
    for (const id of ["notice", "other"]) {
      store.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = ?").run(id);
      for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailedWithQuarantine(id, "unavailable", { failureClass: "transient", httpStatus: 500, larkErrorCode: "2200" });
    }

    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 1, terminalizedQuarantines: 0 });
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'notice'").get()).toEqual({ state: "dismissed" });
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'other'").get()).toEqual({ state: "dead_letter" });
    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(1);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, terminalizedQuarantines: 0 });
  });

  it("atomically releases an immutable quarantine when the failed head is dismissed", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "create", idempotencyKey: "create", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "later", idempotencyKey: "later", bindingId: "b1", rootMessageId: "root-1", kind: "text", payload: "later" });
    store.markOutboundReplyFailedWithQuarantine("create", "invalid target", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null });

    expect(store.dismissDeadLetter("create", "c1", "u1")).toBe("dismissed");
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["later"]);
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 0, released: 1, latest: { action: "manual_dismiss" } } });
    expect(store.dismissDeadLetter("create", "c1", "u1")).toBe("stale");
  });

  it("preserves one isolated immutable quarantine across reopen", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-outbox-quarantine-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "create", idempotencyKey: "create", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "later", idempotencyKey: "later", bindingId: "b1", rootMessageId: "root-1", kind: "text", payload: "later" });
    store.markOutboundReplyFailedWithQuarantine("create", "invalid target", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null });
    store.close();

    store = new SqliteBindingStore(path);
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 5").all()).toEqual([{ version: 5 }]);
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1, released: 0 } });
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["later"]);
  });

  it("coalesces pending binding status-card snapshots behind the in-flight-safe lane head", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });

    store.enqueueOutboundReply({ id: "working", idempotencyKey: "status:working", bindingId: "b1", rootMessageId: "status-card", kind: "card_update", payload: "working" });
    store.enqueueOutboundReply({ id: "progress", idempotencyKey: "status:progress", bindingId: "b1", rootMessageId: "status-card", kind: "card_update", payload: "progress" });
    store.enqueueOutboundReply({ id: "done", idempotencyKey: "status:done", bindingId: "b1", rootMessageId: "status-card", kind: "card_update", payload: "done" });

    expect(store.listPendingOutboundReplies().map((reply) => ({ id: reply.id, payload: reply.payload }))).toEqual([
      { id: "working", payload: "working" },
      { id: "done", payload: "done" }
    ]);
    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["working"]);

    store.markOutboundReplyDelivered("working", "status-card");
    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["done"]);
  });

  it("keeps status-card coalescing isolated by binding, target, and lane", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "One" });
    store.createPendingBinding({ id: "b2", workspaceId: "w2", chatId: "c1", topicId: "t2", rootMessageId: "root-2", title: "Two" });
    store.enqueueOutboundReply({ id: "b1-head", idempotencyKey: "b1-head", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "head" });
    store.enqueueOutboundReply({ id: "b1-next", idempotencyKey: "b1-next", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "next" });
    store.enqueueOutboundReply({ id: "b2-head", idempotencyKey: "b2-head", bindingId: "b2", rootMessageId: "card-1", kind: "card_update", payload: "other binding" });
    store.enqueueOutboundReply({ id: "other-card", idempotencyKey: "other-card", bindingId: "b1", rootMessageId: "card-2", kind: "card_update", payload: "other card" });
    store.enqueueOutboundReply({ id: "b1-latest", idempotencyKey: "b1-latest", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "latest" });

    expect(store.listPendingOutboundReplies().map((reply) => reply.id)).toEqual(["b1-head", "b2-head", "other-card", "b1-latest"]);
  });

  it("preserves every pending Answer stream sequence", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const [answerCreate] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(answerCreate!.id, "answer-1", "cardkit-1");

    for (const sequence of [1, 2, 3]) {
      store.enqueueOutboundReply({
        id: `content-${sequence}`, idempotencyKey: `stream:p1:cardkit-1:${sequence}`, bindingId: "b1", promptId: "p1", viewVersion: sequence, cardRole: "answer",
        rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ elementId: answerElementId("p1", 0), content: `snapshot-${sequence}`, sequence })
      });
    }

    expect(store.listPendingOutboundReplies().map((reply) => ({ id: reply.id, sequence: reply.viewVersion }))).toEqual([
      { id: "content-1", sequence: 1 }, { id: "content-2", sequence: 2 }, { id: "content-3", sequence: 3 }
    ]);
  });

  it("rolls back status-card pruning when insertion fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "head", idempotencyKey: "head", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "head" });
    store.enqueueOutboundReply({ id: "successor", idempotencyKey: "successor", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "successor" });

    expect(() => store!.enqueueOutboundReply({ id: "head", idempotencyKey: "replacement", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "fails" })).toThrow();
    expect(store.listPendingOutboundReplies().map((reply) => reply.id)).toEqual(["head", "successor"]);
  });

  it("reports an empty durable outbox lane summary without identifiers", () => {
    store = new SqliteBindingStore(":memory:");

    expect(store.getOperationalSummary().outboxLanes).toEqual({
      pending: 0, eligible: 0, blocked: 0, nextAttemptAt: null,
      oldestHeadAt: null, oldestHeadAgeSeconds: null, stalled: 0, oldestStalledAgeSeconds: null
    });
  });

  it("preserves Answer lane insertion order across reopen and VACUUM", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-outbox-order-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: null, requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "card-1");
    store.enqueueOutboundReply({ id: "first", idempotencyKey: "first", bindingId: "b1", promptId: "p1", cardRole: "answer", rootMessageId: "root", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "second", idempotencyKey: "second", bindingId: "b1", promptId: "p1", cardRole: "answer", rootMessageId: "root", kind: "card_update", payload: "{}" });
    store.close();

    store = new SqliteBindingStore(path);
    store.database.exec("VACUUM");

    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["first"]);
  });

  it("jitters exponential retries and honors an explicit retry delay", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "jitter", idempotencyKey: "jitter", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "rate-limit", idempotencyKey: "rate-limit", rootMessageId: "card-2", kind: "card_update", payload: "{}" });

    expect(store.markOutboundReplyFailed("jitter", "temporary")?.nextAttemptAt).toBe("2026-08-24T00:00:00.800Z");
    expect(store.markOutboundReplyFailed("rate-limit", "limited", 7_000)?.nextAttemptAt).toBe("2026-08-24T00:00:07.000Z");

    random.mockRestore();
    vi.useRealTimers();
  });

  it("persists classified failures and reopens one cooled transient round only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "transient", idempotencyKey: "transient", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("transient", "upstream unavailable", undefined, { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
    expect(store.database.prepare("SELECT state, failure_class, http_status, auto_recovery_count, dead_lettered_at FROM outbound_replies WHERE id = 'transient'").get()).toEqual({
      state: "dead_letter", failure_class: "transient", http_status: 503, auto_recovery_count: 0, dead_lettered_at: "2026-08-25T00:00:00.000Z"
    });
    expect(store.recoverEligibleDeadLetters("2026-08-24T23:59:59.999Z", 10)).toEqual([]);
    expect(store.recoverEligibleDeadLetters("2026-08-25T00:00:00.000Z", 10)).toMatchObject([{ id: "transient", state: "pending", attemptCount: 0, autoRecoveryCount: 1 }]);
    expect(store.recoverEligibleDeadLetters("2026-08-25T00:00:00.000Z", 10)).toEqual([]);
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("transient", "still unavailable", undefined, { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
    expect(store.recoverEligibleDeadLetters("2099-01-01T00:00:00.000Z", 10)).toEqual([]);
    expect(store!.getOperationalSummary()).toMatchObject({ deadLettersByClass: { transient: 1, permanent: 0, unknown: 0, legacy: 0 }, eligibleDeadLetterRecoveries: 0 });
    vi.useRealTimers();
  });

  it("never automatically reopens legacy or unknown dead letters", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "legacy", idempotencyKey: "legacy", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "unknown", idempotencyKey: "unknown", rootMessageId: "card-2", kind: "card_update", payload: "{}" });
    store.database.exec("UPDATE outbound_replies SET state = 'dead_letter', attempt_count = 5, dead_lettered_at = '2020-01-01T00:00:00.000Z' WHERE id = 'legacy'");
    store.markOutboundReplyDeadLetter("unknown", "generic 400", { failureClass: "unknown", httpStatus: 400, larkErrorCode: null });
    store.database.exec("UPDATE outbound_replies SET dead_lettered_at = '2020-01-01T00:00:00.000Z' WHERE id = 'unknown'");

    expect(store.recoverEligibleDeadLetters("2099-01-01T00:00:00.000Z", 10)).toEqual([]);
    expect(store.getOperationalSummary()).toMatchObject({ deadLettersByClass: { transient: 0, permanent: 0, unknown: 1, legacy: 1 } });
  });

  it("prunes only old delivered or dismissed outbox history in a bounded batch", () => {
    store = new SqliteBindingStore(":memory:");
    for (const id of ["delivered-old", "dismissed-old", "pending-old", "dead-old", "delivered-new"]) {
      store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    }
    store.database.exec(`
      UPDATE outbound_replies SET state = 'delivered', updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'delivered-old';
      UPDATE outbound_replies SET state = 'dismissed', updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'dismissed-old';
      UPDATE outbound_replies SET state = 'pending', updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'pending-old';
      UPDATE outbound_replies SET state = 'dead_letter', updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'dead-old';
      UPDATE outbound_replies SET state = 'delivered', updated_at = '2026-08-25T00:00:00.000Z' WHERE id = 'delivered-new';
    `);

    expect(store.pruneDeliveredOutboundReplies('2026-08-12T00:00:00.000Z', 1)).toBe(1);
    expect(store.pruneDeliveredOutboundReplies('2026-08-12T00:00:00.000Z', 10)).toBe(1);
    expect(store.database.prepare("SELECT id, state FROM outbound_replies ORDER BY id").all()).toEqual([
      { id: 'dead-old', state: 'dead_letter' },
      { id: 'delivered-new', state: 'delivered' },
      { id: 'pending-old', state: 'pending' }
    ]);
  });

  it("prunes only old accepted inbound history in a bounded batch", () => {
    store = new SqliteBindingStore(":memory:");
    for (const id of ["accepted-old-1", "accepted-old-2", "accepted-new", "received-old", "processing-old"]) {
      store.recordInboundMessage({ eventId: id, messageId: `message-${id}`, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "user", text: "private", mentionsBot: false, isRootMessage: false });
    }
    store.database.exec(`
      UPDATE inbound_messages SET state = 'accepted', updated_at = '2026-08-01T00:00:00.000Z' WHERE event_id IN ('accepted-old-1', 'accepted-old-2');
      UPDATE inbound_messages SET state = 'accepted', updated_at = '2026-08-25T00:00:00.000Z' WHERE event_id = 'accepted-new';
      UPDATE inbound_messages SET state = 'received', updated_at = '2026-08-01T00:00:00.000Z' WHERE event_id = 'received-old';
      UPDATE inbound_messages SET state = 'processing', updated_at = '2026-08-01T00:00:00.000Z' WHERE event_id = 'processing-old';
    `);

    expect(store.pruneAcceptedInboundMessages("2026-08-12T00:00:00.000Z", 1)).toBe(1);
    expect(store.pruneAcceptedInboundMessages("2026-08-12T00:00:00.000Z", 10)).toBe(1);
    expect(store.database.prepare("SELECT event_id, state FROM inbound_messages ORDER BY event_id").all()).toEqual([
      { event_id: "accepted-new", state: "accepted" },
      { event_id: "processing-old", state: "processing" },
      { event_id: "received-old", state: "received" }
    ]);
  });

  it("does not reset the automatic recovery budget during a manual retry", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "manual", idempotencyKey: "manual", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    store.markOutboundReplyDeadLetter("manual", "unavailable", { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
    store.database.exec("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = 'manual'");

    expect(store.retryDeadLetter("manual", "c1", "u1")).toBe("retried");
    expect(store.database.prepare("SELECT state, attempt_count, auto_recovery_count FROM outbound_replies WHERE id = 'manual'").get()).toEqual({ state: "pending", attempt_count: 0, auto_recovery_count: 1 });
  });

  it("atomically claims a prompt only while its binding is dispatchable", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "unknown"
    });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const answerCreate = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(answerCreate.id, "answer-card", "cardkit-1");

    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.listQueuedTurnPromptIds("b1")).toEqual(["p1"]);

    store.updateBinding("b1", { lastAgentState: "idle" });
    expect(store.claimNextDispatchablePrompt("b1")).toMatchObject({
      prompt: { id: "p1", state: "running", attemptCount: 1 },
      binding: { id: "b1", paneId: "w1:p1", lastAgentState: "idle" }
    });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
  });

  it("atomically cancels terminal backlog and returns identity-only durable work hints", () => {
    store = new SqliteBindingStore(":memory:");
    for (const [bindingId, state, lifecycle, attachment] of [
      ["archived", "archived", "archived", "attached"],
      ["orphaned", "orphaned", "active", "orphaned"],
      ["pending", "pending", "provisioning", "unattached"]
    ] as const) {
      store.createPendingBinding({ id: bindingId, workspaceId: "w1", chatId: "c1", topicId: bindingId, rootMessageId: bindingId, title: bindingId });
      store.updateBinding(bindingId, { paneId: `w1:${bindingId}`, state, lifecycle, attachment });
      store.enqueuePrompt({ id: `prompt-${bindingId}`, bindingId, larkMessageId: `message-${bindingId}`, actorOpenId: "u1", body: "must not run" });
    }

    store.createPendingBinding({ id: "active", workspaceId: "w1", chatId: "c1", topicId: "active", rootMessageId: "active", title: "active" });
    store.updateBinding("active", { paneId: "w1:active", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.enqueuePrompt({ id: "private-turn", bindingId: "active", larkMessageId: "private-message", actorOpenId: "u1", body: "private prompt body" });

    expect(store.scanDurablePromptWork()).toEqual({
      cancelled: 2,
      failedDetached: 0,
      hints: [{ kind: "prompt-ready", bindingId: "active" }]
    });
    expect(store.getOperationalSummary().prompts).toMatchObject({ queued: 2, cancelled: 2 });
    expect(store.claimNextDispatchablePrompt("active")).toMatchObject({ prompt: { id: "private-turn", state: "running" } });
    expect(store.listFailures("c1").filter((failure) => failure.kind === "prompt").map((failure) => failure.error)).toEqual([
      "Session can no longer dispatch queued work",
      "Session can no longer dispatch queued work"
    ]);
    expect(JSON.stringify(store.scanDurablePromptWork())).not.toMatch(/private-turn|private-message|private prompt body/);
  });

  it("terminalizes detached running turns owned by terminal bindings", () => {
    store = new SqliteBindingStore(":memory:");
    const terminalCases = [
      ["state-archived", "archived", "active", "attached"],
      ["state-orphaned", "orphaned", "active", "attached"],
      ["state-failed", "failed", "active", "attached"],
      ["lifecycle-archived", "active", "archived", "attached"],
      ["lifecycle-closed", "active", "closed", "attached"],
      ["lifecycle-failed", "active", "failed", "attached"],
      ["attachment-orphaned", "active", "active", "orphaned"]
    ] as const;
    const cases = [...terminalCases, ["active", "active", "active", "attached"] as const];
    for (const [bindingId, state, lifecycle, attachment] of cases) {
      store.createPendingBinding({ id: bindingId, workspaceId: "w1", chatId: "c1", topicId: bindingId, rootMessageId: bindingId, title: bindingId });
      store.updateBinding(bindingId, { paneId: `w1:${bindingId}`, state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
      store.database.prepare("UPDATE bindings SET state = ?, lifecycle = ?, attachment = ? WHERE id = ?").run(state, lifecycle, attachment, bindingId);
      const promptId = `prompt-${bindingId}`;
      const view = createQueuedRunCard({
        promptId, bindingId, title: bindingId, workspaceId: "w1", paneId: `w1:${bindingId}`,
        requestText: `private-${bindingId}`, queuePosition: 1, occurredAt: "2026-08-29T01:00:00.000Z"
      });
      store.acceptPrompt({
        prompt: { id: promptId, bindingId, larkMessageId: `message-${bindingId}`, actorOpenId: "u1", body: `private-${bindingId}` },
        view, rootMessageId: bindingId, answerCard: {}
      });
      store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached', was_detached = ? WHERE id = ?").run(bindingId === "state-archived" ? 0 : 1, promptId);
      store.database.prepare("UPDATE run_cards SET phase = 'running', started_at = '2026-08-29T01:00:01.000Z' WHERE prompt_id = ?").run(promptId);
    }

    const result = store.scanDurablePromptWork();
    expect(result).toEqual({
      cancelled: 0, failedDetached: 7,
      hints: [{ kind: "detached-observer-ready", bindingId: "active", promptId: "prompt-active" }]
    });
    const notice = "Session ended while a dispatched turn was detached; the prompt was not replayed";
    for (const [bindingId] of terminalCases) {
      expect(store.getPrompt(`prompt-${bindingId}`)).toMatchObject({
        state: "failed", observationState: "completed", wasDetached: true, error: notice
      });
      expect(store.loadRunCard(`prompt-${bindingId}`)).toMatchObject({
        phase: "failed", notice, queuePosition: 0, viewVersion: 2
      });
      expect(store.loadRunCard(`prompt-${bindingId}`)?.finishedAt).toEqual(expect.any(String));
      expect(store.loadRunCard(`prompt-${bindingId}`)?.activityAt).toEqual(expect.any(String));
    }
    expect(store.getPrompt("prompt-active")).toMatchObject({
      state: "running", observationState: "detached", wasDetached: true
    });
    expect(store.loadRunCard("prompt-active")).toMatchObject({ phase: "running", viewVersion: 1 });

    const versions = terminalCases.map(([bindingId]) => store.loadRunCard(`prompt-${bindingId}`)?.viewVersion);
    expect(store.scanDurablePromptWork()).toEqual({
      cancelled: 0, failedDetached: 0,
      hints: [{ kind: "detached-observer-ready", bindingId: "active", promptId: "prompt-active" }]
    });
    expect(terminalCases.map(([bindingId]) => store.loadRunCard(`prompt-${bindingId}`)?.viewVersion)).toEqual(versions);
    expect(JSON.stringify(result)).not.toMatch(/private-|message-/);
  });

  it("rolls back detached Run Card convergence when the prompt transition fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "archived", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("archived", { paneId: "w1:p1", state: "archived", lifecycle: "archived", attachment: "attached" });
    const view = createQueuedRunCard({
      promptId: "prompt-archived", bindingId: "archived", title: "Task", workspaceId: "w1", paneId: "w1:p1",
      requestText: "private body", queuePosition: 1, occurredAt: "2026-08-29T01:00:00.000Z"
    });
    store.acceptPrompt({
      prompt: { id: "prompt-archived", bindingId: "archived", larkMessageId: "message-1", actorOpenId: "u1", body: "private body" },
      view, rootMessageId: "m1", answerCard: {}
    });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached', was_detached = 1 WHERE id = 'prompt-archived'").run();
    store.database.prepare("UPDATE run_cards SET phase = 'running', started_at = '2026-08-29T01:00:01.000Z' WHERE prompt_id = 'prompt-archived'").run();
    store.database.exec("CREATE TEMP TRIGGER reject_detached_prompt_failure BEFORE UPDATE OF state ON prompt_jobs WHEN OLD.id = 'prompt-archived' AND NEW.state = 'failed' BEGIN SELECT RAISE(ABORT, 'injected detached convergence failure'); END");

    expect(() => store.scanDurablePromptWork()).toThrow(/injected detached convergence failure/);
    expect(store.getPrompt("prompt-archived")).toMatchObject({ state: "running", observationState: "detached", wasDetached: true });
    expect(store.loadRunCard("prompt-archived")).toMatchObject({ phase: "running", notice: null, finishedAt: null, viewVersion: 1 });
  });

  it("discovers steering and detached observer work without claiming or replaying it", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
    for (const [id, kind, parent] of [["parent", "turn", null], ["steer", "steering", "parent"]] as const) {
      store.enqueuePrompt({ id, bindingId: "b1", larkMessageId: `message-${id}`, actorOpenId: "u1", body: `body-${id}`, dispatchKind: kind, parentPromptId: parent });
    }
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached' WHERE id = 'parent'").run();

    expect(store.scanDurablePromptWork()).toEqual({ cancelled: 0, failedDetached: 0, hints: [
      { kind: "detached-observer-ready", bindingId: "b1", promptId: "parent" },
      { kind: "steering-ready", bindingId: "b1", parentPromptId: "parent" }
    ] });
    expect(store.getPrompt("parent")).toMatchObject({ state: "running", observationState: "detached", attemptCount: 0 });
    expect(store.getPrompt("steer")).toMatchObject({ state: "queued", attemptCount: 0 });
  });

  it("does not report an ordinary queued turn while its binding already has a running prompt", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
    store.enqueuePrompt({ id: "running", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "running" });
    store.enqueuePrompt({ id: "later", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "later" });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'attached' WHERE id = 'running'").run();

    expect(store.scanDurablePromptWork()).toEqual({ cancelled: 0, failedDetached: 0, hints: [] });
  });

  it("claims steering in order and fails leftovers instead of converting them to turns", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const makeView = (promptId: string) => createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 0, occurredAt: new Date().toISOString() });
    for (const [id, messageId, steeringOrigin] of [["s1", "m2", "explicit"], ["s2", "m3", "automatic"], ["s3", "m4", "explicit"], ["s4", "m5", "converted"]] as const) {
      store.acceptPrompt({
        prompt: { id, bindingId: "b1", larkMessageId: messageId, actorOpenId: "u1", body: id, dispatchKind: "steering", parentPromptId: "parent", steeringOrigin },
        view: makeView(id), rootMessageId: "m1", taskCard: {}, answerCard: {}
      });
    }
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, `card-${reply.promptId}`, `cardkit-${reply.promptId}`);

    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.listQueuedTurnPromptIds("b1")).toEqual([]);
    expect(store.claimNextReadySteering("b1", "parent")?.id).toBe("s1");
    store.markPromptDispatched("s1");
    store.updatePrompt("s1", "delivered");
    expect(store.claimNextReadySteering("b1", "parent")?.id).toBe("s2");

    // A queued steering job whose parent ended is failed, never promoted to a turn.
    store.updatePrompt("s2", "queued");
    expect(store.failQueuedSteering("b1", "parent", "父任务已结束，本次 `/swarm steer` 未注入，也不会转为普通任务。")).toEqual(["s2", "s3", "s4"]);
    expect(store.loadRunCard("s2")).toMatchObject({ phase: "failed", notice: "当前任务已结束，未自动注入", steeringFailureKind: "rejected" });
    expect(store.loadRunCard("s3")).toMatchObject({ phase: "failed", notice: "父任务已结束，本次 `/swarm steer` 未注入，也不会转为普通任务。", steeringFailureKind: "rejected" });
    expect(store.loadRunCard("s4")).toMatchObject({ phase: "failed", notice: "父任务已结束，本次 `/swarm steer` 未注入，也不会转为普通任务。", steeringFailureKind: "rejected" });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.listQueuedTurnPromptIds("b1")).toEqual([]);
  });

  it("fails queued steering on restart recovery instead of replaying it as a turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "s2", bindingId: "b1", title: "Steer", workspaceId: "w1", paneId: "w1:p1", requestText: "steer", queuePosition: 0, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "s2", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "steer", dispatchKind: "steering", parentPromptId: "parent", steeringOrigin: "automatic" }, view, rootMessageId: "m1", taskCard: {}, answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, `card-${reply.promptId}`, `cardkit-${reply.promptId}`);

    expect(store.recoverRunningPrompts()).toBe(0);
    expect(store.getPrompt("s2")).toMatchObject({ dispatchKind: "steering", state: "failed" });
    expect(store.loadRunCard("s2")).toMatchObject({ phase: "failed", notice: "当前任务已结束，未自动注入", steeringOrigin: "automatic", steeringFailureKind: "rejected" });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
  });

  it("marks interrupted steering as uncertain instead of replaying it", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "s1", bindingId: "b1", title: "Steer", workspaceId: "w1", paneId: "w1:p1", requestText: "steer", queuePosition: 0, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "s1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "steer", dispatchKind: "steering", parentPromptId: "parent", steeringOrigin: "automatic" }, view, rootMessageId: "m1", taskCard: {}, answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, `${reply.cardRole}-card-s1`, "cardkit-s1");
    expect(store.claimNextReadySteering("b1", "parent")?.id).toBe("s1");
    store.markPromptDispatched("s1");

    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.loadRunCard("s1")).toMatchObject({ phase: "failed", notice: "自动注入结果无法确认，请检查 Herdr pane；Bridge 不会自动重试。", steeringOrigin: "automatic", steeringFailureKind: "uncertain" });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
  });

  it("reports aggregate-only automatic steering and queue feedback counts", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const makeView = (id: string, queueFeedback: ReturnType<typeof createQueuedRunCard>["queueFeedback"] = null) => ({ ...createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: `secret-${id}`, queuePosition: 1, occurredAt: "now" }), queueFeedback });
    for (const [id, state, failureKind] of [["queued", "queued", null], ["delivered", "delivered", null], ["rejected", "failed", "rejected"], ["uncertain", "failed", "uncertain"]] as const) {
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: `actor-${id}`, body: `secret-${id}`, dispatchKind: "steering", parentPromptId: "parent", steeringOrigin: "automatic" }, view: makeView(id), rootMessageId: "m1", answerCard: {} });
      store.database.prepare("UPDATE prompt_jobs SET state = ? WHERE id = ?").run(state, id);
      if (failureKind) store.database.prepare("UPDATE run_cards SET phase = 'failed', steering_failure_kind = ? WHERE prompt_id = ?").run(failureKind, id);
    }
    const estimate = { aheadCount: 0, activeElapsedSeconds: null, estimateLowerSeconds: 30, estimateUpperSeconds: 90, sampleCount: 3, elapsedBucket: null };
    for (const [id, feedback] of [["estimated", estimate], ["unestimated", null]] as const) {
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: `actor-${id}`, body: `secret-${id}` }, view: makeView(id, feedback), rootMessageId: "m1", answerCard: {} });
    }

    const summary = store.getOperationalSummary();
    expect(summary).toMatchObject({ automaticSteering: { queued: 1, delivered: 1, failed: 2, rejected: 1, uncertain: 1 }, queueFeedback: { withEstimate: 1, withoutEstimate: 1 } });
    expect(JSON.stringify({ automaticSteering: summary.automaticSteering, queueFeedback: summary.queueFeedback })).not.toContain("secret-");
    expect(JSON.stringify({ automaticSteering: summary.automaticSteering, queueFeedback: summary.queueFeedback })).not.toContain("actor-");
  });

  it("atomically converts only rejected automatic steering into one ordinary prompt", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", creatorOpenId: "creator", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const sourceView = createQueuedRunCard({ promptId: "source", bindingId: "b1", bindingGeneration: 1, title: "Continue", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 0, occurredAt: "2026-08-29T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "source", bindingId: "b1", larkMessageId: "source-message", actorOpenId: "member", body: "继续", dispatchKind: "steering", parentPromptId: "parent", steeringOrigin: "automatic" }, view: sourceView, rootMessageId: "root", answerCard: {} });
    store.failPrompt({ promptId: "source", error: "not working", occurredAt: "2026-08-29T00:01:00.000Z", steeringFailureKind: "rejected" });
    const interaction = store.createCardInteraction({ id: "interaction", bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "enqueue_failed_steering", parentPromptId: null, targetPromptId: "source", expiresAt: "2026-08-29T01:00:00.000Z" });
    const replacementView = createQueuedRunCard({ promptId: "replacement", bindingId: "b1", bindingGeneration: 1, title: "Continue", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 99, occurredAt: "2026-08-29T00:02:00.000Z" });
    const input = { interactionId: interaction.id, actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, sourcePromptId: "source", newPromptId: "replacement", newLarkMessageId: "card:interaction", now: "2026-08-29T00:02:00.000Z", view: replacementView, rootMessageId: "root", answerCardFor: () => ({ kind: "replacement" }) };

    expect(store.convertFailedSteeringToTurn({ ...input, actorOpenId: "other" })).toEqual({ outcome: "unauthorized", prompt: null });
    for (const [column, value] of [["state", "orphaned"], ["lifecycle", "draining"], ["attachment", "degraded"]] as const) {
      store.database.prepare(`UPDATE bindings SET ${column} = ? WHERE id = 'b1'`).run(value);
      expect(store.convertFailedSteeringToTurn(input)).toEqual({ outcome: "stale", prompt: null });
      expect(store.getCardInteraction("interaction")).toMatchObject({ state: "active" });
      store.database.prepare("UPDATE bindings SET state = 'active', lifecycle = 'active', attachment = 'attached' WHERE id = 'b1'").run();
    }
    expect(store.convertFailedSteeringToTurn(input)).toMatchObject({ outcome: "converted", prompt: { id: "replacement", dispatchKind: "turn", steeringOrigin: null, sourcePromptId: "source", body: "继续" } });
    expect(store.loadRunCard("replacement")).toMatchObject({ queuePosition: 1, steeringOrigin: null, steeringFailureKind: null });
    expect(store.listPendingOutboundReplies().filter((reply) => reply.promptId === "replacement")).toHaveLength(1);
    store.createCardInteraction({ id: "forged-interaction", bindingId: "b1", bindingGeneration: 1, actorOpenId: "other", actionKind: "enqueue_failed_steering", parentPromptId: null, targetPromptId: "source", expiresAt: "2026-08-29T01:00:00.000Z" });
    expect(store.convertFailedSteeringToTurn({ ...input, interactionId: "forged-interaction", actorOpenId: "other", newPromptId: "forged-replacement" })).toEqual({ outcome: "unauthorized", prompt: null });
    expect(store.convertFailedSteeringToTurn({ ...input, newPromptId: "replacement-2" })).toMatchObject({ outcome: "duplicate", prompt: { id: "replacement" } });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE source_prompt_id = 'source'").get()).toEqual({ count: 1 });
  });

  it("preserves automatic steering provenance and failure kind across reopen", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-steering-failure-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "source", bindingId: "b1", title: "Continue", workspaceId: "w1", paneId: "w1:p1", requestText: "继续", queuePosition: 0, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "source", bindingId: "b1", larkMessageId: "source-message", actorOpenId: "member", body: "继续", dispatchKind: "steering", parentPromptId: "parent", steeringOrigin: "automatic" }, view, rootMessageId: "root", answerCard: {} });
    store.failPrompt({ promptId: "source", error: "not working", occurredAt: "later", steeringFailureKind: "rejected" });
    store.close();

    store = new SqliteBindingStore(path);
    expect(store.loadRunCard("source")).toMatchObject({ steeringOrigin: "automatic", steeringFailureKind: "rejected", phase: "failed" });
  });

  it("deduplicates control operations and gives accepted model control priority over queued turns", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.enqueuePrompt({ id: "turn", bindingId: "b1", larkMessageId: "turn-message", actorOpenId: "u1", body: "ordinary" });
    const first = store.acceptPaneControlOperation({ id: "model-1", idempotencyKey: "message:model", bindingId: "b1", paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "u1", sourceMessageId: "message" });
    const duplicate = store.acceptPaneControlOperation({ id: "model-2", idempotencyKey: "message:model", bindingId: "b1", paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "u1", sourceMessageId: "message" });

    expect(first.inserted).toBe(true);
    expect(duplicate).toMatchObject({ inserted: false, operation: { id: "model-1", state: "accepted" } });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.claimNextPaneControlOperation("b1")).toMatchObject({ id: "model-1", state: "running" });
    store.finishPaneControlOperation("model-1", "confirmed");
  });

  it("does not let a late pane-control completion overwrite a terminal outcome", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.acceptPaneControlOperation({ id: "model-1", idempotencyKey: "message:model", bindingId: "b1", paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "u1", sourceMessageId: "message" });
    store.claimPaneControlOperation("model-1");
    store.finishPaneControlOperation("model-1", "confirmed", "confirmed first");

    store.finishPaneControlOperation("model-1", "uncertain", "late failure");

    expect(store.getPaneControlOperation("model-1")).toMatchObject({ state: "confirmed", detail: "confirmed first" });
  });

  it("commits a pane-control outcome and its user-visible result atomically", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.acceptPaneControlOperation({ id: "model-1", idempotencyKey: "message:model", bindingId: "b1", paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "u1", sourceMessageId: "message" });
    store.claimPaneControlOperation("model-1");

    store.finishPaneControlWithResult({
      operationId: "model-1", state: "confirmed", detail: "Model selector listed",
      result: { kind: "card_reply", targetMessageId: "m1", idempotencyKey: "model:model-1:confirmed", targetRole: "operation_result", card: { schema: "2.0" } }
    });

    expect(store.getPaneControlOperation("model-1")).toMatchObject({ state: "confirmed", detail: "Model selector listed" });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      bindingId: "b1", idempotencyKey: "model:model-1:confirmed", kind: "card_reply", rootMessageId: "m1", targetRole: "operation_result"
    })]);
  });

  it("atomically checkpoints a delivered session-status card and its binding target", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const reply = store.enqueueOutboundReply({
      id: "status-1", idempotencyKey: "status-card:b1", bindingId: "b1", targetRole: "session_status",
      rootMessageId: "m1", kind: "card_reply", payload: "{}"
    });

    store.markOutboundReplyDelivered(reply.id, "status-message-1");

    expect(store.getBinding("b1")?.statusMessageId).toBe("status-message-1");
    expect(store.database.prepare("SELECT state, delivered_message_id FROM outbound_replies WHERE id = ?").get(reply.id)).toEqual({ state: "delivered", delivered_message_id: "status-message-1" });
  });

  it("rolls back a status-card delivery checkpoint when its binding target cannot be updated", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const reply = store.enqueueOutboundReply({
      id: "status-1", idempotencyKey: "status-card:b1", bindingId: "b1", targetRole: "session_status",
      rootMessageId: "m1", kind: "card_reply", payload: "{}"
    });
    store.database.exec("CREATE TRIGGER reject_status_pointer BEFORE UPDATE OF status_message_id ON bindings BEGIN SELECT RAISE(ABORT, 'reject status pointer'); END");

    expect(() => store!.markOutboundReplyDelivered(reply.id, "status-message-1")).toThrow(/reject status pointer/);

    expect(store.getBinding("b1")?.statusMessageId).toBeNull();
    expect(store.database.prepare("SELECT state, delivered_message_id FROM outbound_replies WHERE id = ?").get(reply.id)).toEqual({ state: "pending", delivered_message_id: null });
  });

  it("rolls back the pane-control outcome when its result intent cannot be persisted", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.acceptPaneControlOperation({ id: "model-1", idempotencyKey: "message:model", bindingId: "b1", paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "u1", sourceMessageId: "message" });
    store.claimPaneControlOperation("model-1");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => store!.finishPaneControlWithResult({
      operationId: "model-1", state: "confirmed", detail: "must roll back",
      result: { kind: "card_reply", targetMessageId: "m1", idempotencyKey: "model:model-1:confirmed", targetRole: "operation_result", card: circular }
    })).toThrow(/circular/i);

    expect(store.getPaneControlOperation("model-1")).toMatchObject({ state: "running", detail: null });
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });
});
