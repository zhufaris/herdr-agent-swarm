import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { HerdrEventRouter } from "../src/runtime/herdr-event-router.js";

function setup() {
  const calls = {
    invalidateWorkspace: vi.fn(),
    invalidatePanes: vi.fn(),
    reconcileBindings: vi.fn(async () => undefined),
    reconcileInstances: vi.fn(async () => undefined),
    observePrimaryTurns: vi.fn(async () => undefined),
    observeInstanceTurns: vi.fn(async () => undefined),
    retryRetiredPanes: vi.fn(async () => undefined)
  };
  return { calls, router: new HerdrEventRouter({ ...calls, logger: pino({ enabled: false }) }) };
}

describe("HerdrEventRouter", () => {
  it("routes Agent status hints only to Pane-targeted consumers", async () => {
    const { calls, router } = setup();
    await router.handle({ kind: "agent-status", scope: "panes", workspaceIds: ["w1"], paneIds: ["w1:p1"] });

    expect(calls.invalidateWorkspace).not.toHaveBeenCalled();
    expect(calls.invalidatePanes).toHaveBeenCalledWith(["w1:p1"]);
    expect(calls.reconcileBindings).toHaveBeenCalledWith({ paneIds: ["w1:p1"] });
    expect(calls.observePrimaryTurns).toHaveBeenCalledWith(["w1:p1"]);
    expect(calls.reconcileInstances).toHaveBeenCalledWith({ paneIds: ["w1:p1"] });
    expect(calls.observeInstanceTurns).toHaveBeenCalledWith(["w1:p1"]);
    expect(calls.retryRetiredPanes).toHaveBeenCalledWith(["w1:p1"]);
  });

  it("invalidates pane snapshots before starting any pane-scoped consumer", async () => {
    const order: string[] = [];
    const { calls, router } = setup();
    calls.invalidatePanes.mockImplementation(() => { order.push("invalidate"); });
    calls.reconcileBindings.mockImplementation(async () => { order.push("bindings"); });
    calls.reconcileInstances.mockImplementation(async () => { order.push("instances"); });
    calls.observePrimaryTurns.mockImplementation(async () => { order.push("primary-turns"); });
    calls.observeInstanceTurns.mockImplementation(async () => { order.push("worker-turns"); });
    calls.retryRetiredPanes.mockImplementation(async () => { order.push("retired"); });

    await router.handle({ kind: "agent-status", scope: "panes", workspaceIds: [], paneIds: ["w1:p1"] });

    expect(order[0]).toBe("invalidate");
    expect(order.indexOf("primary-turns")).toBeGreaterThan(order.indexOf("bindings"));
    expect(new Set(order.slice(1))).toEqual(new Set(["bindings", "primary-turns", "instances", "worker-turns", "retired"]));
  });

  it("invalidates and reconciles affected workspaces for topology hints", async () => {
    const { calls, router } = setup();
    await router.handle({ kind: "pane-moved", scope: "workspaces", workspaceIds: ["w1", "w2"], paneIds: ["w2:p1"] });

    expect(calls.invalidateWorkspace.mock.calls).toEqual([["w1"], ["w2"]]);
    expect(calls.reconcileBindings).toHaveBeenCalledWith({ workspaceIds: ["w1", "w2"] });
    expect(calls.reconcileInstances).toHaveBeenCalledWith({ workspaceIds: ["w1", "w2"] });
    expect(calls.observePrimaryTurns).toHaveBeenCalledWith(["w2:p1"]);
    expect(calls.observeInstanceTurns).toHaveBeenCalledWith(["w2:p1"]);
  });

  it("routes full-scope recovery to every safety scan", async () => {
    const { calls, router } = setup();
    await router.handle({ kind: "socket-recovered", scope: "all", workspaceIds: [], paneIds: [] });

    expect(calls.reconcileBindings).toHaveBeenCalledWith();
    expect(calls.reconcileInstances).toHaveBeenCalledWith();
    expect(calls.observePrimaryTurns).toHaveBeenCalledWith();
    expect(calls.observeInstanceTurns).toHaveBeenCalledWith();
    expect(calls.retryRetiredPanes).toHaveBeenCalledWith();
  });

  it("contains one consumer failure and records diagnostics", async () => {
    const { calls, router } = setup();
    calls.reconcileBindings.mockRejectedValueOnce(new Error("binding unavailable"));

    await router.handle({ kind: "agent-status", scope: "panes", workspaceIds: [], paneIds: ["w1:p1"] });

    expect(calls.retryRetiredPanes).toHaveBeenCalled();
    expect(calls.observePrimaryTurns).not.toHaveBeenCalled();
    expect(router.snapshot()).toMatchObject({ paneHints: 1, handlerFailures: 1 });
  });

  it("does not expand a workspace hint without Pane identity into a full Primary transcript scan", async () => {
    const { calls, router } = setup();

    await router.handle({ kind: "pane-updated", scope: "workspaces", workspaceIds: ["w1"], paneIds: [] });

    expect(calls.reconcileBindings).toHaveBeenCalledWith({ workspaceIds: ["w1"] });
    expect(calls.observePrimaryTurns).not.toHaveBeenCalled();
  });

  it("keeps independent consumers running when the ordered Primary observation chain fails", async () => {
    const { calls, router } = setup();
    calls.observePrimaryTurns.mockRejectedValueOnce(new Error("transcript unavailable"));

    await router.handle({ kind: "agent-status", scope: "panes", workspaceIds: [], paneIds: ["w1:p1"] });

    expect(calls.reconcileInstances).toHaveBeenCalledOnce();
    expect(calls.observeInstanceTurns).toHaveBeenCalledOnce();
    expect(calls.retryRetiredPanes).toHaveBeenCalledOnce();
    expect(router.snapshot()).toMatchObject({ paneHints: 1, handlerFailures: 1 });
  });

  it("coalesces concurrent hints without losing Pane identity", async () => {
    const { calls, router } = setup();
    let release!: () => void;
    calls.reconcileBindings.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));

    const first = router.handle({ kind: "agent-status", scope: "panes", workspaceIds: [], paneIds: ["w1:p1"] });
    const second = router.handle({ kind: "agent-status", scope: "panes", workspaceIds: [], paneIds: ["w1:p2"] });
    const third = router.handle({ kind: "agent-status", scope: "panes", workspaceIds: [], paneIds: ["w1:p3"] });
    expect(calls.reconcileBindings).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, third]);

    expect(calls.reconcileBindings).toHaveBeenCalledTimes(2);
    expect(calls.reconcileBindings).toHaveBeenLastCalledWith({ paneIds: ["w1:p2", "w1:p3"] });
  });
});
