import { afterEach, describe, expect, it } from "vitest";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { supersededDetachedPromptNotice } from "../src/store/sqlite/prompt-running-integrity.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

let store: SqliteBindingStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

function setupBinding(): SqliteBindingStore {
  const candidate = new SqliteBindingStore(":memory:");
  candidate.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
  candidate.updateBinding("b1", {
    state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "working"
  });
  return candidate;
}

function acceptPrompt(candidate: SqliteBindingStore, id: string, occurredAt: string): void {
  const view = createQueuedRunCard({
    promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1",
    requestText: id, queuePosition: 1, occurredAt
  });
  candidate.acceptPrompt({
    prompt: { id, bindingId: "b1", larkMessageId: `message-${id}`, actorOpenId: "u1", body: id },
    view, rootMessageId: "root", answerCard: {}
  });
}

function persistExactRunningPrompt(candidate: SqliteBindingStore, input: {
  promptId: string;
  executionOrigin: "bridge" | "herdr";
  observationState: "attached" | "detached";
  turnId: string;
  startedAt: string;
  paneId?: string | null;
  nativeSessionId?: string | null;
}): void {
  candidate.database.prepare(`
    UPDATE prompt_jobs
    SET execution_origin = ?, state = 'running', observation_state = ?, was_detached = ?,
      dispatched_at = ?, transcript_turn_id = ?, transcript_turn_started_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.executionOrigin,
    input.observationState,
    input.observationState === "detached" ? 1 : 0,
    input.startedAt,
    input.turnId,
    input.startedAt,
    input.startedAt,
    input.promptId
  );
  candidate.database.prepare("UPDATE run_cards SET phase = 'running', started_at = ? WHERE prompt_id = ?")
    .run(input.startedAt, input.promptId);
  candidate.database.prepare(`
    INSERT INTO prompt_transcript_turns(
      prompt_id,binding_id,binding_generation,pane_id,native_session_id,turn_id,started_at,chain_id,parent_turn_id,origin,ordinal,created_at
    ) VALUES (?, 'b1', 1, ?, ?, ?, ?, ?, NULL, 'prompt', 0, ?)
  `).run(
    input.promptId,
    input.paneId ?? "w1:p1",
    input.nativeSessionId ?? (input.executionOrigin === "herdr" ? "session-1" : null),
    input.turnId,
    input.startedAt,
    input.turnId,
    input.startedAt
  );
}

describe("SQLite Prompt running-owner integrity", () => {
  it("terminalizes an older exact detached owner when a later Prompt claims its exact turn", () => {
    store = setupBinding();
    acceptPrompt(store, "older", "2026-09-30T14:08:18.000Z");
    persistExactRunningPrompt(store, {
      promptId: "older", executionOrigin: "herdr", observationState: "detached",
      turnId: "turn-older", startedAt: "2026-09-30T14:08:18.000Z"
    });
    acceptPrompt(store, "successor", "2026-09-30T15:46:08.000Z");
    store.database.prepare("UPDATE prompt_jobs SET state = 'submitted', observation_state = 'not_started' WHERE id = 'successor'").run();
    store.markPromptDispatched("successor", "2026-09-30T15:46:08.500Z");

    expect(store.claimPromptTranscriptTurn({
      promptId: "successor", bindingId: "b1", turnId: "turn-successor", startedAt: "2026-09-30T15:46:09.000Z"
    })).toMatchObject({ state: "claimed", prompt: { id: "successor", transcriptTurnId: "turn-successor" } });

    expect(store.getPrompt("older")).toMatchObject({
      id: "older", state: "uncertain", observationState: "completed",
      transcriptTurnId: "turn-older", transcriptTurnStartedAt: "2026-09-30T14:08:18.000Z",
      error: supersededDetachedPromptNotice
    });
    expect(store.loadRunCard("older")).toMatchObject({ phase: "uncertain", notice: supersededDetachedPromptNotice });
    expect(store.getPrompt("successor")).toMatchObject({
      id: "successor", state: "running", observationState: "attached", transcriptTurnId: "turn-successor"
    });
    expect(store.inspectIntegrity(20).issues).not.toContainEqual(expect.objectContaining({ rule: "multiple_running_turns" }));
    expect(store.database.prepare("SELECT action, outcome FROM audit_log WHERE target LIKE '%prompt:older:%'").get())
      .toEqual({ action: "prompt.superseded_exact_turn", outcome: "uncertain" });
  });

  it("repairs a persisted multiple-running owner shape without replacing Prompt identity or replaying FIFO work", () => {
    store = setupBinding();
    acceptPrompt(store, "older", "2026-09-30T14:08:18.000Z");
    acceptPrompt(store, "successor", "2026-09-30T15:41:34.000Z");
    persistExactRunningPrompt(store, {
      promptId: "older", executionOrigin: "herdr", observationState: "detached",
      turnId: "turn-older", startedAt: "2026-09-30T14:08:18.000Z"
    });
    persistExactRunningPrompt(store, {
      promptId: "successor", executionOrigin: "bridge", observationState: "attached",
      turnId: "turn-successor", startedAt: "2026-09-30T15:41:34.000Z"
    });
    expect(store.inspectIntegrity(20).issues).toContainEqual({ rule: "multiple_running_turns", table: "prompt_jobs", count: 1 });

    expect(store.recoverRunningPrompts()).toBe(2);

    expect(store.getPrompt("older")).toMatchObject({
      id: "older", executionOrigin: "herdr", state: "uncertain", observationState: "completed", transcriptTurnId: "turn-older"
    });
    expect(store.getPrompt("successor")).toMatchObject({
      id: "successor", executionOrigin: "bridge", state: "running", observationState: "detached", transcriptTurnId: "turn-successor"
    });
    expect(store.database.prepare("SELECT id FROM prompt_jobs ORDER BY created_at, rowid").all()).toEqual([{ id: "older" }, { id: "successor" }]);
    expect(store.inspectIntegrity(20)).toMatchObject({ quickCheck: "ok", issues: [] });
  });

  it.each([
    ["a different Binding generation", () => {
      store!.database.prepare("UPDATE run_cards SET binding_generation = 2 WHERE prompt_id = 'older'").run();
    }],
    ["an older owner that is not detached", () => {
      store!.database.prepare("UPDATE prompt_jobs SET observation_state = 'attached', was_detached = 0 WHERE id = 'older'").run();
    }],
    ["an older owner without an exact turn ID", () => {
      store!.database.prepare("UPDATE prompt_jobs SET transcript_turn_id = NULL WHERE id = 'older'").run();
    }],
    ["an older owner without an exact turn start", () => {
      store!.database.prepare("UPDATE prompt_jobs SET transcript_turn_started_at = NULL WHERE id = 'older'").run();
    }],
    ["a successor without an exact turn ID", () => {
      store!.database.prepare("UPDATE prompt_jobs SET transcript_turn_id = NULL WHERE id = 'successor'").run();
    }],
    ["a successor without an exact turn start", () => {
      store!.database.prepare("UPDATE prompt_jobs SET transcript_turn_started_at = NULL WHERE id = 'successor'").run();
    }],
    ["a successor with the same start time", () => {
      store!.database.prepare("UPDATE prompt_jobs SET transcript_turn_started_at = '2026-09-30T14:08:18.000Z' WHERE id = 'successor'").run();
    }],
    ["a successor with an earlier start time", () => {
      store!.database.prepare("UPDATE prompt_jobs SET transcript_turn_started_at = '2026-09-30T14:08:17.999Z' WHERE id = 'successor'").run();
    }]
  ] as const)("fails closed for %s", (_label, mutateEvidence) => {
    store = setupBinding();
    acceptPrompt(store, "older", "2026-09-30T14:08:18.000Z");
    acceptPrompt(store, "successor", "2026-09-30T15:41:34.000Z");
    persistExactRunningPrompt(store, {
      promptId: "older", executionOrigin: "herdr", observationState: "detached",
      turnId: "turn-older", startedAt: "2026-09-30T14:08:18.000Z"
    });
    persistExactRunningPrompt(store, {
      promptId: "successor", executionOrigin: "bridge", observationState: "attached",
      turnId: "turn-successor", startedAt: "2026-09-30T15:41:34.000Z"
    });
    mutateEvidence();

    store.recoverRunningPrompts();

    expect(store.getPrompt("older")).toMatchObject({ id: "older", state: "running" });
    expect(store.database.prepare("SELECT 1 FROM audit_log WHERE action = 'prompt.superseded_exact_turn'").get()).toBeUndefined();
    expect(store.database.prepare("SELECT id FROM prompt_jobs ORDER BY created_at, rowid").all()).toEqual([{ id: "older" }, { id: "successor" }]);
  });
});
