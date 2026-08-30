import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { InstanceMessagingWorkflow } from "../src/coordinator/instance-messaging-workflow.js";
import { InstanceWorkScheduler } from "../src/events/instance-work-scheduler.js";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import type { AgentRuntimeDriver } from "../src/domain/agent-runtime.js";
import type { PaneHost } from "../src/runtime/herdr/pane-host.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

function setup(capabilities: Partial<ReturnType<AgentRuntimeDriver["describe"]>> = {}) {
  store = new SqliteBindingStore(":memory:");
  const runtime = { herdrWorkspaceId: "w", paneId: "w:p1", nativeSessionId: null, generation: 2 };
  const create = (id: string, projectId = "p1", role: "primary" | "worker" = "worker") => {
    store!.createAgentInstance({ id, projectId, name: id, role, agentKind: "traex", model: null, desiredState: "running", workspace: { id: `ws-${id}`, kind: role === "primary" ? "main-checkout" : "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    return store!.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, ...runtime, paneId: `${id}:pane` })!;
  };
  const submit = vi.fn(async () => ({ status: "confirmed-delivered" as const }));
  const driver: AgentRuntimeDriver = {
    kind: "traex", describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "terminal-input", interrupt: "terminal-signal", approvals: "terminal", modelSelection: "runtime", usageReporting: true, ...capabilities }),
    start: vi.fn(async () => undefined), submit, steer: vi.fn(async () => ({ status: "delivered" as const })), interrupt: vi.fn(async () => ({ status: "interrupted" as const }))
  };
  const drivers = new AgentDriverRegistry([driver]);
  const wake = vi.fn();
  const workflow = new InstanceMessagingWorkflow({ store, drivers, paneHost: { interruptPane: vi.fn(async () => undefined) } as unknown as PaneHost, wake, idFactory: (() => { let n = 0; return () => `turn-${++n}`; })() });
  const scheduler = new InstanceWorkScheduler({ store, drivers });
  return { create, workflow, scheduler, wake, submit, driver };
}

describe("instance messaging", () => {
  it("durably accepts before waking and claims FIFO once per instance", async () => {
    const { create, workflow, scheduler, wake } = setup();
    const worker = create("worker");
    const actor = { kind: "human" as const, userId: "u1" };
    await workflow.submit({ idempotencyKey: "m1", actor, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "first" } });
    await workflow.submit({ idempotencyKey: "m2", actor, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "second" } });
    expect(wake).toHaveBeenNthCalledWith(1, worker.id);
    const first = store!.claimNextInstanceTurn(worker.id, worker.generation)!;
    expect(first.text).toBe("first");
    expect(store!.claimNextInstanceTurn(worker.id, worker.generation)).toBeNull();
    store!.completeInstanceTurn({ turnId: first.id, expectedGeneration: worker.generation, result: "done" });
    expect(store!.claimNextInstanceTurn(worker.id, worker.generation)?.text).toBe("second");
    void scheduler;
  });

  it("claims separate instances independently", async () => {
    const { create, workflow } = setup();
    const one = create("one"); const two = create("two");
    const actor = { kind: "human" as const, userId: "u1" };
    await workflow.submit({ idempotencyKey: "one", actor, projectId: "p1", targetInstanceId: one.id, content: { kind: "turn", text: "one" } });
    await workflow.submit({ idempotencyKey: "two", actor, projectId: "p1", targetInstanceId: two.id, content: { kind: "turn", text: "two" } });
    expect(store!.claimNextInstanceTurn(one.id, one.generation)?.text).toBe("one");
    expect(store!.claimNextInstanceTurn(two.id, two.generation)?.text).toBe("two");
  });

  it("keeps explicit unsupported steering out of the ordinary queue", async () => {
    const { create, workflow } = setup({ steering: "unsupported" });
    const worker = create("worker");
    await expect(workflow.steer({ idempotencyKey: "s1", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id, text: "change" })).resolves.toEqual({ status: "unsupported" });
    expect(store!.listInstanceTurns(worker.id).items).toEqual([]);
  });

  it("steers only an active runtime and never falls back to a queued turn", async () => {
    const { create, workflow, driver } = setup();
    const worker = create("worker");
    await expect(workflow.steer({ idempotencyKey: "s1", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id, text: "change" })).resolves.toEqual({ status: "not-active" });
    expect(store!.listInstanceTurns(worker.id).items).toEqual([]);
    store!.updateAgentInstanceLifecycle({ instanceId: worker.id, expectedGeneration: worker.generation, desiredState: "running", observedState: "working" });
    await expect(workflow.steer({ idempotencyKey: "s2", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id, text: "change" })).resolves.toEqual({ status: "delivered" });
    expect(driver.steer).toHaveBeenCalledWith(worker.runtimeRef, "change");
    expect(store!.listInstanceTurns(worker.id).items).toEqual([]);
  });

  it("deduplicates accepted turns and fences claims by instance generation", async () => {
    const { create, workflow, wake } = setup();
    const worker = create("worker");
    const input = { idempotencyKey: "same", actor: { kind: "human" as const, userId: "u1" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn" as const, text: "once" } };
    expect((await workflow.submit(input)).inserted).toBe(true);
    expect((await workflow.submit(input)).inserted).toBe(false);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store!.claimNextInstanceTurn(worker.id, worker.generation - 1)).toBeNull();
    expect(store!.claimNextInstanceTurn(worker.id, worker.generation)).toMatchObject({ text: "once" });
  });

  it("deduplicates steering before repeating the external effect", async () => {
    const { create, workflow, driver } = setup(); const worker = create("worker");
    store!.updateAgentInstanceLifecycle({ instanceId: worker.id, expectedGeneration: worker.generation, desiredState: "running", observedState: "working" });
    const input = { idempotencyKey: "steer-once", actor: { kind: "human" as const, userId: "u1" }, targetInstanceId: worker.id, text: "change" };
    await expect(workflow.steer(input)).resolves.toEqual({ status: "delivered" });
    await expect(workflow.steer(input)).resolves.toEqual({ status: "delivered" });
    expect(driver.steer).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale generation write a turn result", () => {
    const { create } = setup(); const worker = create("worker");
    store!.acceptInstanceTurn({ id: "turn", idempotencyKey: "turn", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
    const claimed = store!.claimNextInstanceTurn(worker.id, worker.generation)!;
    store!.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: worker.generation, herdrWorkspaceId: "w", paneId: "replacement:pane", nativeSessionId: null });
    expect(store!.updateInstanceTurn({ turnId: claimed.id, expectedGeneration: worker.generation, state: "running", eventKind: "turn.running" })).toBeNull();
    expect(store!.getInstanceTurn(claimed.id)).toMatchObject({ state: "claimed" });
  });

  it("keeps instance deletion possible after completed private turns", () => {
    const { create } = setup(); const worker = create("worker");
    store!.acceptInstanceTurn({ id: "turn", idempotencyKey: "turn", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
    store!.claimNextInstanceTurn(worker.id, worker.generation);
    store!.completeInstanceTurn({ turnId: "turn", expectedGeneration: worker.generation, result: "done" });
    store!.updateAgentInstanceLifecycle({ instanceId: worker.id, expectedGeneration: worker.generation, desiredState: "stopped", observedState: "stopped", clearRuntime: true });
    expect(store!.removeAgentInstance({ instanceId: worker.id, expectedGeneration: worker.generation, expectedWorkspaceGeneration: 1 })).toBe(true);
  });

  it("does not replay an uncertain dispatch and records completion without creating a primary turn", async () => {
    const { create, workflow, scheduler, driver } = setup();
    const primary = create("primary", "p1", "primary"); const worker = create("worker");
    vi.mocked(driver.submit).mockResolvedValueOnce({ status: "delivery-uncertain", reason: "lost observer" });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "work" } });
    await scheduler.drain(worker.id);
    expect(store!.listInstanceTurns(worker.id).items[0]).toMatchObject({ state: "dispatch-uncertain", error: "lost observer" });
    expect(store!.claimNextInstanceTurn(worker.id, worker.generation)).toBeNull();
    expect(store!.listInstanceTurns(primary.id).items).toEqual([]);
    expect(store!.listInstanceEvents(worker.id).map(({ kind }) => kind)).toContain("turn.dispatch-uncertain");
  });

  it("completes settled dispatches and drains the next FIFO turn", async () => {
    const { create, workflow, scheduler, submit } = setup();
    const worker = create("worker");
    const actor = { kind: "human" as const, userId: "u1" };
    await workflow.submit({ idempotencyKey: "m1", actor, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "one" } });
    await workflow.submit({ idempotencyKey: "m2", actor, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "two" } });
    await scheduler.drain(worker.id);
    expect(store!.listInstanceTurns(worker.id).items.map(({ state }) => state)).toEqual(["completed", "completed"]);
    expect(store!.getAgentInstance(worker.id)).toMatchObject({ observedState: "idle" });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("persists the dispatch boundary before a driver settles", async () => {
    const { create, workflow, scheduler, driver } = setup();
    const worker = create("worker");
    let release!: () => void;
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, onDispatched) => {
      onDispatched?.();
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "confirmed-delivered" };
    });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "work" } });
    const draining = scheduler.drain(worker.id);
    await vi.waitFor(() => expect(store!.listInstanceTurns(worker.id).items[0]).toMatchObject({ state: "running" }));
    release();
    await draining;
    expect(store!.listInstanceTurns(worker.id).items[0]).toMatchObject({ state: "completed" });
  });

  it("fences a thrown driver call as uncertain without rejecting the drain", async () => {
    const { create, workflow, scheduler, driver } = setup();
    const worker = create("worker");
    vi.mocked(driver.submit).mockRejectedValueOnce(new Error("driver crashed"));
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "work" } });
    await expect(scheduler.drain(worker.id)).resolves.toBeUndefined();
    expect(store!.listInstanceTurns(worker.id).items[0]).toMatchObject({ state: "dispatch-uncertain", error: "driver crashed" });
    expect(scheduler.snapshot()).toMatchObject({ activeDispatchWorkers: 0, lastFailure: "driver crashed" });
  });

  it("detaches an in-flight driver at the shutdown deadline without later writes", async () => {
    const { create, workflow, scheduler, driver } = setup();
    const worker = create("worker");
    let release!: () => void;
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, onDispatched) => {
      onDispatched?.();
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "confirmed-delivered" };
    });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "work" } });
    scheduler.wake(worker.id);
    await vi.waitFor(() => expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running" }));
    const controller = new AbortController();
    const stopped = scheduler.stop({ signal: controller.signal, deadlineAt: Date.now(), remainingMs: () => 0 });
    controller.abort();
    await expect(stopped).resolves.toBeUndefined();
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "dispatch-uncertain" });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "dispatch-uncertain" });
  });
});
