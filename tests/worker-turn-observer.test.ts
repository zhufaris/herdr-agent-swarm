import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { WorkerTurnObserver } from "../src/coordinator/worker-turn-observer.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import type { AgentTranscriptReaderPort } from "../src/domain/ports.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { workerPresentation } from "./helpers/presentation.js";
import { MAX_TURN_OUTPUT_CHARS, TURN_OUTPUT_TRUNCATION_MARKER } from "../src/runtime/bounded-turn-output.js";

const sessionId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
const runtimeTurnId = "01a052d3-9c14-70e1-a375-397e2ecb5501";
const startedAt = "2026-09-01T00:00:01.000Z";
let store: SqliteBindingStore | undefined;

afterEach(() => { vi.useRealTimers(); store?.close(); store = undefined; });

function setup(agentKind: "traex" | "pi" = "traex", pollIntervalMs?: number) {
  store = new SqliteBindingStore(":memory:");
  store.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root-1", title: "Primary", creatorOpenId: "ou_primary" });
  store.updateBinding("binding-1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p0" });
  store.createWorkerAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind, model: null, desiredState: "running", parent: { bindingId: "binding-1", bindingGeneration: 1, paneId: "w1:p0", nativeSessionId: "primary-session" }, workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4);
  const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: sessionId })!;
  const view = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: "review", queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
  store.acceptInstanceTurnWithCard({ id: "turn-1", idempotencyKey: "lark:turn-1", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review", parentTurnId: null, sourceMessageId: "message-1", view, render: renderWorkerTurnCard });
  store.claimNextInstanceTurn(worker.id, worker.generation);
  store.updateInstanceTurn({ turnId: "turn-1", expectedGeneration: worker.generation, state: "running", eventKind: "turn.running" });
  const transcriptReader: AgentTranscriptReaderPort = { open: vi.fn(async () => ({ mode: "unavailable" as const, reason: "transcript_not_found" as const })) };
  const info = vi.fn();
  const warn = vi.fn();
  const observer = new WorkerTurnObserver({ store, transcriptReader, wakeInstance: vi.fn(), wakeOutbound: vi.fn(), presentation: workerPresentation, logger: { info, warn }, pollIntervalMs });
  return { worker, observer, transcriptReader, info, warn };
}

describe("WorkerTurnObserver", () => {
  it("backs off rejected cursor reads, logs retry-tier changes, and resets after recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const { observer, transcriptReader, warn } = setup("traex", 10);
    const readTimes: number[] = [];
    const readObservation = vi.fn(async () => {
      readTimes.push(Date.now());
      if (readTimes.length <= 3) throw new Error("Core cursor unavailable");
      return { answerDelta: "" };
    });
    transcriptReader.open = vi.fn(async () => ({ mode: "typed" as const, cursor: { readDelta: vi.fn(async () => ""), readObservation } }));

    const watch = await observer.watch("turn-1");
    expect(watch).not.toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(readTimes.map((value) => value - Date.parse("2026-09-01T00:00:00.000Z"))).toEqual([10, 30, 70]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
      expect.objectContaining({ event: "worker-turn-cursor-read-failed", turnId: "turn-1", consecutiveFailures: 1, retryDelayMs: 20 }),
      expect.objectContaining({ event: "worker-turn-cursor-read-failed", turnId: "turn-1", consecutiveFailures: 2, retryDelayMs: 40 }),
      expect.objectContaining({ event: "worker-turn-cursor-read-failed", turnId: "turn-1", consecutiveFailures: 3, retryDelayMs: 80 })
    ]);

    await vi.advanceTimersByTimeAsync(50);
    expect(readTimes.at(-1)! - Date.parse("2026-09-01T00:00:00.000Z")).toBe(150);
    await vi.advanceTimersByTimeAsync(10);
    expect(readTimes.at(-1)! - Date.parse("2026-09-01T00:00:00.000Z")).toBe(160);

    await watch!.stop();
    const readsAfterStop = readObservation.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readObservation).toHaveBeenCalledTimes(readsAfterStop);
    await expect(watch!.detach()).resolves.toBeUndefined();
  });

  it("caps repeated cursor failures without repeating warnings at the cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const { observer, transcriptReader, warn } = setup("traex", 1_000);
    let attempts = 0;
    const readObservation = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 5) throw new Error("Core cursor unavailable");
      return { answerDelta: "" };
    });
    transcriptReader.open = vi.fn(async () => ({ mode: "typed" as const, cursor: { readDelta: vi.fn(async () => ""), readObservation } }));

    const watch = await observer.watch("turn-1");
    await vi.advanceTimersByTimeAsync(22_000);

    expect(readObservation).toHaveBeenCalledTimes(6);
    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
      expect.objectContaining({ consecutiveFailures: 1, retryDelayMs: 2_000 }),
      expect.objectContaining({ consecutiveFailures: 2, retryDelayMs: 4_000 }),
      expect.objectContaining({ consecutiveFailures: 3, retryDelayMs: 5_000 })
    ]);
    await watch!.stop();
  });

  it("backs off from the largest configured polling interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const { observer, transcriptReader, warn } = setup("traex", 10_000);
    let attempts = 0;
    const readObservation = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("Core cursor unavailable");
      return { answerDelta: "" };
    });
    transcriptReader.open = vi.fn(async () => ({ mode: "typed" as const, cursor: { readDelta: vi.fn(async () => ""), readObservation } }));

    const watch = await observer.watch("turn-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readObservation).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenLastCalledWith(expect.objectContaining({ consecutiveFailures: 1, retryDelayMs: 20_000 }), expect.any(String));

    await vi.advanceTimersByTimeAsync(20_000);
    expect(readObservation).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.objectContaining({ consecutiveFailures: 2, retryDelayMs: 40_000 }), expect.any(String));

    await vi.advanceTimersByTimeAsync(40_000);
    expect(readObservation).toHaveBeenCalledTimes(3);
    await watch!.stop();
  });

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
    const { observer, info, warn } = setup();
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
      timelineDeltas: [{ kind: "final_answer", id: `final:${runtimeTurnId}`, sequence: 1, markdown: "trusted final" }],
      mainStatus: { tokenCount: 5_000 },
      turnLifecycle: { turnId: runtimeTurnId, state: "completed", startedAt, finalAnswer: "trusted final\n\n```herdr-choice-list\n{\"version\":2,\"intent\":\"human_review\",\"question\":\"继续吗？\",\"default\":\"yes\",\"options\":[{\"id\":\"yes\",\"label\":\"继续\",\"message\":\"default\"}]}\n```" }
    });
    await observer.observe("turn-1", {
      turnId: runtimeTurnId, answerDelta: "",
      turnLifecycle: { turnId: runtimeTurnId, state: "completed", startedAt, finalAnswer: "duplicate" }
    });

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "trusted final" });
    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({ phase: "completed", answer: "trusted final", tokenCount: 5_000, resultCapture: "captured", timelineItems: [{ kind: "final_answer", markdown: "trusted final" }] });
    expect(store!.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("worker-next-input:"))).toHaveLength(0);
    expect(store!.database.prepare("SELECT state FROM completion_notification_obligations WHERE owner_kind = 'worker-turn' AND owner_id = 'turn-1'").get()).toEqual({ state: "waiting_for_answer" });
    expect(JSON.stringify(info.mock.calls)).not.toContain("ou_primary");
    expect(warn).not.toHaveBeenCalled();
  });

  it("persists a structured terminal Worker choice for the existing Task card action path", async () => {
    const { observer, worker } = setup();
    const create = store!.listPendingOutboundReplies().find(({ workerTurnId, kind }) => workerTurnId === "turn-1" && kind === "stream_card_create")!;
    store!.markOutboundReplyDelivered(create.id, "worker-message", "worker-card");
    const completionChoice = {
      version: 2 as const, intent: "human_review" as const, question: "Choose one?", default: "one",
      options: [{ id: "one", label: "One", message: "default" }, { id: "two", label: "Two", message: "2" }]
    };
    await observer.observe("turn-1", { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "Choose one.", turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt } });
    await observer.observe("turn-1", { turnId: runtimeTurnId, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "completed", startedAt, finalAnswer: "Choose one.", completionChoice } });

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "Choose one." });
    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({ phase: "completed", answer: "Choose one." });
    expect(store!.database.prepare("SELECT question, default_option_id FROM completion_choice_specifications WHERE owner_kind = 'worker-turn' AND owner_id = 'turn-1'").get()).toEqual({ question: "Choose one?", default_option_id: "one" });
    store!.database.prepare("UPDATE worker_turn_card_pages SET state = 'finished' WHERE turn_id = 'turn-1'").run();
    const actions = store!.prepareWorkerCompletionActionSet({ turnId: "turn-1", pageIndex: 0, cardId: "worker-card", messageId: "worker-message" })!;
    expect(actions).toMatchObject({ state: "available", mentionOpenId: "ou_primary", choiceSpecification: { question: "Choose one?", defaultOption: { id: "one" } } });
    const inlinePayload = JSON.stringify(renderWorkerTurnCard(store!.loadWorkerTurnCard("turn-1")!, undefined, { completionActions: actions }));
    expect(inlinePayload).toContain("Choose one?");
    expect(inlinePayload).toContain('"optionId":"one"');
    expect(inlinePayload).toContain('"optionId":"two"');
    expect(inlinePayload).toContain('"optionId":"ignore"');
    const inline = store!.enqueueOutboundReply({
      id: "worker-inline-choice", idempotencyKey: "worker-inline-choice", workerTurnId: "turn-1",
      workerId: worker.id, workerSessionGeneration: worker.workerSessionGeneration,
      rootMessageId: "worker-message", kind: "card_update", payload: inlinePayload,
      projectionKey: "worker-turn:inline-choice", snapshotRevision: 2
    });
    expect(store!.markOutboundReplyDelivered(inline.id, "worker-message", "worker-card")).toBe(true);
    expect(store!.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("worker-next-input:"))).toHaveLength(0);
    expect(store!.database.prepare(`SELECT state,notification_reply_id FROM completion_notification_obligations
      WHERE owner_kind='worker-turn' AND owner_id='turn-1'`).get()).toEqual({ state: "suppressed", notification_reply_id: null });
    expect(store!.database.prepare("SELECT state FROM completion_action_sets WHERE id=?").get(actions.id)).toEqual({ state: "available" });
    const followup = createQueuedWorkerTurnCard({ turnId: "turn-followup", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: "turn-1", rootMessageId: "root-1", requestText: "2", queuePosition: 1, occurredAt: "2026-09-01T00:00:03.000Z" });
    const acceptance = {
      actionSetId: actions.id, optionId: "two", ownerTurnId: "turn-1", ownerGeneration: worker.workerSessionGeneration, cardMessageId: "worker-message", chatId: "chat", actorOpenId: "ou_primary",
      accepted: { id: followup.turnId, idempotencyKey: `completion-choice:v1:${actions.id}:two`, actor: { kind: "human" as const, userId: "ou_primary", channel: "feishu" as const }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "followup" as const, text: "2", parentTurnId: "turn-1", sourceMessageId: "worker-message", view: followup, render: renderWorkerTurnCard }
    };
    expect(store!.acceptWorkerCompletionAction(acceptance)).toMatchObject({ inserted: true, turn: { text: "2" } });
    expect(store!.acceptWorkerCompletionAction(acceptance)).toMatchObject({ inserted: false });
    expect(() => store!.acceptWorkerCompletionAction({ ...acceptance, optionId: "one", accepted: { ...acceptance.accepted, id: "forged", idempotencyKey: `completion-choice:v1:${actions.id}:one`, text: "default", view: { ...followup, turnId: "forged", requestText: "default" } } })).toThrow("no longer available");
    expect(store!.database.prepare("SELECT selected_action, selected_choice_option_id FROM completion_action_sets WHERE id = ?").get(actions.id)).toEqual({ selected_action: null, selected_choice_option_id: "two" });
  });

  it("persists and publishes visible progress only for the exact owned transcript", async () => {
    const { observer } = setup();
    await observer.observe("turn-1", {
      turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "",
      mainStatus: { statusTitle: "Inspecting transaction boundaries", tokenCount: 4_570, planSteps: [{ key: "inspect", label: "Read the store", state: "active" }] },
      toolActivities: [{ key: "tool:read", kind: "read", label: "Read src/store/sqlite-store.ts", state: "done" }],
      turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt }
    });

    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({
      phase: "running", statusTitle: "Inspecting transaction boundaries", tokenCount: 4_570,
      progressEvents: expect.arrayContaining([
        expect.objectContaining({ key: "plan:inspect", kind: "step", state: "active" }),
        expect.objectContaining({ key: "tool:read", kind: "read", state: "done" })
      ])
    });
    expect(store!.listPendingOutboundReplies().filter(({ workerTurnId }) => workerTurnId).map(({ idempotencyKey }) => idempotencyKey)).toEqual(["worker-turn:create:turn-1:0"]);
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
    expect(store!.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("worker-next-input:"))).toHaveLength(0);
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

  it("bounds accumulated Worker deltas when completion has no authoritative final answer", async () => {
    const { observer } = setup();
    await observer.observe("turn-1", { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "x".repeat(64_000), turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt } });
    for (let index = 0; index < 9; index += 1) await observer.observe("turn-1", { turnId: runtimeTurnId, answerDelta: String(index).repeat(64_000) });
    await observer.observe("turn-1", { turnId: runtimeTurnId, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "completed", startedAt } });

    const result = store!.getInstanceTurn("turn-1")!.result!;
    expect(result.length).toBeLessThanOrEqual(MAX_TURN_OUTPUT_CHARS);
    expect(result.endsWith(TURN_OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(store!.loadWorkerTurnCard("turn-1")!.answer).toBe(result);
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

    expect(transcriptReader.openAtTurn).toHaveBeenCalledWith(expect.objectContaining({ nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: sessionId } }), runtimeTurnId, startedAt);
    expect(submit).not.toHaveBeenCalled();
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "recovered" });
  });

  it("opens an exact PI Worker turn from its native session identity", async () => {
    const { observer, transcriptReader } = setup("pi");
    await observer.observe("turn-1", { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt } });
    transcriptReader.openAtTurn = vi.fn(async () => ({ mode: "unavailable" as const, reason: "transcript_not_found" as const }));

    await observer.recover("turn-1");

    expect(transcriptReader.openAtTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: "pi", nativeSession: { source: "herdr:pi", agent: "pi", kind: "id", value: sessionId }
    }), runtimeTurnId, startedAt);
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

    expect(transcriptReader.openAtTurn).toHaveBeenCalledWith(expect.objectContaining({ nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: sessionId } }), runtimeTurnId, startedAt);
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "full recovered answer" });
    expect(store!.loadWorkerTurnCard("turn-1")).toMatchObject({ phase: "completed", answer: "full recovered answer", resultCapture: "captured" });
  });
});
