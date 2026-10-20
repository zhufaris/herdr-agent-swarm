import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "../src/config.js";
import { StartupViewConverger, type StartupViewConvergerOptions } from "../src/coordinator/startup-view-converger.js";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { MainCardWorkflow } from "../src/coordinator/main-card-workflow.js";
import { WorkerTurnCardWorkflow } from "../src/coordinator/worker-turn-card-workflow.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import type { OutboundIntentPort } from "../src/domain/ports.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { applicationPresentation, primaryPresentation, workerPresentation } from "./helpers/presentation.js";

const config = {
  projects: [{ id: "bridge", displayName: "Bridge", spaceName: "herdr-lark-bridge", description: "Bridge", workspaceId: "wH", cwd: "/work/bridge" }]
} as const satisfies Pick<BridgeConfig, "projects">;

function createConverger(store: SqliteBindingStore, overrides: Partial<StartupViewConvergerOptions> = {}): StartupViewConverger {
  const outboundWork = overrides.outboundWork ?? { wake: () => {}, subscribe: () => () => {} };
  return new StartupViewConverger({
    config,
    stores: { startupViews: store },
    outbound: { enqueueCardUpdate: vi.fn() } as unknown as OutboundIntentPort,
    outboundWork,
    presentation: primaryPresentation,
    answerPages: new AnswerPageWorkflow(store, () => outboundWork.wake(), primaryPresentation),
    mainCards: new MainCardWorkflow(store, () => outboundWork.wake(), primaryPresentation),
    ...overrides
  });
}

