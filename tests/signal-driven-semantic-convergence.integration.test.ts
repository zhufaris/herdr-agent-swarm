import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreSessionIngestionSupervisor,
  resolvePrimarySessionIngestionSource
} from "../src/coordinator/core-session-ingestion-supervisor.js";
import { HerdrRuntimeReconciler } from "../src/coordinator/herdr-runtime-reconciler.js";
import { InstanceRuntimeReconciler } from "../src/coordinator/instance-runtime-reconciler.js";
import type { AgentInstance } from "../src/domain/agent-instance.js";
import type { PreparedDeliveryPlan } from "../src/domain/delivery.js";
import type { HerdrPort } from "../src/domain/ports.js";
import type { Binding, HerdrPane, OutboundReply } from "../src/domain/types.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardContextRebuilder } from "../src/events/card-context-rebuilder.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";
import { RingDeliveryEngine } from "../src/events/ring-delivery-engine.js";
import { HerdrPaneHost } from "../src/runtime/herdr/pane-host.js";
import { WorkspaceSnapshotCache } from "../src/runtime/workspace-snapshot-cache.js";
import { applicationPresentation } from "./helpers/presentation.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

let store: SqliteBindingStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function openStore(): SqliteBindingStore {
  store = new SqliteBindingStore(":memory:");
  store.setGatewayPlanPreparer((reply: OutboundReply): PreparedDeliveryPlan => ({
    protocolVersion: 1,
    gatewayId: reply.gatewayId,
    profileId: reply.gatewayProfileId,
    rendererRevision: 1,
    operation: "message.reply.view",
    intent: {
      kind: "message.reply.view",
      purpose: "operation-result",
      rootMessageId: reply.rootMessageId!,
      view: {},
      idempotencyKey: reply.idempotencyKey
    }
  }));
  return store;
}

function activateBinding(target: SqliteBindingStore, id: string, paneId: string, nativeSessionId: string): void {
  target.createPendingBinding({
    id,
    projectId: "repo",
    workspaceId: "w1",
    chatId: "chat",
    topicId: `topic-${id}`,
    rootMessageId: `root-${id}`,
    title: id
  });
  target.updateBinding(id, {
    state: "active",
    lifecycle: "active",
    attachment: "attached",
    paneId,
    agentKind: "traex",
    agentSessionSource: "herdr:traex",
    agentSessionAgent: "traex",
    agentSessionKind: "id",
    agentSessionValue: nativeSessionId
  });
  target.saveTopicView({
    ...initialTopicView(id),
    title: id,
    workspaceId: "w1",
    paneId,
    viewVersion: 1,
    sessionIdentity: {
      bindingGeneration: 1,
      sessionEpoch: 1,
      nativeSessionId,
      paneId,
      rootMessageId: `root-${id}`
    }
  });
  target.database.prepare("UPDATE bindings SET status_message_id=? WHERE id=?").run(`main-${id}`, id);
}

function reserveMain(target: SqliteBindingStore, bindingId: string): void {
  target.reservePreparedOutboundReply({
    id: `${bindingId}-main`,
    idempotencyKey: `${bindingId}-main`,
    bindingId,
    bindingGeneration: 1,
    targetRole: "session_status",
    rootMessageId: `main-${bindingId}`,
    kind: "card_update",
    payload: "{}",
    projectionKey: `primary-main:${bindingId}`,
    snapshotRevision: 1,
    viewVersion: 1,
    laneKeyOverride: `primary-main:${bindingId}`
  }).consumeEffects();
  target.database.prepare("UPDATE outbound_replies SET next_attempt_at='2026-10-18T00:10:00.000Z' WHERE id=?").run(`${bindingId}-main`);
}

