import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorClearWorkflow } from "../src/coordinator/orchestrator-clear-workflow.js";
import type { HerdrPort } from "../src/domain/ports/external.js";
import type { RuntimeObservation } from "../src/domain/types.js";
import { createTestStoreBundle, type TestStoreBundle } from "./helpers/create-test-store-bundle.js";
import { cardKitApplicationPresentation } from "../src/cards/cardkit-application-presentation.js";

describe("Orchestrator context clear workflow", () => {
  let stores: TestStoreBundle | null = null;
  afterEach(() => stores?.lifecycle.close());

  it("rotates only the native session and advances the durable epoch", async () => {
    stores = setupStore("orchestrator");
    const before = stores.orchestratorClear.getBinding("binding-1")!;
    const rotateSession = vi.fn(async () => ({ outcome: "rotated" as const, receipt: {
      operationId: "clear-1", paneId: "w-herdr:p1", terminalId: "terminal-1", oldSession: nativeSession("session-1"), newSession: nativeSession("session-2")
    } }));
    const workflow = createWorkflow(stores, runtimeObservation(), { rotateSession });

    const operation = await workflow.request(request());
    const after = stores.orchestratorClear.getBinding("binding-1")!;

    expect(operation).toMatchObject({ id: "clear-1", state: "succeeded", oldSessionEpoch: 1 });
    expect(rotateSession).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "clear-1", paneId: "w-herdr:p1", expectedTerminalId: "terminal-1",
      expectedSession: nativeSession("session-1"), expectedStateChangeSeq: 17
    }));
    expect(after).toMatchObject({
      id: before.id, generation: before.generation, sessionEpoch: 2, workspaceId: before.workspaceId,
      paneId: before.paneId, paneToken: before.paneToken, title: before.title, agentSessionValue: "session-2"
    });
  });

  it("clears through the migrated fixed identity when Core bootstraps the legacy Pane", async () => {
    stores = setupStore("orchestrator");
    stores.driver.updateBinding("binding-1", { workspaceId: "w1", paneId: "w1:p1", paneToken: "abcd" });
    stores.orchestratorIdentity.accept({
      id: "migration-1", bindingId: "binding-1", bindingGeneration: 1,
      expected: { workspaceId: "w1", paneId: "w1:p1", terminalId: "terminal-1", token: "abcd" },
      target: { workspaceId: "w-herdr", expectedWorkspaceLabel: "herdr", token: "orch" }
    });
    stores.orchestratorIdentity.claim("migration-1");
    stores.orchestratorIdentity.applyReceipt({ operationId: "migration-1", receipt: {
      operationId: "migration-1", disposition: "applied", previous: {
        workspaceId: "w1", paneId: "w1:p1", terminalId: "terminal-1", token: "abcd"
      },
      current: { workspaceId: "w-herdr", paneId: "w-herdr:p9", terminalId: "terminal-1", token: "orch" }
    } });
    const rotateSession = vi.fn(async () => ({ outcome: "rotated" as const, receipt: {
      operationId: "clear-1", paneId: "w-herdr:p9", terminalId: "terminal-1",
      oldSession: nativeSession("session-1"), newSession: nativeSession("session-2")
    } }));
    const workflow = createWorkflow(stores, runtimeObservation({ paneId: "w-herdr:p9" }), { rotateSession });

    await expect(workflow.request(request())).resolves.toMatchObject({ state: "succeeded" });

    expect(stores.orchestratorClear.getBinding("binding-1")).toMatchObject({
      workspaceId: "w-herdr", paneId: "w-herdr:p9", paneToken: "orch", sessionEpoch: 2, agentSessionValue: "session-2"
    });
  });

  it.each([
    ["task Binding", "task", runtimeObservation(), false],
    ["non-idle runtime", "orchestrator", runtimeObservation({ agentState: "working", activeTurnId: "turn-1" }), true],
    ["non-ready composer", "orchestrator", { ...runtimeObservation(), composerReady: false }, true]
  ])("rejects %s before creating an operation", async (_case, kind, observation, supported) => {
    stores = setupStore(kind as "task" | "orchestrator");
    const workflow = createWorkflow(stores, observation, { supportsSessionRotation: async () => supported });

    await expect(workflow.request(request())).rejects.toThrow();
    expect(stores.orchestratorClear.get("clear-1")).toBeNull();
  });

  it("rejects a non-quiescent Prompt queue before creating an operation", async () => {
    stores = setupStore("orchestrator");
    stores.promptAcceptance.enqueuePrompt({ id: "prompt-1", bindingId: "binding-1", larkMessageId: "message-1", actorOpenId: "user-1", body: "work", parentPromptId: null });
    const workflow = createWorkflow(stores, runtimeObservation());

    await expect(workflow.request(request())).rejects.toThrow("quiescent");
    expect(stores.orchestratorClear.get("clear-1")).toBeNull();
  });

  it("rejects clear admission while Orchestrator identity migration is active", async () => {
    stores = setupStore("orchestrator");
    stores.orchestratorIdentity.accept({
      id: "migration-1", bindingId: "binding-1", bindingGeneration: 1,
      expected: { workspaceId: "w-herdr", paneId: "w-herdr:p1", terminalId: "terminal-1", token: "orch" },
      target: { workspaceId: "w-herdr", expectedWorkspaceLabel: "herdr", token: "orch" }
    });
    const observeRuntime = vi.fn(async () => runtimeObservation());
    const workflow = createWorkflow(stores, runtimeObservation(), { observeRuntime });

    await expect(workflow.request(request())).rejects.toThrow("identity migration is in progress");
    expect(observeRuntime).not.toHaveBeenCalled();
    expect(stores.orchestratorClear.get("clear-1")).toBeNull();
  });

  it("rejects clear admission until the Orchestrator owns the fixed native identity", async () => {
    stores = setupStore("orchestrator");
    stores.driver.updateBinding("binding-1", { workspaceId: "w1", paneId: "w1:p1", paneToken: "abcd" });
    const rotateSession = vi.fn();
    const workflow = createWorkflow(stores, runtimeObservation({ workspaceId: "w1", paneId: "w1:p1", paneToken: "abcd" }), { rotateSession });

    await expect(workflow.request(request())).rejects.toThrow("fixed Herdr identity");

    expect(rotateSession).not.toHaveBeenCalled();
    expect(stores.orchestratorClear.get("clear-1")).toBeNull();
  });

  it.each([
    ["missing", []],
    ["ambiguous", [{ workspaceId: "w-herdr", label: "herdr" }, { workspaceId: "w-other", label: "herdr" }]],
    ["different", [{ workspaceId: "w-other", label: "herdr" }]]
  ])("rejects clear admission when the exact herdr Space is %s", async (_case, workspaces) => {
    stores = setupStore("orchestrator");
    const rotateSession = vi.fn();
    const workflow = createWorkflow(stores, runtimeObservation(), { listWorkspaces: async () => workspaces, rotateSession });

    await expect(workflow.request(request())).rejects.toThrow("fixed Herdr identity");

    expect(rotateSession).not.toHaveBeenCalled();
    expect(stores.orchestratorClear.get("clear-1")).toBeNull();
  });

  it("recovers an uncertain Core dispatch with the same operation ID", async () => {
    stores = setupStore("orchestrator");
    const rotateSession = vi.fn()
      .mockResolvedValueOnce({ outcome: "uncertain", operationId: "clear-1", paneId: "w-herdr:p1", reason: "timeout" })
      .mockResolvedValueOnce({ outcome: "already-applied", receipt: {
        operationId: "clear-1", paneId: "w-herdr:p1", terminalId: "terminal-1", oldSession: nativeSession("session-1"), newSession: nativeSession("session-2")
      } });
    const workflow = createWorkflow(stores, runtimeObservation(), { rotateSession });

    await expect(workflow.request(request())).resolves.toMatchObject({ state: "rotation-uncertain" });
    await workflow.recover();

    expect(rotateSession).toHaveBeenCalledTimes(2);
    expect(rotateSession.mock.calls.map(([input]) => input.operationId)).toEqual(["clear-1", "clear-1"]);
    expect(stores.orchestratorClear.get("clear-1")).toMatchObject({ state: "succeeded", receipt: { newSession: nativeSession("session-2") } });
  });

  it("keeps a malformed rotation receipt uncertain instead of rejecting a possible effect", async () => {
    stores = setupStore("orchestrator");
    const workflow = createWorkflow(stores, runtimeObservation(), {
      rotateSession: async () => ({
        outcome: "malformed-response", operationId: "clear-1", paneId: "w-herdr:p1",
        reason: "Herdr agent.session_rotate.v1 returned malformed JSON"
      })
    });

    await expect(workflow.request(request())).resolves.toMatchObject({
      state: "rotation-uncertain",
      detail: "Herdr agent.session_rotate.v1 returned malformed JSON"
    });
  });

  it("never replays a historically rejected clear operation", async () => {
    stores = setupStore("orchestrator");
    const rotateSession = vi.fn(async (input: Parameters<NonNullable<HerdrPort["rotateSession"]>>[0]) => input.operationId === "clear-rejected"
      ? { outcome: "fence-lost" as const, operationId: input.operationId, paneId: input.paneId, reason: "historical rejection" }
      : { outcome: "rotated" as const, receipt: {
          operationId: input.operationId, paneId: input.paneId, terminalId: input.expectedTerminalId,
          oldSession: input.expectedSession, newSession: nativeSession("session-2")
        } });
    const workflow = createWorkflow(stores, runtimeObservation(), { rotateSession });

    await expect(workflow.request(request("clear-rejected"))).resolves.toMatchObject({ state: "rejected" });
    await workflow.recover();
    await expect(workflow.request(request("clear-new"))).resolves.toMatchObject({ state: "succeeded" });

    expect(rotateSession.mock.calls.map(([input]) => input.operationId)).toEqual(["clear-rejected", "clear-new"]);
    expect(stores.orchestratorClear.get("clear-rejected")).toMatchObject({ state: "rejected", detail: "historical rejection" });
  });

  it("blocks new Prompt admission while a rotation dispatch is in flight", async () => {
    stores = setupStore("orchestrator");
    let finishRotation!: (value: Awaited<ReturnType<NonNullable<HerdrPort["rotateSession"]>>>) => void;
    const rotation = new Promise<Awaited<ReturnType<NonNullable<HerdrPort["rotateSession"]>>>>((resolve) => { finishRotation = resolve; });
    const rotateSession = vi.fn(() => rotation);
    const workflow = createWorkflow(stores, runtimeObservation(), { rotateSession });

    const clearing = workflow.request(request());
    await vi.waitFor(() => expect(rotateSession).toHaveBeenCalledOnce());
    expect(() => stores!.promptAcceptance.enqueuePrompt({
      id: "prompt-race", bindingId: "binding-1", larkMessageId: "message-race", actorOpenId: "user-1", body: "must wait", parentPromptId: null
    })).toThrow("rotation is in progress");
    finishRotation({ outcome: "rotated", receipt: {
      operationId: "clear-1", paneId: "w-herdr:p1", terminalId: "terminal-1", oldSession: nativeSession("session-1"), newSession: nativeSession("session-2")
    } });
    await expect(clearing).resolves.toMatchObject({ state: "succeeded" });
    expect(stores.promptAcceptance.enqueuePrompt({
      id: "prompt-after", bindingId: "binding-1", larkMessageId: "message-after", actorOpenId: "user-1", body: "new work", parentPromptId: null
    }).prompt).toMatchObject({ sessionEpoch: 2 });
  });

  it("rejects a stale runtime sequence after acceptance without calling Core", async () => {
    stores = setupStore("orchestrator");
    const observeRuntime = vi.fn()
      .mockResolvedValueOnce(runtimeObservation())
      .mockResolvedValueOnce(runtimeObservation({ stateChangeSeq: 18 }));
    const rotateSession = vi.fn();
    const workflow = createWorkflow(stores, runtimeObservation(), { observeRuntime, rotateSession });

    await expect(workflow.request(request())).resolves.toMatchObject({ state: "rejected", detail: expect.stringContaining("fence changed") });
    expect(rotateSession).not.toHaveBeenCalled();
    expect(stores.orchestratorClear.getBinding("binding-1")).toMatchObject({ sessionEpoch: 1, agentSessionValue: "session-1" });
  });

  it("leaves an accepted clear recoverable when stop wins during revalidation", async () => {
    stores = setupStore("orchestrator");
    let finishRevalidation!: (observation: RuntimeObservation) => void;
    const revalidation = new Promise<RuntimeObservation>((resolve) => { finishRevalidation = resolve; });
    const observeRuntime = vi.fn()
      .mockResolvedValueOnce(runtimeObservation())
      .mockReturnValueOnce(revalidation);
    const rotateSession = vi.fn(async () => ({ outcome: "rotated" as const, receipt: {
      operationId: "clear-stop-race", paneId: "w-herdr:p1", terminalId: "terminal-1",
      oldSession: nativeSession("session-1"), newSession: nativeSession("session-2")
    } }));
    const workflow = createWorkflow(stores, runtimeObservation(), { observeRuntime, rotateSession });

    const clearing = workflow.request(request("clear-stop-race"));
    await vi.waitFor(() => expect(observeRuntime).toHaveBeenCalledTimes(2));
    const stopping = workflow.stop();
    finishRevalidation(runtimeObservation());
    await stopping;

    await expect(clearing).resolves.toMatchObject({ state: "accepted" });
    expect(stores.orchestratorClear.get("clear-stop-race")).toMatchObject({ state: "accepted" });
    expect(rotateSession).not.toHaveBeenCalled();
  });

  it("snapshots only prior-epoch Answer messages and settles mixed delivery outcomes exactly once", async () => {
    stores = setupStore("orchestrator");
    for (const [id, messageId] of [["prompt-old-1", "answer-old-3"], ["prompt-old-2", "answer-old-1"], ["prompt-old-3", "answer-old-2"]] as const) {
      stores.promptAcceptance.enqueuePrompt({ id, bindingId: "binding-1", larkMessageId: `request-${id}`, actorOpenId: "user-1", body: "work", parentPromptId: null });
      stores.driver.database.prepare("UPDATE prompt_jobs SET state = 'delivered' WHERE id = ?").run(id);
      stores.driver.database.prepare(`INSERT INTO answer_pages(
        prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at
      ) VALUES (?, 0, ?, NULL, ?, 0, 0, 'finished', 'static', 'now', 'now')`).run(id, messageId, `answer-${id}`);
    }
    const wakeOutbound = vi.fn();
    const workflow = createWorkflow(stores, runtimeObservation(), { rotateSession: async () => ({ outcome: "rotated", receipt: {
      operationId: "clear-1", paneId: "w-herdr:p1", terminalId: "terminal-1", oldSession: nativeSession("session-1"), newSession: nativeSession("session-2")
    } }) }, { presentation: cardKitApplicationPresentation, wakeOutbound });

    expect(await workflow.request(request())).toMatchObject({ state: "withdrawing", answerTargetSnapshot: ["answer-old-1", "answer-old-2", "answer-old-3"], answerTargetCount: 3 });
    const replies = (stores.driver as unknown as { listPendingOutboundReplies(): Array<{ id: string; kind: string; rootMessageId: string | null }> }).listPendingOutboundReplies();
    expect(replies.map(({ kind, rootMessageId }) => [kind, rootMessageId])).toEqual([
      ["message_delete", "answer-old-1"], ["message_delete", "answer-old-2"], ["message_delete", "answer-old-3"]
    ]);
    const deleted = stores.driver.claimOutboundReply(replies[0]!.id, null)!;
    expect(stores.outbox.markOutboundReplyDelivered(deleted, "answer-old-1", undefined, undefined, "deleted")).toBe(true);
    const absent = stores.driver.claimOutboundReply(replies[1]!.id, null)!;
    expect(stores.outbox.markOutboundReplyDelivered(absent, "answer-old-2", undefined, undefined, "already_absent")).toBe(true);
    expect(stores.driver.markOutboundReplyFailedWithQuarantine(replies[2]!.id, "withdrawal forbidden", {
      failureClass: "permanent", effectCertainty: "rejected", httpStatus: 403, larkErrorCode: 230099
    })).toMatchObject({ reply: { state: "dead_letter" } });
    expect(stores.orchestratorClear.get("clear-1")).toMatchObject({ state: "partial", withdrawnCount: 1, alreadyAbsentCount: 1, failedCount: 1 });
    await workflow.recover();
    await workflow.recover();
    const results = (stores.driver as unknown as { listPendingOutboundReplies(): Array<{ kind: string; targetRole: string | null; payload: string }> }).listPendingOutboundReplies().filter(({ targetRole }) => targetRole === "operation_result");
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result).toMatchObject({ kind: "card_reply", targetRole: "operation_result" });
    expect(result?.payload).toContain("已撤回 1，已不存在 1，失败 1");
    expect(wakeOutbound).toHaveBeenCalled();
  });
});

