import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatNativeInputBatch } from "../src/domain/native-input-batch.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { SqliteStoreKernel } from "./helpers/sqlite-store-kernel.js";

describe("Prompt execution lifecycle", () => {
  let store: SqliteStoreKernel | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    store?.close();
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    store = undefined;
    temporaryDirectory = undefined;
  });

  it("classifies legacy nonterminal rows from durable dispatch and exact-turn evidence", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-prompt-lifecycle-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteStoreKernel(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });

    for (const [index, promptId] of ["undispatched", "attached", "detached", "exact", "terminal"].entries()) {
      const occurredAt = `2026-10-01T11:00:0${index}.000Z`;
      const view = createQueuedRunCard({
        promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1",
        requestText: promptId, queuePosition: index + 1, occurredAt
      });
      store.acceptPrompt({
        prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "user-1", body: promptId },
        view, rootMessageId: "root", answerCard: {}
      });
    }
    store.database.exec(`
      UPDATE prompt_jobs SET state='running', observation_state='attached', dispatched_at='2026-10-01T11:01:00.000Z', native_submission_id='attached' WHERE id='attached';
      UPDATE prompt_jobs SET state='running', observation_state='detached', was_detached=1, dispatched_at='2026-10-01T11:01:01.000Z', native_submission_id='detached' WHERE id='detached';
      UPDATE prompt_jobs SET state='running', observation_state='detached', was_detached=1, dispatched_at='2026-10-01T11:01:02.000Z', native_submission_id='exact', transcript_turn_id='turn-exact', transcript_turn_started_at='2026-10-01T11:01:02.500Z' WHERE id='exact';
      UPDATE prompt_jobs SET state='failed', observation_state='completed', error='historical failure' WHERE id='terminal';
      DROP TABLE IF EXISTS schema_metadata;
      DELETE FROM schema_migrations WHERE version=72 OR version>=112;
    `);
    store.close();
    store = new SqliteStoreKernel(path);

    expect(store.getPrompt("undispatched")).toMatchObject({ state: "queued", observationState: "not_started" });
    expect(store.getPrompt("attached")).toMatchObject({ state: "submitted", observationState: "attached" });
    expect(store.getPrompt("detached")).toMatchObject({ state: "recovering", observationState: "detached" });
    expect(store.getPrompt("exact")).toMatchObject({ state: "running", observationState: "detached", transcriptTurnId: "turn-exact" });
    expect(store.getPrompt("terminal")).toMatchObject({ state: "failed", observationState: "completed", error: "historical failure" });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version=72").get()).toEqual({ version: 72 });

    store.close();
    store = new SqliteStoreKernel(path);
    expect(store.getPrompt("attached")?.state).toBe("submitted");
    expect(store.getPrompt("detached")?.state).toBe("recovering");
  });

  it("moves durable native acceptance through submitted to exact running ownership", () => {
    store = new SqliteStoreKernel(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    for (const [index, promptId] of ["first", "following"].entries()) {
      const view = createQueuedRunCard({
        promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId,
        queuePosition: index + 1, occurredAt: `2026-10-01T12:00:0${index}.000Z`
      });
      store.acceptPrompt({
        prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "user-1", body: promptId },
        view, rootMessageId: "root", answerCard: {}
      });
    }

    const first = store.claimNextDispatchablePrompt("b1")!;
    expect(first.executionBody).toBe("first");
    expect(first.prompt).toMatchObject({ id: "first", state: "submitted", observationState: "not_started" });
    expect(store.markPromptNativeQueued({
      promptId: "first", bindingId: "b1", submissionId: "first", dispatchedAt: "2026-10-01T12:00:02.000Z"
    })).toBe(true);
    expect(store.getPrompt("first")).toMatchObject({ state: "submitted", observationState: "detached", transcriptTurnId: null });

    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.claimPromptTranscriptTurn({
      promptId: "first", bindingId: "b1", turnId: "turn-first", startedAt: "2026-10-01T12:00:02.500Z"
    })).toMatchObject({ state: "claimed", prompt: { state: "running", observationState: "attached", transcriptTurnId: "turn-first" } });
    store.markPromptObservationDetached("first", "observer lost");
    expect(store.getPrompt("first")).toMatchObject({ state: "running", observationState: "detached", transcriptTurnId: "turn-first" });
  });

  it("reconverges an accepted native receipt idempotently after process reopen without replay", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-native-receipt-reopen-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteStoreKernel(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    const view = createQueuedRunCard({
      promptId: "prompt-1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1",
      requestText: "continue", queuePosition: 1, occurredAt: "2026-10-02T10:00:00.000Z"
    });
    store.acceptPrompt({
      prompt: { id: "prompt-1", bindingId: "b1", larkMessageId: "message-1", actorOpenId: "user-1", body: "continue" },
      view, rootMessageId: "root", answerCard: {}
    });
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("prompt-1");
    expect(store.fencePromptNativeSubmission({
      promptId: "prompt-1", bindingId: "b1", submissionId: "prompt-1", dispatchedAt: "2026-10-02T10:00:01.000Z"
    })).toBe(true);
    store.close();
    store = new SqliteStoreKernel(path);
    store.recoverRunningPrompts();

    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      expect(store.applyPromptNativeSubmissionReceipt({
        promptId: "prompt-1", bindingId: "b1", submissionId: "prompt-1", dispatchedAt: "2026-10-02T10:00:01.000Z",
        state: "accepted", notice: "Core confirmed the native submission; observing execution without replay"
      })).toBe(true);
    }

    expect(store.getPrompt("prompt-1")).toMatchObject({
      state: "recovering", observationState: "detached", nativeSubmissionId: "prompt-1",
      transcriptTurnId: null, transcriptTurnStartedAt: null,
      error: "Core confirmed the native submission; observing execution without replay"
    });
    expect(store.loadRunCard("prompt-1")).toMatchObject({
      phase: "recovering", notice: "Core confirmed the native submission; observing execution without replay"
    });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
  });

  it("releases a durable rejected receipt after process reopen because Core proves the PTY boundary was not crossed", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-native-rejected-reopen-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteStoreKernel(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    const view = createQueuedRunCard({
      promptId: "prompt-1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1",
      requestText: "continue", queuePosition: 1, occurredAt: "2026-10-02T10:00:00.000Z"
    });
    store.acceptPrompt({
      prompt: { id: "prompt-1", bindingId: "b1", larkMessageId: "message-1", actorOpenId: "user-1", body: "continue" },
      view, rootMessageId: "root", answerCard: {}
    });
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("prompt-1");
    expect(store.fencePromptNativeSubmission({
      promptId: "prompt-1", bindingId: "b1", submissionId: "prompt-1", dispatchedAt: "2026-10-02T10:00:01.000Z"
    })).toBe(true);
    store.close();
    store = new SqliteStoreKernel(path);
    store.recoverRunningPrompts();

    expect(store.releaseRejectedNativeSubmission({
      promptId: "prompt-1", bindingId: "b1", submissionId: "prompt-1", dispatchedAt: "2026-10-02T10:00:01.000Z"
    })).toBe(true);
    expect(store.releaseRejectedNativeSubmission({
      promptId: "prompt-1", bindingId: "b1", submissionId: "prompt-1", dispatchedAt: "2026-10-02T10:00:01.000Z"
    })).toBe(false);
    expect(store.getPrompt("prompt-1")).toMatchObject({ state: "queued", observationState: "not_started", dispatchedAt: null });
    expect(store.loadRunCard("prompt-1")).toMatchObject({ phase: "queued", notice: null });
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("prompt-1");
  });

  it("keeps formed Native Input Batches queued until the exact Primary turn settles", () => {
    store = new SqliteStoreKernel(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    const activeView = createQueuedRunCard({
      promptId: "active", bindingId: "b1", title: "active", workspaceId: "w1", paneId: "w1:p1",
      requestText: "active", queuePosition: 1, occurredAt: "2026-10-02T12:00:00.000Z"
    });
    store.acceptPrompt({
      prompt: { id: "active", bindingId: "b1", larkMessageId: "active-message", actorOpenId: "user-1", body: "active" },
      view: activeView, rootMessageId: "root", answerCard: {}
    });
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("active");
    store.markPromptDispatched("active", "2026-10-02T12:00:00.500Z");
    expect(store.claimPromptTranscriptTurn({
      promptId: "active", bindingId: "b1", turnId: "turn-active", startedAt: "2026-10-02T12:00:01.000Z"
    })).toMatchObject({ state: "claimed" });
    store.updateBinding("b1", { lastAgentState: "working" });

    store.acceptCollectingNativeInput({
      input: {
        id: "input-1", bindingId: "b1", bindingGeneration: 1, ingressSource: "feishu",
        sourceMessageKey: "message-1", larkMessageId: "message-1", actorOpenId: "user-1",
        body: "next", rootMessageId: "root", parentPromptId: null
      },
      batchId: "batch-1", occurredAt: "2026-10-02T12:00:02.000Z", windowMs: 2_000, maxQueueDepth: 20
    });
    store.formDueNativeInputBatch({
      bindingId: "b1", occurredAt: "2026-10-02T12:00:04.000Z", nextBatchId: "batch-2", windowMs: 2_000,
      createProjection: ({ batchId, binding, combinedBody, titleSource, queuePosition }) => ({
        view: createQueuedRunCard({
          promptId: batchId, bindingId: binding.id, bindingGeneration: binding.generation, title: titleSource,
          workspaceId: binding.workspaceId, paneId: binding.paneId, requestText: combinedBody, queuePosition,
          occurredAt: "2026-10-02T12:00:04.000Z"
        }),
        rootMessageId: "root", answerCard: { batchId }
      })
    });

    store.acceptCollectingNativeInput({
      input: {
        id: "input-2", bindingId: "b1", bindingGeneration: 1, ingressSource: "feishu",
        sourceMessageKey: "message-2", larkMessageId: "message-2", actorOpenId: "user-2",
        body: "later", rootMessageId: "root", parentPromptId: null
      },
      batchId: "batch-2", occurredAt: "2026-10-02T12:00:05.000Z", windowMs: 2_000, maxQueueDepth: 20
    });
    store.formDueNativeInputBatch({
      bindingId: "b1", occurredAt: "2026-10-02T12:00:07.000Z", nextBatchId: "batch-3", windowMs: 2_000,
      createProjection: ({ batchId, binding, combinedBody, titleSource, queuePosition }) => ({
        view: createQueuedRunCard({
          promptId: batchId, bindingId: binding.id, bindingGeneration: binding.generation, title: titleSource,
          workspaceId: binding.workspaceId, paneId: binding.paneId, requestText: combinedBody, queuePosition,
          occurredAt: "2026-10-02T12:00:07.000Z"
        }),
        rootMessageId: "root", answerCard: { batchId }
      })
    });

    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    store.database.prepare("UPDATE prompt_jobs SET state = 'delivered', observation_state = 'completed' WHERE id = 'active'").run();
    store.updateBinding("b1", { lastAgentState: "idle" });
    const firstBatch = store.claimNextDispatchablePrompt("b1");
    expect(firstBatch).toMatchObject({
      prompt: { id: "batch-1", state: "submitted" },
      executionBody: "next",
      nativeInputBatch: true
    });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.markPromptNativeQueued({
      promptId: "batch-1", bindingId: "b1", submissionId: "batch-1", dispatchedAt: "2026-10-02T12:00:08.000Z"
    })).toBe(true);
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    store.database.prepare("UPDATE prompt_jobs SET state = 'delivered', observation_state = 'completed' WHERE id = 'batch-1'").run();
    expect(store.claimNextDispatchablePrompt("b1")).toMatchObject({
      prompt: { id: "batch-2", state: "submitted" },
      nativeInputBatch: true
    });
  });

  it("reconstructs a formed Native Input Batch execution body from durable members after reopen", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-native-execution-body-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteStoreKernel(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "working",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    const bodies = ["first", "[Feishu message 1/1]\nliteral user text", "third"];
    bodies.forEach((body, index) => store!.acceptCollectingNativeInput({
      input: {
        id: `input-${index + 1}`, bindingId: "b1", bindingGeneration: 1, ingressSource: "feishu",
        sourceMessageKey: `message-${index + 1}`, larkMessageId: `message-${index + 1}`, actorOpenId: `user-${index + 1}`,
        body, rootMessageId: "root", parentPromptId: null
      },
      batchId: "batch-1", occurredAt: `2026-10-02T12:00:0${index}.000Z`, windowMs: 2_000, maxQueueDepth: 20
    }));
    const formed = store.formDueNativeInputBatch({
      bindingId: "b1", occurredAt: "2026-10-02T12:00:04.000Z", nextBatchId: "batch-2", windowMs: 2_000,
      createProjection: ({ batchId, binding, combinedBody, titleSource, queuePosition }) => ({
        view: createQueuedRunCard({
          promptId: batchId, bindingId: binding.id, bindingGeneration: binding.generation, title: titleSource,
          workspaceId: binding.workspaceId, paneId: binding.paneId, requestText: combinedBody, queuePosition,
          occurredAt: "2026-10-02T12:00:04.000Z"
        }),
        rootMessageId: "root", answerCard: { batchId }
      })
    });
    expect(formed).toMatchObject({ outcome: "formed", prompt: { body: formatNativeInputBatch(bodies) } });
    store.close();
    store = new SqliteStoreKernel(path);
    store.updateBinding("b1", { lastAgentState: "idle" });

    expect(store.claimNextDispatchablePrompt("b1", { nativeInputBatchOnly: true })).toMatchObject({
      prompt: { id: "batch-1", body: formatNativeInputBatch(bodies) },
      executionBody: bodies.join("\n\n"),
      nativeInputBatch: true
    });
  });

  it("refuses a formed Native Input Batch whose durable member sequence is incomplete", () => {
    store = new SqliteStoreKernel(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "working",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    store.acceptCollectingNativeInput({
      input: {
        id: "input-1", bindingId: "b1", bindingGeneration: 1, ingressSource: "feishu",
        sourceMessageKey: "message-1", larkMessageId: "message-1", actorOpenId: "user-1",
        body: "next", rootMessageId: "root", parentPromptId: null
      },
      batchId: "batch-1", occurredAt: "2026-10-02T12:00:00.000Z", windowMs: 2_000, maxQueueDepth: 20
    });
    store.formDueNativeInputBatch({
      bindingId: "b1", occurredAt: "2026-10-02T12:00:03.000Z", nextBatchId: "batch-2", windowMs: 2_000,
      createProjection: ({ batchId, binding, combinedBody, titleSource, queuePosition }) => ({
        view: createQueuedRunCard({
          promptId: batchId, bindingId: binding.id, bindingGeneration: binding.generation, title: titleSource,
          workspaceId: binding.workspaceId, paneId: binding.paneId, requestText: combinedBody, queuePosition,
          occurredAt: "2026-10-02T12:00:03.000Z"
        }),
        rootMessageId: "root", answerCard: { batchId }
      })
    });
    store.database.prepare("DELETE FROM native_input_batch_members WHERE batch_id = ?").run("batch-1");
    store.updateBinding("b1", { lastAgentState: "idle" });

    expect(() => store!.claimNextDispatchablePrompt("b1", { nativeInputBatchOnly: true }))
      .toThrow("Native Input Batch batch-1 has invalid durable members");
    expect(store.getPrompt("batch-1")).toMatchObject({ state: "queued", observationState: "not_started" });

    store.database.prepare(`
      INSERT INTO native_input_batch_members(batch_id, prompt_input_id, ordinal, created_at)
      VALUES (?, ?, 2, ?)
    `).run("batch-1", "input-1", "2026-10-02T12:00:03.000Z");
    expect(() => store!.claimNextDispatchablePrompt("b1", { nativeInputBatchOnly: true }))
      .toThrow("Native Input Batch batch-1 has invalid durable members");
    expect(() => store!.database.prepare(`
      INSERT INTO native_input_batch_members(batch_id, prompt_input_id, ordinal, created_at)
      VALUES (?, ?, 1, ?)
    `).run("batch-1", "input-1", "2026-10-02T12:00:03.000Z")).toThrow();
    expect(store.getPrompt("batch-1")).toMatchObject({ state: "queued", observationState: "not_started" });
  });

  it("keeps identity-less recovery inside the execution slot until explicitly resolved", () => {
    store = new SqliteStoreKernel(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    for (const [index, promptId] of ["historical", "following"].entries()) {
      const view = createQueuedRunCard({
        promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId,
        queuePosition: index + 1, occurredAt: `2026-10-01T13:00:0${index}.000Z`
      });
      store.acceptPrompt({
        prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "user-1", body: promptId },
        view, rootMessageId: "root", answerCard: {}
      });
    }

    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("historical");
    expect(store.markPromptNativeQueued({
      promptId: "historical", bindingId: "b1", submissionId: "historical", dispatchedAt: "2026-10-01T13:00:02.000Z"
    })).toBe(true);
    store.markPromptObservationDetached("historical", "observer lost before exact identity");
    expect(store.getPrompt("historical")).toMatchObject({ state: "recovering", observationState: "detached" });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.getPrompt("following")).toMatchObject({ id: "following", state: "queued" });
  });
});
