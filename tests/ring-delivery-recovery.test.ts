import { describe, expect, it, vi } from "vitest";
import type { PreparedDelivery } from "../src/domain/delivery.js";
import type { DeliveryEngineRefillPort } from "../src/domain/delivery-engine.js";
import { RingDeliveryEngine } from "../src/events/ring-delivery-engine.js";

function delivery(id: string, order = 1, options: { bytes?: number; nextAttemptAt?: string } = {}): PreparedDelivery {
  return {
    replyId: id, scope: { kind: "pane", workspaceId: "workspace", paneId: "pane" },
    ownerFence: { kind: "primary", id: "binding", generation: 1, sessionGeneration: 1 },
    deliveryOrder: order, workClass: "live", idempotencyKey: id, gatewayId: "gateway", gatewayProfileId: "profile",
    preparedPlan: { protocolVersion: 1, gatewayId: "gateway", profileId: "profile", rendererRevision: 1, operation: "message.reply.text", intent: { kind: "message.reply.text", rootMessageId: "root", text: id } },
    planHash: `hash-${id}`, projectionKey: "turn-card:segment:page:0", snapshotRevision: 1, rendererRevision: 1,
    cardSequence: null, priorCheckpoints: [], nextAttemptAt: options.nextAttemptAt ?? "2026-10-06T00:00:00.000Z", estimatedBytes: options.bytes ?? 10
  };
}

function replaceableSnapshot(id: string, order: number, options: { workClass: "live" | "history"; revision: number; bytes: number }): PreparedDelivery {
  return {
    ...delivery(id, order, { bytes: options.bytes, nextAttemptAt: "2026-10-07T00:00:00.000Z" }),
    workClass: options.workClass,
    conflictKey: "conflict",
    projectionKey: "projection",
    snapshotRevision: options.revision,
    preparedPlan: {
      protocolVersion: 1, gatewayId: "gateway", profileId: "profile", rendererRevision: 1,
      operation: "surface.replace", intent: { kind: "surface.replace", purpose: "primary-main", messageId: "root", view: { schemaVersion: 1, nodes: [] } }
    }
  };
}

function store() {
  return {
    runGlobalRingMaintenance: vi.fn(),
    recoverExpiredRingClaims: vi.fn(() => []),
    recoverQuarantinedRingHeads: vi.fn(() => ({ transitionedScopeKeys: [], nextCursor: null })),
    claimConversationPageDelivery: vi.fn(({ delivery: candidate }) => ({ replyId: candidate.replyId, attemptId: `claim-${candidate.replyId}`, ownerId: "owner", fencingToken: 1, planHash: candidate.planHash, snapshotRevision: candidate.snapshotRevision })),
    advanceSupersededHead: vi.fn(() => ({ outcome: "blocked" as const })),
    checkpointConversationPageDelivery: vi.fn(() => true), acknowledgeConversationPageDelivery: vi.fn(() => true), failConversationPageDelivery: vi.fn(() => "retry" as const)
  };
}