function setupStore(kind: "task" | "orchestrator"): TestStoreBundle {
  const stores = createTestStoreBundle();
  stores.driver.createPendingBinding({
    id: "binding-1", kind, gatewayId: "feishu:primary", projectId: "bridge", workspaceId: "w-herdr",
    chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Orchestrator"
  });
  stores.driver.updateBinding("binding-1", {
    state: "active", lifecycle: "active", attachment: "attached", paneId: "w-herdr:p1", paneToken: "orch",
    traexSessionId: "terminal-1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
    agentSessionKind: "id", agentSessionValue: "session-1", lastAgentState: "idle"
  });
  return stores;
}

function createWorkflow(stores: TestStoreBundle, observation: RuntimeObservation, overrides: Partial<HerdrPort> = {}, workflowOptions: Partial<ConstructorParameters<typeof OrchestratorClearWorkflow>[0]> = {}) {
  const herdr = {
    observeRuntime: async () => observation,
    listWorkspaces: async () => [{ workspaceId: "w-herdr", label: "herdr" }],
    supportsSessionRotation: async () => true,
    rotateSession: async () => ({ outcome: "definitely-not-started" as const, operationId: "clear-1", paneId: "w-herdr:p1", reason: "test" }),
    ...overrides
  };
  return new OrchestratorClearWorkflow({ store: stores.orchestratorClear, herdr, launchFor: () => ({ name: "bridge-primary", kind: "traex", args: ["--model", "x"] }), ...workflowOptions });
}

function runtimeObservation(patch: Partial<NonNullable<RuntimeObservation["pane"]>> = {}): RuntimeObservation {
  return { traexProcess: true, composerReady: true, evidenceSource: "structured", pane: {
    paneId: "w-herdr:p1", paneToken: "orch", paneName: "orchestrator", tabId: "w-herdr:t1", terminalId: "terminal-1",
    workspaceId: "w-herdr", cwd: "/repo", label: "orchestrator", agentKind: "traex", agentSession: nativeSession("session-1"),
    activeTurnId: null, outputRevision: 3, stateChangeSeq: 17, steeringCapability: "native", agentState: "idle", foregroundExecutables: ["traex"], ...patch
  } };
}

function nativeSession(value: string) { return { source: "herdr:traex", agent: "traex", kind: "id" as const, value }; }
function request(id = "clear-1") { return { id, idempotencyKey: `clear:${id}`, bindingId: "binding-1", actorOpenId: "user-1", sourceMessageId: `message:${id}`, confirmationId: `confirm:${id}` }; }
