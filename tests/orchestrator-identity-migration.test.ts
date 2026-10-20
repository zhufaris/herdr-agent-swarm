import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "../src/config.js";
import { OrchestratorIdentityMigrationWorkflow } from "../src/coordinator/orchestrator-identity-migration-workflow.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView, updateTopicView } from "../src/domain/topic-view.js";
import type { HerdrPort, PaneIdentityReconcileV1Request } from "../src/domain/ports/external.js";
import { createWorkerMainView } from "../src/domain/worker-main-view.js";
import { createTestStoreBundle, type TestStoreBundle } from "./helpers/create-test-store-bundle.js";

describe("Orchestrator identity migration", () => {
  let stores: TestStoreBundle | null = null;
  let temporaryDirectory: string | null = null;

  afterEach(() => {
    stores?.lifecycle.close();
    stores = null;
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  });

  it("does not reject shutdown when reconciliation fails", async () => {
    stores = setupStore();
    const workflow = createWorkflow(stores, { listWorkspaces: async () => { throw new Error("Herdr unavailable"); } });
    const active = workflow.reconcile();
    const stopping = workflow.stop();

    await expect(active).rejects.toThrow("Herdr unavailable");
    await expect(stopping).resolves.toBeUndefined();
  });

  it("does not replace a definitively rejected recovery operation in the same reconciliation pass", async () => {
    stores = setupStore();
    stores.orchestratorIdentity.accept(migrationRequest("migration-1"));
    const reconcilePaneIdentityV1 = vi.fn(async (request: PaneIdentityReconcileV1Request) => ({
      outcome: "token-conflict" as const,
      operationId: request.operationId,
      reason: "orch is already owned by another Pane"
    }));
    const workflow = createWorkflow(stores, { reconcilePaneIdentityV1 });

    await workflow.reconcile();

    expect(reconcilePaneIdentityV1).toHaveBeenCalledTimes(1);
    expect(reconcilePaneIdentityV1).toHaveBeenCalledWith(expect.objectContaining({ operationId: "migration-1" }));
  });

  it("applies a changed Pane ID without replacing the Binding, terminal, Thread, or Workers", () => {
    stores = setupStore();
    const before = stores.orchestratorIdentity.findOrchestratorBinding("feishu:primary", "chat")!;
    const claims = stores.driver;
    const claimedAt = "2026-10-02T00:00:00.000Z";
    expect(claims.claimCurrentRuntimeIdentity({
      claim: {
        state: "current",
        owner: { bindingId: before.id, bindingGeneration: before.generation, sessionEpoch: before.sessionEpoch },
        nativeIdentity: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
        attachment: { state: "attached", workspaceId: "w1", paneId: "w1:p1", terminalId: "terminal-1" },
        lastRejectedEvidenceFingerprint: null,
        lastRejectedReason: null,
        createdAt: claimedAt,
        updatedAt: claimedAt
      },
      paneToken: "abcd"
    })).toMatchObject({ outcome: "claimed" });
    const worker = stores.instance.createWorkerAgentInstance({
      id: "worker-1", projectId: "bridge", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1" },
      workspace: { id: "workspace-lease-1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4);
    expect(worker.outcome).toBe("created");
    stores.cardContext.saveWorkerMainView(createWorkerMainView({
      workerId: "worker-1", workerSessionGeneration: 1, parentBindingId: "binding-1", parentBindingGeneration: 1,
      parentPaneId: "w1:p1", workerName: "reviewer", ownerName: "Orchestrator", runtimeGeneration: 1,
      runtimeState: "running", runtimeAttached: true, desiredState: "running", parentActive: true, paneId: "w1:worker",
      workspace: "/repo", branch: null, model: null, occurredAt: "2026-10-02T00:00:00.000Z"
    }));
    stores.driver.database.prepare(`INSERT INTO worker_session_threads(
      id, publication_key, worker_id, worker_session_generation, parent_binding_id, parent_binding_generation, parent_pane_id,
      chat_id, mode, source_main_message_id, topic_id, root_message_id, state, created_at, activated_at, updated_at
    ) VALUES ('thread-1', 'worker-thread:worker-1:1', 'worker-1', 1, 'binding-1', 1, 'w1:p1', 'chat', 'legacy-entry', 'worker-main', 'worker-topic', 'worker-root', 'active', 'now', 'now', 'now')`).run();
    stores.driver.database.prepare(`INSERT INTO binding_thread_aliases(
      id, publication_key, binding_id, binding_generation, chat_id, pane_id, source_main_message_id, action_message_id,
      topic_id, root_message_id, state, created_at, updated_at
    ) VALUES ('alias-1', 'pane-entry-1', 'binding-1', 1, 'chat', 'w1:p1', 'root', 'action', 'alias-topic', 'alias-root', 'active', 'now', 'now')`).run();
    stores.orchestratorIdentity.accept(migrationRequest("migration-1"));
    expect(stores.orchestratorIdentity.claim("migration-1")).toMatchObject({ state: "applying" });

    const applied = stores.orchestratorIdentity.applyReceipt({ operationId: "migration-1", receipt: {
      operationId: "migration-1", disposition: "applied",
      previous: migrationRequest("migration-1").expected,
      current: { workspaceId: "w-herdr", paneId: "w-herdr:p9", terminalId: "terminal-1", token: "orch" }
    } });

    expect(applied).toMatchObject({ operation: { state: "succeeded" }, binding: {
      id: before.id, generation: before.generation, workspaceId: "w-herdr", paneId: "w-herdr:p9",
      paneToken: "orch", traexSessionId: before.traexSessionId, topicId: before.topicId, rootMessageId: before.rootMessageId
    } });
    expect(claims.loadRuntimeIdentityClaim({
      bindingId: before.id, bindingGeneration: before.generation, sessionEpoch: before.sessionEpoch
    })).toMatchObject({
      state: "current",
      nativeIdentity: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      attachment: { state: "attached", workspaceId: "w-herdr", paneId: "w-herdr:p9", terminalId: "terminal-1" }
    });
    expect(stores.instance.getAgentInstance("worker-1")).toMatchObject({ parent: {
      bindingId: "binding-1", bindingGeneration: 1, paneId: "w-herdr:p9", nativeSessionId: "session-1"
    } });
    expect(stores.cardContext.loadWorkerMainView("worker-1", 1)).toMatchObject({ parentBindingId: "binding-1", parentPaneId: "w-herdr:p9" });
    expect(stores.driver.database.prepare("SELECT parent_pane_id FROM worker_session_threads WHERE id = 'thread-1'").get()).toEqual({ parent_pane_id: "w-herdr:p9" });
    expect(stores.driver.database.prepare("SELECT pane_id FROM binding_thread_aliases WHERE id = 'alias-1'").get()).toEqual({ pane_id: "w-herdr:p9" });
  });

  it("matches a Core receipt by identity values regardless of JSON property order", () => {
    stores = setupStore();
    stores.orchestratorIdentity.accept(migrationRequest("migration-1"));
    stores.orchestratorIdentity.claim("migration-1");

    const applied = stores.orchestratorIdentity.applyReceipt({ operationId: "migration-1", receipt: {
      operationId: "migration-1", disposition: "applied",
      previous: { paneId: "w1:p1", terminalId: "terminal-1", token: "abcd", workspaceId: "w1" },
      current: { paneId: "w-herdr:p9", terminalId: "terminal-1", token: "orch", workspaceId: "w-herdr" }
    } });

    expect(applied).toMatchObject({ operation: { state: "succeeded" }, binding: {
      workspaceId: "w-herdr", paneId: "w-herdr:p9", paneToken: "orch", traexSessionId: "terminal-1"
    } });
  });

  it("rolls Pane identity migration back when its native session belongs to another owner", () => {
    stores = setupStore();
    stores.driver.createPendingBinding({
      id: "binding-winner", projectId: "bridge", workspaceId: "w1", chatId: "chat", topicId: "winner-topic",
      rootMessageId: "winner-root", title: "Winner"
    });
    const winner = stores.driver.updateBinding("binding-winner", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p2", paneToken: "winner",
      traexSessionId: "terminal-2", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "session-1", lastAgentState: "idle"
    });
    const claims = stores.driver;
    const claimedAt = "2026-10-02T00:00:00.000Z";
    expect(claims.claimCurrentRuntimeIdentity({
      claim: {
        state: "current",
        owner: { bindingId: winner.id, bindingGeneration: winner.generation, sessionEpoch: winner.sessionEpoch },
        nativeIdentity: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
        attachment: { state: "attached", workspaceId: "w1", paneId: "w1:p2", terminalId: "terminal-2" },
        lastRejectedEvidenceFingerprint: null,
        lastRejectedReason: null,
        createdAt: claimedAt,
        updatedAt: claimedAt
      },
      paneToken: "winner"
    })).toMatchObject({ outcome: "claimed" });
    stores.orchestratorIdentity.accept(migrationRequest("migration-conflict"));
    expect(stores.orchestratorIdentity.claim("migration-conflict")).toMatchObject({ state: "applying" });
    const before = stores.orchestratorIdentity.findOrchestratorBinding("feishu:primary", "chat");

    expect(() => stores!.orchestratorIdentity.applyReceipt({ operationId: "migration-conflict", receipt: {
      operationId: "migration-conflict", disposition: "applied",
      previous: migrationRequest("migration-conflict").expected,
      current: { workspaceId: "w-herdr", paneId: "w-herdr:p9", terminalId: "terminal-1", token: "orch" }
    } })).toThrow("Runtime identity transition conflict");

    expect(stores.orchestratorIdentity.findOrchestratorBinding("feishu:primary", "chat")).toEqual(before);
    expect(stores.orchestratorIdentity.listRecoverable()).toContainEqual(expect.objectContaining({
      id: "migration-conflict", state: "applying", receipt: null
    }));
    expect(claims.loadRuntimeIdentityClaim({ bindingId: "binding-1", bindingGeneration: 1, sessionEpoch: 1 })).toBeNull();
    expect(claims.loadRuntimeIdentityClaim({ bindingId: winner.id, bindingGeneration: winner.generation, sessionEpoch: winner.sessionEpoch }))
      .toMatchObject({ state: "current", nativeIdentity: { value: "session-1" }, attachment: { paneId: "w1:p2" } });
  });

  it("applies receipt identity to durable Primary projections and requests card refresh", () => {
    stores = setupStore();
    const topic = updateTopicView(initialTopicView("binding-1"), {
      bindingGeneration: 1, title: "Orchestrator", workspaceId: "w1", spaceName: "legacy", paneId: "w1:p1", paneToken: "abcd", phase: "ready"
    });
    stores.projection.saveTopicView(topic);
    stores.promptAcceptance.acceptPrompt({
      prompt: { id: "prompt-1", bindingId: "binding-1", larkMessageId: "message-1", actorOpenId: "user-1", body: "continue" },
      view: createQueuedRunCard({
        promptId: "prompt-1", bindingId: "binding-1", title: "Queued", workspaceId: "w1", spaceName: "legacy",
        paneId: "w1:p1", paneToken: "abcd", requestText: "continue", queuePosition: 1, occurredAt: "2026-10-02T00:00:00.000Z"
      }),
      rootMessageId: "root", answerCard: {}
    });
    stores.orchestratorIdentity.accept(migrationRequest("migration-1"));
    stores.orchestratorIdentity.claim("migration-1");

    stores.orchestratorIdentity.applyReceipt({ operationId: "migration-1", receipt: {
      operationId: "migration-1", disposition: "applied", previous: migrationRequest("migration-1").expected,
      current: { workspaceId: "w-herdr", paneId: "w-herdr:p9", terminalId: "terminal-1", token: "orch" }
    } });

    expect(stores.projection.loadTopicView("binding-1")).toMatchObject({
      workspaceId: "w-herdr", spaceName: "herdr", paneId: "w-herdr:p9", paneToken: "orch", viewVersion: topic.viewVersion + 1
    });
    expect(stores.projection.loadRunCard("prompt-1")).toMatchObject({
      workspaceId: "w-herdr", spaceName: "herdr", paneId: "w-herdr:p9", paneToken: "orch", viewVersion: 2
    });
    expect(stores.driver.database.prepare(`SELECT target_kind, target_id, target_generation, requested_dependency_revision, projected_dependency_revision
      FROM card_context_invalidations ORDER BY target_kind, target_id`).all()).toEqual([
      { target_kind: "primary-session", target_id: "binding-1", target_generation: 1, requested_dependency_revision: 1, projected_dependency_revision: 0 },
      { target_kind: "primary-turn", target_id: "prompt-1", target_generation: 1, requested_dependency_revision: 1, projected_dependency_revision: 0 }
    ]);
  });

  it("persists intent before Core invocation and retries an uncertain effect with the same operation ID", async () => {
    stores = setupStore();
    let calls = 0;
    const operationIds: string[] = [];
    const reconcilePaneIdentityV1 = vi.fn(async (request: PaneIdentityReconcileV1Request) => {
      operationIds.push(request.operationId);
      expect(stores!.orchestratorIdentity.listRecoverable()).toContainEqual(expect.objectContaining({
        id: request.operationId, state: "applying", attemptCount: calls + 1
      }));
      calls += 1;
      if (calls === 1) return { outcome: "uncertain" as const, operationId: request.operationId, reason: "timeout after dispatch" };
      return { outcome: "already-converged" as const, receipt: {
        operationId: request.operationId, disposition: "already-converged" as const, previous: request.expected,
        current: { workspaceId: "w-herdr", paneId: "w-herdr:p9", terminalId: request.expected.terminalId, token: "orch" }
      } };
    });
    const workflow = createWorkflow(stores, { reconcilePaneIdentityV1 });

    await workflow.reconcile();
    expect(stores.orchestratorIdentity.listRecoverable()).toContainEqual(expect.objectContaining({ state: "uncertain", attemptCount: 1 }));
    await workflow.reconcile();

    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(stores.orchestratorIdentity.listRecoverable()).toEqual([]);
    expect(stores.orchestratorIdentity.findOrchestratorBinding("feishu:primary", "chat")).toMatchObject({
      workspaceId: "w-herdr", paneId: "w-herdr:p9", paneToken: "orch", traexSessionId: "terminal-1"
    });
  });

  it("migrates after an uncertain Prompt has terminalized while unresolved uncertain work still blocks", async () => {
    stores = setupStore();
    stores.driver.database.prepare(`INSERT INTO prompt_jobs(
      id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body,
      execution_origin, priority, was_detached, state, observation_state, attempt_count, created_at, updated_at
    ) VALUES (?, 'binding-1', ?, 'feishu', ?, 'user-1', 'terminal uncertainty',
      'bridge', 'normal', 1, 'uncertain', ?, 1, 'now', 'now')`).run(
      "terminal-prompt", "terminal-message", "terminal-source", "completed"
    );
    stores.driver.database.prepare(`INSERT INTO prompt_jobs(
      id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body,
      execution_origin, priority, was_detached, state, observation_state, attempt_count, created_at, updated_at
    ) VALUES (?, 'binding-1', ?, 'feishu', ?, 'user-1', 'unresolved uncertainty',
      'bridge', 'normal', 1, 'uncertain', ?, 1, 'now', 'now')`).run(
      "unresolved-prompt", "unresolved-message", "unresolved-source", "detached"
    );
    const reconcilePaneIdentityV1 = vi.fn(async (request: PaneIdentityReconcileV1Request) => ({
      outcome: "applied" as const,
      receipt: {
        operationId: request.operationId, disposition: "applied" as const, previous: request.expected,
        current: { workspaceId: "w-herdr", paneId: "w-herdr:p9", terminalId: request.expected.terminalId, token: "orch" }
      }
    }));
    const workflow = createWorkflow(stores, { reconcilePaneIdentityV1 });

    await workflow.reconcile();
    expect(reconcilePaneIdentityV1).not.toHaveBeenCalled();

    stores.driver.database.prepare("UPDATE prompt_jobs SET observation_state = 'completed' WHERE id = 'unresolved-prompt'").run();
    await workflow.reconcile();

    expect(reconcilePaneIdentityV1).toHaveBeenCalledTimes(1);
    expect(stores.orchestratorIdentity.findOrchestratorBinding("feishu:primary", "chat")).toMatchObject({
      workspaceId: "w-herdr", paneId: "w-herdr:p9", paneToken: "orch"
    });
    expect(stores.promptDispatch.getPrompt("terminal-prompt")).toMatchObject({ state: "uncertain", observationState: "completed" });
    expect(stores.promptDispatch.getPrompt("unresolved-prompt")).toMatchObject({ state: "uncertain", observationState: "completed" });
  });

  it("keeps newly accepted Prompt work queued until migration settles", () => {
    stores = setupStore();
    stores.orchestratorIdentity.accept(migrationRequest("migration-1"));
    const view = createQueuedRunCard({
      promptId: "prompt-1", bindingId: "binding-1", title: "Queued", workspaceId: "w1", paneId: "w1:p1",
      requestText: "continue", queuePosition: 1, occurredAt: "2026-10-02T00:00:00.000Z"
    });

    stores.promptAcceptance.acceptPrompt({
      prompt: { id: "prompt-1", bindingId: "binding-1", larkMessageId: "message-1", actorOpenId: "user-1", body: "continue" },
      view, rootMessageId: "root", answerCard: {}
    });

    expect(stores.promptDispatch.claimNextDispatchablePrompt("binding-1")).toBeNull();
    expect(stores.orchestratorIdentity.claim("migration-1")).toMatchObject({ state: "applying" });
    expect(stores.promptDispatch.claimNextDispatchablePrompt("binding-1")).toBeNull();
    expect(stores.orchestratorIdentity.markUncertain("migration-1", "timeout")).toMatchObject({ state: "uncertain" });
    expect(stores.promptDispatch.claimNextDispatchablePrompt("binding-1")).toBeNull();
    expect(stores.promptDispatch.getPrompt("prompt-1")).toMatchObject({ state: "queued", attemptCount: 0 });
    stores.orchestratorIdentity.finish("migration-1", "rejected", "operator action required");
    expect(stores.promptDispatch.claimNextDispatchablePrompt("binding-1")).toMatchObject({ prompt: { id: "prompt-1", state: "submitted" } });
  });

  it("adds migration 82 idempotently to an existing database", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-orchestrator-identity-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    stores = createTestStoreBundle(path);
    stores.driver.database.exec("DROP TABLE orchestrator_identity_migrations; DELETE FROM schema_migrations WHERE version=82 OR version>=112; DROP TABLE schema_metadata");
    stores.lifecycle.close();
    stores = createTestStoreBundle(path);

    expect(stores.driver.database.prepare("SELECT version FROM schema_migrations WHERE version = 82").get()).toEqual({ version: 82 });
    expect(stores.driver.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestrator_identity_migrations'").get()).toEqual({ name: "orchestrator_identity_migrations" });
    stores.lifecycle.close();
    stores = createTestStoreBundle(path);
    expect(stores.driver.database.prepare("SELECT version FROM schema_migrations WHERE version = 82").get()).toEqual({ version: 82 });
  });

  it("allows only one claimant for one durable migration operation", () => {
    stores = setupStore();
    stores.orchestratorIdentity.accept(migrationRequest("migration-1"));

    expect(stores.orchestratorIdentity.claim("migration-1")).toMatchObject({ state: "applying", attemptCount: 1 });
    expect(stores.orchestratorIdentity.claim("migration-1")).toBeNull();
  });

  it("returns the settled operation for an identical operation ID and rejects mismatched reuse", () => {
    stores = setupStore();
    const request = migrationRequest("migration-1");
    stores.orchestratorIdentity.accept(request);
    stores.orchestratorIdentity.claim(request.id);
    const receipt = {
      operationId: request.id, disposition: "applied" as const, previous: request.expected,
      current: { workspaceId: "w-herdr", paneId: "w-herdr:p9", terminalId: "terminal-1", token: "orch" }
    };
    stores.orchestratorIdentity.applyReceipt({ operationId: request.id, receipt });

    expect(stores.orchestratorIdentity.accept(request)).toMatchObject({ inserted: false, operation: { state: "succeeded", receipt } });
    expect(() => stores!.orchestratorIdentity.accept({ ...request, target: { ...request.target, token: "other" } }))
      .toThrow("operation ID belongs to a different request");
  });

  it("serializes migration and clear admission in SQLite", () => {
    stores = setupStore();
    stores.orchestratorIdentity.accept(migrationRequest("migration-1"));

    expect(() => stores!.orchestratorClear.accept(clearRequest("clear-1"))).toThrow("identity migration is in progress");

    stores.orchestratorIdentity.finish("migration-1", "rejected", "operator action required");
    stores.orchestratorClear.accept(clearRequest("clear-1"));
    expect(() => stores!.orchestratorIdentity.accept(migrationRequest("migration-2"))).toThrow("clear is in progress");
  });

  it.each([
    ["missing", []],
    ["ambiguous", [{ workspaceId: "w-herdr-a", label: "herdr" }, { workspaceId: "w-herdr-b", label: "herdr" }]]
  ])("fails closed when the exact herdr Space is %s", async (_case, workspaces) => {
    stores = setupStore();
    const reconcilePaneIdentityV1 = vi.fn();
    const workflow = createWorkflow(stores, { listWorkspaces: async () => workspaces, reconcilePaneIdentityV1 });

    await expect(workflow.reconcile()).rejects.toThrow("Expected exactly one Herdr Space labeled 'herdr'");
    expect(reconcilePaneIdentityV1).not.toHaveBeenCalled();
    expect(stores.orchestratorIdentity.listRecoverable()).toEqual([]);
  });

  it("does nothing when the Orchestrator already owns the final native identity", async () => {
    stores = setupStore();
    stores.driver.updateBinding("binding-1", { workspaceId: "w-herdr", paneId: "w-herdr:p9", paneToken: "orch" });
    const reconcilePaneIdentityV1 = vi.fn();
    const workflow = createWorkflow(stores, { reconcilePaneIdentityV1 });

    await workflow.reconcile();

    expect(reconcilePaneIdentityV1).not.toHaveBeenCalled();
    expect(stores.orchestratorIdentity.listRecoverable()).toEqual([]);
  });
});

function setupStore(): TestStoreBundle {
  const stores = createTestStoreBundle();
  stores.driver.createPendingBinding({
    id: "binding-1", kind: "orchestrator", gatewayId: "feishu:primary", projectId: "bridge", workspaceId: "w1",
    chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Orchestrator"
  });
  stores.driver.updateBinding("binding-1", {
    state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", paneToken: "abcd",
    traexSessionId: "terminal-1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
    agentSessionKind: "id", agentSessionValue: "session-1", lastAgentState: "idle"
  });
  return stores;
}

function migrationRequest(id: string) {
  return {
    id,
    bindingId: "binding-1",
    bindingGeneration: 1,
    expected: { workspaceId: "w1", paneId: "w1:p1", terminalId: "terminal-1", token: "abcd" },
    target: { workspaceId: "w-herdr", expectedWorkspaceLabel: "herdr", token: "orch" }
  };
}

function clearRequest(id: string) {
  return {
    id, idempotencyKey: `clear:${id}`, actorOpenId: "user-1", sourceMessageId: `message:${id}`, confirmationId: `confirmation:${id}`,
    bindingId: "binding-1", bindingGeneration: 1, oldSessionEpoch: 1,
    expectedWorkspaceId: "w1", expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1",
    expectedSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }, expectedStateChangeSeq: 17
  };
}

function createWorkflow(stores: TestStoreBundle, overrides: Partial<Pick<HerdrPort, "listWorkspaces" | "supportsPaneIdentityReconcileV1" | "reconcilePaneIdentityV1">> = {}) {
  const config = { gateway: { kind: "feishu", id: "feishu:primary" }, lark: { chatId: "chat" } } as BridgeConfig;
  return new OrchestratorIdentityMigrationWorkflow({
    config,
    store: stores.orchestratorIdentity,
    herdr: {
      listWorkspaces: async () => [{ workspaceId: "w-herdr", label: "herdr" }],
      supportsPaneIdentityReconcileV1: async () => true,
      reconcilePaneIdentityV1: async (request) => ({ outcome: "rejected", operationId: request.operationId, reason: "test" }),
      ...overrides
    }
  });
}
