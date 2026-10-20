import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { InstanceMessagingWorkflow } from "../src/coordinator/instance-messaging-workflow.js";
import { WorkerTurnDispatcher } from "../src/coordinator/worker-turn-dispatcher.js";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import type { AgentRuntimeDriver } from "../src/domain/agent-runtime.js";
import { WorkerTurnObserver } from "../src/coordinator/worker-turn-observer.js";
import type { AgentTranscriptReaderPort } from "../src/domain/ports.js";
import { workerPresentation } from "./helpers/presentation.js";
import { TurnControlRequestError } from "../src/domain/ports/turn-control.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { connectPreparedDeliveryProducers } from "../src/composition/create-outbound-runtime.js";
import type { GatewayDeliveryIntent } from "../src/gateways/contract/plugin.js";

let store: SqliteBindingStore | undefined;
let schedulers: WorkerTurnDispatcher[] = [];
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.stop()));
  vi.useRealTimers();
  store?.close();
  store = undefined;
});

function createStore(): SqliteBindingStore {
  const target = new SqliteBindingStore(":memory:");
  const modules = target.capabilityModules();
  connectPreparedDeliveryProducers(modules.outbox, modules.preparedDeliveryProducers, {
    prepare: (intent: GatewayDeliveryIntent) => ({
      protocolVersion: 1,
      gatewayId: "feishu:primary",
      profileId: "feishu-cardkit-v1",
      rendererRevision: 1,
      operation: intent.kind,
      intent
    })
  }, { enqueuePreparedDelivery() {} });
  return target;
}

function unifiedWorkerTurn(turnId: string): Record<string, unknown> | null {
  if (!store) return null;
  const id = `worker-turn:${turnId}`;
  const segment = store.capabilityModules().conversationSegments.getConversationSegment(id);
  if (!segment) return null;
  expect(store.database.prepare("SELECT COUNT(*) AS count FROM worker_turn_cards WHERE turn_id=?").get(turnId)).toEqual({ count: 0 });
  expect(store.database.prepare("SELECT COUNT(*) AS count FROM worker_turn_card_pages WHERE turn_id=?").get(turnId)).toEqual({ count: 0 });
  const items = store.capabilityModules().conversationSegments.listConversationSegmentItems(id).map(({ item }) => item);
  const turn = store.getInstanceTurn(turnId);
  const answer = turn?.result ?? items.filter((item) => item.kind === "agent_message" || item.kind === "final_answer").map((item) => item.markdown).join("");
  const phase = turn?.state === "dispatch-uncertain" ? "dispatch-uncertain" : turn?.state === "claimed" ? "preparing" : turn?.state === "running" ? "running" : turn?.state === "completed" ? "completed" : turn?.state === "failed" ? "failed" : segment.state;
  const notice = turn?.error === "Command failed: herdr agent prompt w:p [REDACTED] --wait\n{\"error\":{\"code\":\"agent_prompt_stalled\"}}" ? "正在确认 Worker 是否已接收任务；系统不会自动重放。" : turn?.error ?? null;
  return { phase, answer, notice, resultCapture: answer ? "captured" : "pending", segmentId: id, viewVersion: segment.viewVersion };
}

function projectCanonicalWorker(turnId: string): void {
  if (!store) throw new Error("Worker test store is unavailable");
  const intent = store.database.prepare(`SELECT text,canonical_expected_session_id FROM instance_turns WHERE id=?`).get(turnId) as {
    text: string; canonical_expected_session_id: string | null;
  } | undefined;
  if (!intent) throw new Error(`Worker canonical intent is unavailable: ${turnId}`);
  store.capabilityModules().conversationSegments.projectCanonicalEvent({
    laneId: `worker-test:${turnId}`,
    laneSequence: 1,
    observedAt: "2026-10-04T12:00:01.000Z",
    event: {
      schemaVersion: 1,
      eventId: `worker-test-human:${turnId}`,
      cursor: "worker-test:1",
      sourceId: "worker-test",
      agentKind: "traex",
      sessionId: intent.canonical_expected_session_id ?? `session:${turnId}`,
      turnId: `runtime:${turnId}`,
      occurredAt: "2026-10-04T12:00:01.000Z",
      payload: { type: "human_message", message_id: `worker-test-message:${turnId}`, text: intent.text, truncated: false, submission_id: turnId }
    }
  });
}