describe("Ring delivery cold recovery", () => {
  it("refills only the hinted scope without running global maintenance", async () => {
    let notifyWork!: (hint: { kind: "scope"; scope: PreparedDelivery["scope"] } | { kind: "recovery" }) => void;
    const maintenance = vi.fn();
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const engine = new RingDeliveryEngine({
      store: { ...store(), runGlobalRingMaintenance: maintenance } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: false,
      subscribeWork: (listener) => { notifyWork = listener; return () => undefined; }
    });

    engine.start();
    const scope = { kind: "pane" as const, workspaceId: "workspace", paneId: "scope-only" };
    notifyWork({ kind: "scope", scope });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());

    expect(load).toHaveBeenCalledWith(expect.objectContaining({ scope }));
    expect(maintenance).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("owns a rejected exact-scope notifier refill", async () => {
    let notifyWork!: (hint: { kind: "scope"; scope: PreparedDelivery["scope"] } | { kind: "recovery" }) => void;
    const failure = new Error("injected exact-scope refill failure");
    const load = vi.fn(async () => { throw failure; });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: false,
      subscribeWork: (listener) => { notifyWork = listener; return () => undefined; }
    });

    try {
      engine.start();
      notifyWork({ kind: "scope", scope: { kind: "pane", workspaceId: "workspace", paneId: "rejected-refill" } });
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await engine.stop().catch(() => undefined);
    }
  });

  it("does not refill a hinted scope whose exact work is already cached", async () => {
    let notifyWork!: (hint: { kind: "scope"; scope: PreparedDelivery["scope"] } | { kind: "recovery" }) => void;
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: false,
      subscribeWork: (listener) => { notifyWork = listener; return () => undefined; }
    });
    const exact = delivery("already-cached");

    engine.start();
    engine.enqueue(exact);
    notifyWork({ kind: "scope", scope: exact.scope });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    expect(load).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("retains global discovery for an unknown recovery wake", async () => {
    let notifyWork!: (hint: { kind: "scope"; scope: PreparedDelivery["scope"] } | { kind: "recovery" }) => void;
    const maintenance = vi.fn();
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const engine = new RingDeliveryEngine({
      store: { ...store(), runGlobalRingMaintenance: maintenance } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: false,
      subscribeWork: (listener) => { notifyWork = listener; return () => undefined; }
    });

    engine.start();
    notifyWork({ kind: "recovery" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());

    expect(load).toHaveBeenCalledWith(expect.objectContaining({ scope: null }));
    expect(maintenance).toHaveBeenCalledOnce();
    await engine.stop();
  });

  it("executes a crash-recovered frozen semantic plan without rerendering it", async () => {
    const recovered = delivery("frozen-semantic");
    const prepareSemanticDelivery = vi.fn();
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute },
      prepareSemanticDelivery,
      refill: { load: vi.fn(async () => ({ deliveries: [recovered], nextRetryAt: null, nextPageToken: null })), isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true
    });

    engine.start();
    await engine.whenRecoveryReady();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    expect(prepareSemanticDelivery).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(recovered.preparedPlan, expect.objectContaining({ idempotencyKey: recovered.idempotencyKey }));
    await engine.stop();
  });

  it("pages startup recovery to completion before reporting recovery readiness", async () => {
    const calls: Array<string | null> = [];
    const yieldedBeforeCalls: boolean[] = [];
    let yielded = false;
    const refill: DeliveryEngineRefillPort = {
      load: vi.fn(async ({ pageToken, limit }) => {
        calls.push(pageToken ?? null);
        yieldedBeforeCalls.push(yielded);
        expect(limit).toBe(4);
        return pageToken === undefined || pageToken === null
          ? { deliveries: [delivery("first")], nextRetryAt: null, nextPageToken: "scope-a" }
          : { deliveries: [], nextRetryAt: null, nextPageToken: null };
      }),
      isDurablyEmpty: vi.fn(async () => false)
    };
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute },
      refill,
      coldRecoveryEnabled: true,
      yieldRefillPage: vi.fn(async () => { yielded = true; })
    });

    engine.start();
    expect(engine.snapshot().recoveryReady).toBe(false);
    await engine.whenRecoveryReady();

    expect(calls).toEqual([null, "scope-a"]);
    expect(yieldedBeforeCalls).toEqual([false, true]);
    expect(engine.snapshot().recoveryReady).toBe(true);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await engine.stop();
  });

  it("runs global maintenance once before traversing every startup refill page", async () => {
    const maintenance = vi.fn();
    const load = vi.fn(async ({ pageToken }: { pageToken?: string | null }) => pageToken === null || pageToken === undefined
      ? { deliveries: [], nextRetryAt: null, nextPageToken: "scope-a" }
      : { deliveries: [], nextRetryAt: null, nextPageToken: null });
    const engine = new RingDeliveryEngine({
      store: { ...store(), runGlobalRingMaintenance: maintenance } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true
    });

    engine.start();
    await engine.whenRecoveryReady();

    expect(load).toHaveBeenCalledTimes(2);
    expect(maintenance).toHaveBeenCalledOnce();
    expect(maintenance).toHaveBeenCalledWith({ at: expect.any(String), limit: 64 });
    expect(maintenance.mock.invocationCallOrder[0]).toBeLessThan(load.mock.invocationCallOrder[0]!);
    await engine.stop();
  });

  it("coordinates bounded maintenance slices once and yields between their writer transactions", async () => {
    const recoverExpiredRingClaims = vi.fn(() => ["expired"]);
    const dismissRejectedQuarantineReviewBatch = vi.fn(() => ["review-scope"]);
    const coalesceHistoricalPrimaryMainSnapshots = vi.fn(() => []);
    const yieldRefillPage = vi.fn(async () => undefined);
    const targetStore = store();
    const engine = new RingDeliveryEngine({
      store: {
        ...targetStore,
        recoverExpiredRingClaims,
        dismissRejectedQuarantineReviewBatch,
        coalesceHistoricalPrimaryMainSnapshots
      } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load: vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null })), isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      yieldRefillPage
    });

    engine.start();
    await engine.whenRecoveryReady();

    expect(recoverExpiredRingClaims).toHaveBeenCalledOnce();
    expect(dismissRejectedQuarantineReviewBatch).toHaveBeenCalledOnce();
    expect(coalesceHistoricalPrimaryMainSnapshots).toHaveBeenCalledOnce();
    expect(targetStore.runGlobalRingMaintenance).not.toHaveBeenCalled();
    expect(yieldRefillPage).toHaveBeenCalledTimes(2);
    expect(recoverExpiredRingClaims.mock.invocationCallOrder[0]).toBeLessThan(dismissRejectedQuarantineReviewBatch.mock.invocationCallOrder[0]!);
    expect(dismissRejectedQuarantineReviewBatch.mock.invocationCallOrder[0]).toBeLessThan(coalesceHistoricalPrimaryMainSnapshots.mock.invocationCallOrder[0]!);
    await engine.stop();
  });

  it("dispatches committed retirement hints, refills transitioned scopes, and never calls Gateway for retirement", async () => {
    const hint = { kind: "card-context" as const, targetKind: "primary-session" as const, targetId: "current", targetGeneration: 1 };
    const transitionedScopeKey = '["pane","workspace","pane-retired"]';
    const retireReconstructibleInvalidOwnerHeads = vi.fn(() => ({
      transitionedScopeKeys: [transitionedScopeKey], projectionRecoveryHints: [hint]
    }));
    const onProjectionRecoveryHints = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const execute = vi.fn();
    const engine = new RingDeliveryEngine({
      store: { ...store(), retireReconstructibleInvalidOwnerHeads } as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      onProjectionRecoveryHints,
      coldRecoveryEnabled: true
    });

    engine.start();
    await engine.whenRecoveryReady();

    expect(onProjectionRecoveryHints).toHaveBeenCalledExactlyOnceWith([hint]);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "pane", workspaceId: "workspace", paneId: "pane-retired" }
    }));
    expect(onProjectionRecoveryHints.mock.invocationCallOrder[0]).toBeLessThan(load.mock.invocationCallOrder[0]!);
    expect(execute).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("refills scopes retired from orphaned no-effect Primary Main pending delivery without Gateway work", async () => {
    const transitionedScopeKey = '["pane","workspace","pane-orphaned-pending"]';
    const retireOrphanedPrimaryMainPendingDeliveries = vi.fn(() => ({
      transitionedScopeKeys: [transitionedScopeKey]
    }));
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const execute = vi.fn();
    const engine = new RingDeliveryEngine({
      store: { ...store(), retireOrphanedPrimaryMainPendingDeliveries } as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true
    });

    engine.start();
    await engine.whenRecoveryReady();

    expect(retireOrphanedPrimaryMainPendingDeliveries).toHaveBeenCalledExactlyOnceWith({ at: expect.any(String), limit: 64 });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "pane", workspaceId: "workspace", paneId: "pane-orphaned-pending" }
    }));
    expect(execute).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("consumes affected scopes from the legacy global-maintenance compatibility path once", async () => {
    const transitionedScopeKey = '["pane","workspace","pane-legacy-maintenance"]';
    const maintenance = vi.fn(() => ({ affectedScopeKeys: [transitionedScopeKey] }));
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const engine = new RingDeliveryEngine({
      store: { ...store(), runGlobalRingMaintenance: maintenance } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true
    });

    engine.start();
    await engine.whenRecoveryReady();

    expect(maintenance).toHaveBeenCalledExactlyOnceWith({ at: expect.any(String), limit: 64 });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "pane", workspaceId: "workspace", paneId: "pane-legacy-maintenance" }
    }));
    await engine.stop();
  });

  it("completes empty bounded maintenance slices without yielding startup recovery", async () => {
    const yieldRefillPage = vi.fn(async () => undefined);
    const engine = new RingDeliveryEngine({
      store: {
        ...store(),
        recoverExpiredRingClaims: vi.fn(() => []),
        dismissRejectedQuarantineReviewBatch: vi.fn(() => []),
        coalesceHistoricalPrimaryMainSnapshots: vi.fn(() => [])
      } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load: vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null })), isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      yieldRefillPage
    });

    engine.start();
    await engine.whenRecoveryReady();

    expect(yieldRefillPage).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("keeps scope hints enabled after a runtime maintenance slice fails", async () => {
    let notifyWork!: (hint: { kind: "scope"; scope: PreparedDelivery["scope"] } | { kind: "recovery" }) => void;
    let failMaintenance = false;
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const engine = new RingDeliveryEngine({
      store: {
        ...store(),
        recoverExpiredRingClaims: vi.fn(() => { if (failMaintenance) throw new Error("injected runtime maintenance failure"); return []; }),
        dismissRejectedQuarantineReviewBatch: vi.fn(() => []),
        coalesceHistoricalPrimaryMainSnapshots: vi.fn(() => [])
      } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      subscribeWork: (listener) => { notifyWork = listener; return () => undefined; }
    });

    engine.start();
    await engine.whenRecoveryReady();
    failMaintenance = true;
    notifyWork({ kind: "recovery" });
    await vi.waitFor(() => expect(engine.snapshot().state).toBe("degraded"));
    failMaintenance = false;
    const scope = { kind: "pane" as const, workspaceId: "workspace", paneId: "after-maintenance-failure" };
    notifyWork({ kind: "scope", scope });
    await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ scope })));

    expect(engine.snapshot().recoveryReady).toBe(true);
    await engine.stop();
  });

  it("runs legacy expired-claim recovery once before a multi-page refill when global maintenance is unavailable", async () => {
    const recoverExpiredRingClaims = vi.fn(() => []);
    const load = vi.fn(async ({ pageToken }: { pageToken?: string | null }) => pageToken === null || pageToken === undefined
      ? { deliveries: [], nextRetryAt: null, nextPageToken: "scope-a" }
      : { deliveries: [], nextRetryAt: null, nextPageToken: null });
    const engine = new RingDeliveryEngine({
      store: { ...store(), runGlobalRingMaintenance: undefined, recoverExpiredRingClaims } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      yieldRefillPage: vi.fn(async () => undefined)
    });

    engine.start();
    await engine.whenRecoveryReady();

    expect(load).toHaveBeenCalledTimes(2);
    expect(recoverExpiredRingClaims).toHaveBeenCalledOnce();
    await engine.stop();
  });

  it("yields after page one when interactive work arrives and does not report partial startup recovery ready", async () => {
    let notifyInteractive!: () => void;
    let releaseBackoff!: () => void;
    const backoff = new Promise<void>((resolve) => { releaseBackoff = resolve; });
    let loadCount = 0;
    const load = vi.fn(async ({ pageToken }: { pageToken?: string | null }) => {
      loadCount += 1;
      if (loadCount === 1) {
        notifyInteractive();
        return { deliveries: [], nextRetryAt: null, nextPageToken: "scope-a" };
      }
      return pageToken === null || pageToken === undefined
        ? { deliveries: [], nextRetryAt: null, nextPageToken: "scope-a" }
        : { deliveries: [], nextRetryAt: null, nextPageToken: null };
    });
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      subscribeWork: (listener) => { notifyInteractive = listener; return () => undefined; },
      waitForInteractiveBackoff: vi.fn(async () => backoff)
    });

    engine.start();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(engine.snapshot().recoveryReady).toBe(false);
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();

    releaseBackoff();
    await engine.whenRecoveryReady();
    expect(load.mock.calls.map(([input]) => input.pageToken ?? null)).toEqual([null, null, "scope-a"]);
    expect(engine.snapshot().recoveryReady).toBe(true);
    await engine.stop();
  });

  it("backs off each yielded global recovery pass while interactive work persists", async () => {
    let notifyInteractive!: () => void;
    const backoffReleases: Array<() => void> = [];
    const waitForInteractiveBackoff = vi.fn(async (_delayMs: number) => new Promise<void>((resolve) => {
      backoffReleases.push(resolve);
    }));
    let recoveryCalls = 0;
    const recoverQuarantinedRingHeads = vi.fn(({ afterScopeKey }: { afterScopeKey: string | null }) => {
      recoveryCalls += 1;
      if (recoveryCalls <= 2) {
        notifyInteractive();
        return { transitionedScopeKeys: [], nextCursor: "scope-a" };
      }
      return { transitionedScopeKeys: [], nextCursor: afterScopeKey === null ? "scope-a" : null };
    });
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const backoffPolicy = { interactiveBackoffMs: 17, waitForInteractiveBackoff };
    const engine = new RingDeliveryEngine({
      store: { ...store(), recoverQuarantinedRingHeads } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      subscribeWork: (listener) => { notifyInteractive = listener; return () => undefined; },
      ...backoffPolicy
    });

    engine.start();
    await vi.waitFor(() => expect(waitForInteractiveBackoff).toHaveBeenCalledOnce());
    expect(waitForInteractiveBackoff).toHaveBeenLastCalledWith(17);
    expect(recoverQuarantinedRingHeads.mock.calls.map(([input]) => input.afterScopeKey)).toEqual([null]);
    expect(load).not.toHaveBeenCalled();
    expect(engine.snapshot()).toMatchObject({ recoveryReady: false, safetyScanRuns: 0 });

    notifyInteractive();
    await Promise.resolve();
    expect(recoverQuarantinedRingHeads).toHaveBeenCalledOnce();
    backoffReleases.shift()!();

    await vi.waitFor(() => expect(waitForInteractiveBackoff).toHaveBeenCalledTimes(2));
    expect(recoverQuarantinedRingHeads.mock.calls.map(([input]) => input.afterScopeKey)).toEqual([null]);
    expect(load).not.toHaveBeenCalled();
    expect(engine.snapshot()).toMatchObject({ recoveryReady: false, safetyScanRuns: 0 });

    backoffReleases.shift()!();
    await vi.waitFor(() => expect(waitForInteractiveBackoff).toHaveBeenCalledTimes(3));
    expect(recoverQuarantinedRingHeads.mock.calls.map(([input]) => input.afterScopeKey)).toEqual([null, null]);
    expect(engine.snapshot()).toMatchObject({ recoveryReady: false, safetyScanRuns: 0 });

    backoffReleases.shift()!();
    await engine.whenRecoveryReady();
    expect(recoverQuarantinedRingHeads.mock.calls.map(([input]) => input.afterScopeKey)).toEqual([null, null, null, "scope-a"]);
    expect(load).toHaveBeenCalledOnce();
    expect(engine.snapshot().recoveryReady).toBe(true);
    await engine.stop();
  });

  it("cancels an interactive recovery backoff during bounded shutdown", async () => {
    let notifyInteractive!: () => void;
    let markBackoffStarted!: () => void;
    const backoffStarted = new Promise<void>((resolve) => { markBackoffStarted = resolve; });
    const recoverQuarantinedRingHeads = vi.fn(() => {
      notifyInteractive();
      return { transitionedScopeKeys: [], nextCursor: "scope-a" };
    });
    const engine = new RingDeliveryEngine({
      store: { ...store(), recoverQuarantinedRingHeads } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load: vi.fn(), isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      subscribeWork: (listener) => { notifyInteractive = listener; return () => undefined; },
      waitForInteractiveBackoff: vi.fn(async () => {
        markBackoffStarted();
        await new Promise<void>(() => undefined);
      })
    });

    engine.start();
    await backoffStarted;
    await expect(engine.stop()).resolves.toBeUndefined();
    await expect(engine.whenRecoveryReady()).resolves.toBeUndefined();
    expect(engine.snapshot()).toMatchObject({ state: "stopped", recoveryReady: false, safetyScanRuns: 0 });
    expect(recoverQuarantinedRingHeads).toHaveBeenCalledOnce();
  });

  it("finishes Ring cleanup before reporting an active refill failure during shutdown", async () => {
    let notifyWork!: (hint: { kind: "recovery" }) => void;
    let rejectRefill!: (error: Error) => void;
    const refillGate = new Promise<void>((_resolve, reject) => { rejectRefill = reject; });
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const load = vi.fn(async () => {
      await refillGate;
      return { deliveries: [], nextRetryAt: null, nextPageToken: null };
    });
    const execute = vi.fn(async () => {
      await deliveryGate;
      return { refs: [{ kind: "message" as const, opaqueId: "message" }] };
    });
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: false,
      subscribeWork: (listener) => { notifyWork = listener; return () => undefined; }
    });

    engine.start();
    engine.enqueue(delivery("active-during-stop"));
    engine.enqueue(delivery("queued-during-stop", 2));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    notifyWork({ kind: "recovery" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());

    let stopSettled = false;
    const stopping = engine.stop();
    void stopping.finally(() => { stopSettled = true; }).catch(() => undefined);
    rejectRefill(new Error("injected refill failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(engine.snapshot().state).toBe("stopping");

    releaseDelivery();
    await expect(stopping).rejects.toThrow("injected refill failure");
    expect(engine.snapshot()).toMatchObject({
      state: "stopped", ringCount: 0, activeDeliveries: 0, cachedItems: 0, cachedBytes: 0
    });
    expect((engine as unknown as { scheduler: { snapshot(): { readyCount: number; activeCount: number } } }).scheduler.snapshot())
      .toEqual({ readyCount: 0, activeCount: 0 });
  });

  it("waits for cold-start recovery to cross its shutdown fence", async () => {
    let releaseYield!: () => void;
    const yieldGate = new Promise<void>((resolve) => { releaseYield = resolve; });
    const backfillLegacyConflictKeys = vi.fn()
      .mockReturnValueOnce({ updated: 1, hasMore: true })
      .mockReturnValue({ updated: 0, hasMore: false });
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const engine = new RingDeliveryEngine({
      store: { ...store(), backfillLegacyConflictKeys } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      yieldRefillPage: async () => { await yieldGate; }
    });

    engine.start();
    await vi.waitFor(() => expect(backfillLegacyConflictKeys).toHaveBeenCalledOnce());
    let stopSettled = false;
    const stopping = engine.stop().then(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseYield();
    await stopping;
    expect(backfillLegacyConflictKeys).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(engine.snapshot().state).toBe("stopped");
  });

  it("executes an oversized cold head without retaining it in cache accounting", async () => {
    const oversized = delivery("oversized", 1, { bytes: 100 });
    const refill: DeliveryEngineRefillPort = {
      load: vi.fn(async () => ({ deliveries: [oversized], nextRetryAt: null, nextPageToken: null })),
      isDurablyEmpty: vi.fn(async () => false)
    };
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const engine = new RingDeliveryEngine({ store: store() as never, gateway: { prepare: vi.fn(), execute }, refill, limits: { paneBytes: 50 }, coldRecoveryEnabled: true });

    engine.start();
    await engine.whenRecoveryReady();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    expect(engine.snapshot()).toMatchObject({ cachedBytes: 0, cachedItems: 0 });
    await engine.stop();
  });

  it("uses a due timer to cold-rehydrate instead of executing a stale retry object", async () => {
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    let wake: (() => void) | null = null;
    const fresh = delivery("retry", 1, { nextAttemptAt: "2026-10-06T00:00:10.000Z" });
    const load = vi.fn(async () => now < Date.parse(fresh.nextAttemptAt)
      ? { deliveries: [], nextRetryAt: fresh.nextAttemptAt, nextPageToken: null }
      : { deliveries: [fresh], nextRetryAt: null, nextPageToken: null });
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute: vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] })) },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) }, coldRecoveryEnabled: true, now: () => now,
      scheduleWake: (callback) => { wake = callback; return 1; }, cancelWake: vi.fn()
    });

    engine.start();
    await engine.whenRecoveryReady();
    expect(load).toHaveBeenCalledOnce();
    now = Date.parse(fresh.nextAttemptAt);
    wake!();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await engine.stop();
  });

  it("runs bounded quarantine maintenance before startup hydration exposes the next head", async () => {
    const successor = delivery("successor", 2);
    let maintained = false;
    let yielded = false;
    const yieldedBeforeMaintenanceCalls: boolean[] = [];
    const recoverQuarantinedRingHeads = vi.fn(({ afterScopeKey }: { afterScopeKey: string | null }) => {
      yieldedBeforeMaintenanceCalls.push(yielded);
      if (afterScopeKey === "scope-a") maintained = true;
      return {
        transitionedScopeKeys: ['["pane","workspace","pane"]'],
        nextCursor: afterScopeKey === null ? "scope-a" : null
      };
    });
    let loaded = false;
    const load = vi.fn(async () => {
      const deliveries = maintained && !loaded ? [successor] : [];
      loaded = true;
      return { deliveries, nextRetryAt: null, nextPageToken: null };
    });
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const engine = new RingDeliveryEngine({
      store: { ...store(), recoverQuarantinedRingHeads } as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      yieldRefillPage: vi.fn(async () => { yielded = true; })
    });

    engine.start();
    await engine.whenRecoveryReady();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    expect(recoverQuarantinedRingHeads).toHaveBeenNthCalledWith(1, { afterScopeKey: null, limit: 4, at: expect.any(String), skipGlobalMaintenance: true });
    expect(recoverQuarantinedRingHeads).toHaveBeenNthCalledWith(2, { afterScopeKey: "scope-a", limit: 4, at: expect.any(String), skipGlobalMaintenance: true });
    expect(yieldedBeforeMaintenanceCalls).toEqual([false, true]);
    expect(recoverQuarantinedRingHeads.mock.invocationCallOrder[0]).toBeLessThan(load.mock.invocationCallOrder[0]!);
    await engine.stop();
  });

  it("does not hot-loop when periodic quarantine maintenance leaves a blocked head unchanged", async () => {
    let maintenanceWake: (() => void) | null = null;
    const recoverQuarantinedRingHeads = vi.fn(() => ({ transitionedScopeKeys: [], nextCursor: null }));
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const engine = new RingDeliveryEngine({
      store: { ...store(), recoverQuarantinedRingHeads } as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      scheduleMaintenance: (callback) => { maintenanceWake = callback; return 1; },
      cancelMaintenance: vi.fn()
    });

    engine.start();
    await engine.whenRecoveryReady();
    expect(recoverQuarantinedRingHeads).toHaveBeenCalledTimes(1);
    maintenanceWake!();
    await vi.waitFor(() => expect(recoverQuarantinedRingHeads).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    expect(recoverQuarantinedRingHeads).toHaveBeenCalledTimes(2);
    expect(engine.snapshot()).toMatchObject({
      safetyScanRuns: 1,
      safetyScanDiscoveries: 0,
      lastSafetyScanAt: expect.any(String),
      lastSafetyScanDiscoveryAt: null
    });
    await engine.stop();
  });

  it("keeps exact-scope delivery responsive while an interactive wake yields a global safety scan", async () => {
    let maintenanceWake: (() => void) | null = null;
    let notifyInteractive!: () => void;
    let releaseBackoff!: () => void;
    const backoff = new Promise<void>((resolve) => { releaseBackoff = resolve; });
    let loadCount = 0;
    const load = vi.fn(async ({ pageToken }: { pageToken?: string | null }) => {
      loadCount += 1;
      if (loadCount === 1) return { deliveries: [], nextRetryAt: null, nextPageToken: null };
      if (loadCount === 2) {
        notifyInteractive();
        return { deliveries: [], nextRetryAt: null, nextPageToken: "scope-a" };
      }
      return pageToken === null || pageToken === undefined
        ? { deliveries: [], nextRetryAt: null, nextPageToken: "scope-a" }
        : { deliveries: [], nextRetryAt: null, nextPageToken: null };
    });
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      subscribeWork: (listener) => { notifyInteractive = listener; return () => undefined; },
      scheduleMaintenance: (callback) => { maintenanceWake = callback; return 1; },
      cancelMaintenance: vi.fn(),
      waitForInteractiveBackoff: vi.fn(async () => backoff)
    });

    engine.start();
    await engine.whenRecoveryReady();
    maintenanceWake!();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    engine.enqueue(delivery("interactive"));

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(engine.snapshot().safetyScanRuns).toBe(0);

    releaseBackoff();
    await vi.waitFor(() => expect(engine.snapshot().safetyScanRuns).toBe(1));
    await engine.stop();
  });

  it("refills only the acknowledged scope after an ACK leaves its Ring empty", async () => {
    const candidates = ["first", "second", "third"].map((id, index) => ({
      ...delivery(id, index + 1),
      scope: { kind: "global" as const }
    }));
    let globalLoadCount = 0;
    let scopeLoadCount = 0;
    const load = vi.fn(async ({ scope }: { scope: PreparedDelivery["scope"] | null }) => {
      if (scope !== null) {
        const candidate = candidates[scopeLoadCount++ + 1] ?? null;
        return { deliveries: candidate ? [candidate] : [], nextRetryAt: null, nextPageToken: null };
      }
      const candidate = candidates[globalLoadCount++] ?? null;
      return { deliveries: candidate ? [candidate] : [], nextRetryAt: null, nextPageToken: null };
    });
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load: load as never, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true
    });

    engine.start();
    await engine.whenRecoveryReady();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));

    expect(execute.mock.calls.map(([plan]) => plan.intent.text)).toEqual(["first", "second", "third"]);
    expect(globalLoadCount).toBe(1);
    expect(scopeLoadCount).toBe(3);
    await engine.stop();
  });

  it("runs a follow-up global refill when a notifier wake arrives during the active pass", async () => {
    let notifyWork!: () => void;
    let durableWorkReady = false;
    let globalLoadCount = 0;
    let candidateLoadCount = 0;
    const candidate = { ...delivery("notifier-follow-up"), scope: { kind: "global" as const } };
    const load = vi.fn(async ({ scope }: { scope: PreparedDelivery["scope"] | null }) => {
      if (scope !== null) return { deliveries: [], nextRetryAt: null, nextPageToken: null };
      globalLoadCount += 1;
      if (globalLoadCount === 1) {
        durableWorkReady = true;
        notifyWork();
        return { deliveries: [], nextRetryAt: null, nextPageToken: null };
      }
      if (durableWorkReady) {
        durableWorkReady = false;
        candidateLoadCount += 1;
        return { deliveries: [candidate], nextRetryAt: null, nextPageToken: null };
      }
      return { deliveries: [], nextRetryAt: null, nextPageToken: null };
    });
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load: load as never, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: false,
      subscribeWork: (listener) => { notifyWork = listener; return () => undefined; }
    });

    engine.start();
    notifyWork();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    expect(globalLoadCount).toBe(2);
    expect(candidateLoadCount).toBe(1);
    expect(execute).toHaveBeenCalledWith(candidate.preparedPlan, expect.objectContaining({ idempotencyKey: candidate.idempotencyKey }));
    await engine.stop();
  });

  it("keeps an ACK-triggered scope refill separate from interactive global recovery backoff", async () => {
    let maintenanceWake: (() => void) | null = null;
    let notifyInteractive!: () => void;
    let releaseBackoff!: () => void;
    const backoff = new Promise<void>((resolve) => { releaseBackoff = resolve; });
    const recoverExpiredRingClaims = vi.fn(() => []);
    let quarantineCalls = 0;
    const recoverQuarantinedRingHeads = vi.fn(() => {
      quarantineCalls += 1;
      if (quarantineCalls === 2) {
        notifyInteractive();
        return { transitionedScopeKeys: [], nextCursor: "scope-a" };
      }
      return { transitionedScopeKeys: [], nextCursor: null };
    });
    const load = vi.fn(async () => ({ deliveries: [], nextRetryAt: null, nextPageToken: null }));
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const waitForInteractiveBackoff = vi.fn(async () => backoff);
    const targetStore = store();
    const engine = new RingDeliveryEngine({
      store: { ...targetStore, runGlobalRingMaintenance: undefined, recoverExpiredRingClaims, recoverQuarantinedRingHeads } as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      subscribeWork: (listener) => { notifyInteractive = listener; return () => undefined; },
      scheduleMaintenance: (callback) => { maintenanceWake = callback; return 1; },
      cancelMaintenance: vi.fn(),
      waitForInteractiveBackoff
    });

    engine.start();
    await engine.whenRecoveryReady();
    maintenanceWake!();
    await vi.waitFor(() => expect(waitForInteractiveBackoff).toHaveBeenCalledOnce());
    const before = {
      expired: recoverExpiredRingClaims.mock.calls.length,
      quarantine: recoverQuarantinedRingHeads.mock.calls.length,
      load: load.mock.calls.length
    };

    engine.enqueue(delivery("ack-during-backoff"));
    try {
      await vi.waitFor(() => expect(targetStore.acknowledgeConversationPageDelivery).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recoverExpiredRingClaims).toHaveBeenCalledTimes(before.expired);
      expect(recoverQuarantinedRingHeads).toHaveBeenCalledTimes(before.quarantine);
      expect(load).toHaveBeenCalledTimes(before.load + 1);
      expect(engine.snapshot().safetyScanRuns).toBe(0);
    } finally {
      releaseBackoff();
      await vi.waitFor(() => expect(engine.snapshot().safetyScanRuns).toBe(1));
      await engine.stop();
    }

    expect(recoverExpiredRingClaims).toHaveBeenCalledTimes(before.expired + 1);
    expect(recoverQuarantinedRingHeads).toHaveBeenCalledTimes(before.quarantine + 1);
    expect(load).toHaveBeenCalledTimes(before.load + 2);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("coalesces a retry-wake global refill behind an interactive backoff", async () => {
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    const dueAt = "2026-10-06T00:00:10.000Z";
    let retryWake: (() => void) | null = null;
    let maintenanceWake: (() => void) | null = null;
    let notifyInteractive!: () => void;
    let releaseBackoff!: () => void;
    const backoff = new Promise<void>((resolve) => { releaseBackoff = resolve; });
    const recoverExpiredRingClaims = vi.fn(() => []);
    let quarantineCalls = 0;
    const recoverQuarantinedRingHeads = vi.fn(() => {
      quarantineCalls += 1;
      if (quarantineCalls === 2) {
        notifyInteractive();
        return { transitionedScopeKeys: [], nextCursor: "scope-a" };
      }
      return { transitionedScopeKeys: [], nextCursor: null };
    });
    const future = delivery("retry-during-backoff", 1, { nextAttemptAt: dueAt });
    let globalLoadCalls = 0;
    const load = vi.fn(async ({ scope }: { scope: PreparedDelivery["scope"] | null }) => {
      if (scope !== null) return { deliveries: [], nextRetryAt: null, nextPageToken: null };
      globalLoadCalls += 1;
      return globalLoadCalls === 1
        ? { deliveries: [future], nextRetryAt: dueAt, nextPageToken: null }
        : { deliveries: [], nextRetryAt: null, nextPageToken: null };
    });
    const execute = vi.fn(async () => ({ refs: [{ kind: "message" as const, opaqueId: "message" }] }));
    const waitForInteractiveBackoff = vi.fn(async () => backoff);
    const targetStore = store();
    targetStore.acknowledgeConversationPageDelivery.mockImplementation(() => false);
    const engine = new RingDeliveryEngine({
      store: { ...targetStore, runGlobalRingMaintenance: undefined, recoverExpiredRingClaims, recoverQuarantinedRingHeads } as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load: load as never, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      now: () => now,
      subscribeWork: (listener) => { notifyInteractive = listener; return () => undefined; },
      scheduleWake: (callback) => { retryWake = callback; return 1; },
      cancelWake: vi.fn(),
      scheduleMaintenance: (callback) => { maintenanceWake = callback; return 2; },
      cancelMaintenance: vi.fn(),
      waitForInteractiveBackoff
    });

    engine.start();
    await engine.whenRecoveryReady();
    maintenanceWake!();
    await vi.waitFor(() => expect(waitForInteractiveBackoff).toHaveBeenCalledOnce());
    const before = {
      expired: recoverExpiredRingClaims.mock.calls.length,
      quarantine: recoverQuarantinedRingHeads.mock.calls.length,
      globalLoad: globalLoadCalls
    };

    now = Date.parse(dueAt);
    retryWake!();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recoverExpiredRingClaims).toHaveBeenCalledTimes(before.expired);
      expect(recoverQuarantinedRingHeads).toHaveBeenCalledTimes(before.quarantine);
      expect(globalLoadCalls).toBe(before.globalLoad);
      expect(execute).not.toHaveBeenCalled();
      expect(engine.snapshot().safetyScanRuns).toBe(0);
    } finally {
      releaseBackoff();
      await vi.waitFor(() => expect(engine.snapshot().safetyScanRuns).toBe(1));
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      await engine.stop();
    }

    expect(recoverExpiredRingClaims).toHaveBeenCalledTimes(before.expired + 1);
    expect(recoverQuarantinedRingHeads).toHaveBeenCalledTimes(before.quarantine + 1);
    expect(globalLoadCalls).toBe(before.globalLoad + 1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("counts a missed durable head once when a safety scan discovers it", async () => {
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    let maintenanceWake: (() => void) | null = null;
    let loadCount = 0;
    const missed = delivery("missed", 1, { nextAttemptAt: "2026-10-07T00:00:00.000Z" });
    const load = vi.fn(async () => {
      loadCount += 1;
      return { deliveries: loadCount === 1 ? [] : [missed], nextRetryAt: missed.nextAttemptAt, nextPageToken: null };
    });
    const execute = vi.fn();
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      now: () => now,
      scheduleMaintenance: (callback) => { maintenanceWake = callback; return 1; },
      cancelMaintenance: vi.fn()
    });

    engine.start();
    await engine.whenRecoveryReady();
    expect(engine.snapshot()).toMatchObject({
      safetyScanRuns: 0,
      safetyScanDiscoveries: 0,
      lastSafetyScanAt: null,
      lastSafetyScanDiscoveryAt: null
    });
    now += 30_000;
    maintenanceWake!();
    await vi.waitFor(() => expect(engine.snapshot().safetyScanRuns).toBe(1));
    expect(engine.snapshot()).toMatchObject({
      safetyScanDiscoveries: 1,
      lastSafetyScanAt: "2026-10-06T00:00:30.000Z",
      lastSafetyScanDiscoveryAt: "2026-10-06T00:00:30.000Z"
    });

    now += 30_000;
    maintenanceWake!();
    await vi.waitFor(() => expect(engine.snapshot().safetyScanRuns).toBe(2));
    expect(engine.snapshot()).toMatchObject({ safetyScanDiscoveries: 1 });

    expect(execute).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("does not complete a failed safety scan and reports its discovery after the next successful scan", async () => {
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    let maintenanceWake: (() => void) | null = null;
    let loadCount = 0;
    const missed = delivery("partial-discovery", 1, { nextAttemptAt: "2026-10-07T00:00:00.000Z" });
    const load = vi.fn(async ({ pageToken }: { pageToken?: string | null }) => {
      loadCount += 1;
      if (loadCount === 1) return { deliveries: [], nextRetryAt: null, nextPageToken: null };
      if (loadCount === 2 && (pageToken === null || pageToken === undefined)) {
        return { deliveries: [missed], nextRetryAt: missed.nextAttemptAt, nextPageToken: "next" };
      }
      if (loadCount === 3) throw new Error("injected safety scan failure");
      return { deliveries: [], nextRetryAt: missed.nextAttemptAt, nextPageToken: null };
    });
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      now: () => now,
      scheduleMaintenance: (callback) => { maintenanceWake = callback; return 1; },
      cancelMaintenance: vi.fn()
    });

    engine.start();
    await engine.whenRecoveryReady();
    now += 30_000;
    maintenanceWake!();
    await vi.waitFor(() => expect(engine.snapshot().state).toBe("degraded"));
    expect(engine.snapshot()).toMatchObject({
      safetyScanRuns: 0,
      safetyScanDiscoveries: 0,
      lastSafetyScanAt: null,
      lastSafetyScanDiscoveryAt: null
    });

    now += 30_000;
    maintenanceWake!();
    await vi.waitFor(() => expect(engine.snapshot().safetyScanRuns).toBe(1));
    expect(engine.snapshot()).toMatchObject({
      safetyScanDiscoveries: 1,
      lastSafetyScanAt: "2026-10-06T00:01:00.000Z",
      lastSafetyScanDiscoveryAt: "2026-10-06T00:01:00.000Z"
    });
    await engine.stop();
  });

  it("replaces a safe historical cache reference with live work, refilling only that scope", async () => {
    const now = Date.parse("2026-10-06T00:00:00.000Z");
    const history = replaceableSnapshot("history", 1, { workClass: "history", revision: 1, bytes: 17 });
    const live = replaceableSnapshot("live", 2, { workClass: "live", revision: 2, bytes: 23 });
    let loads = 0;
    const load = vi.fn(async () => ({
      deliveries: loads++ === 0 ? [history] : [], nextRetryAt: "2026-10-07T00:00:00.000Z", nextPageToken: null
    }));
    const engine = new RingDeliveryEngine({
      store: store() as never,
      gateway: { prepare: vi.fn(), execute: vi.fn() },
      refill: { load, isDurablyEmpty: vi.fn(async () => false) },
      coldRecoveryEnabled: true,
      now: () => now
    });

    engine.start();
    await engine.whenRecoveryReady();
    expect(engine.snapshot()).toMatchObject({ cachedItems: 1, cachedBytes: 17 });
    engine.enqueue(live);

    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load).toHaveBeenLastCalledWith({ scope: live.scope, limit: 4, now: new Date(now).toISOString(), pageToken: null });
    expect(engine.snapshot()).toMatchObject({ cachedItems: 1, cachedBytes: 23, oldestLiveReadyAt: null, oldestHistoryReadyAt: null });
    await engine.stop();
  });
});
