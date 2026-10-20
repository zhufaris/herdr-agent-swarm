import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInputStore } from "../src/domain/ports/agent-input.js";
import { createTestStoreBundle, type TestStoreBundle } from "./helpers/create-test-store-bundle.js";

type MigrationResult = {
  migratedInputs: number;
  cancelledPromptJobs: number;
  cancelledBatches: number;
  remainingEligible: number;
  preservedPossibleEffect: number;
};

type MigrationStore = AgentInputStore & {
  migrateLegacyNeverAttempted(recordedAt: string): MigrationResult;
};

const opened: TestStoreBundle[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.lifecycle.close();
});

describe("legacy Agent Input migration", () => {
  it("decomposes queued and formed legacy input into independent Submission Intents", () => {
    const stores = create();
    seedBinding(stores);
    seedQueuedInput(stores, "input-a", "message-a", "first body");
    seedFormedBatch(stores, [
      { id: "input-b", messageId: "message-b", body: "second body", ordinal: 1 },
      { id: "input-c", messageId: "message-c", body: "third body", ordinal: 0 }
    ]);
    seedDirectQueuedPrompt(stores, "direct-d", "message-d", "fourth body");

    expect(migration(stores).migrateLegacyNeverAttempted("2026-10-04T08:00:00.000Z")).toEqual({
      migratedInputs: 4,
      cancelledPromptJobs: 2,
      cancelledBatches: 2,
      remainingEligible: 0,
      preservedPossibleEffect: 0
    });

    expect(stores.driver.database.prepare(`
      SELECT source_message_key, text, owner_kind, owner_id, owner_generation,
        pane_id, terminal_id, expected_agent_kind, expected_session_id, state
      FROM submission_intents ORDER BY source_message_key
    `).all()).toEqual([
      { source_message_key: "message-a", text: "first body", owner_kind: "primary", owner_id: "binding-1", owner_generation: 1, pane_id: "w1:p1", terminal_id: "terminal-1", expected_agent_kind: "traex", expected_session_id: null, state: "recorded" },
      { source_message_key: "message-b", text: "second body", owner_kind: "primary", owner_id: "binding-1", owner_generation: 1, pane_id: "w1:p1", terminal_id: "terminal-1", expected_agent_kind: "traex", expected_session_id: null, state: "recorded" },
      { source_message_key: "message-c", text: "third body", owner_kind: "primary", owner_id: "binding-1", owner_generation: 1, pane_id: "w1:p1", terminal_id: "terminal-1", expected_agent_kind: "traex", expected_session_id: null, state: "recorded" },
      { source_message_key: "message-d", text: "fourth body", owner_kind: "primary", owner_id: "binding-1", owner_generation: 1, pane_id: "w1:p1", terminal_id: "terminal-1", expected_agent_kind: "traex", expected_session_id: null, state: "recorded" }
    ]);
    expect(stores.driver.database.prepare("SELECT id, state, batch_id FROM prompt_inputs ORDER BY id").all()).toEqual([
      { id: "input-a", state: "cancelled", batch_id: null },
      { id: "input-b", state: "cancelled", batch_id: "batch-1" },
      { id: "input-c", state: "cancelled", batch_id: "batch-1" }
    ]);
    expect(stores.driver.database.prepare("SELECT id, state FROM native_input_batches ORDER BY id").all()).toEqual([
      { id: "batch-1", state: "cancelled" },
      { id: "collecting-a", state: "cancelled" }
    ]);
    expect(stores.driver.database.prepare("SELECT id, state, observation_state FROM prompt_jobs WHERE id IN ('batch-1','direct-d') ORDER BY id").all()).toEqual([
      { id: "batch-1", state: "cancelled", observation_state: "completed" },
      { id: "direct-d", state: "cancelled", observation_state: "completed" }
    ]);
  });

  it("never converts legacy possible-effect work into Submission Intent work", () => {
    const stores = create();
    seedBinding(stores);
    for (const [index, state] of (["submitted", "running", "recovering", "uncertain"] as const).entries()) {
      stores.driver.database.prepare(`
        INSERT INTO prompt_jobs(
          id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body,
          execution_origin, priority, was_detached, dispatched_at, native_submission_id,
          state, observation_state, attempt_count, created_at, updated_at
        ) VALUES (?, 'binding-1', ?, 'feishu', ?, 'user-1', ?, 'bridge', 'normal', ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        `possible-${state}`, `possible-message-${state}`, `possible-message-${state}`, `possible ${state}`,
        state === "recovering" || state === "uncertain" ? 1 : 0,
        `2026-10-04T07:0${index}:00.000Z`, `possible-${state}`,
        state, state === "submitted" ? "attached" : "detached",
        `2026-10-04T07:0${index}:00.000Z`, `2026-10-04T07:0${index}:01.000Z`
      );
    }

    expect(migration(stores).migrateLegacyNeverAttempted("2026-10-04T08:00:00.000Z")).toMatchObject({
      migratedInputs: 0,
      remainingEligible: 0,
      preservedPossibleEffect: 4
    });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM submission_intents").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT state, COUNT(*) AS count FROM prompt_jobs GROUP BY state ORDER BY state").all()).toEqual([
      { state: "recovering", count: 1 }, { state: "running", count: 1 }, { state: "submitted", count: 1 }, { state: "uncertain", count: 1 }
    ]);
  });

  it("is idempotent across competing store handles and database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "legacy-agent-input-migration-"));
    const path = join(directory, "bridge.db");
    const first = create(path); const second = create(path);
    try {
      seedBinding(first);
      seedQueuedInput(first, "input-a", "message-a", "first body");
      seedDirectQueuedPrompt(first, "direct-b", "message-b", "second body");

      expect(migration(first).migrateLegacyNeverAttempted("2026-10-04T08:00:00.000Z").migratedInputs).toBe(2);
      expect(migration(second).migrateLegacyNeverAttempted("2026-10-04T08:00:01.000Z").migratedInputs).toBe(0);
      second.lifecycle.close(); opened.splice(opened.indexOf(second), 1);
      const reopened = create(path);

      expect(migration(reopened).migrateLegacyNeverAttempted("2026-10-04T08:00:02.000Z")).toMatchObject({ migratedInputs: 0, remainingEligible: 0 });
      expect(reopened.driver.database.prepare("SELECT source_message_key, text FROM submission_intents ORDER BY source_message_key").all()).toEqual([
        { source_message_key: "message-a", text: "first body" },
        { source_message_key: "message-b", text: "second body" }
      ]);
    } finally {
      while (opened.length > 0) opened.pop()!.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports Agent Input receipts, Core projection lag, and legacy convergence separately", () => {
    const stores = create();
    seedBinding(stores);
    seedQueuedInput(stores, "input-a", "message-a", "first body");
    seedFormedBatch(stores, [{ id: "input-b", messageId: "message-b", body: "second body", ordinal: 0 }]);
    stores.driver.database.prepare(`INSERT INTO prompt_jobs(
      id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body,
      execution_origin, priority, was_detached, dispatched_at, native_submission_id,
      state, observation_state, attempt_count, created_at, updated_at
    ) VALUES ('possible', 'binding-1', 'possible-message', 'feishu', 'possible-message', 'user-1', 'possible',
      'bridge', 'normal', 1, '2026-10-04T07:05:00.000Z', 'possible',
      'recovering', 'detached', 1, '2026-10-04T07:05:00.000Z', '2026-10-04T07:05:01.000Z')`).run();

    migration(stores).migrateLegacyNeverAttempted("2026-10-04T08:00:00.000Z");
    stores.driver.database.prepare(`INSERT INTO core_event_lane_checkpoints(
      lane_id, source_id, agent_kind, session_id, read_cursor, latest_cursor, updated_at
    ) VALUES ('lane-1', 'source-1', 'traex', 'session-1', 'cursor-1', 'cursor-2', '2026-10-04T08:01:00.000Z')`).run();
    stores.driver.database.prepare(`INSERT INTO core_event_inbox(
      event_id, source_id, agent_kind, session_id, turn_id, source_cursor, occurred_at, event_json, ingested_at
    ) VALUES ('event-1', 'source-1', 'traex', 'session-1', 'turn-1', 'cursor-2',
      '2026-10-04T08:01:00.000Z', '{}', '2026-10-04T08:01:00.000Z')`).run();
    stores.driver.database.prepare(`INSERT INTO core_event_lane_items(
      lane_id, event_id, sequence, state, created_at, updated_at
    ) VALUES ('lane-1', 'event-1', 1, 'pending', '2026-10-04T08:01:00.000Z', '2026-10-04T08:01:00.000Z')`).run();

    const status = stores.health.getOperationalSummary();
    expect(status.submissionIntents).toEqual({
      states: { recorded: 2, attempting: 0, prepared: 0, observed: 0, terminal: 0, cancelled: 0, uncertain: 0 },
      awaitingReceipt: 2,
      receiptKnown: 0
    });
    expect(status.coreProjection).toMatchObject({ lanes: 1, laggingLanes: 1, pendingEvents: 1, quarantinedEvents: 0 });
  });
});

function create(path = ":memory:"): TestStoreBundle {
  const stores = createTestStoreBundle(path); opened.push(stores); return stores;
}

function migration(stores: TestStoreBundle): MigrationStore { return stores.agentInputs as MigrationStore; }

function seedBinding(stores: TestStoreBundle): void {
  stores.driver.database.prepare(`
    INSERT INTO bindings(
      id, gateway_id, creator_open_id, project_id, workspace_id, chat_id, topic_id, root_message_id,
      pane_id, traex_session_id, title, runtime, agent_kind, state, last_agent_state,
      lifecycle, attachment, generation, created_at, updated_at
    ) VALUES (
      'binding-1', 'feishu:primary', 'user-1', 'project-1', 'workspace-1', 'chat-1', 'topic-1', 'root-1',
      'w1:p1', 'terminal-1', 'Primary', 'traex', 'traex', 'active', 'idle',
      'active', 'attached', 1, '2026-10-04T07:00:00.000Z', '2026-10-04T07:00:00.000Z'
    )
  `).run();
}

function seedQueuedInput(stores: TestStoreBundle, id: string, messageId: string, body: string): void {
  stores.driver.database.prepare(`
    INSERT INTO native_input_batches(id, binding_id, binding_generation, state, window_opened_at, drain_due_at, created_at, updated_at)
    VALUES ('collecting-a', 'binding-1', 1, 'collecting', '2026-10-04T07:01:00.000Z', '2026-10-04T07:02:00.000Z', '2026-10-04T07:01:00.000Z', '2026-10-04T07:01:00.000Z')
  `).run();
  insertInput(stores, { id, messageId, body, state: "queued", batchId: null });
}

function seedFormedBatch(stores: TestStoreBundle, inputs: Array<{ id: string; messageId: string; body: string; ordinal: number }>): void {
  stores.driver.database.prepare(`
    INSERT INTO prompt_jobs(
      id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body,
      execution_origin, priority, was_detached, state, observation_state, attempt_count, native_submission_id, created_at, updated_at
    ) VALUES ('batch-1', 'binding-1', NULL, 'feishu', 'feishu-batch:v1:batch-1', 'user-1', 'combined',
      'bridge', 'normal', 0, 'queued', 'not_started', 0, 'batch-1', '2026-10-04T07:03:00.000Z', '2026-10-04T07:03:00.000Z')
  `).run();
  stores.driver.database.prepare(`
    INSERT INTO native_input_batches(
      id, binding_id, binding_generation, state, window_opened_at, drain_due_at,
      combined_body, execution_prompt_id, formed_at, created_at, updated_at
    ) VALUES ('batch-1', 'binding-1', 1, 'formed', '2026-10-04T07:03:00.000Z', '2026-10-04T07:03:00.000Z',
      'combined', 'batch-1', '2026-10-04T07:03:00.000Z', '2026-10-04T07:03:00.000Z', '2026-10-04T07:03:00.000Z')
  `).run();
  for (const input of inputs) {
    insertInput(stores, { ...input, state: "batched", batchId: "batch-1" });
    stores.driver.database.prepare("INSERT INTO native_input_batch_members(batch_id, prompt_input_id, ordinal, created_at) VALUES ('batch-1', ?, ?, '2026-10-04T07:03:00.000Z')").run(input.id, input.ordinal);
  }
}

function seedDirectQueuedPrompt(stores: TestStoreBundle, id: string, messageId: string, body: string): void {
  stores.driver.database.prepare(`INSERT INTO prompt_jobs(
    id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body,
    execution_origin, priority, was_detached, state, observation_state, attempt_count, created_at, updated_at
  ) VALUES (?, 'binding-1', ?, 'feishu', ?, 'user-1', ?,
    'bridge', 'normal', 0, 'queued', 'not_started', 0, '2026-10-04T07:04:00.000Z', '2026-10-04T07:04:00.000Z')
  `).run(id, messageId, messageId, body);
}

function insertInput(stores: TestStoreBundle, input: { id: string; messageId: string; body: string; state: "queued" | "batched"; batchId: string | null }): void {
  stores.driver.database.prepare(`
    INSERT INTO prompt_inputs(
      id, binding_id, binding_generation, ingress_source, source_message_key, lark_message_id,
      actor_open_id, body, root_message_id, state, batch_id, created_at, updated_at
    ) VALUES (?, 'binding-1', 1, 'feishu', ?, ?, 'user-1', ?, 'root-1', ?, ?, '2026-10-04T07:01:00.000Z', '2026-10-04T07:01:00.000Z')
  `).run(input.id, input.messageId, input.messageId, input.body, input.state, input.batchId);
}
