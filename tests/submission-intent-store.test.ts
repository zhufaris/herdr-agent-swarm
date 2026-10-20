import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdmitSubmissionIntentInput } from "../src/domain/submission-intent.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";
import { SqliteConversationSegmentStore } from "../src/store/sqlite/conversation-segment-store.js";
import { SqliteSubmissionIntentStore } from "../src/store/sqlite/submission-intent-store.js";
import type { InputCardReservation } from "../src/domain/input-card-view.js";
import { canonicalHumanInputJson } from "../src/domain/inbound.js";

describe("Submission Intent persistence", () => {
  it("serializes Human Input with the shared Core canonical fixture bytes", () => {
    const fixture = readFileSync(new URL("./fixtures/human-input-message-v2.json", import.meta.url), "utf8").trimEnd();

    expect(canonicalHumanInputJson({
      schemaVersion: 2,
      text: "continue",
      choice: { actionSetId: "actions-1", optionId: "approve", sourceMessageId: "message-1" }
    })).toBe(fixture);
  });

  it("keeps historical pending segment admission atomic behind the compatibility writer", () => {
    const stores = createTestStoreBundle();
    ensurePrimaryBinding(stores);
    const result = stores.driver.capabilityModules().agentInputs.admitLegacyPendingCard(submission(), {
      segmentId: "segment-1", rootMessageId: "root-1", card: { schema: "2.0", state: "pending" }
    });
    expect(result).toMatchObject({ outcome: "accepted" });
    expect(stores.driver.database.prepare("SELECT state, human_event_id, submission_id FROM conversation_segments WHERE id='segment-1'").get())
      .toEqual({ state: "pending", human_event_id: null, submission_id: "submission-1" });
    expect(stores.driver.database.prepare("SELECT page_index, state, element_id FROM conversation_segment_pages WHERE segment_id='segment-1'").all())
      .toEqual([{ page_index: 0, state: "creating", element_id: "turn-card:segment-1:page:0" }]);
    expect(stores.driver.database.prepare("SELECT kind, projection_key, snapshot_revision FROM outbound_replies").all())
      .toEqual([{ kind: "card_reply", projection_key: "turn-card:segment-1:page:0", snapshot_revision: 1 }]);
  });

  it("adopts canonical evidence through the unified segment without creating a legacy Input Card row", () => {
    const stores = createTestStoreBundle();
    ensurePrimaryBinding(stores);
    stores.driver.capabilityModules().agentInputs.admitLegacyPendingCard(submission(), {
      segmentId: "segment-canonical", rootMessageId: "root-1", card: { schema: "2.0", state: "pending" }
    });

    stores.coreEvents.ingestBatch({
      laneId: "lane-primary", sourceId: "source-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: "c1", latestCursor: "c1", ingestedAt: "2026-10-04T00:00:01.000Z",
      events: [{ schemaVersion: 1, eventId: "human-1", cursor: "c1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-04T00:00:01.000Z", payload: { type: "human_message", message_id: "message-1", text: "run the audit", truncated: false, submission_id: "submission-1" } }]
    });
    expect(stores.driver.database.prepare("SELECT state, human_event_id FROM conversation_segments WHERE id='segment-canonical'").get())
      .toEqual({ state: "working", human_event_id: "human-1" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });
  });

  it("deduplicates a source delivery without another segment, page, or outbox row", () => {
    const stores = createTestStoreBundle();
    ensurePrimaryBinding(stores);
    const compatibility = stores.driver.capabilityModules().agentInputs;
    compatibility.admitLegacyPendingCard(submission(), { segmentId: "segment-1", rootMessageId: "root-1", card: { state: "pending" } });
    expect(compatibility.admitLegacyPendingCard(submission(), { segmentId: "segment-2", rootMessageId: "root-1", card: { state: "pending" } })).toMatchObject({ outcome: "duplicate" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 1 });
  });

  it("rolls back the intent and segment when Turn Card enqueue fails", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    const conversationSegments = new SqliteConversationSegmentStore(graph.context, {
      enqueueOutboundReply: () => { throw new Error("enqueue failed"); }
    });
    conversationSegments.setPreparedDeliveryReservation({
      reservePreparedOutboundReply: () => { throw new Error("enqueue failed"); }
    }, { enqueuePreparedDelivery() {} });
    const store = new SqliteSubmissionIntentStore(graph.context, {
      conversationSegments,
      enqueue: () => {}
    });
    expect(() => store.admitLegacyPendingCard(submission(), { segmentId: "segment-fail", rootMessageId: "root-1", card: { state: "pending" } })).toThrow("enqueue failed");
    expect(store.get("submission-1")).toBeNull();
    expect(graph.conversationSegments.getConversationSegment("segment-fail")).toBeNull();
    graph.context.close();
  });

  it("keeps concrete-store callers compatible with the legacy Input Card reservation", () => {
    const graph = new SqliteCapabilityGraph(":memory:");
    const store = new SqliteSubmissionIntentStore(graph.context, { enqueue: () => {} });
    const legacy: InputCardReservation = {
      rootMessageId: "root-1", pendingCard: { state: "pending" }, workingCard: { state: "working" }
    };
    expect(store.admitLegacyPendingCard(submission(), legacy)).toMatchObject({ outcome: "accepted", intent: { submissionId: "submission-1" } });
    expect(graph.database.prepare("SELECT state, working_card_json FROM input_card_views WHERE submission_id='submission-1'").get())
      .toEqual({ state: "pending", working_card_json: JSON.stringify(legacy.workingCard) });
    graph.context.close();
  });

  it("converges an identical source delivery and rejects changed immutable effect identity", () => {
    const stores = createTestStoreBundle();
    const input = submission();

    expect(stores.agentInputs.admit(input)).toEqual({
      outcome: "accepted",
      intent: expect.objectContaining({
        submissionId: "submission-1",
        state: "recorded",
        text: "run the audit",
        input: { schemaVersion: 2, text: "run the audit" }
      })
    });
    expect(stores.agentInputs.admit({ ...input, submissionId: "ignored-duplicate-id" })).toEqual({
      outcome: "duplicate",
      intent: expect.objectContaining({ submissionId: "submission-1", text: "run the audit" })
    });
    expect(stores.agentInputs.admit({
      ...input,
      actor: {
        rootMessageId: "root-1",
        topicId: "topic-1",
        chatId: "chat-1",
        gatewayId: "feishu:primary",
        id: "user-1",
        kind: "human"
      }
    })).toMatchObject({ outcome: "duplicate", intent: { submissionId: "submission-1" } });

    expect(stores.agentInputs.admit({ ...input, text: "different body" })).toEqual({
      outcome: "conflict",
      intent: expect.objectContaining({ submissionId: "submission-1", text: "run the audit" })
    });
    expect(stores.agentInputs.admit({
      ...input,
      input: { schemaVersion: 2, text: "run the audit", choice: { actionSetId: "action-1", optionId: "approve", sourceMessageId: "message-1" } }
    })).toEqual({
      outcome: "conflict",
      intent: expect.objectContaining({ submissionId: "submission-1", input: { schemaVersion: 2, text: "run the audit" } })
    });
    expect(stores.agentInputs.admit({ ...input, terminalId: "terminal-2" })).toEqual({
      outcome: "conflict",
      intent: expect.objectContaining({ submissionId: "submission-1", terminalId: "terminal-1" })
    });
  });

  it("allows only one persistent claimant to cross the external-effect boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "submission-intent-"));
    const path = join(directory, "bridge.db");
    const first = createTestStoreBundle(path);
    const second = createTestStoreBundle(path);
    try {
      first.agentInputs.admit(submission());

      expect(first.agentInputs.claimRecorded("submission-1", "2026-10-04T00:00:01.000Z")).toMatchObject({
        submissionId: "submission-1",
        state: "attempting",
        attemptedAt: "2026-10-04T00:00:01.000Z"
      });
      expect(second.agentInputs.claimRecorded("submission-1", "2026-10-04T00:00:02.000Z")).toBeNull();
      expect(second.agentInputs.get("submission-1")).toMatchObject({ state: "attempting" });
      expect(second.agentInputs.listRecoveryWork()).toEqual({
        submit: [],
        query: [expect.objectContaining({ submissionId: "submission-1", state: "attempting" })]
      });
    } finally {
      second.lifecycle.close();
      first.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconstitutes receipt evidence and permits only forward receipt transitions", () => {
    const directory = mkdtempSync(join(tmpdir(), "submission-receipt-"));
    const path = join(directory, "bridge.db");
    let stores = createTestStoreBundle(path);
    try {
      stores.agentInputs.admit(submission());
      expect(stores.agentInputs.recordReceipt("submission-1", receipt("prepared"))).toBeNull();
      stores.agentInputs.claimRecorded("submission-1", "2026-10-04T00:00:01.000Z");
      expect(stores.agentInputs.recordReceipt("submission-1", receipt("prepared"))).toMatchObject({ state: "prepared" });
      stores.lifecycle.close();

      stores = createTestStoreBundle(path);
      expect(stores.agentInputs.get("submission-1")).toMatchObject({
        state: "prepared",
        attemptedAt: "2026-10-04T00:00:01.000Z",
        receipt: { state: "prepared", terminalId: "terminal-1" }
      });
      expect(stores.agentInputs.recordReceipt("submission-1", receipt("observed"))).toMatchObject({
        state: "observed",
        receipt: { sessionId: "session-1", turnId: "turn-1" }
      });
      expect(stores.agentInputs.recordReceipt("submission-1", { ...receipt("observed"), sessionId: "wrong-session" })).toBeNull();
      expect(stores.agentInputs.recordReceipt("submission-1", receipt("prepared"))).toBeNull();
      expect(stores.agentInputs.recordReceipt("submission-1", receipt("terminal"))).toMatchObject({
        state: "terminal",
        receipt: { terminalState: "completed" }
      });
      expect(stores.agentInputs.recordReceipt("submission-1", { ...receipt("terminal"), terminalState: "failed" })).toBeNull();
      expect(stores.agentInputs.listRecoveryWork()).toEqual({ submit: [], query: [] });
    } finally {
      try { stores.lifecycle.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when persisted typed input text diverges from its indexed text", () => {
    const directory = mkdtempSync(join(tmpdir(), "submission-input-integrity-"));
    const path = join(directory, "bridge.db");
    let stores = createTestStoreBundle(path);
    try {
      stores.agentInputs.admit({
        ...submission(),
        input: { schemaVersion: 2, text: "run the audit", choice: { actionSetId: "action-1", optionId: "approve", sourceMessageId: "review-1" } }
      });
      stores.driver.database.prepare("UPDATE submission_intents SET input_json=? WHERE submission_id='submission-1'")
        .run(JSON.stringify({ schemaVersion: 2, text: "forged indexed text", choice: { actionSetId: "action-1", optionId: "approve", sourceMessageId: "review-1" } }));
      stores.lifecycle.close();
      stores = createTestStoreBundle(path);

      expect(() => stores.agentInputs.get("submission-1")).toThrow("Submission Intent input text mismatch");
    } finally {
      try { stores.lifecycle.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps later work submit-eligible while an earlier intent is uncertain", () => {
    const stores = createTestStoreBundle();
    stores.agentInputs.admit(submission());
    stores.agentInputs.claimRecorded("submission-1", "2026-10-04T00:00:01.000Z");
    expect(stores.agentInputs.recordUncertain("submission-1", {
      code: "receipt_not_found",
      detail: "Core has no conclusive receipt",
      recordedAt: "2026-10-04T00:00:02.000Z"
    })).toMatchObject({ state: "uncertain" });

    stores.agentInputs.admit({
      ...submission(),
      submissionId: "submission-2",
      sourceMessageKey: "message-2",
      text: "continue independently"
    });
    expect(stores.agentInputs.claimRecorded("submission-2", "2026-10-04T00:00:03.000Z")).toMatchObject({
      submissionId: "submission-2",
      state: "attempting"
    });
    expect(stores.agentInputs.listRecoveryWork()).toEqual({
      submit: [],
      query: [
        expect.objectContaining({ submissionId: "submission-1", state: "uncertain" }),
        expect.objectContaining({ submissionId: "submission-2", state: "attempting" })
      ]
    });
  });

  it("persists a structured definite pre-effect rejection as non-replayable cancellation", () => {
    const stores = createTestStoreBundle();
    stores.agentInputs.admit(submission());
    stores.agentInputs.claimRecorded("submission-1", "2026-10-04T00:00:01.000Z");

    expect(stores.agentInputs.recordDefiniteRejection("submission-1", {
      code: "agent_blocked",
      detail: "Core rejected before terminal input",
      recordedAt: "2026-10-04T00:00:02.000Z"
    })).toMatchObject({
      state: "cancelled",
      cancellation: { code: "agent_blocked" }
    });
    expect(stores.agentInputs.claimRecorded("submission-1", "2026-10-04T00:00:03.000Z")).toBeNull();
    expect(stores.agentInputs.listRecoveryWork()).toEqual({ submit: [], query: [] });
  });

  it("adds migration 88 without converting legacy possible-effect work", () => {
    const directory = mkdtempSync(join(tmpdir(), "submission-migration-"));
    const path = join(directory, "bridge.db");
    let stores = createTestStoreBundle(path);
    try {
      stores.driver.database.prepare(`
        INSERT INTO bindings(id, workspace_id, chat_id, title, runtime, state, last_agent_state, created_at, updated_at)
        VALUES ('binding-1', 'workspace-1', 'chat-1', 'legacy', 'traex', 'active', 'working', ?, ?)
      `).run("2026-10-04T00:00:00.000Z", "2026-10-04T00:00:00.000Z");
      stores.driver.database.prepare(`
        INSERT INTO prompt_jobs(
          id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body,
          was_detached, dispatched_at, native_submission_id, state, observation_state, attempt_count, created_at, updated_at
        ) VALUES ('legacy-a', 'binding-1', 'legacy-message', 'feishu', 'legacy-message', 'user-1', 'possibly sent',
          1, '2026-10-04T00:00:01.000Z', 'legacy-submission', 'uncertain', 'detached', 1, ?, ?)
      `).run("2026-10-04T00:00:00.000Z", "2026-10-04T00:00:02.000Z");
      stores.driver.database.exec("DROP TABLE submission_intents; DELETE FROM schema_migrations WHERE version=88 OR version>=112; DROP TABLE schema_metadata");
      stores.lifecycle.close();

      stores = createTestStoreBundle(path);
      expect(stores.driver.database.prepare("SELECT 1 AS present FROM schema_migrations WHERE version = 88").get()).toEqual({ present: 1 });
      expect(stores.agentInputs.listRecoveryWork()).toEqual({ submit: [], query: [] });
      expect(stores.agentInputs.get("legacy-submission")).toBeNull();

      stores.agentInputs.admit(submission());
      stores.lifecycle.close();
      stores = createTestStoreBundle(path);
      expect(stores.agentInputs.listRecoveryWork()).toEqual({
        submit: [expect.objectContaining({ submissionId: "submission-1", state: "recorded" })],
        query: []
      });
    } finally {
      try { stores.lifecycle.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records migration 93 for the pending Input owner lookup index", () => {
    const directory = mkdtempSync(join(tmpdir(), "submission-owner-index-migration-"));
    const path = join(directory, "bridge.db");
    let stores = createTestStoreBundle(path);
    try {
      stores.driver.database.exec("DROP INDEX submission_intents_owner; DELETE FROM schema_migrations WHERE version=93 OR version>=112; DROP TABLE schema_metadata");
      stores.lifecycle.close();

      stores = createTestStoreBundle(path);
      expect(stores.driver.database.prepare("SELECT 1 AS present FROM schema_migrations WHERE version = 93").get()).toEqual({ present: 1 });
      expect(stores.driver.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'submission_intents_owner'").get())
        .toEqual({ name: "submission_intents_owner" });
    } finally {
      try { stores.lifecycle.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers an accepted ordinary submission without a legacy Input Card and never replays it", () => {
    const stores = createTestStoreBundle();
    ensurePrimaryBinding(stores);
    stores.agentInputs.admit(submission());
    stores.agentInputs.claimRecorded("submission-1", "2026-10-04T00:00:01.000Z");
    stores.agentInputs.recordReceipt("submission-1", receipt("observed"));

    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });
    expect(stores.agentInputs.listPendingCanonicalRecoveries(16, "2026-10-04T00:00:03.000Z"))
      .toEqual([expect.objectContaining({ submissionId: "submission-1", state: "observed" })]);
    expect(stores.agentInputs.listRecoveryWork()).toEqual({ submit: [], query: [] });

    stores.agentInputs.recordCanonicalRecoveryOutcome("submission-1", "ambiguous", "2026-10-04T00:00:04.000Z");
    expect(stores.agentInputs.getCanonicalRecoverySummary()).toEqual({ indexing: 0, needsHuman: 0, lastFailureCode: null });
    expect(stores.driver.database.prepare("SELECT state,failure_code FROM canonical_input_recovery_attempts WHERE submission_id='submission-1'").get())
      .toEqual({ state: "auto_closed", failure_code: "ambiguous" });
    expect(stores.agentInputs.listRecoveryWork()).toEqual({ submit: [], query: [] });

    stores.coreEvents.ingestBatch({
      laneId: "lane-recovered", sourceId: "source-recovered", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: "c1", latestCursor: "c1", ingestedAt: "2026-10-04T00:00:05.000Z",
      events: [{ schemaVersion: 1, eventId: "human-recovered", cursor: "c1", sourceId: "source-recovered", agentKind: "traex", sessionId: "session-1", turnId: "turn-recovered", occurredAt: "2026-10-04T00:00:05.000Z", payload: { type: "human_message", message_id: "message-recovered", text: "run the audit", truncated: false, submission_id: "submission-1" } }]
    });
    expect(stores.agentInputs.getCanonicalRecoverySummary()).toEqual({ indexing: 0, needsHuman: 0, lastFailureCode: null });

    stores.agentInputs.recordCanonicalRecoveryOutcome("submission-1", "not_found", "2026-10-04T00:00:06.000Z");
    expect(stores.agentInputs.getCanonicalRecoverySummary()).toEqual({ indexing: 0, needsHuman: 0, lastFailureCode: null });
    stores.agentInputs.reconcileCanonicalHumanMessages();
    expect(stores.agentInputs.getCanonicalRecoverySummary()).toEqual({ indexing: 0, needsHuman: 0, lastFailureCode: null });
  });

  it("auto-closes ambiguous canonical recovery rows without starving a later Input", () => {
    const directory = mkdtempSync(join(tmpdir(), "canonical-input-recovery-"));
    const path = join(directory, "bridge.db");
    let stores = createTestStoreBundle(path);
    try {
      for (let index = 1; index <= 17; index += 1) {
        const submissionId = `submission-${String(index).padStart(2, "0")}`;
        stores.driver.capabilityModules().agentInputs.admitLegacyPendingCard({
          ...submission(), submissionId, sourceMessageKey: `message-${index}`,
          recordedAt: `2026-10-04T00:00:${String(index).padStart(2, "0")}.000Z`
        }, { rootMessageId: "root-1", pendingCard: { state: "pending" }, workingCard: { state: "working" } });
        stores.agentInputs.claimRecorded(submissionId, "2026-10-04T00:01:00.000Z");
        stores.agentInputs.recordReceipt(submissionId, {
          ...receipt("observed"), submissionId, turnId: `turn-${index}`, startedAt: `2026-10-04T00:00:${String(index).padStart(2, "0")}.500Z`
        });
      }

      const firstPage = stores.agentInputs.listPendingCanonicalRecoveries(16, "2026-10-04T00:02:00.000Z");
      expect(firstPage).toHaveLength(16);
      for (const intent of firstPage) stores.agentInputs.recordCanonicalRecoveryOutcome(intent.submissionId, "ambiguous", "2026-10-04T00:02:01.000Z");
      expect(stores.agentInputs.getCanonicalRecoverySummary()).toEqual({ indexing: 0, needsHuman: 0, lastFailureCode: null });

      stores.lifecycle.close();
      stores = createTestStoreBundle(path);
      expect(stores.agentInputs.listPendingCanonicalRecoveries(16, "2026-10-04T00:02:02.000Z").map(({ submissionId }) => submissionId))
        .toEqual(["submission-17"]);
      expect(stores.driver.database.prepare("SELECT version FROM schema_migrations WHERE version=94").get()).toEqual({ version: 94 });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM canonical_input_recovery_attempts WHERE state='auto_closed'").get()).toEqual({ count: 16 });
    } finally {
      try { stores.lifecycle.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists recovered canonical settlement across reopen without making it eligible again", () => {
    const directory = mkdtempSync(join(tmpdir(), "canonical-recovery-settled-"));
    const path = join(directory, "bridge.db");
    let stores = createTestStoreBundle(path);
    try {
      ensurePrimaryBinding(stores);
      stores.agentInputs.admit(submission());
      stores.agentInputs.claimRecorded("submission-1", "2026-10-04T00:00:01.000Z");
      stores.agentInputs.recordReceipt("submission-1", receipt("observed"));
      expect(stores.agentInputs.listPendingCanonicalRecoveries()).toHaveLength(1);

      stores.agentInputs.recordCanonicalRecoveryOutcome("submission-1", "recovered", "2026-10-04T00:00:04.000Z");
      expect(stores.driver.database.prepare(`SELECT state,failure_code,attempt_count,next_attempt_at
        FROM canonical_input_recovery_attempts WHERE submission_id='submission-1'`).get()).toEqual({
        state: "recovered", failure_code: null, attempt_count: 0, next_attempt_at: null
      });
      expect(stores.agentInputs.listPendingCanonicalRecoveries()).toEqual([]);

      stores.lifecycle.close();
      stores = createTestStoreBundle(path);
      expect(stores.agentInputs.listPendingCanonicalRecoveries()).toEqual([]);
      expect(stores.driver.database.prepare("SELECT state FROM canonical_input_recovery_attempts WHERE submission_id='submission-1'").get())
        .toEqual({ state: "recovered" });
    } finally {
      try { stores.lifecycle.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles only active canonical recovery states and retains terminal audit rows", () => {
    const stores = createTestStoreBundle();
    ensurePrimaryBinding(stores);
    const outcomes = ["recovered", "ambiguous", "indexing", "indexing"] as const;
    for (let index = 0; index < outcomes.length; index += 1) {
      const ordinal = index + 1;
      const submissionId = `submission-${ordinal}`;
      stores.driver.capabilityModules().agentInputs.admitLegacyPendingCard({
        ...submission(), submissionId, sourceMessageKey: `message-${ordinal}`
      }, {
        segmentId: `segment-${ordinal}`, rootMessageId: "root-1", card: { state: "pending" }
      });
      stores.agentInputs.claimRecorded(submissionId, "2026-10-04T00:00:01.000Z");
      stores.agentInputs.recordReceipt(submissionId, {
        ...receipt("observed"), submissionId, turnId: `turn-${ordinal}`
      });
    }
    stores.coreEvents.ingestBatch({
      laneId: "lane-reconcile", sourceId: "source-reconcile", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: "c4", latestCursor: "c4", ingestedAt: "2026-10-04T00:00:05.000Z",
      events: outcomes.map((_, index) => {
        const ordinal = index + 1;
        return {
          schemaVersion: 1 as const, eventId: `human-${ordinal}`, cursor: `c${ordinal}`, sourceId: "source-reconcile",
          agentKind: "traex" as const, sessionId: "session-1", turnId: `turn-${ordinal}`,
          occurredAt: `2026-10-04T00:00:0${ordinal + 4}.000Z`,
          payload: {
            type: "human_message" as const, message_id: `message-${ordinal}`, text: "run the audit",
            truncated: false, submission_id: `submission-${ordinal}`
          }
        };
      })
    });
    for (let index = 0; index < outcomes.length; index += 1) {
      stores.agentInputs.recordCanonicalRecoveryOutcome(`submission-${index + 1}`, outcomes[index]!, "2026-10-04T00:00:09.000Z");
    }
    stores.driver.database.prepare(`UPDATE canonical_input_recovery_attempts
      SET state='needs_human',next_attempt_at=NULL WHERE submission_id='submission-4'`).run();

    expect(stores.agentInputs.observeCanonicalHumanMessage({
      submissionId: "submission-1", eventId: "human-1", agentKind: "traex", sessionId: "session-1",
      observedAt: "2026-10-04T00:00:10.000Z"
    })).toBe("duplicate");
    expect(stores.agentInputs.observeCanonicalHumanMessage({
      submissionId: "submission-2", eventId: "human-2", agentKind: "traex", sessionId: "session-1",
      observedAt: "2026-10-04T00:00:10.000Z"
    })).toBe("duplicate");
    expect(stores.agentInputs.reconcileCanonicalHumanMessages()).toBe(0);
    expect(stores.driver.database.prepare(`SELECT submission_id,state FROM canonical_input_recovery_attempts
      ORDER BY submission_id`).all()).toEqual([
      { submission_id: "submission-1", state: "recovered" },
      { submission_id: "submission-2", state: "auto_closed" }
    ]);
  });
});

function receipt(state: "prepared" | "observed" | "terminal") {
  return {
    submissionId: "submission-1",
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    agentKind: "traex" as const,
    sessionId: "session-1",
    state,
    turnId: state === "prepared" ? null : "turn-1",
    startedAt: state === "prepared" ? null : "2026-10-04T00:00:02.000Z",
    terminalState: state === "terminal" ? "completed" : null,
    createdAt: 1,
    updatedAt: state === "terminal" ? 3 : state === "observed" ? 2 : 1
  };
}

function ensurePrimaryBinding(stores: ReturnType<typeof createTestStoreBundle>): void {
  stores.driver.createPendingBinding({
    id: "binding-1",
    workspaceId: "workspace-1",
    chatId: "chat-1",
    topicId: "topic-1",
    rootMessageId: "root-1",
    title: "Primary"
  });
  stores.driver.updateBinding("binding-1", {
    generation: 3,
    state: "active",
    lifecycle: "active",
    attachment: "attached",
    paneId: "workspace-1:pane-1"
  });
}

function submission(): AdmitSubmissionIntentInput {
  return {
    submissionId: "submission-1",
    ingressSource: "feishu:primary",
    sourceMessageKey: "message-1",
    actor: {
      kind: "human",
      id: "user-1",
      gatewayId: "feishu:primary",
      chatId: "chat-1",
      topicId: "topic-1",
      rootMessageId: "root-1"
    },
    text: "run the audit",
    owner: { kind: "primary", id: "binding-1", generation: 3 },
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    expectedAgentKind: "traex",
    expectedSessionId: "session-1",
    recordedAt: "2026-10-04T00:00:00.000Z"
  };
}