function loadPrimaryMainIdentity(target: SqliteBindingStore, bindingId: string, bindingGeneration: number) {
  return target.database.prepare(`
    SELECT binding_id AS bindingId,target_role AS targetRole,projection_key AS projectionKey
    FROM outbound_replies
    WHERE binding_id=? AND target_role='session_status' AND projection_key=?
  `).get(bindingId, `primary-main:${bindingId}:${bindingGeneration}`) as {
    bindingId: string;
    targetRole: string;
    projectionKey: string;
  } | undefined;
}

function createAttachedWorker(target: SqliteBindingStore): AgentInstance {
  const created = target.createWorkerAgentInstance({
    id: "worker",
    projectId: "repo",
    name: "worker",
    role: "worker",
    agentKind: "traex",
    model: null,
    desiredState: "running",
    parent: {
      bindingId: "owner",
      bindingGeneration: 1,
      paneId: "w1:primary",
      nativeSessionId: "owner-session"
    },
    workspace: {
      id: "worker-ws",
      kind: "shared-read-only",
      cwd: "/repo/worker",
      branch: null,
      baseCommit: "base"
    }
  }, 4);
  if (created.outcome !== "created") throw new Error("expected attached Worker fixture");
  const attached = target.attachAgentInstanceRuntime({
    instanceId: created.instance.id,
    expectedGeneration: created.instance.generation,
    herdrWorkspaceId: "w1",
    paneId: "w1:worker",
    paneToken: "worker-token-1",
    nativeSessionId: "worker-session"
  });
  if (!attached) throw new Error("expected Worker runtime attachment");
  return attached;
}

function bindingSource(binding: Binding) {
  return {
    agentKind: binding.agentKind,
    bindingId: binding.id,
    generation: binding.generation,
    paneId: binding.paneId,
    nativeSession: binding.agentSessionValue
      ? {
          source: binding.agentSessionSource!,
          agent: binding.agentSessionAgent!,
          kind: "id" as const,
          value: binding.agentSessionValue
        }
      : null
  };
}

function stableCoreDiagnostics(supervisor: CoreSessionIngestionSupervisor) {
  const snapshot = supervisor.snapshot();
  return {
    ready: snapshot.ready,
    state: snapshot.state,
    recoveryState: snapshot.recoveryState,
    requiredFailures: snapshot.requiredFailures,
    indexingRecoveries: snapshot.indexingRecoveries,
    needsHumanRecoveries: snapshot.needsHumanRecoveries,
    pendingReprojections: snapshot.pendingReprojections,
    pendingReprojectionRuns: snapshot.pendingReprojectionRuns,
    pendingReprojectedEvents: snapshot.pendingReprojectedEvents,
    pendingReprojectionRetries: snapshot.pendingReprojectionRetries,
    pendingReprojectionQuarantined: snapshot.pendingReprojectionQuarantined,
    pendingReprojectionNoPending: snapshot.pendingReprojectionNoPending,
    pendingReprojectionNoCandidate: snapshot.pendingReprojectionNoCandidate,
    pendingReprojectionIdentityMismatch: snapshot.pendingReprojectionIdentityMismatch,
    pendingReprojectionRouteUnavailable: snapshot.pendingReprojectionRouteUnavailable,
    lastPendingReprojectionSkipReason: snapshot.lastPendingReprojectionSkipReason,
    activeIngestionPermits: snapshot.activeIngestionPermits,
    lastFailureCode: snapshot.lastFailureCode
  };
}

