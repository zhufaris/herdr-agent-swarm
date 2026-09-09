import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { WorkerTurnObserver } from "../src/coordinator/worker-turn-observer.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import type { TraexTranscriptReaderPort } from "../src/domain/ports.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { workerPresentation } from "./helpers/presentation.js";

const sessionId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
const runtimeTurnId = "01a052d3-9c14-70e1-a375-397e2ecb5501";
const startedAt = "2026-09-01T00:00:01.000Z";
let store: SqliteBindingStore | undefined;

afterEach(() => { store?.close(); store = undefined; });

function setup() {
  store = new SqliteBindingStore(":memory:");
  store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
  const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: sessionId })!;
  const view = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: "review", queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
  store.acceptInstanceTurnWithCard({ id: "turn-1", idempotencyKey: "lark:turn-1", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review", parentTurnId: null, sourceMessageId: "message-1", view, render: renderWorkerTurnCard });
  store.claimNextInstanceTurn(worker.id, worker.generation);
  store.updateInstanceTurn({ turnId: "turn-1", expectedGeneration: worker.generation, state: "running", eventKind: "turn.running" });
  const transcriptReader: TraexTranscriptReaderPort = { open: vi.fn(async () => ({ mode: "unavailable" as const, reason: "transcript_not_found" as const })) };
  const observer = new WorkerTurnObserver({ store, transcriptReader, wakeInstance: vi.fn(), wakeOutbound: vi.fn(), presentation: workerPresentation });
  return { worker, observer, transcriptReader };
}

describe("WorkerTurnObserver", () => {
  it("claims only a fresh exact transcript turn for the current instance generation", async () => {
    const { observer } = setup();

    await observer.observe("turn-1", {
      turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "",
      turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt }
    });

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({
      state: "running", runtimeTurnId, runtimeTurnStartedAt: startedAt
    });
  });

  it("projects only matching transcript deltas and completes from the exact lifecycle", async () => {
    const { observer } = setup();
    await observer.observe("turn-1", {
      turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "first",
      turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt }
    });
    await observer.observe("turn-1", {
      turnId: "01a052d3-9c14-70e1-a375-397e2ecb5502", answerDelta: "foreign",
      turnLifecycle: { turnId: "01a052d3-9c14-70e1-a375-397e2ecb5502", state: "completed", startedAt, finalAnswer: "wrong" }
    });
    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({ phase: "running", answer: "first", resultCapture: "pending" });

    await observer.observe("turn-1", {
      turnId: runtimeTurnId, answerDelta: "second",
      turnLifecycle: { turnId: runtimeTurnId, state: "completed", startedAt, finalAnswer: "trusted final" }
    });

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "trusted final" });
    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({ phase: "completed", answer: "trusted final", resultCapture: "captured" });
  });

  it("persists and publishes visible progress only for the exact owned transcript", async () => {
    const { observer } = setup();
    await observer.observe("turn-1", {
      turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "",
      mainStatus: { statusTitle: "Inspecting transaction boundaries", planSteps: [{ key: "inspect", label: "Read the store", state: "active" }] },
      toolActivities: [{ key: "tool:read", kind: "read", label: "Read src/store/sqlite-store.ts", state: "done" }],
      turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt }
    });

    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({
      phase: "running", statusTitle: "Inspecting transaction boundaries",
      progressEvents: expect.arrayContaining([
        expect.objectContaining({ key: "plan:inspect", kind: "step", state: "active" }),
        expect.objectContaining({ key: "tool:read", kind: "read", state: "done" })
      ])
    });
    expect(store!.listPendingOutboundReplies().filter(({ workerTurnId }) => workerTurnId)).toEqual([]);
    expect(store!.listPendingCardContextInvalidations()).toContainEqual(expect.objectContaining({
      targetKind: "worker-session", targetId: "reviewer", targetGeneration: 1
    }));

    await observer.observe("turn-1", {
      turnId: "01a052d3-9c14-70e1-a375-397e2ecb5502", answerDelta: "",
      mainStatus: { statusTitle: "Foreign progress" },
      turnLifecycle: { turnId: "01a052d3-9c14-70e1-a375-397e2ecb5502", state: "active", startedAt }
    });
    expect(store!.loadWorkerTurnCard("turn-1")!.statusTitle).toBe("Inspecting transaction boundaries");
  });

  it("ignores missing identity and stale instance generations", async () => {
    const { observer, worker } = setup();
    await observer.observe("turn-1", { answerDelta: "unowned" });
    store!.updateAgentInstanceLifecycle({ instanceId: worker.id, expectedGeneration: worker.generation, desiredState: "stopped", observedState: "stopped", clearRuntime: true });

    await observer.observe("turn-1", {
      turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "stale",
      turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt }
    });

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ runtimeTurnId: null });
    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({ answer: "" });
  });

  it("cancels only an exactly owned aborted lifecycle", async () => {
    const { observer } = setup();
    await observer.observe("turn-1", { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "partial", turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt } });
    await observer.observe("turn-1", { turnId: runtimeTurnId, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "aborted", startedAt, reason: "interrupted" } });

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "cancelled", result: null, error: "TraeX turn was interrupted by a human operator" });
    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({ phase: "cancelled", answer: "partial" });
  });

  it("redacts secrets before persisting trusted output", async () => {
    const { observer } = setup();
    await observer.observe("turn-1", {
      turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "token=secret-value",
      turnLifecycle: { turnId: runtimeTurnId, state: "completed", startedAt, finalAnswer: "api_key: secret-value" }
    });

    expect(store!.getInstanceTurn("turn-1")!.result).toContain("[REDACTED]");
    expect(store!.getInstanceTurn("turn-1")!.result).not.toContain("secret-value");
  });

  it("recovers an exact owned turn from its boundary without submitting again", async () => {
    const { observer, transcriptReader } = setup();
    await observer.observe("turn-1", { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt } });
    const readObservation = vi.fn()
      .mockResolvedValueOnce({ turnId: runtimeTurnId, answerDelta: "recovered", turnLifecycle: { turnId: runtimeTurnId, state: "completed", startedAt } })
      .mockResolvedValue({ answerDelta: "" });
    transcriptReader.openAtTurn = vi.fn(async () => ({ mode: "typed" as const, cursor: { readDelta: vi.fn(async () => ""), readObservation } }));
    const submit = vi.fn();

    await observer.recover("turn-1");

    expect(transcriptReader.openAtTurn).toHaveBeenCalledWith({ source: "traex", agent: "traex", kind: "id", value: sessionId }, runtimeTurnId, startedAt);
    expect(submit).not.toHaveBeenCalled();
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "recovered" });
  });

  it("does not infer completion when the exact recovery cursor has no terminal lifecycle", async () => {
    const { observer, transcriptReader } = setup();
    await observer.observe("turn-1", { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "persisted answer", turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt } });
    transcriptReader.openAtTurn = vi.fn(async () => ({ mode: "typed" as const, cursor: { readDelta: vi.fn(async () => "") } }));

    await observer.recover("turn-1");

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running", result: null });
    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({ phase: "running", answer: "persisted answer", resultCapture: "pending" });
  });

  it("recovers the full final answer from the exact turn start boundary", async () => {
    const { observer, transcriptReader } = setup();
    await observer.observe("turn-1", { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt } });
    const observations = Array.from({ length: 40 }, (_, index) => ({
      turnId: runtimeTurnId, answerDelta: `progress ${index}`, turnLifecycle: { turnId: runtimeTurnId, state: "active" as const, startedAt }
    }));
    observations.push({ turnId: runtimeTurnId, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "completed" as const, startedAt, finalAnswer: "full recovered answer" } });
    const readObservation = vi.fn(async () => observations.shift() ?? { answerDelta: "" });
    transcriptReader.openAtTurn = vi.fn(async () => ({ mode: "typed" as const, cursor: { readDelta: vi.fn(async () => ""), readObservation } }));

    await observer.recover("turn-1");

    expect(transcriptReader.openAtTurn).toHaveBeenCalledWith({ source: "traex", agent: "traex", kind: "id", value: sessionId }, runtimeTurnId, startedAt);
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "full recovered answer" });
    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({ phase: "completed", answer: "full recovered answer", resultCapture: "captured" });
  });
});
