import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthSnapshotCollector, type HealthSnapshotOptions } from "../src/health/health-snapshot-collector.js";
import { createShutdownContext } from "../src/runtime/shutdown-context.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe("HealthSnapshotCollector", () => {
  const buildIdentity = { serviceId: "herdr-agent-swarm" as const, version: "0.4.0", buildId: "sha256:test-build", gitCommit: null };
  const project = { id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() };
  const lease = { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) };

  it("fails readiness closed through one coherent provider observation", async () => {
    store = new SqliteBindingStore(":memory:");
    const runtimeSnapshot = vi.fn(() => { throw new Error("runtime unavailable"); });
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never,
      lease, instanceRuntime: { snapshot: runtimeSnapshot }, buildIdentity, readinessTtlMs: 0
    });

    await expect(collector.readiness()).resolves.toMatchObject({
      status: "not_ready", components: { instanceRuntime: { ok: false, error: "runtime unavailable" } }
    });
    expect(runtimeSnapshot).toHaveBeenCalledOnce();
  });

  it("isolates and redacts a diagnostic failure while preserving sibling status", async () => {
    store = new SqliteBindingStore(":memory:");
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease,
      workspaceCache: { status() { throw new Error("Bearer collector-secret"); } },
      herdrSocket: { status: () => ({ connected: true }) } as never, buildIdentity
    });

    const status = await collector.status();
    expect(status).toMatchObject({ status: "degraded", workspaceCache: { error: "Bearer [REDACTED]" }, herdrSocket: { connected: true } });
    expect(JSON.stringify(status)).not.toContain("collector-secret");
  });

  it("shares one in-flight workspace probe across concurrent reads", async () => {
    store = new SqliteBindingStore(":memory:");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const assertWorkspace = vi.fn(async () => { await gate; });
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { assertWorkspace } as never,
      lease, buildIdentity, readinessTtlMs: 60_000
    });

    const readiness = collector.readiness();
    const status = collector.status();
    await vi.waitFor(() => expect(assertWorkspace).toHaveBeenCalledOnce());
    release();
    await Promise.all([readiness, status]);
    expect(assertWorkspace).toHaveBeenCalledOnce();
  });

  it("serves stale workspace readiness to status while strict readiness awaits one refresh", async () => {
    store = new SqliteBindingStore(":memory:");
    let now = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let calls = 0;
    const assertWorkspace = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return;
      await refreshGate;
      throw new Error("workspace offline");
    });
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { assertWorkspace } as never,
      lease, buildIdentity, readinessTtlMs: 100, clock: () => now
    });
    await expect(collector.readiness()).resolves.toMatchObject({ status: "ready" });
    now = 101;

    const [staleFirst, staleSecond] = await Promise.all([collector.status(), collector.status()]);
    const strictReadiness = collector.readiness();
    let strictSettled = false;
    void strictReadiness.then(() => { strictSettled = true; });
    await Promise.resolve();
    expect(assertWorkspace).toHaveBeenCalledTimes(2);
    expect(strictSettled).toBe(false);

    releaseRefresh();
    const freshReadiness = await strictReadiness;
    expect(staleFirst).toMatchObject({ readiness: { status: "ready" } });
    expect(staleSecond).toMatchObject({ readiness: { status: "ready" } });
    expect(freshReadiness).toMatchObject({ status: "not_ready", components: { herdr: { ok: false } } });
    await expect(collector.status()).resolves.toMatchObject({
      status: "degraded", readiness: { status: "ready" },
      herdrReadinessSnapshot: { state: "stale", lastFailure: "One or more Herdr workspaces are unavailable" }
    });
  });

  it("backs off failed stale refreshes and retries once after the deadline", async () => {
    store = new SqliteBindingStore(":memory:");
    let now = 0;
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const assertWorkspace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("workspace offline"))
      .mockImplementationOnce(async () => { await retryGate; });
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { assertWorkspace } as never,
      lease, buildIdentity, readinessTtlMs: 100,
      workspaceReadinessRetryBackoffMinMs: 50, workspaceReadinessRetryBackoffMaxMs: 50, clock: () => now
    });
    await collector.readiness();
    now = 101;

    await collector.status();
    await vi.waitFor(() => expect(assertWorkspace).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      await expect(collector.status()).resolves.toMatchObject({
        status: "degraded",
        herdrReadinessSnapshot: {
          state: "stale", refreshing: false, collectedAt: "1970-01-01T00:00:00.000Z",
          lastFailure: "One or more Herdr workspaces are unavailable", failedWorkspaceIds: ["w1"], retryAt: "1970-01-01T00:00:00.151Z"
        }
      });
    });
    expect(assertWorkspace).toHaveBeenCalledTimes(2);

    now = 151;
    const [firstRetryStatus, secondRetryStatus] = await Promise.all([collector.status(), collector.status()]);
    expect(firstRetryStatus).toMatchObject({ herdrReadinessSnapshot: { state: "stale", refreshing: true, lastFailure: "One or more Herdr workspaces are unavailable" } });
    expect(secondRetryStatus).toMatchObject({ herdrReadinessSnapshot: { state: "stale", refreshing: true, lastFailure: "One or more Herdr workspaces are unavailable" } });
    expect(assertWorkspace).toHaveBeenCalledTimes(3);

    releaseRetry();
    await vi.waitFor(async () => {
      await expect(collector.status()).resolves.toMatchObject({
        status: "ok",
        herdrReadinessSnapshot: { state: "fresh", refreshing: false, lastFailure: null, retryAt: null }
      });
    });
    expect(assertWorkspace).toHaveBeenCalledTimes(3);
  });

  it("reuses a cold failed workspace observation until the status retry deadline", async () => {
    store = new SqliteBindingStore(":memory:");
    let now = 0;
    let retryAllowed = false;
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const assertWorkspace = vi.fn(async () => {
      if (!retryAllowed) throw new Error("workspace offline");
      await retryGate;
    });
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { assertWorkspace } as never,
      lease, buildIdentity, readinessTtlMs: 100,
      workspaceReadinessRetryBackoffMinMs: 100, workspaceReadinessRetryBackoffMaxMs: 100, clock: () => now
    });

    await expect(collector.status()).resolves.toMatchObject({
      status: "degraded", readiness: { status: "not_ready" },
      herdrReadinessSnapshot: {
        state: "unavailable", refreshing: false, failedWorkspaceIds: ["w1"],
        lastFailure: "One or more Herdr workspaces are unavailable", retryAt: "1970-01-01T00:00:00.100Z"
      }
    });
    await expect(collector.status()).resolves.toMatchObject({ readiness: { status: "not_ready" } });
    expect(assertWorkspace).toHaveBeenCalledOnce();

    now = 100;
    retryAllowed = true;
    const [firstRetryStatus, secondRetryStatus] = await Promise.all([collector.status(), collector.status()]);
    expect(firstRetryStatus).toMatchObject({ readiness: { status: "not_ready" }, herdrReadinessSnapshot: { refreshing: true } });
    expect(secondRetryStatus).toMatchObject({ readiness: { status: "not_ready" }, herdrReadinessSnapshot: { refreshing: true } });
    expect(assertWorkspace).toHaveBeenCalledTimes(2);

    const strictReadiness = collector.readiness();
    let strictSettled = false;
    void strictReadiness.finally(() => { strictSettled = true; });
    await Promise.resolve();
    expect(strictSettled).toBe(false);
    releaseRetry();
    await expect(strictReadiness).resolves.toMatchObject({ status: "ready" });
    await vi.waitFor(async () => {
      await expect(collector.status()).resolves.toMatchObject({
        status: "ok", readiness: { status: "ready" },
        herdrReadinessSnapshot: { state: "fresh", refreshing: false, lastFailure: null, retryAt: null }
      });
    });
  });

  it("lets strict readiness bypass a stale refresh backoff", async () => {
    store = new SqliteBindingStore(":memory:");
    let now = 0;
    let releaseStrict!: () => void;
    const strictGate = new Promise<void>((resolve) => { releaseStrict = resolve; });
    const assertWorkspace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("workspace offline"))
      .mockImplementationOnce(async () => { await strictGate; });
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { assertWorkspace } as never,
      lease, buildIdentity, readinessTtlMs: 100,
      workspaceReadinessRetryBackoffMinMs: 1_000, workspaceReadinessRetryBackoffMaxMs: 1_000, clock: () => now
    });
    await collector.readiness();
    now = 101;
    await collector.status();
    await vi.waitFor(() => expect(assertWorkspace).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      await expect(collector.status()).resolves.toMatchObject({
        status: "degraded",
        herdrReadinessSnapshot: { state: "stale", refreshing: false, lastFailure: "One or more Herdr workspaces are unavailable" }
      });
    });

    now = 102;
    const strictReadiness = collector.readiness();
    await vi.waitFor(() => expect(assertWorkspace).toHaveBeenCalledTimes(3));
    let strictSettled = false;
    void strictReadiness.finally(() => { strictSettled = true; });
    await Promise.resolve();
    expect(strictSettled).toBe(false);
    releaseStrict();
    await expect(strictReadiness).resolves.toMatchObject({ status: "ready" });
  });

  it("increases failed workspace refresh backoff up to its cap", async () => {
    store = new SqliteBindingStore(":memory:");
    let now = 0;
    const assertWorkspace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("workspace offline"));
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { assertWorkspace } as never,
      lease, buildIdentity, readinessTtlMs: 100,
      workspaceReadinessRetryBackoffMinMs: 50, workspaceReadinessRetryBackoffMaxMs: 200, clock: () => now
    });
    await collector.readiness();

    for (const [refreshAt, expectedRetryAt, expectedCalls] of [[101, 151, 2], [151, 251, 3], [251, 451, 4], [451, 651, 5]] as const) {
      now = refreshAt;
      await collector.status();
      await vi.waitFor(async () => {
        await expect(collector.status()).resolves.toMatchObject({
          herdrReadinessSnapshot: { refreshing: false, retryAt: new Date(expectedRetryAt).toISOString() }
        });
      });
      expect(assertWorkspace).toHaveBeenCalledTimes(expectedCalls);
    }
  });

  it("settles an active stale workspace refresh before health collection stops", async () => {
    store = new SqliteBindingStore(":memory:");
    let now = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const assertWorkspace = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => { await refreshGate; });
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { assertWorkspace } as never,
      lease, buildIdentity, readinessTtlMs: 100, clock: () => now
    });
    await collector.readiness();
    now = 101;
    await collector.status();
    await vi.waitFor(() => expect(assertWorkspace).toHaveBeenCalledTimes(2));

    let stopped = false;
    const stopping = collector.stop(createShutdownContext(1_000).context).then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(assertWorkspace).toHaveBeenCalledTimes(2);

    releaseRefresh();
    await stopping;
    expect(stopped).toBe(true);
    expect(assertWorkspace).toHaveBeenCalledTimes(2);
  });

  it("reports recovery diagnostics and degrades status only for a failed pass", async () => {
    store = new SqliteBindingStore(":memory:");
    const recovery = {
      version: 4, state: "idle" as const, lastPassAt: "2026-10-02T05:00:00.000Z", lastPassOutcome: "succeeded" as const,
      stageCounts: { observing_execution: 1, rebuilding_projection: 2, delivering: 3, awaiting_ack: 4, recovered: 5, needs_human: 6 },
      oldestPendingAt: "2026-10-02T04:59:00.000Z", oldestPendingAgeSeconds: 60, lastFailure: null,
      items: [{ kind: "primary_answer" as const, stage: "delivering" as const, bindingId: "binding-1", promptId: "prompt-1", workerId: null, workerTurnId: null, updatedAt: "2026-10-02T04:59:00.000Z" }]
    };
    const recoverySupervisor = { snapshot: vi.fn(() => recovery) };
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never,
      lease, recoverySupervisor, buildIdentity, readinessTtlMs: 0, statusTtlMs: 0
    });

    await expect(collector.readiness()).resolves.toMatchObject({ status: "ready" });
    await expect(collector.status()).resolves.toMatchObject({ status: "ok", recovery });

    recoverySupervisor.snapshot.mockReturnValue({ ...recovery, version: 5, lastPassOutcome: "failed", lastFailure: "scan failed" });
    await expect(collector.readiness()).resolves.toMatchObject({ status: "ready" });
    await expect(collector.status()).resolves.toMatchObject({ status: "degraded", recovery: { version: 5, lastPassOutcome: "failed" } });
  });

  it("reports unified Turn Card lifecycle and delivery diagnostics", async () => {
    store = new SqliteBindingStore(":memory:");
    const segment = store.database.prepare("SELECT 1").get();
    expect(segment).toEqual({ 1: 1 });
    const status = await createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease,
      buildIdentity, readinessTtlMs: 0, statusTtlMs: 0
    }).status();
    expect(status).toMatchObject({ operational: { turnCards: {
      pending: 0, working: 0, terminal: 0, needsHuman: 0,
      pagesAwaitingCreate: 0, pagesAwaitingUpdate: 0, quarantined: 0
    }, semanticDeliveryRollout: {
      shadowEpoch:0,shadowStartedAt:null,oldestUnpreparedSemanticAt:null,oldestUnpreparedSemanticAgeSeconds:null,
      preparationCasFailures:0,unmetPrerequisiteCount:0,oldestUnmetPrerequisiteAt:null,oldestUnmetPrerequisiteAgeSeconds:null,
      checkpointBackwardRebases:0
    } } });
  });

  it("reports bounded Pane Topology and per-pane Worker Ring convergence evidence", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "ok", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane" });
    const createWorker = (id: string, paneId: string) => {
      const created = store!.createWorkerAgentInstance({
        id, projectId: "ok", name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running",
        parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
        workspace: { id: `${id}-workspace`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
      }, 4).instance;
      return store!.attachAgentInstanceRuntime({
        instanceId: created.id, expectedGeneration: created.generation,
        herdrWorkspaceId: "w1", paneId, nativeSessionId: `${id}-session`
      })!;
    };
    const perPane = createWorker("worker-per-pane", "worker-pane");
    const legacy = createWorker("worker-legacy", "legacy-worker-pane");
    store.enqueueOutboundReply({ id: "primary-delivery", idempotencyKey: "primary-delivery", bindingId: "binding", bindingGeneration: 1, rootMessageId: "root", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "worker-per-pane-delivery", idempotencyKey: "worker-per-pane-delivery", workerId: perPane.id, workerSessionGeneration: perPane.workerSessionGeneration, rootMessageId: "worker-root", kind: "card_reply", payload: "{}" });
    const legacyReply = store.enqueueOutboundReply({ id: "worker-legacy-delivery", idempotencyKey: "worker-legacy-delivery", workerId: legacy.id, workerSessionGeneration: legacy.workerSessionGeneration, rootMessageId: "legacy-root", kind: "card_reply", payload: "{}" });
    const immutable = store.database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='outbound_replies_immutable_claim'").get() as { sql: string };
    store.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    store.database.prepare("UPDATE outbound_replies SET scope_key=json_array('pane','w1','primary-pane'),scope_pane_id='primary-pane' WHERE id=?").run(legacyReply.id);
    store.database.exec(immutable.sql);
    const topologyInput = (id: string, ownerId: string) => ({
      id, idempotencyKey: id,
      owner: { kind: "primary" as const, id: ownerId, generation: 1, sessionGeneration: 1 },
      expected: { workspaceId: "w1", paneId: `${id}-pane`, terminalId: `${id}-terminal`, agentSessionId: `${id}-session`, tabId: `${id}-tab`, paneLabel: "old", tabLabel: "old" },
      desired: { tabId: "primary-tab", anchorPaneId: "primary-pane", paneLabel: "new", tabLabel: "group" }
    });
    store.paneTopology.reserve(topologyInput("topology-pending", "binding-pending"));
    const uncertain = store.paneTopology.reserve(topologyInput("topology-uncertain", "binding-uncertain")).intent;
    const claimed = store.paneTopology.claim(uncertain.id, "2026-10-13T00:00:00.000Z")!;
    store.paneTopology.markUncertain({ id: claimed.id, expectedAttemptCount: claimed.attemptCount, detail: "observe", at: "2026-10-13T00:00:01.000Z" });

    const status = await createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease,
      buildIdentity, readinessTtlMs: 0, statusTtlMs: 0
    }).status();

    expect(status).toMatchObject({
      status: "degraded",
      operational: {
        paneTopology: { pending: 1, executing: 0, uncertain: 1, recoverable: 2 },
        deliveryRings: { primaryPaneScopes: 1, workerPaneScopes: 1, legacyWorkerScopeDebt: 1 }
      }
    });
  });

  it("refuses semantic Turn Card cutover while shadow parity has mismatches", async () => {
    store = new SqliteBindingStore(":memory:");
    const operational = {
      ...store.getOperationalSummary(),
      semanticDeliveryRollout: {
        phase: "shadow",
        cohortEnabled: false,
        cutoverAllowed: false,
        contractionAllowed: false,
        legacyRows: 3,
        semanticRows: 0,
        shadowMatches: 7,
        shadowMismatches: 1,
        ambiguousActionableRows: 0,
        unsupportedVersions: 0,
        unresolvedSettlementGaps: 0,
        retentionBlockers: 0,
        blockers: ["shadow_mismatch"]
      }
    };
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease, buildIdentity,
      diagnostics: { async inspectDiagnostics() { return {
        operational, semantic: { issues: [], truncated: false },
        physical: { quickCheck: "ok", foreignKeyIssues: [], truncated: false }, connection: { queryOnly: true, busyTimeoutMs: 25 }
      }; } }
    });

    await expect(collector.status()).resolves.toMatchObject({
      status: "degraded",
      operational: { semanticDeliveryRollout: { cutoverAllowed: false, blockers: ["shadow_mismatch"] } }
    });
  });

  it.each([
    "shadow_mismatch", "ambiguous_actionable_rows", "unsupported_versions", "unresolved_settlement_gaps", "retention_blockers"
  ] as const)("degrades semantic Turn Card rollout refusal for %s", async (blocker) => {
    store = new SqliteBindingStore(":memory:");
    const operational = { ...store.getOperationalSummary(), semanticDeliveryRollout: {
      ...store.getOperationalSummary().semanticDeliveryRollout, phase: "shadow" as const,
      cutoverAllowed: false, contractionAllowed: false, blockers: [blocker]
    } };
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease, buildIdentity,
      diagnostics: { async inspectDiagnostics() { return {
        operational, semantic: { issues: [], truncated: false },
        physical: { quickCheck: "ok", foreignKeyIssues: [], truncated: false }, connection: { queryOnly: true, busyTimeoutMs: 25 }
      }; } }
    });
    await expect(collector.status()).resolves.toMatchObject({ status:"degraded", operational:{ semanticDeliveryRollout:{ blockers:[blocker] } } });
  });

  it("fails Agent Input readiness when required session ingestion is unavailable", async () => {
    store = new SqliteBindingStore(":memory:");
    const coreSessionIngestion = { snapshot: () => ({
      ready: false, state: "idle" as const, recoveryState: "needs_human" as const, runCount: 4,
      activeSessions: 0, awaitingSessions: 0, laggingSessions: 1, oldestLagAgeSeconds: 15, requiredFailures: 1,
      retryingSessions: 1, maxRetryAttempt: 2, nextRetryAt: "2026-10-04T12:00:05.000Z",
      indexingRecoveries: 0, needsHumanRecoveries: 1,
      lastRunAt: "2026-10-04T12:00:00.000Z", lastSuccessfulIngestAt: null,
      lastFailureAt: "2026-10-04T12:00:00.000Z", lastFailureCode: "recovery_ambiguous" as const,
      lastFailure: "Exact Core session ingestion route is unavailable"
    }) };
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease,
      agentInputCapability: { snapshot: () => ({ required: true, detected: true, supported: true, ready: true, error: null }) },
      coreSessionIngestion, buildIdentity, readinessTtlMs: 0, statusTtlMs: 0
    });

    await expect(collector.readiness()).resolves.toMatchObject({
      status: "not_ready", components: { agentInput: { ok: false, supported: true, error: "Exact Core session ingestion route is unavailable" } }
    });
    await expect(collector.status()).resolves.toMatchObject({
      coreSessionIngestion: { recoveryState: "needs_human", runCount: 4, requiredFailures: 1, needsHumanRecoveries: 1, lastFailureCode: "recovery_ambiguous" }
    });
  });

  it("degrades semantic findings without reporting physical corruption", async () => {
    store = new SqliteBindingStore(":memory:");
    const operational = store.getOperationalSummary();
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease, buildIdentity,
      diagnostics: { async inspectDiagnostics() { return {
        operational, semantic: { issues: [{ rule: "semantic_mismatch", table: "safe_table", count: 2 }], truncated: false },
        physical: { quickCheck: "ok", foreignKeyIssues: [], truncated: false }, connection: { queryOnly: true, busyTimeoutMs: 25 }
      }; } }
    });

    await expect(collector.status()).resolves.toMatchObject({
      status: "degraded",
      sqliteDiagnostics: { state: "fresh", physicalState: "healthy", semanticIssueCount: 2 }
    });
    await expect(collector.readiness()).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps a physical failure sticky until a later physical audit confirms health", async () => {
    store = new SqliteBindingStore(":memory:");
    const operational = store.getOperationalSummary();
    const inspectDiagnostics = vi.fn().mockResolvedValue({
      operational, semantic: { issues: [], truncated: false }, physical: undefined,
      connection: { queryOnly: true, busyTimeoutMs: 25 }
    });
    let physicalFailed = true;
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease, buildIdentity,
      diagnostics: { inspectDiagnostics }, diagnosticsTtlMs: 0,
      sqliteIntegrity: { snapshot: () => physicalFailed ? {
        state: "degraded", quickCheck: "failed", issues: [{ rule: "sqlite_quick_check", table: "database", count: 1 }], truncated: false,
        startedAt: "2026-10-08T00:00:00.000Z", completedAt: "2026-10-08T00:00:01.000Z", durationMs: 1_000, error: null
      } : {
        state: "healthy", quickCheck: "ok", issues: [], truncated: false,
        startedAt: "2026-10-08T00:01:00.000Z", completedAt: "2026-10-08T00:01:01.000Z", durationMs: 1_000, error: null
      } }
    });

    await collector.status();
    await expect(collector.readiness()).resolves.toMatchObject({ status: "not_ready" });
    physicalFailed = false;
    await expect(collector.status()).resolves.toMatchObject({ sqliteDiagnostics: { physicalState: "healthy" } });
    await expect(collector.readiness()).resolves.toMatchObject({ status: "ready" });
    expect(inspectDiagnostics).toHaveBeenCalledWith({ issueLimit: 20, includePhysical: false }, expect.any(AbortSignal));
  });

  it.each([
    ["locked", Object.assign(new Error("secret-locked-payload"), { errcode: 6 })],
    ["timeout", Object.assign(new Error("secret-timeout-payload"), { failureClass: "timeout" })],
    ["other", new Error("secret-other-payload")]
  ] as const)("classifies a %s refresh failure without leaking its message", async (failureClass, failure) => {
    store = new SqliteBindingStore(":memory:");
    let now = 2_000;
    const operational = store.getOperationalSummary();
    const collector = createCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease, buildIdentity,
      diagnostics: { inspectDiagnostics: vi.fn().mockResolvedValueOnce({
        operational, semantic: { issues: [], truncated: false },
        physical: { quickCheck: "ok", foreignKeyIssues: [], truncated: false }, connection: { queryOnly: true, busyTimeoutMs: 25 }
      }).mockRejectedValueOnce(failure) },
      clock: () => now, diagnosticsTtlMs: 0, retryBackoffMinMs: 10, retryBackoffMaxMs: 10
    });

    await collector.status();
    now += 1;
    await collector.status();
    await Promise.resolve();
    const status = await collector.status();
    expect(status).toMatchObject({ sqliteDiagnostics: { state: "stale", physicalState: "healthy", failureClass } });
    expect(JSON.stringify(status)).not.toContain(failure.message);
  });
});

function createCollector(options: Omit<HealthSnapshotOptions, "diagnostics"> & { diagnostics?: HealthSnapshotOptions["diagnostics"]; store: SqliteBindingStore }): HealthSnapshotCollector {
  return new HealthSnapshotCollector({
    sqliteIntegrity: { snapshot: () => ({
      state: "healthy", quickCheck: "ok", issues: [], truncated: false,
      startedAt: "2026-10-08T00:00:00.000Z", completedAt: "2026-10-08T00:00:01.000Z", durationMs: 1_000, error: null
    }) },
    ...options,
    diagnostics: options.diagnostics ?? diagnosticsFor(options.store)
  });
}

function diagnosticsFor(store: SqliteBindingStore): HealthSnapshotOptions["diagnostics"] {
  return { async inspectDiagnostics({ includePhysical }) {
    return {
      operational: store.getOperationalSummary(),
      semantic: { issues: [], truncated: false },
      physical: includePhysical ? { quickCheck: "ok", foreignKeyIssues: [], truncated: false } : undefined,
      connection: { queryOnly: true, busyTimeoutMs: 25 }
    };
  } };
}