function durableSnapshot(target: SqliteBindingStore, supervisor: CoreSessionIngestionSupervisor) {
  const worker = target.database.prepare(`
    SELECT observed_state,pane_token,updated_at
    FROM agent_instances
    WHERE id='worker'
  `).get() as { observed_state: string; pane_token: string | null; updated_at: string };
  const scalar = (sql: string) => Number((target.database.prepare(sql).get() as { value: number | null }).value ?? 0);
  const invalidations = target.listPendingCardContextInvalidations()
    .map((row) => ({
      targetKind: row.targetKind,
      targetId: row.targetId,
      targetGeneration: row.targetGeneration,
      requestedDependencyRevision: row.requestedDependencyRevision,
      projectedDependencyRevision: row.projectedDependencyRevision,
      reason: row.reason
    }))
    .sort((left, right) =>
      `${left.targetKind}:${left.targetId}:${left.requestedDependencyRevision}`.localeCompare(
        `${right.targetKind}:${right.targetId}:${right.requestedDependencyRevision}`
      ));
  return {
    core: stableCoreDiagnostics(supervisor),
    worker: {
      observedState: worker.observed_state,
      paneToken: worker.pane_token,
      updatedAt: worker.updated_at
    },
    invalidations,
    topicRevisions: scalar("SELECT COALESCE(SUM(CAST(json_extract(state_json,'$.viewVersion') AS INTEGER)),0) AS value FROM topic_views"),
    outboxRows: scalar("SELECT COUNT(*) AS value FROM outbound_replies"),
    waitingScopes: scalar("SELECT COUNT(DISTINCT scope_key) AS value FROM outbound_replies WHERE state IN ('pending','dead_letter')"),
    replyStates: (target.database.prepare(`
      SELECT id,state
      FROM outbound_replies
      WHERE id IN ('owner-main','current-main')
      ORDER BY id
    `).all() as Array<{ id: string; state: string }>)
  };
}

function createMutableHerdr(panes: readonly HerdrPane[]) {
  const state = new Map(panes.map((pane) => [pane.paneId, pane]));
  const api = {
    listAllPanes: vi.fn(async () => [...state.values()]),
    listPanes: vi.fn(async (workspaceId: string) => [...state.values()].filter((pane) => pane.workspaceId === workspaceId)),
    getPane: vi.fn(async (paneId: string) => state.get(paneId) ?? null),
    assertWorkspace: vi.fn(async () => undefined)
  } satisfies Partial<HerdrPort>;
  return {
    herdr: api as HerdrPort,
    listAllPanes: api.listAllPanes,
    updatePane(paneId: string, patch: Partial<HerdrPane>) {
      const current = state.get(paneId);
      if (!current) throw new Error(`unknown pane ${paneId}`);
      state.set(paneId, { ...current, ...patch });
    }
  };
}

async function runLoopPass(input: {
  supervisor: CoreSessionIngestionSupervisor;
  bindingRuntime: HerdrRuntimeReconciler;
  instanceRuntime: InstanceRuntimeReconciler;
}): Promise<void> {
  await input.supervisor.reconcile();
  await input.bindingRuntime.reconcile();
  await input.instanceRuntime.reconcile();
}

async function pingRecovery(
  notifyWork: (hint?: { kind: "recovery" }) => void,
  retirement: ReturnType<typeof vi.spyOn>
): Promise<void> {
  const previous = retirement.mock.calls.length;
  notifyWork({ kind: "recovery" });
  await vi.waitFor(() => expect(retirement.mock.calls.length).toBeGreaterThan(previous));
}

