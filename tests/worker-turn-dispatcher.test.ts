import { describe, expect, it, vi } from "vitest";
import { WorkerTurnDispatcher } from "../src/coordinator/worker-turn-dispatcher.js";

describe("WorkerTurnDispatcher", () => {
  it("detaches an exact observed turn after submission failure without claiming later FIFO work", async () => {
    const turn = { id: "turn-1", instanceId: "worker-1", instanceGeneration: 2, text: "review" };
    const exactTurn = { ...turn, state: "running", runtimeTurnId: "runtime-1", runtimeTurnStartedAt: "2026-09-24T00:00:00.000Z" };
    const claim = vi.fn().mockReturnValueOnce(turn).mockReturnValueOnce({ ...turn, id: "turn-2" });
    const detach = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const flush = vi.fn(async () => undefined);
    const submit = vi.fn(async () => { throw new Error("observer disconnected"); });
    const dispatcher = new WorkerTurnDispatcher({
      store: {
        getAgentInstance: vi.fn(() => ({ id: "worker-1", generation: 2, agentKind: "traex", runtimeRef: { herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1", generation: 2 } })),
        claimNextInstanceTurn: claim, loadWorkerTurnCard: vi.fn(() => null), updateInstanceTurn: vi.fn(),
        getInstanceTurn: vi.fn(() => exactTurn)
      },
      drivers: { get: vi.fn(() => ({ describe: () => ({ structuredEvents: true }), submit })) },
      observer: { watch: vi.fn(async () => ({ flush, stop, detach })) },
      presentation: {}
    } as never);

    await dispatcher.drain("worker-1");

    expect(claim).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });
});