describe("StartupViewConverger", () => {
  it("adopts exact delivered Completion Review receipts before projecting startup views", async () => {
    const store = new SqliteBindingStore(":memory:");
    const recoverDeliveredCompletionReviews = vi.fn(() => ({ activated: 1, alreadyActive: 2, alreadyTerminal: 3, invalid: 1 }));
    const logger = { warn: vi.fn() };
    Object.assign(store, { recoverDeliveredCompletionReviews });

    await createConverger(store, { logger }).converge();

    expect(recoverDeliveredCompletionReviews).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "startup-completion-review-receipts-invalid", activated: 1, alreadyActive: 2,
      alreadyTerminal: 3, invalid: 1, outcome: "deferred"
    }), expect.any(String));
  });

  it("adopts only an exact delivered fresh-review receipt after SQLite reopen and preserves pending or uncertain presentations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "completion-review-startup-reopen-"));
    const databasePath = join(directory, "bridge.db");
    let store = new SqliteBindingStore(databasePath);
    try {
      store.createPendingBinding({ id: "binding-review", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary", creatorOpenId: "ou_actor" });
      store.updateBinding("binding-review", {
        state: "active", lifecycle: "active", attachment: "attached", paneId: "wH:p1", traexSessionId: "terminal",
        agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1", lastAgentState: "idle"
      });
      const view = createQueuedRunCard({ promptId: "prompt-review", bindingId: "binding-review", bindingGeneration: 1, title: "Review", workspaceId: "wH", paneId: "wH:p1", requestText: "review", queuePosition: 1, occurredAt: "2026-10-01T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: view.promptId, bindingId: view.bindingId, larkMessageId: "request", actorOpenId: "ou_actor", body: view.requestText }, view, rootMessageId: "root", answerCard: {} });
      const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === view.promptId && reply.kind === "stream_card_create")!;
      store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
      store.database.prepare("UPDATE prompt_jobs SET state='delivered',session_epoch=1 WHERE id=?").run(view.promptId);
      store.database.prepare("UPDATE run_cards SET phase='completed' WHERE prompt_id=?").run(view.promptId);
      store.database.prepare("UPDATE answer_pages SET state='finished' WHERE prompt_id=?").run(view.promptId);
      for (const id of ["delivered-review", "pending-review", "uncertain-review", "invalid-review"]) {
        store.enqueueOutboundReply({ id, idempotencyKey: id, bindingId: "binding-review", bindingGeneration: 1, promptId: view.promptId, rootMessageId: "root", kind: "card_reply", targetRole: "operation_result", payload: JSON.stringify({ id }), projectionKey: `completion-review:${id}:surface:1`, snapshotRevision: 1 });
      }
      store.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='review-message',card_id_checkpoint='review-card' WHERE id='delivered-review'").run();
      store.database.prepare("UPDATE outbound_replies SET state='dead_letter',effect_certainty='uncertain' WHERE id='uncertain-review'").run();
      store.database.prepare("UPDATE outbound_replies SET state='delivered' WHERE id='invalid-review'").run();
      const insertAction = store.database.prepare(`INSERT INTO completion_action_sets(
        id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,mention_open_id,
        presentation_kind,presentation_generation,presentation_reply_id,state,created_at,updated_at
      ) VALUES(?,?,?,1,'binding-review',1,0,'ou_actor','fresh-card',1,?,'presenting',?,?)`);
      const timestamp = "2026-10-01T00:00:02.000Z";
      insertAction.run("action-delivered", "primary-prompt", view.promptId, "delivered-review", timestamp, timestamp);
      insertAction.run("action-pending", "primary-prompt", "pending-owner", "pending-review", timestamp, timestamp);
      insertAction.run("action-uncertain", "primary-prompt", "uncertain-owner", "uncertain-review", timestamp, timestamp);
      insertAction.run("action-invalid", "primary-prompt", "invalid-owner", "invalid-review", timestamp, timestamp);
      store.close();

      store = new SqliteBindingStore(databasePath);
      await createConverger(store, { stores: { startupViews: store.capabilityModules().startupViews } }).converge();

      expect(store.database.prepare("SELECT state,presentation_message_id,presentation_card_id FROM completion_action_sets WHERE id='action-delivered'").get())
        .toEqual({ state: "active", presentation_message_id: "review-message", presentation_card_id: "review-card" });
      expect(store.database.prepare("SELECT state FROM completion_action_sets WHERE id IN ('action-pending','action-uncertain','action-invalid') ORDER BY id").all())
        .toEqual([{ state: "presenting" }, { state: "presenting" }, { state: "presenting" }]);
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'completion-review:%'").get()).toEqual({ count: 4 });
      expect(store.database.prepare("SELECT state,failure_code FROM projection_gaps WHERE source_item_id='invalid-review'").get())
        .toEqual({ state: "open", failure_code: "completion_review_startup_receipt_conflict" });
      const status = store.getOperationalSummary().completionReviews;
      expect(status).toMatchObject({ presenting: 3, active: 1, pendingPresentations: 1, uncertainPresentations: 1, deliveredPresentationsAwaitingAdoption: 1 });
      expect(JSON.stringify(status)).not.toContain("review-message");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers retained Session Activity before startup view projection", async () => {
    const store = new SqliteBindingStore(":memory:");
    const recoverRetainedMultiAgentActivity = vi.fn(() => ({ recoveredAgents: 1, visibleChanged: true, remaining: false }));

    await createConverger(store, { sessionActivity: { recoverRetainedMultiAgentActivity } }).converge();

    expect(recoverRetainedMultiAgentActivity).toHaveBeenCalledOnce();
    expect(recoverRetainedMultiAgentActivity).toHaveBeenCalledWith(expect.objectContaining({ limit: 128 }));
    store.close();
  });

  it("drains up to two retained Session Activity recovery pages during one convergence pass", async () => {
    const store = new SqliteBindingStore(":memory:");
    const recoverRetainedMultiAgentActivity = vi.fn()
      .mockReturnValueOnce({ recoveredAgents: 0, visibleChanged: false, remaining: true, nextCursor: "cursor-1" })
      .mockReturnValueOnce({ recoveredAgents: 1, visibleChanged: true, remaining: false, nextCursor: null });

    await createConverger(store, { sessionActivity: { recoverRetainedMultiAgentActivity } }).converge();

    expect(recoverRetainedMultiAgentActivity).toHaveBeenCalledTimes(2);
    expect(recoverRetainedMultiAgentActivity).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 128 }));
    expect(recoverRetainedMultiAgentActivity).toHaveBeenNthCalledWith(2, expect.objectContaining({ afterCursor: "cursor-1" }));
    store.close();
  });

  it("continues a bounded retained recovery cursor without repeating full convergence work", async () => {
    const store = new SqliteBindingStore(":memory:");
    const startupViews = store.capabilityModules().startupViews;
    const recoverDeliveredCompletionReviews = vi.spyOn(startupViews, "recoverDeliveredCompletionReviews");
    const recoverStaleOutboxQuarantines = vi.spyOn(startupViews, "recoverStaleOutboxQuarantines");
    const listStartupViewBindings = vi.spyOn(startupViews, "listStartupViewBindings");
    const recoverRetainedMultiAgentActivity = vi.fn()
      .mockReturnValueOnce({ recoveredAgents: 0, visibleChanged: false, remaining: true, nextCursor: "cursor-1" })
      .mockReturnValueOnce({ recoveredAgents: 0, visibleChanged: false, remaining: true, nextCursor: "cursor-2" })
      .mockReturnValueOnce({ recoveredAgents: 1, visibleChanged: true, remaining: false, nextCursor: null });
    const converger = createConverger(store, { stores: { startupViews }, sessionActivity: { recoverRetainedMultiAgentActivity } });

    await expect(converger.converge()).resolves.toEqual({ failedBindingIds: [], fullRescanRequired: true });
    expect(recoverRetainedMultiAgentActivity).toHaveBeenCalledTimes(2);
    await expect(converger.continueRetainedActivity()).resolves.toEqual({ failedBindingIds: [], fullRescanRequired: false });

    expect(recoverRetainedMultiAgentActivity).toHaveBeenCalledTimes(3);
    expect(recoverRetainedMultiAgentActivity).toHaveBeenNthCalledWith(3, expect.objectContaining({ afterCursor: "cursor-2" }));
    expect(recoverDeliveredCompletionReviews).toHaveBeenCalledOnce();
    expect(recoverStaleOutboxQuarantines).toHaveBeenCalledOnce();
    expect(listStartupViewBindings).toHaveBeenCalledOnce();
    store.close();
  });

  it("invokes unified Turn Card actionable convergence on startup", async () => {
    const store = new SqliteBindingStore(":memory:");
    const turnCards = { convergeActionable: vi.fn(async () => []) };
    await createConverger(store, { turnCards }).converge();
    expect(turnCards.convergeActionable).toHaveBeenCalledOnce();
    store.close();
  });

  it("refuses startup convergence before any view work when an active semantic cohort is unsafe", async () => {
    const store = new SqliteBindingStore(":memory:");
    const turnCards = { convergeActionable: vi.fn(async () => []) };
    const rolloutGuard = { assertSemanticDeliveryStartupSafe: vi.fn(() => { throw new Error("semantic_delivery_startup_refused:unsupported_versions"); }) };
    await expect(createConverger(store, { turnCards, rolloutGuard }).converge()).rejects.toThrow("unsupported_versions");
    expect(turnCards.convergeActionable).not.toHaveBeenCalled();
    store.close();
  });

  it("reserves authoritative Worker snapshots before releasing startup quarantines", async () => {
    const store = new SqliteBindingStore(":memory:");
    const order: string[] = [];
    const workerTurnCards = { converge: vi.fn(async () => undefined), convergeActionable: vi.fn(async () => { order.push("worker"); return []; }) };
    vi.spyOn(store, "recoverStaleOutboxQuarantines").mockImplementation(() => {
      order.push("recovery");
      return { retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 };
    });

    await createConverger(store, { workerTurnCards }).converge();

    expect(order).toEqual(["worker", "recovery"]);
    store.close();
  });

  it("requests the existing full-rescan path after isolating failed Worker cards", async () => {
    const store = new SqliteBindingStore(":memory:");
    const workerTurnCards = { converge: vi.fn(async () => undefined), convergeActionable: vi.fn(async () => ["bad-worker-turn"]) };
    const mainCards = { project: vi.fn(async () => undefined) };

    await expect(createConverger(store, { workerTurnCards, mainCards }).converge()).rejects.toThrow("1 Worker Task Card");

    expect(mainCards.project).not.toHaveBeenCalled();
    store.close();
  });

  it("recovers stale outbox quarantines before projecting views and wakes delivery", async () => {
    const store = new SqliteBindingStore(":memory:");
    const recover = vi.spyOn(store, "recoverStaleOutboxQuarantines").mockReturnValue({ retriedAnswerPromptIds: ["p1"], rolledBackAnswerPromptIds: [], dismissedNotices: 1, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
    const wake = vi.fn();

    await createConverger(store, { outboundWork: { wake, subscribe: () => () => {} } }).converge();

    expect(recover).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("reports terminalized quarantines without waking an empty outbox", async () => {
    const store = new SqliteBindingStore(":memory:");
    vi.spyOn(store, "recoverStaleOutboxQuarantines").mockReturnValue({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 2
    });
    const wake = vi.fn();
    const logger = { warn: vi.fn() };

    await createConverger(store, { outboundWork: { wake, subscribe: () => () => {} }, logger }).converge();

    expect(wake).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "startup-outbox-quarantines-recovered", terminalizedQuarantines: 2 }),
      expect.any(String)
    );
    store.close();
  });

  it("reports a superseded Answer target and wakes its released snapshot lane", async () => {
    const store = new SqliteBindingStore(":memory:");
    vi.spyOn(store, "recoverStaleOutboxQuarantines").mockReturnValue({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 1, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0
    });
    const wake = vi.fn();
    const logger = { warn: vi.fn() };

    await createConverger(store, { outboundWork: { wake, subscribe: () => () => {} }, logger }).converge();

    expect(wake).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "startup-outbox-quarantines-recovered", resolvedSupersededAnswerTargets: 1 }),
      expect.any(String)
    );
    store.close();
  });

  it("wakes a superseded Worker Main snapshot lane", async () => {
    const store = new SqliteBindingStore(":memory:");
    vi.spyOn(store, "recoverStaleOutboxQuarantines").mockReturnValue({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 1, terminalizedQuarantines: 0
    });
    const wake = vi.fn();
    const logger = { warn: vi.fn() };

    await createConverger(store, { outboundWork: { wake, subscribe: () => () => {} }, logger }).converge();

    expect(wake).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "startup-outbox-quarantines-recovered", releasedSupersededWorkerMainUpdates: 1 }),
      expect.any(String)
    );
    store.close();
  });

  it("reports rejected immutable cleanup without waking an empty outbox", async () => {
    const store = new SqliteBindingStore(":memory:");
    vi.spyOn(store, "recoverStaleOutboxQuarantines").mockReturnValue({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 2, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0
    });
    const wake = vi.fn();
    const logger = { warn: vi.fn() };

    await createConverger(store, { outboundWork: { wake, subscribe: () => () => {} }, logger }).converge();

    expect(wake).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "startup-outbox-quarantines-recovered", dismissedRejectedImmutableEffects: 2 }),
      expect.any(String)
    );
    store.close();
  });

  it("continues with later bindings when one binding view cannot converge", async () => {
    const store = new SqliteBindingStore(":memory:");
    for (const id of ["bad", "good"]) {
      store.createPendingBinding({ id, projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: id, rootMessageId: `root-${id}`, title: id });
      store.updateBinding(id, { paneId: `wH:${id}`, statusMessageId: `root-${id}`, state: "active" });
    }
    const mainCards = { project: vi.fn(async (view: { bindingId: string }) => { if (view.bindingId === "bad") throw new Error("bad view"); }) };
    const logger = { warn: vi.fn() };
    const converger = createConverger(store, { mainCards, logger });

    await expect(converger.converge()).resolves.toEqual({ failedBindingIds: ["bad"], fullRescanRequired: false });
    expect(mainCards.project).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "startup-view-binding-failed", bindingId: "bad" }), expect.any(String));
    store.close();
  });

  it("isolates one historical Answer convergence failure and still projects the current Answer and Main Card", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    for (const [promptId, occurredAt] of [["old", "2026-09-27T00:00:00Z"], ["current", "2026-09-27T00:01:00Z"]] as const) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "wH", paneId: "wH:p1", requestText: promptId, queuePosition: 0, occurredAt });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view: { ...view, phase: "running" }, rootMessageId: "root", answerCard: {} });
      store.markOutboundReplyDelivered(store.listPendingOutboundReplies().find((reply) => reply.promptId === promptId)!.id, `answer-${promptId}`, `answer-card-${promptId}`);
    }
    const answerPages = { converge: vi.fn(async (promptId: string) => { if (promptId === "old") throw new Error("outbound_idempotency_conflict"); }) };
    const mainCards = { project: vi.fn(async () => undefined) };
    const logger = { warn: vi.fn() };

    await expect(createConverger(store, { answerPages, mainCards, logger }).converge()).resolves.toEqual({ failedBindingIds: [], fullRescanRequired: false });

    expect(answerPages.converge).toHaveBeenCalledWith("current", "history");
    expect(mainCards.project).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "startup-answer-view-failed", promptId: "old" }), expect.any(String));
    store.close();
  });

  it("reprojects an existing root card using the durable binding title", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({
      id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "herdr-lark-bridge / task-ab12"
    });
    store.updateBinding("b1", { paneId: "wH:p2H", statusMessageId: "root-card", state: "active" });
    store.saveTopicView({
      ...initialTopicView("b1"), title: "HerderSwarm: 已就绪", workspaceId: "wH", spaceName: "old-space", paneId: "wH:p2H", phase: "ready"
    });
    const enqueueCardUpdate = vi.fn<OutboundIntentPort["enqueueCardUpdate"]>().mockResolvedValue(undefined);
    const outbound = { enqueueCardUpdate } as Pick<OutboundIntentPort, "enqueueCardUpdate">;
    await createConverger(store, { outbound: outbound as OutboundIntentPort }).converge();

    expect(store.loadTopicView("b1")).toMatchObject({
      title: "herdr-lark-bridge / task-ab12", spaceName: "herdr-lark-bridge", paneId: "wH:p2H"
    });
    expect(enqueueCardUpdate).not.toHaveBeenCalled();
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      kind: "card_update", bindingId: "b1", viewVersion: 1, targetRole: "session_status", workClass: "history"
    })]);
    store.close();
  });

  it("preserves unresolved legacy workspace naming when that workspace has multiple projects", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "legacy", projectId: null, workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "legacy task" });
    store.updateBinding("legacy", { paneId: "w1:p1", statusMessageId: "root-card", state: "active" });
    const enqueueCardUpdate = vi.fn<OutboundIntentPort["enqueueCardUpdate"]>().mockResolvedValue(undefined);
    const multiProjectConfig = { projects: [
      { id: "one", displayName: "One", spaceName: "one", description: "One", workspaceId: "w1", cwd: "/one" },
      { id: "two", displayName: "Two", spaceName: "two", description: "Two", workspaceId: "w1", cwd: "/two" }
    ] } as const satisfies Pick<BridgeConfig, "projects">;

    await createConverger(store, { config: multiProjectConfig, outbound: { enqueueCardUpdate } as OutboundIntentPort }).converge();

    expect(store.loadTopicView("legacy")?.spaceName).toBe("legacy/unresolved");
    store.close();
  });

  it("does not enqueue a Main Card update when its durable version is already delivered", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "task", workspaceId: "wH", spaceName: "herdr-lark-bridge", paneId: "wH:p1", phase: "ready", viewVersion: 1, deliveredVersion: 1 });

    await createConverger(store).converge();

    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.loadTopicView("b1")).toMatchObject({ viewVersion: 1, deliveredVersion: 1 });
    store.close();
  });

  it("terminalizes a queued Run Card whose legacy Prompt was migrated", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached" });
    const queued = createQueuedRunCard({ promptId: "legacy", bindingId: "b1", title: "legacy", workspaceId: "wH", paneId: "wH:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-10-04T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "legacy", bindingId: "b1", larkMessageId: "message", actorOpenId: "u1", body: "go" }, view: queued, rootMessageId: "root", answerCard: {} });
    const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === "legacy")!;
    store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
    store.database.prepare("UPDATE prompt_jobs SET state = 'cancelled', observation_state = 'completed', error = 'Legacy input migrated to independent Agent Input.' WHERE id = 'legacy'").run();
    await createConverger(store).converge();

    expect(store.loadRunCard("legacy")).toMatchObject({ phase: "failed", notice: "Legacy input migrated to independent Agent Input." });
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([
      expect.objectContaining({ promptId: "legacy", kind: "stream_content", cardRole: "answer", payload: expect.stringContaining("Legacy input migrated") })
    ]));
    store.close();
  });

  it("does not replay fully delivered historical Answer cards during startup", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "renamed task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    for (let index = 0; index < 100; index += 1) {
      const promptId = `history-${index}`;
      const queued = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, sessionTitle: "old title", workspaceId: "wH", spaceName: "old-space", paneId: "wH:p1", requestText: promptId, queuePosition: 0, occurredAt: `2026-08-01T00:00:${String(index % 60).padStart(2, "0")}.000Z` });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view: queued, rootMessageId: "root", answerCard: {} });
      const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === promptId)!;
      store.markOutboundReplyDelivered(create.id, `answer-${index}`, `card-${index}`);
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase: "completed", answer: "done", answerSegments: ["done"], workerContextFrozenAt: "2026-08-01T00:01:00.000Z", viewVersion: 1, answerDeliveredVersion: 1 });
      store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = ?").run(promptId);
    }
    const enqueueCardUpdate = vi.fn<OutboundIntentPort["enqueueCardUpdate"]>();

    await createConverger(store, { outbound: { enqueueCardUpdate } as unknown as OutboundIntentPort }).converge();

    expect(enqueueCardUpdate).not.toHaveBeenCalled();
    expect(store.listPendingOutboundReplies().filter((reply) => reply.cardRole === "answer")).toEqual([]);
    expect(store.loadRunCard("history-0")).toMatchObject({ sessionTitle: "old title", spaceName: "old-space", viewVersion: 1 });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "done", activePromptId: null });
    store.close();
  });

  it("replaces a pristine pending Primary legacy reminder with the sole fresh Completion Review after reopen", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-primary-completion-startup-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    let store = new SqliteBindingStore(databasePath);
    try {
      store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary", creatorOpenId: "ou_creator" });
      store.updateBinding("b1", { paneId: "wH:p1", paneToken: "p001", statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
      const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", bindingGeneration: 1, title: "work", workspaceId: "wH", paneId: "wH:p1", paneToken: "p001", requestText: "go", queuePosition: 1, occurredAt: "2026-10-01T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "request", ingressSource: "feishu", actorOpenId: "ou_actor", body: "go" }, view: queued, rootMessageId: "root", answerCard: {} });
      const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === "p1" && reply.kind === "stream_card_create")!;
      store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
      store.updatePrompt("p1", "running");
      store.completeTurn({ promptId: "p1", bindingId: "b1", answer: "final assistant message\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"继续吗？\",\"default\":\"approve\",\"options\":[{\"id\":\"approve\",\"label\":\"批准\",\"message\":\"default\"}]}\n```", occurredAt: "2026-10-01T00:00:01.000Z", outputFingerprint: "fp" });
      const completed = store.loadRunCard("p1")!;
      store.saveRunCard({ ...completed, answerDeliveredVersion: completed.viewVersion });
      store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'p1'").run();
      store.enqueueOutboundReply({ id: "legacy-primary", idempotencyKey: "primary-next-input:b1:1:p1", bindingId: "b1", promptId: "p1", rootMessageId: "root", kind: "text", targetRole: "operation_result", payload: "需要你的选择" });
      store.database.prepare("UPDATE completion_notification_obligations SET state = 'released', notification_reply_id = 'legacy-primary', released_at = updated_at WHERE owner_kind = 'primary-prompt' AND owner_id = 'p1'").run();
      store.close();

      store = new SqliteBindingStore(databasePath);
      const wake = vi.fn();
      await createConverger(store, {
        stores: { startupViews: store.capabilityModules().startupViews },
        answerPages: new AnswerPageWorkflow(store, () => wake(), applicationPresentation),
        outboundWork: { wake, subscribe: () => () => {} }
      }).converge();

      expect(store.listPendingOutboundReplies().filter((reply) => reply.projectionKey?.startsWith("completion-review:"))).toHaveLength(1);
      expect(store.database.prepare("SELECT state, error FROM outbound_replies WHERE id = 'legacy-primary'").get()).toEqual({
        state: "dismissed",
        error: "Human Review mention became obsolete before first delivery attempt"
      });
      expect(store.database.prepare("SELECT state, mention_open_id, card_message_id FROM completion_action_sets WHERE owner_kind = 'primary-prompt' AND owner_id = 'p1'").get()).toEqual({
        state: "presenting", mention_open_id: "ou_actor", card_message_id: null
      });
      expect(store.database.prepare("SELECT state,notification_reply_id FROM completion_notification_obligations WHERE owner_kind = 'primary-prompt' AND owner_id = 'p1'").get()).toEqual({ state: "suppressed", notification_reply_id: null });
      expect(wake).toHaveBeenCalled();
    } finally {
      store.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rediscovers native-input completion-action cleanup after commit and reopen", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-native-action-reopen-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    let store = new SqliteBindingStore(databasePath);
    try {
      store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary", creatorOpenId: "ou_creator" });
      store.updateBinding("b1", { paneId: "wH:p1", paneToken: "p001", statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
      const queued = createQueuedRunCard({ promptId: "completed", bindingId: "b1", bindingGeneration: 1, title: "work", workspaceId: "wH", paneId: "wH:p1", paneToken: "p001", requestText: "go", queuePosition: 1, occurredAt: "2026-10-01T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: queued.promptId, bindingId: queued.bindingId, larkMessageId: "request", ingressSource: "feishu", actorOpenId: "ou_actor", body: queued.requestText }, view: queued, rootMessageId: "root", answerCard: {} });
      const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === queued.promptId && reply.kind === "stream_card_create")!;
      store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
      store.updatePrompt(queued.promptId, "running");
      store.completeTurn({ promptId: queued.promptId, bindingId: queued.bindingId, answer: "final assistant message\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"继续吗？\",\"default\":\"approve\",\"options\":[{\"id\":\"approve\",\"label\":\"批准\",\"message\":\"default\"}]}\n```", occurredAt: "2026-10-01T00:00:01.000Z", outputFingerprint: "fp" });
      store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = ?").run(queued.promptId);

      const wake = vi.fn();
      await new AnswerPageWorkflow(store, wake, applicationPresentation).converge(queued.promptId, "history");
      const visibleButtons = store.listPendingOutboundReplies().find((reply) => reply.promptId === queued.promptId && reply.kind === "card_update")!;
      expect(visibleButtons.payload).not.toContain("批准");
      store.markOutboundReplyDelivered(visibleButtons.id, "answer-message", "answer-card");
      expect(store.loadRunCard(queued.promptId)?.answerDeliveredVersion).toBe(store.loadRunCard(queued.promptId)?.viewVersion);

      store.updateBinding("b1", { lastAgentState: "idle" });
      const combinedBody = "[Feishu message 1/1]\nnew human input";
      const next = createQueuedRunCard({ promptId: "native-batch", bindingId: "b1", bindingGeneration: 1, title: "Next", workspaceId: "wH", paneId: "wH:p1", paneToken: "p001", requestText: combinedBody, queuePosition: 1, occurredAt: "2026-10-01T00:00:02.000Z" });
      const accepted = store.acceptImmediateNativeInputBatch({
        input: { id: "native-input", bindingId: "b1", bindingGeneration: 1, ingressSource: "feishu", sourceMessageKey: "native-source", larkMessageId: "native-message", actorOpenId: "ou_actor", body: "new human input", rootMessageId: "root", parentPromptId: null },
        batchId: "native-batch", combinedBody, occurredAt: "2026-10-01T00:00:02.000Z", view: next, answerCard: {}, maxQueueDepth: 20
      });
      expect(accepted.supersededPromptIds).toEqual([queued.promptId]);
      // Simulate a throw/crash after SQLite commit by intentionally dropping the
      // process-local supersededPromptIds cleanup hint and reopening the store.
      store.close();

      store = new SqliteBindingStore(databasePath);
      await createConverger(store, {
        stores: { startupViews: store.capabilityModules().startupViews },
        outboundWork: { wake, subscribe: () => () => {} }
      }).converge();

      const cleanup = store.listPendingOutboundReplies().find((reply) => reply.promptId === queued.promptId && reply.kind === "card_update");
      expect(cleanup, "startup convergence must rediscover the durable stale-button projection").toBeDefined();
      expect(cleanup!.payload).not.toContain("批准");
      expect(cleanup!.payload).not.toContain("继续");
      expect(store.database.prepare("SELECT state FROM completion_action_sets WHERE owner_kind = 'primary-prompt' AND owner_id = ?").get(queued.promptId)).toEqual({ state: "superseded" });
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_inputs WHERE source_message_key = 'native-source'").get()).toEqual({ count: 1 });
      expect(store.database.prepare("SELECT state FROM prompt_jobs WHERE id = 'native-batch'").get()).toEqual({ state: "queued" });
    } finally {
      store.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("preserves a possible-effect legacy reminder and does not reserve a replacement Completion Review", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary", creatorOpenId: "ou_creator" });
    store.updateBinding("b1", { paneId: "wH:p1", paneToken: "p001", statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", bindingGeneration: 1, title: "work", workspaceId: "wH", paneId: "wH:p1", paneToken: "p001", requestText: "go", queuePosition: 1, occurredAt: "2026-10-01T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "request", actorOpenId: "ou_actor", body: "go" }, view: queued, rootMessageId: "root", answerCard: {} });
    const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === "p1" && reply.kind === "stream_card_create")!;
    store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
    store.updatePrompt("p1", "running");
    store.completeTurn({ promptId: "p1", bindingId: "b1", answer: "final assistant message\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"继续吗？\",\"default\":\"approve\",\"options\":[{\"id\":\"approve\",\"label\":\"批准\",\"message\":\"default\"}]}\n```", occurredAt: "2026-10-01T00:00:01.000Z", outputFingerprint: "fp" });
    const completed = store.loadRunCard("p1")!;
    store.saveRunCard({ ...completed, answerDeliveredVersion: completed.viewVersion });
    store.database.prepare("UPDATE answer_pages SET state='finished' WHERE prompt_id='p1'").run();

    store.enqueueOutboundReply({ id: "legacy-primary", idempotencyKey: "primary-next-input:b1:1:p1", bindingId: "b1", promptId: "p1", rootMessageId: "root", kind: "text", targetRole: "operation_result", payload: "需要你的选择" });
    store.database.prepare(`UPDATE outbound_replies SET attempt_count=1,effect_certainty='uncertain' WHERE id='legacy-primary'`).run();
    store.database.prepare("UPDATE completion_notification_obligations SET state = 'released', notification_reply_id = 'legacy-primary', released_at = updated_at WHERE owner_kind = 'primary-prompt' AND owner_id = 'p1'").run();

    await createConverger(store, {
      stores: { startupViews: store.capabilityModules().startupViews },
      answerPages: new AnswerPageWorkflow(store, vi.fn(), applicationPresentation)
    }).converge();

    expect(store.database.prepare("SELECT state,attempt_count,effect_certainty FROM outbound_replies WHERE id = 'legacy-primary'").get())
      .toEqual({ state: "pending", attempt_count: 1, effect_certainty: "uncertain" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM completion_action_sets").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT state,notification_reply_id FROM completion_notification_obligations WHERE owner_kind='primary-prompt' AND owner_id='p1'").get())
      .toEqual({ state: "released", notification_reply_id: "legacy-primary" });
    store.close();
  });

  it("replaces a pristine pending Worker legacy reminder with the sole fresh Completion Review after reopen", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-worker-completion-startup-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    let store = new SqliteBindingStore(databasePath);
    try {
      store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary", creatorOpenId: "ou_creator" });
      store.updateBinding("b1", { paneId: "wH:p1", paneToken: "p001", statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
      const created = store.createWorkerAgentInstance({ id: "reviewer", projectId: "bridge", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "b1", bindingGeneration: 1, paneId: "wH:p1", nativeSessionId: "primary-session" }, workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/work/bridge", branch: null, baseCommit: "base" } }, 4).instance;
      const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "wH", paneId: "wH:p2", paneToken: "p002", nativeSessionId: "worker-session" })!;
      const queued = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null, rootMessageId: "worker-root", requestText: "go", queuePosition: 1, occurredAt: "2026-10-01T00:00:00.000Z" });
      store.acceptInstanceTurnWithCard({ id: queued.turnId, idempotencyKey: queued.turnId, actor: { kind: "human", userId: "ou_actor", channel: "feishu" }, projectId: "bridge", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: queued.requestText, parentTurnId: null, sourceMessageId: "m1", view: queued, render: workerPresentation.workerTurn });
      store.claimNextInstanceTurn(worker.id, worker.generation);
      store.transitionInstanceTurnWithProjection({ turnId: queued.turnId, expectedGeneration: worker.generation, state: "completed", result: "final worker message\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"继续吗？\",\"default\":\"approve\",\"options\":[{\"id\":\"approve\",\"label\":\"批准\",\"message\":\"default\"}]}\n```", eventKind: "turn.completed", change: { type: "completed", occurredAt: "2026-10-01T00:00:01.000Z", answer: "final worker message\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"继续吗？\",\"default\":\"approve\",\"options\":[{\"id\":\"approve\",\"label\":\"批准\",\"message\":\"default\"}]}\n```" }, render: workerPresentation.workerTurn });
      const completed = store.loadWorkerTurnCard(queued.turnId)!;
      store.database.prepare("UPDATE worker_turn_cards SET delivered_version = ? WHERE turn_id = ?").run(completed.viewVersion, queued.turnId);
      store.database.prepare("UPDATE worker_turn_card_pages SET state = 'finished', message_id = 'worker-message', card_id = 'worker-card' WHERE turn_id = ?").run(queued.turnId);
      store.enqueueOutboundReply({ id: "legacy-worker", idempotencyKey: `worker-next-input:${worker.id}:${worker.workerSessionGeneration}:${queued.turnId}`, bindingId: "b1", rootMessageId: "root", kind: "text", targetRole: "operation_result", payload: "需要你的选择" });
      store.database.prepare("UPDATE completion_notification_obligations SET state = 'released', notification_reply_id = 'legacy-worker', released_at = updated_at WHERE owner_kind = 'worker-turn' AND owner_id = 'turn-1'").run();
      store.close();

      store = new SqliteBindingStore(databasePath);
      const wake = vi.fn();
      await createConverger(store, {
        stores: { startupViews: store.capabilityModules().startupViews },
        outboundWork: { wake, subscribe: () => () => {} },
        workerTurnCards: new WorkerTurnCardWorkflow(store, wake, applicationPresentation)
      }).converge();

      const review = store.listPendingOutboundReplies().find((reply) => reply.workerTurnId === "turn-1" && reply.projectionKey?.startsWith("completion-review:"));
      expect(review?.kind).toBe("card_reply");
      expect(review?.payload).toContain("继续吗？");
      expect(review?.payload).toContain("批准");
      expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'legacy-worker'").get()).toEqual({ state: "dismissed" });
      expect(store.database.prepare("SELECT state, mention_open_id, card_message_id FROM completion_action_sets WHERE owner_kind = 'worker-turn' AND owner_id = 'turn-1'").get()).toEqual({
        state: "presenting", mention_open_id: "ou_actor", card_message_id: null
      });
      expect(store.database.prepare("SELECT state,notification_reply_id FROM completion_notification_obligations WHERE owner_kind = 'worker-turn' AND owner_id = 'turn-1'").get()).toEqual({ state: "suppressed", notification_reply_id: null });
      expect(wake).toHaveBeenCalled();
    } finally {
      store.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("does not visit a terminal binding whose Main and Answer views are fully delivered", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "historical", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "history" });
    store.updateBinding("historical", { paneId: "wH:p1", statusMessageId: "root", state: "archived", lifecycle: "archived", attachment: "unattached" });
    store.saveTopicView({ ...initialTopicView("historical"), title: "history", workspaceId: "wH", spaceName: "herdr-lark-bridge", paneId: "wH:p1", phase: "done", viewVersion: 1, deliveredVersion: 1 });
    const queued = createQueuedRunCard({ promptId: "done", bindingId: "historical", title: "done", workspaceId: "wH", paneId: "wH:p1", requestText: "done", queuePosition: 0, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "done", bindingId: "historical", larkMessageId: "message-done", actorOpenId: "u1", body: "done" }, view: queued, rootMessageId: "root", answerCard: {} });
    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "answer", "card");
    store.saveRunCard({ ...store.loadRunCard("done")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 1, answerDeliveredVersion: 1 });
    store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'done'").run();
    const mainCards = { project: vi.fn(async () => undefined) };

    await createConverger(store, { mainCards }).converge();

    expect(mainCards.project).not.toHaveBeenCalled();
    store.close();
  });

  it("does not synthesize a new startup projection for a terminal binding without a Pane", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "pending-view", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "pending" });
    store.updateBinding("pending-view", { statusMessageId: "root", state: "archived", lifecycle: "archived", attachment: "unattached" });
    store.saveTopicView({ ...initialTopicView("pending-view"), title: "pending", workspaceId: "wH", spaceName: "herdr-lark-bridge", phase: "done", viewVersion: 2, deliveredVersion: 1 });

    await expect(createConverger(store).convergeBindings(["absent", "pending-view"])).resolves.toEqual([]);

    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.loadTopicView("pending-view")).toMatchObject({ viewVersion: 2, deliveredVersion: 1 });
    store.close();
  });

  it("keeps a dirty terminal binding deliverable while its Pane is retained", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "retained-pane", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "retained" });
    store.updateBinding("retained-pane", { paneId: "wH:p1", statusMessageId: "root", state: "archived", lifecycle: "archived", attachment: "unattached" });
    store.saveTopicView({ ...initialTopicView("retained-pane"), title: "retained", workspaceId: "wH", spaceName: "herdr-lark-bridge", paneId: "wH:p1", phase: "archived", viewVersion: 2, deliveredVersion: 1 });
    const mainCards = { project: vi.fn(async () => undefined) };

    await expect(createConverger(store, { mainCards }).convergeBindings(["retained-pane"])).resolves.toEqual([]);

    expect(mainCards.project).toHaveBeenCalledOnce();
    expect(mainCards.project).toHaveBeenCalledWith(expect.objectContaining({ bindingId: "retained-pane", paneId: "wH:p1" }), "history");
    store.close();
  });

  it("reloads a selected binding after an earlier projection yields to a terminal transition", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "selection-blocker", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic-blocker", rootMessageId: "root-blocker", title: "blocker" });
    store.updateBinding("selection-blocker", { paneId: "wH:p0", statusMessageId: "root-blocker", state: "active", lifecycle: "active", attachment: "attached" });
    store.createPendingBinding({ id: "selection-race", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "race" });
    store.updateBinding("selection-race", { paneId: "wH:p1", statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached" });
    const realMainCards = new MainCardWorkflow(store, () => {}, primaryPresentation);
    let releaseBlocker!: () => void;
    let projectionStarted!: () => void;
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const started = new Promise<void>((resolve) => { projectionStarted = resolve; });
    const mainCards = { project: vi.fn(async (view, workClass) => {
      if (view.bindingId === "selection-blocker") { projectionStarted(); await blocker; }
      await realMainCards.project(view, workClass);
    }) } satisfies Pick<MainCardWorkflow, "project">;

    const converging = createConverger(store, { mainCards }).convergeBindings(["selection-blocker", "selection-race"]);
    await started;
    store.updateBinding("selection-race", { paneId: null, state: "archived", lifecycle: "archived", attachment: "unattached" });
    releaseBlocker();
    await expect(converging).resolves.toEqual([]);

    expect(mainCards.project.mock.calls.map(([view]) => view.bindingId)).toEqual(["selection-blocker"]);
    expect(store.listPendingOutboundReplies().filter(({ bindingId }) => bindingId === "selection-race")).toEqual([]);
    store.close();
  });

  it("restores the running prompt instead of a newer completed card", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "task", workspaceId: "wH", paneId: "wH:p1", phase: "done", agentState: "done", activePromptId: null });
    const parent = createQueuedRunCard({ promptId: "parent", bindingId: "b1", title: "parent", workspaceId: "wH", paneId: "wH:p1", requestText: "work", queuePosition: 0, occurredAt: "2026-08-28T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "parent-message", actorOpenId: "u1", body: "work" }, view: { ...parent, phase: "running" }, rootMessageId: "root", answerCard: {} });
    const completed = createQueuedRunCard({ promptId: "completed", bindingId: "b1", title: "completed", workspaceId: "wH", paneId: "wH:p1", requestText: "more", queuePosition: 0, occurredAt: "2026-08-28T00:01:00Z" });
    store.acceptPrompt({ prompt: { id: "completed", bindingId: "b1", larkMessageId: "completed-message", actorOpenId: "u1", body: "more" }, view: { ...completed, phase: "completed" }, rootMessageId: "root", answerCard: {} });

    await createConverger(store).converge();

    expect(store.loadTopicView("b1")).toMatchObject({ phase: "running", agentState: "working", activePromptId: "parent" });
    store.close();
  });

  it("rebuilds missing terminal CardKit stream content from a durable completed run", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "work", workspaceId: "wH", paneId: "wH:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "request", actorOpenId: "u1", body: "go" }, view: queued, rootMessageId: "root", answerCard: {} });
    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "durable answer", answerSegments: ["durable answer"], viewVersion: 3, answerDeliveredVersion: 1 });
    const outbound = { enqueueCardUpdate: vi.fn() } as unknown as OutboundIntentPort;

    await createConverger(store, { outbound }).converge();

    const pending = store.listPendingOutboundReplies();
    const answer = pending.find((reply) => reply.promptId === "p1");
    expect(answer).toMatchObject({ kind: "stream_content", intentKind: "stream-content", promptId: "p1", rootMessageId: "answer-card", workClass: "history" });
    expect(JSON.parse(answer!.payload)).toMatchObject({ content: expect.stringContaining("durable answer"), pageIndex: 0 });
    expect(pending).toContainEqual(expect.objectContaining({ kind: "card_update", bindingId: "b1", targetRole: "session_status", workClass: "history" }));
    store.close();
  });

  it("backfills the binding title on legacy Run Cards", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "herdr-lark-bridge / task-ab12" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    const legacy = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "work", workspaceId: "wH", spaceName: "herdr-lark-bridge", paneId: "wH:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "request", actorOpenId: "u1", body: "go" }, view: legacy, rootMessageId: "root", answerCard: {} });

    await createConverger(store).converge();

    expect(store.loadRunCard("p1")).toMatchObject({ sessionTitle: "herdr-lark-bridge / task-ab12", viewVersion: 2 });
    store.close();
  });

  it("reconciles an actionable Run Card to the Binding's authoritative Agent kind", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task", agentKind: "codex" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    const stale = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "work", workspaceId: "wH", paneId: "wH:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "request", actorOpenId: "u1", body: "go" }, view: stale, rootMessageId: "root", answerCard: {} });

    await createConverger(store).converge();

    expect(store.loadRunCard("p1")).toMatchObject({ agentKind: "codex", viewVersion: 2 });
    store.close();
  });
});