describe("signal-driven semantic convergence", () => {
  it("stays flat while idle, converges one pane-plus-owner change once, then returns flat", async () => {
    const target = openStore();
    activateBinding(target, "owner", "w1:primary", "owner-session");
    reserveMain(target, "owner");
    createAttachedWorker(target);

    const paneTopology = createMutableHerdr([
      {
        paneId: "w1:primary",
        terminalId: "primary-terminal",
        workspaceId: "w1",
        cwd: "/repo",
        label: "owner",
        paneToken: "primary-token-1",
        agentState: "idle",
        foregroundExecutables: ["traex"],
        agentKind: "traex",
        agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "owner-session" }
      },
      {
        paneId: "w1:worker",
        terminalId: "worker-terminal",
        workspaceId: "w1",
        cwd: "/repo/worker",
        label: "worker",
        paneToken: "worker-token-1",
        agentState: "idle",
        foregroundExecutables: ["worker-runtime"],
        agentKind: "traex",
        agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "worker-session" }
      }
    ]);
    const cache = new WorkspaceSnapshotCache(paneTopology.herdr);
    const logger = pino({ enabled: false });
    const gatewayExecute = vi.fn();
    let notifyWork!: (hint?: { kind: "recovery" }) => void;
    const rebuilder = new CardContextRebuilder(target, () => undefined, logger, applicationPresentation);
    const engine = new RingDeliveryEngine({
      store: target.preparedDeliveries,
      refill: target.preparedDeliveries,
      gateway: { prepare: vi.fn(), execute: gatewayExecute },
      now: () => Date.parse("2026-10-18T00:00:00.000Z"),
      coldRecoveryEnabled: true,
      subscribeWork: (listener) => {
        notifyWork = listener as typeof notifyWork;
        return () => undefined;
      },
      onProjectionRecoveryHints: async (hints) => {
        for (const hint of hints) if (hint.kind === "card-context") await rebuilder.requestProjectionRecovery(hint);
      }
    });
    const retirement = vi.spyOn(target.preparedDeliveries, "retireReconstructibleInvalidOwnerHeads");
    const bindingRuntime = new HerdrRuntimeReconciler({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
      store: target,
      herdr: cache,
      runtimeObservations: cache,
      lifecycleEvents: new BridgeEventBus(),
      channelPublisher: { async enqueueRunCardUpdate() {} },
      logger,
      discoverPane: async () => { throw new Error("not used"); },
      scheduler: new InProcessPromptWorkScheduler(),
      isBindingBusy: () => false,
      presentation: applicationPresentation
    });
    const wakeWorker = vi.fn();
    const wakeCardContext = vi.fn();
    const instanceRuntime = new InstanceRuntimeReconciler({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
      store: target,
      paneHost: new HerdrPaneHost(cache),
      runtimeObservations: cache,
      wake: wakeWorker,
      wakeCardContext
    });
    const ingestCurrentSession = vi.fn(async (source: { bindingId: string }) => ({
      laneId: `lane:${source.bindingId}`,
      sourceId: `stream:${source.bindingId}`,
      ingestedEvents: 1,
      caughtUp: true
    }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: (state) => target.listBindingsByState(state) },
      ingestor: { ingestCurrentSession },
      onIngested: vi.fn(),
      resolveSource: (binding) => resolvePrimarySessionIngestionSource(binding, {
        getBinding: (id) => target.getBinding(id),
        getPane: (paneId) => cache.getPane(paneId)
      }),
      reconcileCanonicalHumanMessages: vi.fn(() => 0),
      retireLegacyInputCards: vi.fn(() => 0)
    });

    engine.start();
    await engine.whenRecoveryReady();
    await bindingRuntime.captureBaselines();
    await runLoopPass({ supervisor, bindingRuntime, instanceRuntime });
    await rebuilder.requestScan();

    const baseline = durableSnapshot(target, supervisor);
    const baselineRefreshes = paneTopology.listAllPanes.mock.calls.length;
    expect(baseline).toEqual({
      core: {
        ready: true,
        state: "idle",
        recoveryState: "idle",
        requiredFailures: 0,
        indexingRecoveries: 0,
        needsHumanRecoveries: 0,
        pendingReprojections: 0,
        pendingReprojectionRuns: 0,
        pendingReprojectedEvents: 0,
        pendingReprojectionRetries: 0,
        pendingReprojectionQuarantined: 0,
        pendingReprojectionNoPending: 0,
        pendingReprojectionNoCandidate: 0,
        pendingReprojectionIdentityMismatch: 0,
        pendingReprojectionRouteUnavailable: 0,
        lastPendingReprojectionSkipReason: null,
        activeIngestionPermits: 0,
        lastFailureCode: null
      },
      worker: {
        observedState: "idle",
        paneToken: "worker-token-1",
        updatedAt: baseline.worker.updatedAt
      },
      invalidations: [],
      topicRevisions: 2,
      outboxRows: 3,
      waitingScopes: 2,
      replyStates: [{ id: "owner-main", state: "pending" }]
    });
    expect(ingestCurrentSession.mock.calls.map(([source]) => source.bindingId)).toContain("owner");

    for (let iteration = 0; iteration < 2; iteration += 1) {
      await runLoopPass({ supervisor, bindingRuntime, instanceRuntime });
      await pingRecovery(notifyWork, retirement);
      expect(durableSnapshot(target, supervisor)).toEqual(baseline);
    }
    expect(paneTopology.listAllPanes).toHaveBeenCalledTimes(baselineRefreshes);

    paneTopology.updatePane("w1:worker", { agentState: "working", paneToken: "worker-token-2" });
    cache.invalidatePanes(["w1:worker"]);
    target.updateBinding("owner", { state: "archived", lifecycle: "archived", attachment: "unattached", paneId: null });
    activateBinding(target, "current", "w1:primary", "owner-session");
    const authoritativeCurrentTopic = target.loadTopicView("current")!;
    target.saveTopicView({
      ...authoritativeCurrentTopic,
      sessionIdentity: null,
      sessionActivityRevision: 1,
      activityAt: "2026-10-18T00:00:01.000Z"
    });

    await runLoopPass({ supervisor, bindingRuntime, instanceRuntime });
    const transition = durableSnapshot(target, supervisor);
    expect(transition.core).toEqual(baseline.core);
    expect(transition.worker.observedState).toBe("working");
    expect(transition.worker.paneToken).toBe("worker-token-2");
    expect(transition.worker.updatedAt).not.toBe(baseline.worker.updatedAt);
    expect(transition.invalidations).toContainEqual(expect.objectContaining({
      targetKind: "worker-session",
      targetId: "worker",
      reason: "worker.runtime-observed"
    }));
    expect(transition.topicRevisions).toBe(baseline.topicRevisions + 1);
    expect(paneTopology.listAllPanes).toHaveBeenCalledTimes(baselineRefreshes);

    await pingRecovery(notifyWork, retirement);
    expect(target.getOutboundReply("owner-main")).toMatchObject({ state: "pending" });
    expect(durableSnapshot(target, supervisor).outboxRows).toBe(baseline.outboxRows);
    expect(loadPrimaryMainIdentity(target, "current", 1)).toBeUndefined();

    target.saveTopicView(authoritativeCurrentTopic);
    await pingRecovery(notifyWork, retirement);
    await vi.waitFor(() => expect(target.getOutboundReply("owner-main")).toMatchObject({ state: "dismissed" }));
    await vi.waitFor(() => expect(loadPrimaryMainIdentity(target, "current", 1)).toEqual({
      bindingId: "current",
      targetRole: "session_status",
      projectionKey: "primary-main:current:1"
    }));
    await vi.waitFor(() => expect(durableSnapshot(target, supervisor).outboxRows).toBe(baseline.outboxRows + 1));

    const converged = durableSnapshot(target, supervisor);
    expect(converged.core).toEqual(transition.core);
    expect(converged.worker).toEqual({
      observedState: "working",
      paneToken: "worker-token-2",
      updatedAt: transition.worker.updatedAt
    });
    expect(converged.invalidations).toEqual([]);
    expect(converged.topicRevisions).toBe(baseline.topicRevisions + 1);
    expect(converged.outboxRows).toBe(baseline.outboxRows + 1);
    expect(converged.waitingScopes).toBe(baseline.waitingScopes);
    expect(converged.replyStates).toEqual([{ id: "owner-main", state: "dismissed" }]);
    expect(ingestCurrentSession.mock.calls.map(([source]) => source.bindingId)).toContain("current");

    for (let iteration = 0; iteration < 2; iteration += 1) {
      await runLoopPass({ supervisor, bindingRuntime, instanceRuntime });
      await pingRecovery(notifyWork, retirement);
      expect(durableSnapshot(target, supervisor)).toEqual(converged);
    }

    expect(gatewayExecute).not.toHaveBeenCalled();
    await engine.stop();
    await rebuilder.stop();
  });
});
