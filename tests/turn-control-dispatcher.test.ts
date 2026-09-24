import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnControlDispatcher } from "../src/coordinator/turn-control-dispatcher.js";
import type { TurnControlOwner, TurnTarget } from "../src/domain/turn-control.js";
import type { HerdrPane } from "../src/domain/types.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { applicationPresentation } from "./helpers/presentation.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

function fixture(ownerIds = ["i1"]) {
  store = new SqliteBindingStore(":memory:");
  const panes = new Map<string, HerdrPane>();
  const targets = new Map<string, TurnTarget>();
  for (const [index, id] of ownerIds.entries()) {
    const paneId = `w1:p${index + 1}`;
    const runtimeTurnId = `runtime-${id}`;
    store.createAgentInstance({ id, projectId: "project-a", name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const instance = store.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId, nativeSessionId: `session-${id}` })!;
    const logicalTurnId = `logical-${id}`;
    store.acceptInstanceTurn({ id: logicalTurnId, idempotencyKey: `turn-${id}`, actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn(id, instance.generation);
    store.updateInstanceTurn({ turnId: logicalTurnId, expectedGeneration: instance.generation, state: "dispatching", eventKind: "turn.dispatching" });
    store.claimInstanceTurnTranscript({ turnId: logicalTurnId, expectedGeneration: instance.generation, runtimeTurnId, startedAt: "2026-09-24T00:00:00.000Z" });
    const session = { source: "herdr:traex" as const, agent: "traex" as const, kind: "id" as const, value: `session-${id}` };
    panes.set(paneId, { paneId, workspaceId: "w1", cwd: "/repo", label: id, agentState: "working", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: session, steeringCapability: "native", activeTurnId: runtimeTurnId });
    targets.set(id, { owner: { kind: "instance", id }, projectId: "project-a", paneId, generation: instance.generation, agentSession: session, logicalTurnId, runtimeTurnId });
  }
  const accept = (id: string, owner: TurnControlOwner, kind: "steer" | "interrupt" = "interrupt") => store!.acceptTurnControlOperation({ id, idempotencyKey: id, kind, target: targets.get(owner.id)!, actor: { kind: "human", userId: "u1" }, payload: kind === "steer" ? "secret steer text" : null }).operation;
  return { panes, targets, accept };
}

describe("TurnControlDispatcher", () => {
  it("serializes durable operations for one owner", async () => {
    const { panes, accept } = fixture();
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const interruptAgent = vi.fn(async ({ idempotencyKey }: { idempotencyKey: string }) => { calls.push(idempotencyKey); if (idempotencyKey === "control-1") await firstGate; return { status: "interrupted" as const }; });
    const dispatcher = new TurnControlDispatcher({ store: store!, herdr: { getPane: async (paneId) => panes.get(paneId) ?? null, interruptAgent }, presentation: applicationPresentation, wakeOutbound: () => undefined });
    const owner = { kind: "instance" as const, id: "i1" };
    accept("control-1", owner); accept("control-2", owner);

    dispatcher.wake(owner);
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")?.state).toBe("dispatching"));
    expect(calls).toEqual(["control-1"]);
    releaseFirst();
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-2")?.state).toBe("delivered"));
    expect(calls).toEqual(["control-1", "control-2"]);
    await dispatcher.stop();
  });

  it("allows different owners to dispatch independently", async () => {
    const { panes, accept } = fixture(["i1", "i2"]);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const interruptAgent = vi.fn(async ({ idempotencyKey }: { idempotencyKey: string }) => { if (idempotencyKey === "control-1") await firstGate; return { status: "interrupted" as const }; });
    const dispatcher = new TurnControlDispatcher({ store: store!, herdr: { getPane: async (paneId) => panes.get(paneId) ?? null, interruptAgent }, presentation: applicationPresentation, wakeOutbound: () => undefined });
    const first = { kind: "instance" as const, id: "i1" }; const second = { kind: "instance" as const, id: "i2" };
    accept("control-1", first); accept("control-2", second);

    dispatcher.wake(first); dispatcher.wake(second);
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-2")?.state).toBe("delivered"));
    expect(store!.getTurnControlOperation("control-1")?.state).toBe("dispatching");
    releaseFirst(); await dispatcher.stop();
  });

  it("recovers accepted work but never replays an operation claimed before restart", async () => {
    const { panes, accept } = fixture();
    const owner = { kind: "instance" as const, id: "i1" };
    accept("accepted-control", owner); accept("claimed-control", owner);
    expect(store!.claimTurnControlOperation("claimed-control")?.state).toBe("dispatching");
    const interruptAgent = vi.fn(async () => ({ status: "interrupted" as const }));
    const dispatcher = new TurnControlDispatcher({ store: store!, herdr: { getPane: async (paneId) => panes.get(paneId) ?? null, interruptAgent }, presentation: applicationPresentation, wakeOutbound: () => undefined });

    await expect(dispatcher.recover()).resolves.toEqual({ accepted: 1, uncertain: 1 });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("accepted-control")?.state).toBe("delivered"));
    expect(store!.getTurnControlOperation("claimed-control")?.state).toBe("uncertain");
    expect(interruptAgent).toHaveBeenCalledOnce();
    await dispatcher.stop();
  });
});