function setup(capabilities: Partial<ReturnType<AgentRuntimeDriver["describe"]>> = {}, options: { nativeSessionId?: string | null; transcriptReader?: AgentTranscriptReaderPort; projectCanonicalOnSubmit?: boolean } = {}) {
  store = createStore();
  store.createPendingBinding({ id: "instance-messaging-parent", projectId: "p1", workspaceId: "w", chatId: "chat", topicId: "topic", rootMessageId: "primary-root", title: "Primary" });
  store.updateBinding("instance-messaging-parent", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane", statusMessageId: "primary-root" });
  const runtime = { herdrWorkspaceId: "w", paneId: "w:p1", nativeSessionId: null, generation: 2 };
  const create = (id: string, projectId = "p1", role: "primary" | "worker" = "worker") => {
    store!.createAgentInstance({ id, projectId, name: id, role, agentKind: "traex", model: null,
      ...(role === "worker" ? { parent: { bindingId: "instance-messaging-parent", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" } } : {}),
      ...(role === "worker" ? { workerSessionLifecycle: "active" as const } : {}),
      desiredState: "running", workspace: { id: `ws-${id}`, kind: role === "primary" ? "main-checkout" : "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    return store!.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, ...runtime, paneId: `${id}:pane`, nativeSessionId: options.nativeSessionId ?? null })!;
  };
  let canonicalSequence = 0;
  const submit = vi.fn(async (submittedRuntime: typeof runtime, text: string, hooks?: { submissionId?: string }) => {
    if (options.projectCanonicalOnSubmit !== false && hooks?.submissionId) {
      const sequence = ++canonicalSequence;
      void submittedRuntime; void text; void sequence;
      projectCanonicalWorker(hooks.submissionId);
    }
    return { status: "confirmed-delivered" as const };
  });
  const driver: AgentRuntimeDriver = {
    kind: "traex", describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "terminal-input", interrupt: "terminal-signal", approvals: "terminal", modelSelection: "runtime", usageReporting: true, ...capabilities }),
    start: vi.fn(async () => undefined), submit, steer: vi.fn(async () => ({ status: "delivered" as const })), interrupt: vi.fn(async () => ({ status: "interrupted" as const }))
  };
  const drivers = new AgentDriverRegistry([driver]);
  const wake = vi.fn();
  const wakeOutbound = vi.fn();
  const turnControl = {
    steer: vi.fn(async () => ({ operation: { state: "delivered", result: { status: "delivered" } }, duplicate: false })),
    interrupt: vi.fn(async () => ({ operation: { state: "delivered", result: { status: "interrupted" } }, duplicate: false }))
  };
  const workflow = new InstanceMessagingWorkflow({ store, turnControl: turnControl as never, wake, wakeOutbound, idFactory: (() => { let n = 0; return () => `turn-${++n}`; })(), presentation: workerPresentation });
  let scheduler!: WorkerTurnDispatcher;
  const observer = options.transcriptReader ? new WorkerTurnObserver({ store, transcriptReader: options.transcriptReader, wakeInstance: (instanceId) => scheduler.wake(instanceId), wakeOutbound, presentation: workerPresentation }) : undefined;
  scheduler = new WorkerTurnDispatcher({ store, drivers, observer, wakeOutbound, presentation: workerPresentation });
  schedulers.push(scheduler);
  return { create, workflow, scheduler, observer, wake, wakeOutbound, submit, driver, turnControl };
}

describe("instance messaging", () => {
  it("creates the first Worker Turn Card only when the exact canonical Human Message arrives", async () => {
    const sessionId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const { create, workflow, scheduler, submit } = setup({}, { nativeSessionId: sessionId, projectCanonicalOnSubmit: false });
    const worker = create("worker");

    await workflow.submit({
      idempotencyKey: "m1",
      actor: { kind: "human", userId: "u1", channel: "feishu" },
      projectId: "p1",
      targetInstanceId: worker.id,
      content: { kind: "turn", text: "review" },
      source: { messageId: "m1", rootMessageId: "root-1" }
    });

    expect(store!.capabilityModules().conversationSegments.getConversationSegment("worker-turn:turn-1")).toBeNull();
    expect(store!.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 0 });
    expect(store!.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'turn-card:%'").get()).toEqual({ count: 0 });

    await scheduler.drain(worker.id);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ nativeSessionId: sessionId }),
      "review",
      expect.objectContaining({ submissionId: "turn-1" }),
      expect.any(AbortSignal)
    );

    const adopted = store!.capabilityModules().conversationSegments.projectCanonicalEvent({
      laneId: "worker-lane",
      laneSequence: 42,
      observedAt: "2026-10-04T12:00:01.000Z",
      event: {
        schemaVersion: 1,
        eventId: "worker-human-1",
        cursor: "worker:42",
        sourceId: "worker-source",
        agentKind: "traex",
        sessionId,
        turnId: "runtime-turn-1",
        occurredAt: "2026-10-04T12:00:01.000Z",
        payload: { type: "human_message", message_id: "worker-message-1", text: "review", truncated: false, submission_id: "turn-1" }
      }
    });

    expect(adopted).toEqual({ outcome: "created", segmentId: "worker-turn:turn-1" });
    expect(store!.database.prepare("SELECT id FROM conversation_segments").all()).toEqual([{ id: "worker-turn:turn-1" }]);
    expect(store!.capabilityModules().conversationSegments.getConversationSegment("worker-turn:turn-1")).toMatchObject({
      humanEventId: "worker-human-1",
      state: "working",
      startAt: { laneSequence: 42, itemOrdinal: 0 }
    });
    expect(store!.capabilityModules().conversationSegments.listConversationSegmentItems("worker-turn:turn-1")).toHaveLength(1);
    expect(store!.database.prepare(`SELECT scope_kind,scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,
      gateway_plan_hash IS NOT NULL AS prepared FROM outbound_replies WHERE projection_key LIKE 'turn-card:%'`).get()).toEqual({
      scope_kind: "pane", scope_workspace_id: "w", scope_pane_id: "worker:pane",
      delivery_owner_kind: "worker", delivery_owner_id: worker.id, prepared: 1
    });
  });

  it.each([
    ["default", "default"],
    ["approve", "批准，按当前方案继续执行。"],
    ["continue", "继续。"],
    ["reject", "拒绝，请停止当前方案并等待进一步指示。"]
  ] as const)("maps Worker completion action %s to one ordinary follow-up", async (selection, expectedText) => {
    const owner = { id: "owner-turn", projectId: "p1", instanceId: "worker", instanceGeneration: 2, state: "completed", kind: "turn" };
    const ownerView = createQueuedWorkerTurnCard({ turnId: owner.id, instanceId: "worker", instanceGeneration: 2, workerSessionGeneration: 3, workerName: "reviewer", parentTurnId: null, rootMessageId: "worker-root", requestText: "review", queuePosition: 1, occurredAt: "2026-10-01T00:00:00.000Z" });
    const target = { id: "worker", projectId: "p1", name: "reviewer", generation: 2, workerSessionGeneration: 3, desiredState: "running", runtimeRef: { paneId: "worker-pane" } };
    const acceptWorkerCompletionAction = vi.fn((input) => ({ turn: { ...owner, id: "followup-turn", text: input.accepted.text }, view: input.accepted.view, inserted: true, completionActionOwnerTurnIds: [owner.id] }));
    const convergeWorkerTurn = vi.fn(async () => undefined);
    const wake = vi.fn();
    const workflow = new InstanceMessagingWorkflow({
      store: { getInstanceTurn: vi.fn(() => owner), loadWorkerTurnCard: vi.fn(() => ownerView), getAgentInstance: vi.fn(() => target), acceptWorkerCompletionAction } as never,
      turnControl: {} as never, wake, wakeOutbound: vi.fn(), convergeWorkerTurn, idFactory: () => "followup-turn", presentation: workerPresentation
    });

    const result = await workflow.acceptWorkerCompletionAction({ actionSetId: "actions-1", selection, ownerTurnId: owner.id, ownerGeneration: 3, cardMessageId: "worker-card", chatId: "chat", actor: { kind: "human", userId: "ou_actor", channel: "feishu" } });

    expect(result).toMatchObject({ accepted: true, inserted: true, turn: { id: "followup-turn", text: expectedText }, card: { parentTurnId: owner.id, requestText: expectedText } });
    expect(acceptWorkerCompletionAction).toHaveBeenCalledWith(expect.objectContaining({
      selection, ownerTurnId: owner.id, ownerGeneration: 3, cardMessageId: "worker-card", actorOpenId: "ou_actor",
      accepted: expect.objectContaining({ idempotencyKey: `completion-action:v1:actions-1:${selection}`, kind: "followup", text: expectedText, parentTurnId: owner.id, sourceMessageId: "worker-card" })
    }));
    expect(convergeWorkerTurn).toHaveBeenCalledWith(owner.id);
    expect(wake).toHaveBeenCalledWith(target.id);
  });

  it("resolves a dynamic Worker choice before constructing its ordinary follow-up", async () => {
    const owner = { id: "owner-turn", projectId: "p1", instanceId: "worker", instanceGeneration: 2, state: "completed", kind: "turn" };
    const ownerView = createQueuedWorkerTurnCard({ turnId: owner.id, instanceId: "worker", instanceGeneration: 2, workerSessionGeneration: 3, workerName: "reviewer", parentTurnId: null, rootMessageId: "worker-root", requestText: "review", queuePosition: 1, occurredAt: "2026-10-01T00:00:00.000Z" });
    const target = { id: "worker", projectId: "p1", name: "reviewer", generation: 2, workerSessionGeneration: 3, desiredState: "running", runtimeRef: { paneId: "worker-pane" } };
    const acceptWorkerCompletionAction = vi.fn((input) => ({ turn: { ...owner, id: "followup-turn", text: input.accepted.text }, view: input.accepted.view, inserted: true, completionActionOwnerTurnIds: [owner.id] }));
    const workflow = new InstanceMessagingWorkflow({
      store: { getInstanceTurn: vi.fn(() => owner), loadWorkerTurnCard: vi.fn(() => ownerView), getAgentInstance: vi.fn(() => target), resolveWorkerCompletionChoice: vi.fn(() => ({ label: "Two", message: "server message" })), acceptWorkerCompletionAction } as never,
      turnControl: {} as never, wake: vi.fn(), idFactory: () => "followup-turn", presentation: workerPresentation
    });

    await workflow.acceptWorkerCompletionAction({ actionSetId: "actions-1", optionId: "two", ownerTurnId: owner.id, ownerGeneration: 3, cardMessageId: "worker-card", chatId: "chat", actor: { kind: "human", userId: "ou_actor", channel: "feishu" } });

    expect(acceptWorkerCompletionAction).toHaveBeenCalledWith(expect.objectContaining({ optionId: "two", accepted: expect.objectContaining({ idempotencyKey: "completion-choice:v1:actions-1:two", text: "server message" }) }));
  });

  it("consumes Worker Ignore locally without constructing or waking a follow-up", async () => {
    const ignoreWorkerCompletionAction = vi.fn(() => ({ ownerId: "owner-turn", changed: true }));
    const convergeWorkerTurn = vi.fn(async () => undefined);
    const wake = vi.fn();
    const idFactory = vi.fn(() => "must-not-be-created");
    const workflow = new InstanceMessagingWorkflow({
      store: { ignoreWorkerCompletionAction } as never,
      turnControl: {} as never, wake, convergeWorkerTurn, idFactory, presentation: workerPresentation
    });

    await expect(workflow.ignoreWorkerCompletionAction({ actionSetId: "actions-1", ownerTurnId: "owner-turn", ownerGeneration: 3, cardMessageId: "worker-card", chatId: "chat", actor: { kind: "human", userId: "ou_actor", channel: "feishu" } })).resolves.toEqual({ ownerId: "owner-turn", changed: true });
    expect(ignoreWorkerCompletionAction).toHaveBeenCalledWith({ actionSetId: "actions-1", ownerTurnId: "owner-turn", ownerGeneration: 3, cardMessageId: "worker-card", chatId: "chat", actorOpenId: "ou_actor" });
    expect(convergeWorkerTurn).toHaveBeenCalledWith("owner-turn");
    expect(idFactory).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("rejects oversized task and steering input at the messaging boundary", async () => {
    const { create, workflow, wake, turnControl } = setup();
    const worker = create("worker");
    const actor = { kind: "human" as const, userId: "u1" };
    const text = "x".repeat(12_001);

    await expect(workflow.submit({ idempotencyKey: "too-large", actor, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text } })).rejects.toThrow("Prompt input exceeds");
    await expect(workflow.steer({ idempotencyKey: "steer-too-large", actor, targetInstanceId: worker.id, text })).rejects.toThrow("Prompt input exceeds");

    expect(store!.listInstanceTurns(worker.id).items).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    expect(turnControl.steer).not.toHaveBeenCalled();
  });

  it("atomically accepts each Feishu Worker turn without creating per-turn cards", async () => {
    const { create, workflow, wake, wakeOutbound } = setup();
    const worker = create("worker");
    const actor = { kind: "human" as const, userId: "u1", channel: "feishu" as const };
    for (const [index, text] of ["A", "B", "C"].entries()) {
      const result = await workflow.submit({ idempotencyKey: `message-${text}`, actor, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text }, source: { messageId: `message-${text}`, rootMessageId: "root-1" } });
      expect(result.card).toMatchObject({ requestText: text, queuePosition: index + 1, rootMessageId: "root-1", phase: "queued" });
    }

    const duplicate = await workflow.submit({ idempotencyKey: "message-B", actor, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "B" }, source: { messageId: "message-B", rootMessageId: "root-1" } });
    expect(duplicate.inserted).toBe(false);
    expect(store!.listInstanceTurns(worker.id).items).toHaveLength(3);
    expect(store!.listPendingOutboundReplies().filter(({ workerTurnId }) => workerTurnId)).toEqual([]);
    expect(store!.listPendingCardContextInvalidations()).toContainEqual(expect.objectContaining({
      targetKind: "worker-session", targetId: worker.id, targetGeneration: worker.workerSessionGeneration
    }));
    expect(wakeOutbound).toHaveBeenCalledTimes(3);
    expect(wake).toHaveBeenCalledTimes(3);
    expect(wakeOutbound.mock.invocationCallOrder[0]).toBeLessThan(wake.mock.invocationCallOrder[0]!);
  });

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
    const { create, workflow, turnControl } = setup({ steering: "unsupported" });
    const worker = create("worker");
    turnControl.steer.mockResolvedValueOnce({ operation: { state: "rejected", result: { status: "unsupported" } }, duplicate: false } as never);
    await expect(workflow.steer({ idempotencyKey: "s1", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id, text: "change" })).resolves.toEqual({ status: "unsupported" });
    expect(store!.listInstanceTurns(worker.id).items).toEqual([]);
  });

  it("steers only an active runtime and never falls back to a queued turn", async () => {
    const { create, workflow, driver, turnControl } = setup();
    const worker = create("worker");
    turnControl.steer.mockRejectedValueOnce(new TurnControlRequestError("not-active", "runtime unavailable"));
    await expect(workflow.steer({ idempotencyKey: "s1", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id, text: "change" })).resolves.toMatchObject({ status: "not-active" });
    expect(store!.listInstanceTurns(worker.id).items).toEqual([]);
    store!.updateAgentInstanceLifecycle({ instanceId: worker.id, expectedGeneration: worker.generation, desiredState: "running", observedState: "working" });
    await expect(workflow.steer({ idempotencyKey: "s2", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id, text: "change" })).resolves.toEqual({ status: "delivered" });
    expect(turnControl.steer).toHaveBeenCalledWith(expect.objectContaining({ owner: { kind: "instance", id: worker.id }, text: "change" }));
    expect(driver.steer).not.toHaveBeenCalled();
    expect(store!.listInstanceTurns(worker.id).items).toEqual([]);
  });

  it("classifies turn-control rejection by stable code rather than message text", async () => {
    const { create, workflow, turnControl } = setup();
    const worker = create("worker");
    turnControl.steer.mockRejectedValueOnce(new TurnControlRequestError("blocked", "local interaction required"));
    await expect(workflow.steer({ idempotencyKey: "blocked", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id, text: "change" }))
      .resolves.toEqual({ status: "blocked", reason: "local interaction required" });
    turnControl.steer.mockRejectedValueOnce(new Error("blocked text from an unknown failure"));
    await expect(workflow.steer({ idempotencyKey: "unknown", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id, text: "change" }))
      .resolves.toEqual({ status: "failed", reason: "blocked text from an unknown failure" });
  });

  it("stops only through the shared exact-turn control workflow", async () => {
    const { create, workflow, driver, turnControl } = setup();
    const worker = create("worker");

    await expect(workflow.interrupt({ idempotencyKey: "stop-once", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id })).resolves.toEqual({ status: "interrupted" });
    expect(turnControl.interrupt).toHaveBeenCalledWith(expect.objectContaining({ owner: { kind: "instance", id: worker.id }, idempotencyKey: "stop-once" }));
    expect(driver.interrupt).not.toHaveBeenCalled();
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
    const { create, workflow, driver, turnControl } = setup(); const worker = create("worker");
    store!.updateAgentInstanceLifecycle({ instanceId: worker.id, expectedGeneration: worker.generation, desiredState: "running", observedState: "working" });
    const input = { idempotencyKey: "steer-once", actor: { kind: "human" as const, userId: "u1" }, targetInstanceId: worker.id, text: "change" };
    await expect(workflow.steer(input)).resolves.toEqual({ status: "delivered" });
    await expect(workflow.steer(input)).resolves.toEqual({ status: "delivered" });
    expect(turnControl.steer).toHaveBeenCalledTimes(2);
    expect(driver.steer).not.toHaveBeenCalled();
  });

  it("steers only the exact current-generation active turn and deduplicates the reply event", async () => {
    const { create, workflow, driver, turnControl } = setup();
    const worker = create("worker");
    store!.acceptInstanceTurn({ id: "active-turn", idempotencyKey: "active-turn", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review" });
    store!.claimNextInstanceTurn(worker.id, worker.generation);
    store!.updateInstanceTurn({ turnId: "active-turn", expectedGeneration: worker.generation, state: "running", eventKind: "turn.running" });
    store!.updateAgentInstanceLifecycle({ instanceId: worker.id, expectedGeneration: worker.generation, desiredState: "running", observedState: "working" });
    const input = { idempotencyKey: "reply-once", actor: { kind: "human" as const, userId: "u1" }, targetInstanceId: worker.id, targetTurnId: "active-turn", text: "focus" };

    await expect(workflow.steer({ ...input, targetTurnId: "other-turn" })).resolves.toEqual({ status: "not-active" });
    await expect(workflow.steer(input)).resolves.toEqual({ status: "delivered" });
    await expect(workflow.steer(input)).resolves.toEqual({ status: "delivered" });

    expect(turnControl.steer).toHaveBeenCalledTimes(2);
    expect(turnControl.steer).toHaveBeenCalledWith(expect.objectContaining({ owner: { kind: "instance", id: worker.id }, text: "focus" }));
    expect(driver.steer).not.toHaveBeenCalled();
  });

  it("interrupts only the exact running turn selected by a Task Card", async () => {
    const { create, workflow, turnControl } = setup();
    const worker = create("worker");
    store!.acceptInstanceTurn({ id: "active-turn", idempotencyKey: "active-turn", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review" });
    store!.claimNextInstanceTurn(worker.id, worker.generation);
    store!.updateInstanceTurn({ turnId: "active-turn", expectedGeneration: worker.generation, state: "running", eventKind: "turn.running" });

    await expect(workflow.interrupt({ idempotencyKey: "stop-stale", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id, targetTurnId: "other-turn" })).resolves.toEqual({ status: "not-active" });
    expect(turnControl.interrupt).not.toHaveBeenCalled();
    await expect(workflow.interrupt({ idempotencyKey: "stop-active", actor: { kind: "human", userId: "u1" }, targetInstanceId: worker.id, targetTurnId: "active-turn" })).resolves.toEqual({ status: "interrupted" });
    expect(turnControl.interrupt).toHaveBeenCalledOnce();
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

  it("shows a neutral confirmation notice while a stalled Herdr prompt is being recovered", async () => {
    const { create, workflow, scheduler, driver } = setup();
    const worker = create("worker");
    vi.mocked(driver.submit).mockResolvedValueOnce({
      status: "delivery-uncertain",
      reason: "Command failed: herdr agent prompt w:p [REDACTED] --wait\n{\"error\":{\"code\":\"agent_prompt_stalled\"}}"
    });

    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "report progress" }, source: { messageId: "m1", rootMessageId: "root-1" } });
    await scheduler.drain(worker.id);

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "dispatch-uncertain" });
    expect(unifiedWorkerTurn("turn-1")).toBeNull();
    expect(store!.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'turn-card:%'").get()).toEqual({ count: 0 });
  });

  it("completes unstructured dispatches without inventing output and drains FIFO", async () => {
    const { create, workflow, scheduler, submit } = setup({ structuredEvents: false });
    const worker = create("worker");
    const actor = { kind: "human" as const, userId: "u1" };
    await workflow.submit({ idempotencyKey: "m1", actor, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "one" } });
    await workflow.submit({ idempotencyKey: "m2", actor, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "two" } });
    await scheduler.drain(worker.id);
    expect(store!.listInstanceTurns(worker.id).items.map(({ state }) => state)).toEqual(["completed", "completed"]);
    expect(store!.getAgentInstance(worker.id)).toMatchObject({ observedState: "idle" });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("keeps a structured Worker turn running after dispatch delivery", async () => {
    const { create, workflow, scheduler, driver, wakeOutbound } = setup();
    const worker = create("worker");
    let release!: () => void;
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, hooks) => {
      projectCanonicalWorker(hooks?.submissionId ?? "turn-1");
      await hooks?.onDispatched?.();
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "confirmed-delivered", runtimeCursor: "not-an-answer" };
    });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "work" }, source: { messageId: "m1", rootMessageId: "root-1" } });
    const draining = scheduler.drain(worker.id);
    await vi.waitFor(() => {
      expect(store!.listInstanceTurns(worker.id).items[0]).toMatchObject({ state: "running", result: null });
      expect(unifiedWorkerTurn("turn-1")).toMatchObject({ phase: "running", answer: "" });
    });
    release();
    await draining;
    expect(store!.listInstanceTurns(worker.id).items[0]).toMatchObject({ state: "running", result: null });
    expect(unifiedWorkerTurn("turn-1")).toMatchObject({ phase: "running", answer: "" });
    expect(JSON.stringify(store!.listPendingOutboundReplies())).not.toContain("not-an-answer");
    expect(wakeOutbound).toHaveBeenCalled();
  });

  it("completes a structured Worker turn from its exact transcript lifecycle", async () => {
    const runtimeTurnId = "01a052d3-9c14-70e1-a375-397e2ecb5501";
    const startedAt = "2026-09-01T00:00:01.000Z";
    let read = false;
    const transcriptReader: AgentTranscriptReaderPort = {
      async open() { return { mode: "typed" as const, cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          if (read) return { answerDelta: "" };
          read = true;
          return { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "review finding", turnLifecycle: { turnId: runtimeTurnId, state: "completed" as const, startedAt } };
        }
      } }; }
    };
    const { create, workflow, scheduler, driver } = setup({}, { nativeSessionId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptReader });
    const worker = create("worker");
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, hooks) => { projectCanonicalWorker(hooks?.submissionId ?? "turn-1"); await hooks?.onDispatched?.(); return { status: "confirmed-delivered" }; });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "review" }, source: { messageId: "m1", rootMessageId: "root-1" } });

    await scheduler.drain(worker.id);

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "review finding", runtimeTurnId });
    expect(unifiedWorkerTurn("turn-1")).toMatchObject({ phase: "completed", answer: "review finding", resultCapture: "captured" });
  });

  it("does not overwrite an exact transcript completion when the driver observer disconnects", async () => {
    const runtimeTurnId = "01a052d3-9c14-70e1-a375-397e2ecb5501";
    const transcriptReader: AgentTranscriptReaderPort = {
      async open() { let read = false; return { mode: "typed" as const, cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          if (read) return { answerDelta: "" };
          read = true;
          return { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "trusted", turnLifecycle: { turnId: runtimeTurnId, state: "completed" as const, startedAt: "2026-09-01T00:00:01.000Z" } };
        }
      } }; }
    };
    const { create, workflow, scheduler, driver } = setup({}, { nativeSessionId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptReader });
    const worker = create("worker");
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, hooks) => { projectCanonicalWorker(hooks?.submissionId ?? "turn-1"); await hooks?.onDispatched?.(); throw new Error("observer disconnected"); });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "review" }, source: { messageId: "m1", rootMessageId: "root-1" } });

    await scheduler.drain(worker.id);

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "trusted" });
    expect(unifiedWorkerTurn("turn-1")).toMatchObject({ phase: "completed", answer: "trusted" });
  });

  it("does not overwrite an exact transcript completion with a late not-delivered receipt", async () => {
    const runtimeTurnId = "01a052d3-9c14-70e1-a375-397e2ecb5501";
    const transcriptReader: AgentTranscriptReaderPort = {
      async open() { let read = false; return { mode: "typed" as const, cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          if (read) return { answerDelta: "" };
          read = true;
          return { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "trusted", turnLifecycle: { turnId: runtimeTurnId, state: "completed" as const, startedAt: "2026-09-01T00:00:01.000Z" } };
        }
      } }; }
    };
    const { create, workflow, scheduler, driver } = setup({}, { nativeSessionId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptReader });
    const worker = create("worker");
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, hooks) => {
      projectCanonicalWorker(hooks?.submissionId ?? "turn-1");
      await hooks?.onDispatched?.();
      return { status: "not-delivered", reason: "late settlement missed the already completed turn" };
    });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "review" }, source: { messageId: "m1", rootMessageId: "root-1" } });

    await scheduler.drain(worker.id);

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "trusted", error: null });
    expect(unifiedWorkerTurn("turn-1")).toMatchObject({ phase: "completed", answer: "trusted" });
  });

  it("keeps observing an exact-owned running turn after a late not-delivered receipt", async () => {
    const runtimeTurnId = "01a052d3-9c14-70e1-a375-397e2ecb5501";
    const startedAt = "2026-09-01T00:00:01.000Z";
    const transcriptReader: AgentTranscriptReaderPort = {
      async open() { let read = false; return { mode: "typed" as const, cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          if (read) return { answerDelta: "" };
          read = true;
          return { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "active" as const, startedAt } };
        }
      } }; }
    };
    const { create, workflow, scheduler, observer, driver } = setup({}, { nativeSessionId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptReader });
    const worker = create("worker");
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, hooks) => {
      projectCanonicalWorker(hooks?.submissionId ?? "turn-1");
      await hooks?.onDispatched?.();
      await vi.waitFor(() => expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running", runtimeTurnId, runtimeTurnStartedAt: startedAt }));
      return { status: "not-delivered", reason: "late settlement missed the running turn" };
    });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "review" }, source: { messageId: "m1", rootMessageId: "root-1" } });

    await scheduler.drain(worker.id);

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running", error: null, runtimeTurnId, runtimeTurnStartedAt: startedAt });
    expect(unifiedWorkerTurn("turn-1")).toMatchObject({ phase: "running", notice: null });
    expect(store!.listInstanceEvents(worker.id).map(({ kind }) => kind)).not.toContain("turn.failed");

    await observer!.observe("turn-1", { turnId: runtimeTurnId, answerDelta: "trusted completion", turnLifecycle: { turnId: runtimeTurnId, state: "completed", startedAt, finalAnswer: "trusted completion" } });
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "trusted completion", error: null });
  });

  it("keeps observing an exact-owned running turn after a late uncertain receipt", async () => {
    const runtimeTurnId = "01a052d3-9c14-70e1-a375-397e2ecb5501";
    const startedAt = "2026-09-01T00:00:01.000Z";
    const transcriptReader: AgentTranscriptReaderPort = {
      async open() { let read = false; return { mode: "typed" as const, cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          if (read) return { answerDelta: "" };
          read = true;
          return { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "active" as const, startedAt } };
        }
      } }; }
    };
    const { create, workflow, scheduler, observer, driver } = setup({}, { nativeSessionId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptReader });
    const worker = create("worker");
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, hooks) => {
      projectCanonicalWorker(hooks?.submissionId ?? "turn-1");
      await hooks?.onDispatched?.();
      await vi.waitFor(() => expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running", runtimeTurnId, runtimeTurnStartedAt: startedAt }));
      return { status: "delivery-uncertain", reason: "agent_prompt_stalled" };
    });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "review" }, source: { messageId: "m1", rootMessageId: "root-1" } });

    await scheduler.drain(worker.id);

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running", error: null, runtimeTurnId, runtimeTurnStartedAt: startedAt });
    expect(unifiedWorkerTurn("turn-1")).toMatchObject({ phase: "running", notice: null });

    await observer!.observe("turn-1", { turnId: runtimeTurnId, answerDelta: "trusted completion", turnLifecycle: { turnId: runtimeTurnId, state: "completed", startedAt, finalAnswer: "trusted completion" } });
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "trusted completion", error: null });
  });

  it("keeps the transcript watcher alive after an exact-owned stalled receipt", async () => {
    vi.useFakeTimers();
    const runtimeTurnId = "01a052d3-9c14-70e1-a375-397e2ecb5501";
    const startedAt = "2026-09-01T00:00:01.000Z";
    const observations = [{
      turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "",
      turnLifecycle: { turnId: runtimeTurnId, state: "active" as const, startedAt }
    }];
    const transcriptReader: AgentTranscriptReaderPort = {
      async open() { return { mode: "typed" as const, cursor: {
        async readDelta() { return ""; },
        async readObservation() { return observations.shift() ?? { answerDelta: "" }; }
      } }; }
    };
    const { create, workflow, scheduler, driver } = setup({}, { nativeSessionId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptReader });
    const worker = create("worker");
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, hooks) => {
      projectCanonicalWorker(hooks?.submissionId ?? "turn-1");
      await hooks?.onDispatched?.();
      await vi.advanceTimersByTimeAsync(250);
      return { status: "delivery-uncertain", reason: "agent_prompt_stalled" };
    });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "review" }, source: { messageId: "m1", rootMessageId: "root-1" } });

    await scheduler.drain(worker.id);
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running", runtimeTurnId });

    observations.push({ turnId: runtimeTurnId, answerDelta: "late progress", turnLifecycle: { turnId: runtimeTurnId, state: "active", startedAt } });
    await vi.advanceTimersByTimeAsync(250);
    expect(unifiedWorkerTurn("turn-1")).toMatchObject({ phase: "running", segmentId: "worker-turn:turn-1" });

    observations.push({ turnId: runtimeTurnId, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "completed", startedAt, finalAnswer: "final answer" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "completed", result: "final answer" });
    expect(driver.submit).toHaveBeenCalledOnce();
    await scheduler.stop();
    vi.useRealTimers();
  });

  it("keeps observing an exact-owned running turn when the driver throws late", async () => {
    const runtimeTurnId = "01a052d3-9c14-70e1-a375-397e2ecb5501";
    const startedAt = "2026-09-01T00:00:01.000Z";
    const transcriptReader: AgentTranscriptReaderPort = {
      async open() { let read = false; return { mode: "typed" as const, cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          if (read) return { answerDelta: "" };
          read = true;
          return { turnId: runtimeTurnId, freshTurnStart: true, answerDelta: "", turnLifecycle: { turnId: runtimeTurnId, state: "active" as const, startedAt } };
        }
      } }; }
    };
    const { create, workflow, scheduler, driver } = setup({}, { nativeSessionId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptReader });
    const worker = create("worker");
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, hooks) => {
      projectCanonicalWorker(hooks?.submissionId ?? "turn-1");
      await hooks?.onDispatched?.();
      await vi.waitFor(() => expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running", runtimeTurnId, runtimeTurnStartedAt: startedAt }));
      throw new Error("agent_prompt_stalled");
    });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "review" }, source: { messageId: "m1", rootMessageId: "root-1" } });

    await scheduler.drain(worker.id);

    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running", error: null, runtimeTurnId, runtimeTurnStartedAt: startedAt });
    expect(unifiedWorkerTurn("turn-1")).toMatchObject({ phase: "running", notice: null });
  });

  it("fences a thrown driver call as uncertain without rejecting the drain", async () => {
    const { create, workflow, scheduler, driver } = setup();
    const worker = create("worker");
    vi.mocked(driver.submit).mockRejectedValueOnce(new Error("driver crashed"));
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "work" }, source: { messageId: "m1", rootMessageId: "root-1" } });
    await expect(scheduler.drain(worker.id)).resolves.toBeUndefined();
    expect(store!.listInstanceTurns(worker.id).items[0]).toMatchObject({ state: "dispatch-uncertain", error: "driver crashed" });
    expect(unifiedWorkerTurn("turn-1")).toBeNull();
    expect(scheduler.snapshot()).toMatchObject({ activeDispatchWorkers: 0, lastFailure: "driver crashed" });
  });

  it("cancels an in-flight driver at the shutdown deadline and waits for its drain", async () => {
    const { create, workflow, scheduler, driver } = setup();
    const worker = create("worker");
    let release!: () => void; let receivedSignal: AbortSignal | undefined;
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, hooks, signal) => {
      receivedSignal = signal;
      projectCanonicalWorker(hooks?.submissionId ?? "turn-1");
      await hooks?.onDispatched?.();
      await new Promise<void>((resolve) => { release = resolve; signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { status: "confirmed-delivered" };
    });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "work" }, source: { messageId: "m1", rootMessageId: "root-1" } });
    scheduler.wake(worker.id);
    await vi.waitFor(() => expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running" }));
    const controller = new AbortController();
    const stopped = scheduler.stop({ signal: controller.signal, deadlineAt: Date.now(), remainingMs: () => 0 });
    controller.abort();
    await expect(stopped).resolves.toBeUndefined();
    expect(receivedSignal?.aborted).toBe(true);
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "dispatch-uncertain" });
    expect(unifiedWorkerTurn("turn-1")).toMatchObject({ phase: "dispatch-uncertain" });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "dispatch-uncertain" });
  });

  it("keeps shutdown pending when a custom driver ignores cancellation", async () => {
    const { create, workflow, scheduler, driver } = setup();
    const worker = create("worker");
    let release!: () => void; let receivedSignal: AbortSignal | undefined;
    vi.mocked(driver.submit).mockImplementationOnce(async (_runtime, _text, hooks, signal) => {
      receivedSignal = signal;
      projectCanonicalWorker(hooks?.submissionId ?? "turn-1");
      await hooks?.onDispatched?.();
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "confirmed-delivered" };
    });
    await workflow.submit({ idempotencyKey: "m1", actor: { kind: "human", userId: "u1", channel: "feishu" }, projectId: "p1", targetInstanceId: worker.id, content: { kind: "turn", text: "work" }, source: { messageId: "m1", rootMessageId: "root-1" } });
    scheduler.wake(worker.id);
    await vi.waitFor(() => expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "running" }));
    const controller = new AbortController();
    let stopped = false;
    const stopping = scheduler.stop({ signal: controller.signal, deadlineAt: Date.now(), remainingMs: () => 0 }).then(() => { stopped = true; });
    controller.abort();
    await Promise.resolve();

    expect(receivedSignal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ state: "dispatch-uncertain" });
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
