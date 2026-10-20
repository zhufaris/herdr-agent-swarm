import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectionDeliveryRecoveryWatchdog } from "../src/coordinator/projection-delivery-recovery-watchdog.js";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { BindingPromptWorkflow } from "../src/coordinator/binding-prompt-workflow.js";
import { WorkerTurnCardWorkflow } from "../src/coordinator/worker-turn-card-workflow.js";
import { answerElementId, createQueuedRunCard } from "../src/domain/run-card-view.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { applicationPresentation, primaryPresentation, workerPresentation } from "./helpers/presentation.js";
import { prepareOutboundGatewayIntent } from "../src/events/outbound-gateway-intent.js";
import type { DeliveryFailureMetadata } from "../src/domain/types.js";

describe("ProjectionDeliveryRecoveryWatchdog", () => {
  it("converges each recoverable Primary Answer once across a periodic scan", async () => {
    const converge = vi.fn(async () => undefined);
    const convergeWorker = vi.fn(async () => undefined);
    const debug = vi.fn();
    const watchdog = new ProjectionDeliveryRecoveryWatchdog({
      store: {
        listRecoverablePrimaryAnswerPromptIds: () => ["p1", "p1", "p2"],
        listRecoverableWorkerTurnIds: () => ["t1", "t1", "t2"]
      },
      answerPages: { converge },
      workerTurns: { converge: convergeWorker },
      logger: { warn: vi.fn(), debug }
    });

    await watchdog.scan();

    expect(converge.mock.calls).toEqual([["p1", "history"], ["p2", "history"]]);
    expect(convergeWorker.mock.calls).toEqual([["t1"], ["t2"]]);
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      event: "projection-delivery-recovery-converged",
      recoveryId: "primary-answer:p1",
      projectionKind: "primary_answer"
    }), expect.any(String));
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      event: "projection-delivery-recovery-converged",
      recoveryId: "worker-task:t1",
      projectionKind: "worker_task"
    }), expect.any(String));
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      event: "projection-delivery-recovery-scan-completed",
      primaryAnswerCount: 2,
      workerTaskCount: 2,
      candidateCount: 4,
      durationMs: expect.any(Number)
    }), expect.any(String));
    await watchdog.stop();
  });

  it("coalesces repeated immediate wake hints for one Primary Answer", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const converge = vi.fn(async () => blocked);
    const watchdog = new ProjectionDeliveryRecoveryWatchdog({
      store: { listRecoverablePrimaryAnswerPromptIds: () => [], listRecoverableWorkerTurnIds: () => [] },
      answerPages: { converge },
      workerTurns: { converge: vi.fn(async () => undefined) },
      logger: { warn: vi.fn(), debug: vi.fn() }
    });

    const first = watchdog.requestPrompt("p1");
    const second = watchdog.requestPrompt("p1");
    release();
    await Promise.all([first, second]);

    expect(converge).toHaveBeenCalledTimes(1);
    expect(converge).toHaveBeenCalledWith("p1", "history");
    await watchdog.stop();
  });

  it("coalesces repeated immediate wake hints for one Worker Task", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const converge = vi.fn(async () => blocked);
    const watchdog = new ProjectionDeliveryRecoveryWatchdog({
      store: { listRecoverablePrimaryAnswerPromptIds: () => [], listRecoverableWorkerTurnIds: () => [] },
      answerPages: { converge: vi.fn(async () => undefined) },
      workerTurns: { converge },
      logger: { warn: vi.fn(), debug: vi.fn() }
    });

    const first = watchdog.requestWorkerTurn("t1");
    const second = watchdog.requestWorkerTurn("t1");
    release();
    await Promise.all([first, second]);

    expect(converge).toHaveBeenCalledTimes(1);
    expect(converge).toHaveBeenCalledWith("t1");
    await watchdog.stop();
  });

  it("backfills proven historical Primary Answer and Worker Task gaps after reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "projection-recovery-watchdog-"));
    const databasePath = join(directory, "bridge.db");
    let store = new SqliteBindingStore(databasePath);
    try {
      store.createPendingBinding({ id: "b1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "primary-root", title: "Primary" });
      store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:primary", statusMessageId: "primary-root" });
      const primary = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Primary", workspaceId: "w1", paneId: "w1:primary", requestText: "run", queuePosition: 1, occurredAt: "2026-10-02T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "human-primary", actorOpenId: "user", body: "run" }, view: primary, rootMessageId: "primary-root", answerCard: {} });
      const primaryCreate = store.listPendingOutboundReplies().find(({ promptId }) => promptId === "p1")!;
      store.markOutboundReplyDelivered(primaryCreate.id, "answer-message", "answer-card");
      store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "durable primary result", answerSegments: ["durable primary result"], viewVersion: 2 });
      expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "answer-card", elementId: answerElementId("p1", 0), content: "durable primary result", source: "durable primary result" })).toBe("reserved");
      const primaryContent = store.listPendingOutboundReplies().find(({ promptId, kind }) => promptId === "p1" && kind === "stream_content")!;
      failPrepared(store, primaryContent.id, "target deleted", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230011", recoveryKind: "defunct_target" });

      store.createPendingBinding({ id: "b2", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-primary-root", title: "Worker Parent" });
      store.updateBinding("b2", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:worker-primary", statusMessageId: "worker-primary-root" });
      const createdWorker = store.createWorkerAgentInstance({
        id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
        parent: { bindingId: "b2", bindingGeneration: 1, paneId: "w1:worker-primary", nativeSessionId: "primary-session" },
        workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
      }, 4).instance;
      const worker = store.attachAgentInstanceRuntime({
        instanceId: createdWorker.id,
        expectedGeneration: createdWorker.generation,
        herdrWorkspaceId: "w1",
        paneId: "w1:reviewer",
        nativeSessionId: "reviewer-session"
      })!;
      const workerView = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null, rootMessageId: "worker-root", requestText: "review", queuePosition: 1, occurredAt: "2026-10-02T00:00:00.000Z" });
      store.acceptInstanceTurnWithCard({ id: workerView.turnId, idempotencyKey: workerView.turnId, actor: { kind: "human", userId: "user" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: workerView.requestText, parentTurnId: null, sourceMessageId: "human-worker", view: workerView, render: workerPresentation.workerTurn });
      const workerCreate = store.listPendingOutboundReplies().find(({ workerTurnId }) => workerTurnId === "turn-1")!;
      store.markOutboundReplyDelivered(workerCreate.id, "worker-message", "worker-card");
      store.database.prepare("UPDATE worker_turn_cards SET phase = 'completed', answer = 'durable worker result', sequence = 2, view_version = 2 WHERE turn_id = 'turn-1'").run();
      store.database.prepare("UPDATE worker_turn_card_pages SET sequence = 2 WHERE turn_id = 'turn-1' AND page_index = 0").run();
      store.enqueueOutboundReply({ id: "worker-content", idempotencyKey: "worker-content", bindingId: "b2", workerId: worker.id, workerSessionGeneration: worker.workerSessionGeneration, workerTurnId: "turn-1", viewVersion: 2, cardSequence: 2, streamPageIndex: 0, projectionKey: "worker-task:turn-1:page:0", rootMessageId: "worker-card", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: workerView.elementId, content: "durable worker result", sequence: 2 }), laneKeyOverride: "worker-turn:turn-1" });
      failPrepared(store, "worker-content", "target deleted", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230011", recoveryKind: "defunct_target" });
      store.close();

      store = new SqliteBindingStore(databasePath);
      const watchdog = new ProjectionDeliveryRecoveryWatchdog({
        store,
        answerPages: new AnswerPageWorkflow(store, vi.fn(), primaryPresentation),
        workerTurns: new WorkerTurnCardWorkflow(store, vi.fn(), workerPresentation),
        logger: { warn: vi.fn(), debug: vi.fn() }
      });
      await watchdog.scan();

      expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([
        expect.objectContaining({ promptId: "p1", kind: "stream_card_create", workClass: "history" }),
        expect.objectContaining({ workerTurnId: "turn-1", kind: "stream_card_create", workClass: "history" })
      ]));
      expect(store.listRecoverablePrimaryAnswerPromptIds(10)).toEqual(["p1"]);
      expect(store.listRecoverableWorkerTurnIds(10)).toEqual(["turn-1"]);
      await watchdog.stop();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not schedule obsolete inline cleanup when a fresh review is superseded after in-process convergence failure", async () => {
    const store = new SqliteBindingStore(":memory:");
    try {
      store.createPendingBinding({ id: "b1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "primary-root", title: "Primary", creatorOpenId: "ou_creator" });
      store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:primary", lastAgentState: "idle" });
      const completed = createQueuedRunCard({ promptId: "completed", bindingId: "b1", bindingGeneration: 1, title: "Completed", workspaceId: "w1", paneId: "w1:primary", requestText: "first", queuePosition: 1, occurredAt: "2026-10-02T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: completed.promptId, bindingId: completed.bindingId, larkMessageId: "human-primary", ingressSource: "feishu", actorOpenId: "ou_actor", body: completed.requestText }, view: completed, rootMessageId: "primary-root", answerCard: {} });
      const create = store.listPendingOutboundReplies().find(({ promptId, kind }) => promptId === completed.promptId && kind === "stream_card_create")!;
      store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
      store.updatePrompt(completed.promptId, "running");
      store.completeTurn({ promptId: completed.promptId, bindingId: completed.bindingId, answer: "done\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"继续吗？\",\"default\":\"approve\",\"options\":[{\"id\":\"approve\",\"label\":\"批准\",\"message\":\"default\"}]}\n```", occurredAt: "2026-10-02T00:00:01.000Z", outputFingerprint: "fp" });
      const answerPages = new AnswerPageWorkflow(store, vi.fn(), applicationPresentation);
      await answerPages.converge(completed.promptId);
      const content = store.listPendingOutboundReplies().find(({ promptId, kind }) => promptId === completed.promptId && kind === "stream_content")!;
      store.markOutboundReplyDelivered(content.id, "answer-message", "answer-card");
      await answerPages.converge(completed.promptId);
      const finish = store.listPendingOutboundReplies().find(({ promptId, kind }) => promptId === completed.promptId && kind === "stream_finish")!;
      const initialFinalCard = store.listPendingOutboundReplies().find(({ promptId, kind }) => promptId === completed.promptId && kind === "card_update")!;
      store.markOutboundReplyDelivered(finish.id, "answer-message", "answer-card");
      store.markOutboundReplyDelivered(initialFinalCard.id, "answer-message", "answer-card");
      expect(store.listPendingOutboundReplies().filter(({ promptId, kind }) => promptId === completed.promptId && kind === "card_update")).toEqual([]);
      expect(store.database.prepare("SELECT presentation_kind, state FROM completion_action_sets WHERE owner_kind = 'primary-prompt' AND owner_id = ?").get(completed.promptId)).toEqual({ presentation_kind: "fresh-card", state: "presenting" });

      const workflow = new BindingPromptWorkflow({
        config: { projects: [{ id: "p1", displayName: "Project", description: "Project", workspaceId: "w1", cwd: "/repo" }], maxQueueDepth: 20 },
        store,
        lifecycleEvents: { publish: vi.fn(async () => undefined) },
        outboundWork: { wake: vi.fn(), subscribe: vi.fn() },
        scheduler: { wake: vi.fn(), subscribe: vi.fn() },
        presentation: primaryPresentation,
        convergeAnswer: vi.fn(async () => { throw new Error("post-commit convergence failed"); })
      });
      const binding = store.getBinding("b1")!;

      await expect(workflow.acceptManagedInput({
        binding,
        body: "next",
        actor: { openId: "ou_actor" },
        ingressSource: "feishu",
        sourceMessageKey: "human-next",
        larkMessageId: "human-next",
        parentPromptId: completed.promptId,
        initialProjectionContext: { rootMessageId: "primary-root" }
      })).rejects.toThrow("post-commit convergence failed");

      expect(store.database.prepare("SELECT state FROM completion_action_sets WHERE owner_kind = 'primary-prompt' AND owner_id = ?").get(completed.promptId)).toEqual({ state: "superseded" });
      expect(store.listRecoverablePrimaryAnswerPromptIdsForBinding("b1", 10)).toEqual([]);
      expect(store.listRecoverablePrimaryAnswerPromptIdsForBinding("missing", 10)).toEqual([]);
      const executionBeforeRecovery = store.database.prepare("SELECT id, state, attempt_count FROM prompt_jobs ORDER BY created_at, rowid").all();
      const watchdog = new ProjectionDeliveryRecoveryWatchdog({
        store,
        answerPages,
        workerTurns: { converge: vi.fn(async () => undefined) },
        logger: { warn: vi.fn(), debug: vi.fn() }
      });

      await watchdog.scan();
      const cleanup = store.listPendingOutboundReplies().filter(({ promptId, kind }) => promptId === completed.promptId && kind === "card_update");
      expect(cleanup).toEqual([]);
      await watchdog.scan();
      expect(store.listPendingOutboundReplies().filter(({ promptId, kind }) => promptId === completed.promptId && kind === "card_update")).toEqual([]);
      expect(store.database.prepare("SELECT id, state, attempt_count FROM prompt_jobs ORDER BY created_at, rowid").all()).toEqual(executionBeforeRecovery);
      await watchdog.stop();
    } finally {
      store.close();
    }
  });
});

function failPrepared(store: SqliteBindingStore, replyId: string, error: string, metadata: DeliveryFailureMetadata): void {
  activatePreparedClaimFence(store);
  const reply = store.getOutboundReply(replyId);
  if (!reply) throw new Error(`Missing outbound reply ${replyId}`);
  const intent = prepareOutboundGatewayIntent(store, reply).intent;
  const plan = {
    protocolVersion: 1 as const,
    gatewayId: reply.gatewayId,
    profileId: reply.gatewayProfileId,
    rendererRevision: reply.rendererRevision ?? 1,
    operation: intent.kind,
    intent
  };
  store.prepareOutboundGatewayPlan(replyId, {
    gatewayId: reply.gatewayId,
    gatewayProfileId: reply.gatewayProfileId,
    gatewayPlanJson: JSON.stringify(plan)
  });
  const hydrated = store.preparedDeliveries.hydratePreparedDelivery(replyId);
  if (hydrated.status !== "prepared") throw new Error(`Could not hydrate ${replyId}: ${JSON.stringify(hydrated)}`);
  const claim = store.preparedDeliveries.claimPreparedDelivery({
    delivery: hydrated.delivery,
    at: "2098-10-06T00:00:00.000Z",
    expiresAt: "2098-10-06T00:01:00.000Z"
  });
  if (!claim) throw new Error(`Could not claim prepared delivery ${replyId}`);
  expect(store.preparedDeliveries.failPreparedDelivery(claim, {
    error, metadata, retryAt: "2098-10-06T00:00:01.000Z"
  })).toBe("dead_letter");
}

function activatePreparedClaimFence(store: SqliteBindingStore): void {
  const existing = store.database.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' AND name='bridge_write_fence'").get();
  if (existing) return;
  const lease = store.acquireInstanceLease("projection-recovery-test", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
  if (!lease) throw new Error("Could not acquire prepared-delivery test lease");
  store.activateWriteFence(lease.ownerId, lease.fencingToken);
}
