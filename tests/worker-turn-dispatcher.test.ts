import { describe, expect, it, vi } from "vitest";
import { WorkerTurnDispatcher } from "../src/coordinator/worker-turn-dispatcher.js";
import type { AgentCapabilities, AgentDriverCatalog, AgentRuntimeDriver, DispatchReceipt } from "../src/domain/agent-runtime.js";
import type { AgentInstance } from "../src/domain/agent-instance.js";
import type { WorkerTurnDispatchStore } from "../src/domain/ports/instance.js";
import type { WorkerPresentation } from "../src/domain/ports/presentation.js";
import type { WorkerTurnObservationPort, WorkerTurnWatch } from "../src/domain/ports/worker-turn-observation.js";
import type { InstanceTurn } from "../src/domain/instance-turn.js";

describe("WorkerTurnDispatcher", () => {
  const turn: InstanceTurn = {
    id: "turn-1",
    idempotencyKey: "idem-1",
    projectId: "project-1",
    instanceId: "worker-1",
    instanceGeneration: 2,
    actor: { type: "user", openId: "user-1" },
    kind: "turn",
    priority: "ordinary",
    text: "review",
    state: "claimed",
    result: null,
    error: null,
    parentTurnId: null,
    sourceMessageId: "message-1",
    runtimeTurnId: null,
    runtimeTurnStartedAt: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
  const runtime = {
    herdrWorkspaceId: "w1",
    paneId: "w1:p1",
    nativeSessionId: "session-1",
    generation: 2,
  };
  const instance: AgentInstance = {
    id: "worker-1", projectId: "project-1", name: "worker", role: "worker", agentKind: "traex", model: null,
    sourcePrimaryPaneLabel: null, parent: null, workerSessionLifecycle: "active", workerSessionGeneration: 1,
    desiredState: "running", observedState: "idle", workspaceLeaseId: "lease-1", generation: 2, runtimeRef: runtime,
    pendingRuntimeRef: null, provisioningCheckpoint: "verified", lastError: null,
  };
  const capabilities: AgentCapabilities = {
    available: true, structuredEvents: false, nativeResume: true, primaryTools: false, steering: "native",
    interrupt: "native", approvals: "terminal", modelSelection: "runtime", usageReporting: false,
  };
  const presentation: Pick<WorkerPresentation, "workerTurn" | "workerHumanReviewNotification"> = {
    workerTurn: vi.fn(() => ({})),
    workerHumanReviewNotification: vi.fn(() => ({})),
  };

  function harness(input: {
    structured: boolean;
    receipt: DispatchReceipt;
    submit?: AgentRuntimeDriver["submit"];
    projected?: boolean;
  }) {
    const transitions: string[] = [];
    const claim = vi.fn().mockReturnValueOnce(turn).mockReturnValue(undefined);
    const submit =
      input.submit ??
      vi.fn(async (_runtime, _text, hooks) => {
        await hooks?.onDispatched?.();
        return input.receipt;
      });
    const update = vi.fn(({ state }) => {
      transitions.push(state);
      return { ...turn, state };
    });
    const lifecycle = vi.fn();
    const watch = {
      flush: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
    };
    const transition = vi.fn((transitionInput: { state: string }) => ({
      turn: { ...turn, state: transitionInput.state }, view: {}, projectionChanged: true,
      notification: { outcome: "skipped" as const, reason: "not-blocked" as const },
      completionActionEligibility: transitionInput.state === "completed"
        ? { outcome: "deferred" as const }
        : { outcome: "skipped" as const, reason: "not-completion" as const }
    }));
    const store = {
        getAgentInstance: vi.fn(() => instance),
        claimNextInstanceTurn: claim,
        loadWorkerTurnCard: vi.fn(() => input.projected ? {} as never : null),
        updateInstanceTurn: update,
        getInstanceTurn: vi.fn(() => ({
          ...turn,
          state: "dispatching",
          runtimeTurnId: null,
          runtimeTurnStartedAt: null,
        })),
        updateAgentInstanceLifecycle: lifecycle,
        transitionInstanceTurnWithProjection: transition,
      } satisfies WorkerTurnDispatchStore;
    const drivers = {
        get: vi.fn(() => ({
          kind: "traex",
          describe: () => ({ ...capabilities, structuredEvents: input.structured }),
          start: vi.fn(async () => undefined),
          submit,
          steer: vi.fn(),
          interrupt: vi.fn(),
        })),
        describe: vi.fn(() => ({ ...capabilities, structuredEvents: input.structured })),
      } satisfies AgentDriverCatalog;
    const observer = { watch: vi.fn(async () => watch) } satisfies Pick<WorkerTurnObservationPort, "watch">;
    const wakeOutbound = vi.fn();
    const info = vi.fn();
    const dispatcher = new WorkerTurnDispatcher({ store, drivers, observer, presentation, wakeOutbound, logger: { error: vi.fn(), info } });
    return { dispatcher, transitions, claim, submit, lifecycle, watch, transition, wakeOutbound, info };
  }

  it("terminalizes confirmed non-delivery and stops the FIFO drain", async () => {
    const h = harness({
      structured: false,
      receipt: { status: "not-delivered", reason: "rejected" },
    });
    await h.dispatcher.drain("worker-1");
    expect(h.transitions).toEqual(["dispatching", "running", "failed"]);
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it("leaves structured confirmed delivery under observation", async () => {
    const h = harness({
      structured: true,
      receipt: { status: "confirmed-delivered" },
    });
    await h.dispatcher.drain("worker-1");
    expect(h.transitions).toEqual(["dispatching", "running"]);
    expect(h.watch.flush).toHaveBeenCalledOnce();
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it("completes unstructured confirmed delivery and continues FIFO", async () => {
    const h = harness({
      structured: false,
      receipt: { status: "confirmed-delivered" },
    });
    await h.dispatcher.drain("worker-1");
    expect(h.transitions).toEqual(["dispatching", "running", "completed"]);
    expect(h.lifecycle).toHaveBeenCalledOnce();
    expect(h.claim).toHaveBeenCalledTimes(2);
  });

  it("wakes final-card convergence for projected unstructured completion", async () => {
    const h = harness({
      structured: false,
      receipt: { status: "confirmed-delivered" },
      projected: true,
    });

    await h.dispatcher.drain("worker-1");

    expect(h.transition).toHaveBeenCalledWith(expect.objectContaining({ state: "completed" }));
    expect(h.wakeOutbound).toHaveBeenCalled();
    expect(JSON.stringify(h.info.mock.calls)).not.toContain("review");
  });

  it("cannot mutate or replay work after the Worker generation changes following claim", async () => {
    let replacementState = "idle";
    let generation = 2;
    const claim = vi.fn(() => {
      generation = 3;
      return turn;
    });
    const update = vi.fn(
      (input: { expectedGeneration: number; state: string }) => {
        if (input.expectedGeneration !== generation) return null;
        replacementState = input.state;
        return { ...turn, instanceGeneration: generation, state: input.state };
      },
    );
    const submit = vi.fn(async () => ({
      status: "not-delivered" as const,
      reason: "stale Worker",
    }));
    const store = {
        getAgentInstance: vi.fn(() => instance),
        claimNextInstanceTurn: claim,
        loadWorkerTurnCard: vi.fn(() => null),
        updateInstanceTurn: update,
        getInstanceTurn: vi.fn(() => ({
          ...turn,
          state: "claimed",
          runtimeTurnId: null,
          runtimeTurnStartedAt: null,
        })),
        transitionInstanceTurnWithProjection: vi.fn(),
        updateAgentInstanceLifecycle: vi.fn(),
      } satisfies WorkerTurnDispatchStore;
    const drivers = {
        get: vi.fn(() => ({
          kind: "traex",
          describe: () => capabilities,
          start: vi.fn(async () => undefined),
          submit,
          steer: vi.fn(),
          interrupt: vi.fn(),
        })),
        describe: vi.fn(() => capabilities),
      } satisfies AgentDriverCatalog;
    const dispatcher = new WorkerTurnDispatcher({ store, drivers, presentation });

    await dispatcher.drain("worker-1");

    expect(update).toHaveBeenCalled();
    expect(
      update.mock.calls.every(([input]) => input.expectedGeneration === 2),
    ).toBe(true);
    expect(replacementState).toBe("idle");
    expect(claim).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("aborts and marks an in-flight turn uncertain when shutdown expires", async () => {
    let aborted = false;
    const submit = vi.fn(
      (_runtime, _text, _hooks, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ status: "delivery-uncertain", reason: "aborted" });
          });
        }),
    );
    const h = harness({ structured: false, receipt: {}, submit });
    const drain = h.dispatcher.drain("worker-1");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await h.dispatcher.stop({
      signal: new AbortController().signal,
      deadlineAt: 0,
      remainingMs: () => 0,
    });
    await drain;
    expect(aborted).toBe(true);
    expect(h.transitions).toContain("dispatch-uncertain");
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it("detaches an exact observed turn after submission failure without claiming later FIFO work", async () => {
    const exactTurn = {
      ...turn,
      state: "running",
      runtimeTurnId: "runtime-1",
      runtimeTurnStartedAt: "2026-09-24T00:00:00.000Z",
    };
    const claim = vi
      .fn()
      .mockReturnValueOnce(turn)
      .mockReturnValueOnce({ ...turn, id: "turn-2" });
    const detach = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const flush = vi.fn(async () => undefined);
    const submit = vi.fn(async () => {
      throw new Error("observer disconnected");
    });
    const store = {
        getAgentInstance: vi.fn(() => instance),
        claimNextInstanceTurn: claim,
        loadWorkerTurnCard: vi.fn(() => null),
        updateInstanceTurn: vi.fn(),
        getInstanceTurn: vi.fn(() => exactTurn),
        transitionInstanceTurnWithProjection: vi.fn(),
        updateAgentInstanceLifecycle: vi.fn(),
      } satisfies WorkerTurnDispatchStore;
    const drivers = {
        get: vi.fn(() => ({
          kind: "traex",
          describe: () => ({ ...capabilities, structuredEvents: true }),
          start: vi.fn(async () => undefined),
          submit,
          steer: vi.fn(),
          interrupt: vi.fn(),
        })),
        describe: vi.fn(() => ({ ...capabilities, structuredEvents: true })),
      } satisfies AgentDriverCatalog;
    const watch = { flush, stop, detach } satisfies WorkerTurnWatch;
    const observer = { watch: vi.fn(async () => watch) } satisfies Pick<WorkerTurnObservationPort, "watch">;
    const dispatcher = new WorkerTurnDispatcher({ store, drivers, observer, presentation });

    await dispatcher.drain("worker-1");

    expect(claim).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });
});
