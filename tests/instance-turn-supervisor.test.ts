import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceTurnSupervisor } from "../src/coordinator/instance-turn-supervisor.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import type { PaneHost } from "../src/runtime/herdr/pane-host.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { workerPresentation } from "./helpers/presentation.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

function setup(state: "dispatching" | "running", options: { convergeWorkerTurn?: (turnId: string) => void } = {}) {
  store = new SqliteBindingStore(":memory:");
  store.createPendingBinding({ id: "binding", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root-1", title: "Primary", creatorOpenId: "ou_primary" });
  store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p0" });
  const created = store.createWorkerAgentInstance({ id: "worker", projectId: "p1", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "binding", bindingGeneration: 1, paneId: "w1:p0", nativeSessionId: null }, workspace: { id: "ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
  const instance = store.attachAgentInstanceRuntime({ instanceId: "worker", expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: null })!;
  const view = createQueuedWorkerTurnCard({ turnId: "turn", instanceId: instance.id, instanceGeneration: instance.generation, workerSessionGeneration: instance.workerSessionGeneration, workerName: instance.name, parentTurnId: null, rootMessageId: "root-1", requestText: "work", queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
  store.acceptInstanceTurnWithCard({ id: "turn", idempotencyKey: "turn", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "work", parentTurnId: null, sourceMessageId: "m1", view, render: renderWorkerTurnCard });
  store.claimNextInstanceTurn(instance.id, instance.generation);
  store.updateInstanceTurn({ turnId: "turn", expectedGeneration: instance.generation, state, eventKind: `turn.${state}` });
  const inspectPane = vi.fn(async () => ({ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle" as const, foregroundExecutables: ["traex"], agentKind: "traex", terminalId: "term" }));
  const wake = vi.fn();
  const wakeOutbound = vi.fn();
  const supervisor = new InstanceTurnSupervisor({ store, paneHost: { inspectPane } as unknown as PaneHost, wake, wakeOutbound, convergeWorkerTurn: options.convergeWorkerTurn, presentation: workerPresentation });
  return { supervisor, inspectPane, wake, wakeOutbound };
}

describe("InstanceTurnSupervisor", () => {
  it("re-converges durable Worker Task cards during startup recovery", () => {
    const convergeWorkerTurn = vi.fn();
    const { supervisor } = setup("running", { convergeWorkerTurn });
    vi.spyOn(store!, "listActionableWorkerTurnCardIds").mockReturnValue(["turn"]);
    supervisor.prepareRecovery();
    expect(convergeWorkerTurn).toHaveBeenCalledWith("turn");
  });

  it("does not wake recovered claims before fresh runtime reconciliation", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "worker", projectId: "p1", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const instance = store.attachAgentInstanceRuntime({ instanceId: "worker", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: null })!;
    store.acceptInstanceTurn({ id: "turn", idempotencyKey: "turn", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn(instance.id, instance.generation);
    const wake = vi.fn();
    const supervisor = new InstanceTurnSupervisor({ store, paneHost: {} as PaneHost, wake, presentation: workerPresentation });
    supervisor.prepareRecovery();
    expect(store.getInstanceTurn("turn")).toMatchObject({ state: "queued" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("observes a proven running turn to completion without dispatching it again", async () => {
    const { supervisor, wake, wakeOutbound } = setup("running");
    supervisor.prepareRecovery();
    await supervisor.reconcile();
    expect(store!.getInstanceTurn("turn")).toMatchObject({ state: "completed", result: "" });
    expect(store!.loadWorkerTurnCard("turn")).toMatchObject({ phase: "completed", resultCapture: "unavailable", answer: "" });
    expect(JSON.stringify(store!.loadWorkerTurnCard("turn"))).not.toContain("observed:idle");
    expect(wakeOutbound).toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith("worker");
  });

  it("projects recovered blocked and uncertain states only to their own task card", async () => {
    const { supervisor, inspectPane, wakeOutbound } = setup("running");
    inspectPane.mockResolvedValueOnce({ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "blocked", foregroundExecutables: ["traex"], agentKind: "traex", terminalId: "term" });
    await supervisor.reconcile();
    expect(store!.getInstanceTurn("turn")).toMatchObject({ state: "blocked" });
    expect(store!.loadWorkerTurnCard("turn")).toMatchObject({ phase: "blocked" });
    expect(wakeOutbound).toHaveBeenCalled();
  });

  it("wakes and logs once for one durable blocked episode without sensitive notification fields", async () => {
    const { supervisor, inspectPane, wakeOutbound } = setup("running");
    const info = vi.fn(); const warn = vi.fn();
    (supervisor as unknown as { options: { logger: object } }).options.logger = { info, warn };
    inspectPane.mockResolvedValue({ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "blocked", foregroundExecutables: ["traex"], agentKind: "traex", terminalId: "term" });

    await supervisor.reconcile();
    await supervisor.reconcile();

    const notifications = store!.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("worker-review:"));
    expect(notifications).toHaveLength(1);
    expect(wakeOutbound).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "worker-human-review-notification-reserved", instanceId: "worker", turnId: "turn", mention: "included", outcome: "reserved" }), "reserved Worker human review notification");
    expect(JSON.stringify(info.mock.calls)).not.toContain("ou_primary");
    expect(JSON.stringify(info.mock.calls)).not.toContain("Worker 正在等待");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous dispatch uncertain when the pane is idle", async () => {
    const { supervisor, wake } = setup("dispatching");
    supervisor.prepareRecovery();
    await supervisor.reconcile();
    expect(store!.getInstanceTurn("turn")).toMatchObject({ state: "dispatch-uncertain" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("isolates one pane observation failure and still converges another instance", async () => {
    store = new SqliteBindingStore(":memory:");
    const actor = { kind: "human" as const, userId: "u1" };
    for (const id of ["broken", "healthy"]) {
      store.createAgentInstance({ id, projectId: "p1", name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: `/repo/${id}`, branch: null, baseCommit: "base" } });
      const instance = store.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: `w1:${id}`, nativeSessionId: null })!;
      store.acceptInstanceTurn({ id: `turn-${id}`, idempotencyKey: `turn-${id}`, actor, projectId: "p1", instanceId: id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
      store.claimNextInstanceTurn(id, instance.generation);
      store.updateInstanceTurn({ turnId: `turn-${id}`, expectedGeneration: instance.generation, state: "running", eventKind: "turn.running" });
    }
    const inspectPane = vi.fn(async (paneId: string) => {
      if (paneId === "w1:broken") throw new Error("temporary Herdr failure");
      return { paneId, workspaceId: "w1", cwd: "/repo/healthy", label: null, agentState: "idle" as const, foregroundExecutables: ["traex"], agentKind: "traex", terminalId: "term" };
    });
    const supervisor = new InstanceTurnSupervisor({ store, paneHost: { inspectPane } as unknown as PaneHost, wake: vi.fn(), presentation: workerPresentation });
    supervisor.prepareRecovery();
    await supervisor.reconcile();
    expect(store.getInstanceTurn("turn-broken")).toMatchObject({ state: "running" });
    expect(store.getInstanceTurn("turn-healthy")).toMatchObject({ state: "completed" });
    expect(supervisor.snapshot()).toMatchObject({ lastFailure: "temporary Herdr failure" });
  });

  it("logs repeated observation failures once and emits one recovery record", async () => {
    const { supervisor, inspectPane } = setup("running");
    const warnings: object[] = [];
    const infos: object[] = [];
    (supervisor as unknown as { options: { logger: object } }).options.logger = { warn(value: object) { warnings.push(value); }, info(value: object) { infos.push(value); } };
    inspectPane.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));

    await supervisor.reconcile();
    await supervisor.reconcile();
    expect(warnings.filter((value) => (value as { event?: string }).event === "instance-turn-observation-failed")).toHaveLength(1);

    await supervisor.reconcile();
    expect(infos.filter((value) => (value as { event?: string }).event === "instance-turn-observation-recovered")).toHaveLength(1);
  });

  it("uses one shared pane snapshot for multiple observable turns", async () => {
    store = new SqliteBindingStore(":memory:");
    const actor = { kind: "human" as const, userId: "u1" };
    const panes = [];
    for (const id of ["one", "two"]) {
      store.createAgentInstance({ id, projectId: "p1", name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: `/repo/${id}`, branch: null, baseCommit: "base" } });
      const instance = store.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: `w1:${id}`, nativeSessionId: null })!;
      store.acceptInstanceTurn({ id: `turn-${id}`, idempotencyKey: `turn-${id}`, actor, projectId: "p1", instanceId: id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
      store.claimNextInstanceTurn(id, instance.generation);
      store.updateInstanceTurn({ turnId: `turn-${id}`, expectedGeneration: instance.generation, state: "running", eventKind: "turn.running" });
      panes.push({ paneId: `w1:${id}`, workspaceId: "w1", cwd: `/repo/${id}`, label: null, agentState: "idle" as const, foregroundExecutables: ["traex"], agentKind: "traex" as const, terminalId: "term" });
    }
    const snapshotPanes = vi.fn(async () => panes);
    const inspectPane = vi.fn(async () => { throw new Error("individual inspection should not run"); });
    const supervisor = new InstanceTurnSupervisor({ store, paneHost: { snapshotPanes, inspectPane } as unknown as PaneHost, wake: vi.fn(), presentation: workerPresentation });

    await supervisor.reconcile();

    expect(snapshotPanes).toHaveBeenCalledOnce();
    expect(inspectPane).not.toHaveBeenCalled();
    expect(store.getInstanceTurn("turn-one")).toMatchObject({ state: "completed" });
    expect(store.getInstanceTurn("turn-two")).toMatchObject({ state: "completed" });
  });

  it("bounds concurrent targeted observations without serializing independent turns", async () => {
    store = new SqliteBindingStore(":memory:");
    const actor = { kind: "human" as const, userId: "u1" };
    for (let index = 0; index < 6; index += 1) {
      const id = `worker-${index}`;
      store.createAgentInstance({ id, projectId: "p1", name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: `/repo/${id}`, branch: null, baseCommit: "base" } });
      const instance = store.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: `w1:${id}`, nativeSessionId: null })!;
      store.acceptInstanceTurn({ id: `turn-${id}`, idempotencyKey: `turn-${id}`, actor, projectId: "p1", instanceId: id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
      store.claimNextInstanceTurn(id, instance.generation);
      store.updateInstanceTurn({ turnId: `turn-${id}`, expectedGeneration: instance.generation, state: "running", eventKind: "turn.running" });
    }
    let active = 0;
    let maximumActive = 0;
    const inspectPane = vi.fn(async (paneId: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      const id = paneId.slice(3);
      return { paneId, workspaceId: "w1", cwd: `/repo/${id}`, label: null, agentState: "idle" as const, foregroundExecutables: ["traex"], agentKind: "traex" as const, terminalId: "term" };
    });
    const supervisor = new InstanceTurnSupervisor({ store, paneHost: { inspectPane } as unknown as PaneHost, wake: vi.fn(), presentation: workerPresentation });

    await supervisor.reconcile();

    expect(maximumActive).toBe(4);
    expect(inspectPane).toHaveBeenCalledTimes(6);
  });

  it("observes only turns attached to a targeted Pane", async () => {
    const { supervisor, inspectPane } = setup("running");

    await supervisor.requestObservationByPane(["w1:p1"]);

    expect(inspectPane).toHaveBeenCalledOnce();
    expect(inspectPane).toHaveBeenCalledWith("w1:p1");
    expect(store!.getInstanceTurn("turn")).toMatchObject({ state: "completed" });
  });

  it("records a periodic scan failure and retries on the next interval", async () => {
    vi.useFakeTimers();
    const { supervisor } = setup("running");
    const warn = vi.fn();
    (supervisor as unknown as { options: { logger: object } }).options.logger = { warn, info: vi.fn() };
    vi.spyOn(store!, "listObservableInstanceTurns").mockImplementationOnce(() => { throw new Error("database busy"); });

    supervisor.start(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(supervisor.snapshot()).toMatchObject({ lastFailureAt: expect.any(String), lastFailure: "database busy" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "instance-turn-scan-failed", outcome: "retry_later" }), "instance turn scan failed");

    await vi.advanceTimersByTimeAsync(100);
    expect(store!.getInstanceTurn("turn")).toMatchObject({ state: "completed" });
    await supervisor.stop();
    vi.useRealTimers();
  });
});
