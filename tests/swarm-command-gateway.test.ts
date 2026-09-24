import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SwarmCommandContextResolver } from "../src/coordinator/swarm-command-context-resolver.js";
import { SwarmCommandGateway } from "../src/coordinator/swarm-command-gateway.js";
import { ProgrammaticWorkerCreation } from "../src/coordinator/programmatic-worker-creation.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { applicationPresentation } from "./helpers/presentation.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";

const project = { id: "project", displayName: "Project", spaceName: "space", description: "project", workspaceId: "w1", cwd: "/repo", maxInstances: 4 };
const config = { projects: [project], defaultProjectId: "project", lark: { adminOpenIds: ["admin"] } } as never;
const message = { eventId: "event", messageId: "message", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "admin", text: "", mentionsBot: true, isRootMessage: false };

function setup(activeTurn: () => { promptId: string; paneId: string } | null = () => ({ promptId: "prompt", paneId: "w1:p1" })) {
  const store = new SqliteBindingStore(":memory:");
  store.createPendingBinding({ id: "binding", creatorOpenId: "admin", projectId: "project", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
  store.updateBinding("binding", { paneId: "w1:p1", traexSessionId: "terminal", state: "active", lifecycle: "active", attachment: "attached" });
  const provisioning = { selectProject: vi.fn(async () => undefined), reset: vi.fn(async () => true), attach: vi.fn(async () => true), reattach: vi.fn(async () => undefined), replace: vi.fn(async () => undefined) };
  const operationsQuery = { listSpaces: vi.fn(async () => undefined), listTopicPanes: vi.fn(async () => undefined), listSessions: vi.fn(async () => undefined), listFailures: vi.fn(async () => undefined) };
  const sessionAdministration = { emitStatus: vi.fn(async () => undefined), rename: vi.fn(async () => true), archive: vi.fn(async () => true), resume: vi.fn(async () => true) };
  const modelSelection = { runModel: vi.fn(async () => true) }; const paneControl = { stop: vi.fn(async () => true), steer: vi.fn(async () => true) };
  const paneClosure = { requestPaneClose: vi.fn(async () => true), confirmPaneClose: vi.fn(async () => true) }; const promptRun = {
    awake: vi.fn(async () => ({ outcome: "none", reason: "no_detached_prompt" })),
    skipDetached: vi.fn(() => ({ outcome: "skipped" as const, promptId: "detached-prompt", outboxReserved: true }))
  };
  const worker = { id: "worker", name: "reviewer", workerSessionGeneration: 1 }; const instanceControl = { createWorker: vi.fn(async () => ({ status: "created" as const, instance: worker })), inspect: vi.fn(() => ({ instance: worker })) };
  const outbound = { enqueueCard: vi.fn(async () => undefined) }; const resolver = new SwarmCommandContextResolver({ config, store, activeTurn });
  const wakeCardContext = vi.fn();
  let gateway!: SwarmCommandGateway;
  const wakeCommand = vi.fn((intentId: string) => { queueMicrotask(() => gateway.wakeAcceptedIntent({ id: intentId })); });
  gateway = new SwarmCommandGateway({ store, primaryPrompts: store, resolver, outbound, logger: pino({ enabled: false }), provisioning, operationsQuery, sessionAdministration, modelSelection, paneControl, paneClosure, promptRun, instanceControl, wakeCardContext, wakeCommand, presentation: applicationPresentation } as never);
  const workerCreation = new ProgrammaticWorkerCreation(gateway, 1_000);
  return { store, gateway, workerCreation, provisioning, operationsQuery, sessionAdministration, modelSelection, paneControl, paneClosure, promptRun, instanceControl, outbound, wakeCardContext, wakeCommand };
}

async function waitForIntentState(store: SqliteBindingStore, state: string): Promise<void> {
  await vi.waitFor(() => expect(store.database.prepare("SELECT state FROM swarm_command_intents").get()).toEqual({ state }));
}
async function handle(gateway: SwarmCommandGateway, inputMessage: typeof message, command: Parameters<SwarmCommandGateway["submit"]>[0]["command"]): Promise<void> {
  await gateway.submit({ source: "literal", message: inputMessage, command });
}

describe("SwarmCommandGateway", () => {
  it("normalizes literal queries and mutations into typed receipts", async () => {
    const fixture = setup();
    await expect(fixture.gateway.submit({ source: "literal", message, command: { kind: "status" } })).resolves.toMatchObject({ outcome: "query-completed", commandKind: "status" });
    let release!: () => void;
    fixture.sessionAdministration.rename.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    await expect(fixture.gateway.submit({ source: "literal", message: { ...message, messageId: "rename-submit" }, command: { kind: "rename", title: "Next" } })).resolves.toMatchObject({ outcome: "accepted", commandKind: "rename", intent: { state: "accepted" } });
    expect(fixture.sessionAdministration.emitStatus).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fixture.sessionAdministration.rename).toHaveBeenCalledOnce());
    release();
    await waitForIntentState(fixture.store, "succeeded");
    fixture.store.close();
  });

  it("returns typed source-equivalent authorization rejections before admission", async () => {
    const fixture = setup();
    const member = { ...message, actorOpenId: "member" };
    await expect(fixture.gateway.submit({ source: "literal", message: member, command: { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false } })).resolves.toMatchObject({ outcome: "rejected", code: "administrator_required" });
    await expect(fixture.gateway.submit({ source: "natural-language", message: member, command: { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false } })).resolves.toMatchObject({ outcome: "rejected", code: "administrator_required" });
    expect(fixture.store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get()).toEqual({ count: 0 });
    fixture.store.close();
  });

  it.each([
    [{ kind: "stop" as const }, "confirmation-required"],
    [{ kind: "skip" as const }, "confirmation-required"],
    [{ kind: "pane_close_confirm" as const, code: "ABC123" }, "confirmation-required"],
    [{ kind: "rename" as const, title: "Next" }, "accepted"]
  ])("applies natural-language risk admission for %j", async (command, outcome) => {
    const fixture = setup();
    await expect(fixture.gateway.submit({ source: "natural-language", message: { ...message, messageId: `nl-${command.kind}` }, command })).resolves.toMatchObject({ outcome });
    const count = fixture.store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get() as { count: number };
    expect(count.count).toBe(outcome === "accepted" ? 1 : 0);
    fixture.store.close();
  });

  it("normalizes CardKit Worker admission without caller-owned lane or replay policy", async () => {
    const fixture = setup();
    const command = { kind: "worker_create" as const, name: "reviewer", agentKind: "traex" as const, model: null, start: false };
    const receipt = await fixture.gateway.submit({ source: "card", action: { messageId: "card-submit", chatId: "chat", operatorOpenId: "admin", value: {} }, bindingId: "binding", command });
    expect(receipt).toMatchObject({ outcome: "accepted", commandKind: "worker_create", intent: { laneKey: "binding:binding", replayPolicy: "reconcilable" } });
    fixture.store.close();
  });

  it.each([
    [{ kind: "help" }, "outbound", "enqueueCard"], [{ kind: "projects" }, "provisioning", "selectProject"], [{ kind: "spaces" }, "operationsQuery", "listSpaces"], [{ kind: "panes" }, "operationsQuery", "listTopicPanes"],
    [{ kind: "sessions", cursor: null }, "operationsQuery", "listSessions"], [{ kind: "failures" }, "operationsQuery", "listFailures"], [{ kind: "status" }, "sessionAdministration", "emitStatus"],
    [{ kind: "model", name: null }, "modelSelection", "runModel"]
  ] as const)("runs query %j without a durable intent", async (command, owner, method) => {
    const fixture = setup(); await handle(fixture.gateway, message, command); expect((fixture[owner] as never)[method]).toHaveBeenCalled();
    expect(fixture.store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get()).toEqual({ count: 0 }); fixture.store.close();
  });

  it("audits a query without creating a command intent", async () => {
    const fixture = setup();
    await handle(fixture.gateway, message, { kind: "status" });
    expect(fixture.store.database.prepare("SELECT action, target, outcome FROM audit_log WHERE action = 'swarm.status'").get()).toEqual({ action: "swarm.status", target: "binding:binding", outcome: "success" });
    expect(fixture.store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get()).toEqual({ count: 0 });
    fixture.store.close();
  });

  it("deduplicates a mutation before invoking its owning handler", async () => {
    const { gateway, store, sessionAdministration } = setup(); const command = { kind: "rename" as const, title: "New title" };
    await handle(gateway, message, command); await handle(gateway, message, command);
    await vi.waitFor(() => expect(sessionAdministration.rename).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.database.prepare("SELECT state, attempt_count FROM swarm_command_intents").all()).toEqual([{ state: "succeeded", attempt_count: 1 }])); store.close();
  });

  it("persists one Primary Worker-thread entry request with the durable create command", async () => {
    const fixture = setup();
    const worker = fixture.store.createWorkerAgentInstance({ id: "worker", projectId: "project", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "binding", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: null }, workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
    fixture.instanceControl.createWorker.mockResolvedValueOnce({ status: "created", instance: worker });
    await handle(fixture.gateway, { ...message, messageId: "worker-entry" }, { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: true });
    await vi.waitFor(() => expect(fixture.wakeCardContext).toHaveBeenCalledOnce());

    expect(fixture.store.database.prepare("SELECT worker_id, worker_session_generation, binding_id, binding_generation, root_message_id, state FROM worker_thread_entry_requests").all())
      .toEqual([{ worker_id: "worker", worker_session_generation: 1, binding_id: "binding", binding_generation: 1, root_message_id: "root", state: "pending" }]);
    fixture.store.close();
  });

  it("creates a Worker from the active Primary tool context and preserves its entry request", async () => {
    const fixture = setup();
    const view = createQueuedRunCard({ promptId: "primary-tool-prompt", bindingId: "binding", title: "Primary", workspaceId: "w1", paneId: "w1:p1", requestText: "coordinate", queuePosition: 1, occurredAt: "2026-09-13T00:00:00.000Z" });
    fixture.store.acceptPrompt({ prompt: { id: "primary-tool-prompt", bindingId: "binding", larkMessageId: "primary-tool-message", actorOpenId: "admin", body: "coordinate" }, view, rootMessageId: "root", answerCard: {} });
    fixture.store.updatePrompt("primary-tool-prompt", "running");
    const worker = fixture.store.createWorkerAgentInstance({ id: "worker-tool", projectId: "project", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "binding", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: null }, workspace: { id: "worker-tool-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
    fixture.instanceControl.createWorker.mockResolvedValueOnce({ status: "created", instance: worker });
    const input = { bindingId: "binding", bindingGeneration: 1, parentPromptId: "primary-tool-prompt", sourceMessageId: "primary-tool-message", rootMessageId: "root", idempotencyKey: "create-reviewer", command: { kind: "worker_create" as const, name: "reviewer", agentKind: "traex" as const, model: null, start: true } };
    await fixture.workerCreation.createWorkerFromPrimaryTool(input);
    await fixture.workerCreation.createWorkerFromPrimaryTool(input);
    expect(fixture.instanceControl.createWorker).toHaveBeenCalledOnce();
    expect(fixture.store.database.prepare("SELECT worker_id, root_message_id, state FROM worker_thread_entry_requests").all()).toEqual([{ worker_id: "worker-tool", root_message_id: "root", state: "pending" }]);
    await expect(fixture.workerCreation.createWorkerFromPrimaryTool({ ...input, sourceMessageId: "forged" })).rejects.toThrow(/active prompt changed/);
    fixture.store.close();
  });

  it.each([
    [{ kind: "new", title: null }, "provisioning", "selectProject"],
    [{ kind: "reset", title: null }, "provisioning", "reset"],
    [{ kind: "attach", spaceName: "space", paneId: "w1:p2" }, "provisioning", "attach"],
    [{ kind: "rename", title: "New title" }, "sessionAdministration", "rename"],
    [{ kind: "close" }, "paneClosure", "requestPaneClose"],
    [{ kind: "pane_close_request" }, "paneClosure", "requestPaneClose"],
    [{ kind: "pane_close_confirm", code: "ABC123" }, "paneClosure", "confirmPaneClose"],
    [{ kind: "resume" }, "sessionAdministration", "resume"],
    [{ kind: "awake" }, "promptRun", "awake"],
    [{ kind: "skip" }, "promptRun", "skipDetached"],
    [{ kind: "stop" }, "paneControl", "stop"],
    [{ kind: "steer", text: "focus" }, "paneControl", "steer"],
    [{ kind: "model", name: "gpt" }, "modelSelection", "runModel"],
    [{ kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false }, "instanceControl", "createWorker"]
  ] as const)("routes mutation %j through a durable intent", async (command, owner, method) => {
    const fixture = setup();
    await handle(fixture.gateway, { ...message, messageId: `mutation-${command.kind}` }, command);
    await vi.waitFor(() => expect((fixture[owner] as never)[method]).toHaveBeenCalled());
    const row = fixture.store.database.prepare("SELECT id FROM swarm_command_intents").get() as { id: string };
    await vi.waitFor(() => expect(fixture.store.getCommandIntent(row.id)).toMatchObject({ command: { kind: command.kind }, state: "succeeded", attemptCount: 1 }));
    fixture.store.close();
  });

  it("skips a durable detached blocker without requiring an in-memory active turn and deduplicates redelivery", async () => {
    const fixture = setup(() => null);
    const skipMessage = { ...message, messageId: "skip-message" };

    await handle(fixture.gateway, skipMessage, { kind: "skip" });
    await handle(fixture.gateway, skipMessage, { kind: "skip" });

    await vi.waitFor(() => expect(fixture.promptRun.skipDetached).toHaveBeenCalledOnce());
    expect(fixture.promptRun.skipDetached).toHaveBeenCalledWith("binding", 1, "admin", "skip-message", "root");
    expect(fixture.outbound.enqueueCard).toHaveBeenCalledWith("root", "skip:skip-message", expect.any(Object));
    expect(JSON.stringify(fixture.outbound.enqueueCard.mock.calls.at(-1)?.[2])).toMatch(/detached-prompt|结果仍不确定/);
    await vi.waitFor(() => expect(fixture.store.database.prepare("SELECT state, attempt_count FROM swarm_command_intents").all()).toEqual([{ state: "succeeded", attempt_count: 1 }]));
    fixture.store.close();
  });

  it.each([
    [{ outcome: "none" as const }, "当前没有 detached prompt", "succeeded"],
    [{ outcome: "stale" as const }, "上下文已变化", "rejected"]
  ])("renders detached skip outcome %# without changing another prompt", async (result, expectedText, intentState) => {
    const fixture = setup(() => null);
    fixture.promptRun.skipDetached.mockReturnValueOnce(result);
    await handle(fixture.gateway, { ...message, messageId: `skip-${result.outcome}` }, { kind: "skip" });
    await waitForIntentState(fixture.store, intentState);
    expect(JSON.stringify(fixture.outbound.enqueueCard.mock.calls.at(-1)?.[2])).toContain(expectedText);
    expect(fixture.store.database.prepare("SELECT state FROM swarm_command_intents").get()).toEqual({ state: intentState });
    fixture.store.close();
  });

  it.each([
    [{ kind: "reattach", paneId: "w1:p2" }, "当前会话不处于 orphaned 状态，无需重新连接。"],
    [{ kind: "replace" }, "只有 orphaned 会话可以创建 replacement Pane。"]
  ] as const)("preserves the visible rejection for %j outside orphaned state", async (command, reason) => {
    const { gateway, store, outbound } = setup();
    await handle(gateway, { ...message, messageId: `rejected-${command.kind}` }, command);
    await waitForIntentState(store, "rejected");
    expect(outbound.enqueueCard).toHaveBeenCalledWith("root", expect.stringContaining(`:${command.kind}`), expect.objectContaining({ body: expect.any(Object) }));
    expect(JSON.stringify(outbound.enqueueCard.mock.calls[0]?.[2])).toContain(reason);
    const row = store.database.prepare("SELECT id FROM swarm_command_intents").get() as { id: string };
    expect(store.getCommandIntent(row.id)).toMatchObject({ command: { kind: command.kind }, state: "rejected" });
    store.close();
  });

  it.each([
    { kind: "reattach" as const, command: { kind: "reattach" as const, paneId: "w1:p2" }, method: "reattach" as const },
    { kind: "replace" as const, command: { kind: "replace" as const }, method: "replace" as const }
  ])("routes successful orphaned $kind through its durable handler", async ({ command, method }) => {
    const fixture = setup();
    fixture.store.updateBinding("binding", { state: "orphaned", attachment: "orphaned" });
    await handle(fixture.gateway, { ...message, messageId: `orphaned-${command.kind}` }, command);
    await vi.waitFor(() => expect(fixture.provisioning[method]).toHaveBeenCalledOnce());
    const row = fixture.store.database.prepare("SELECT id FROM swarm_command_intents").get() as { id: string };
    expect(fixture.store.getCommandIntent(row.id)).toMatchObject({ command: { kind: command.kind }, state: "succeeded" });
    fixture.store.close();
  });

  it.each([
    ["generation", { generation: 2 }],
    ["pane", { paneId: "w1:replacement" }],
    ["terminal", { traexSessionId: "replacement-terminal" }],
    ["native session", { agentSessionSource: "herdr:codex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "replacement-native" }]
  ] as const)("rejects an accepted command after the Primary %s changes", async (_dimension, change) => {
    const fixture = setup();
    const resolved = new SwarmCommandContextResolver({ config, store: fixture.store, activeTurn: () => null }).resolve(message, { kind: "rename", title: "New title" });
    if (resolved.outcome !== "resolved") throw new Error("context");
    fixture.store.acceptCommandIntent({ id: "stale", idempotencyKey: "stale-key", laneKey: resolved.laneKey, command: { kind: "rename", title: "New title" }, context: resolved.context, replayPolicy: "safe-before-effect", acceptedAt: "2026-09-05T00:00:00.000Z" });
    fixture.store.updateBinding("binding", change);
    await fixture.gateway.recover();
    expect(fixture.sessionAdministration.rename).not.toHaveBeenCalled();
    expect(fixture.store.getCommandIntent("stale")).toMatchObject({ state: "rejected", outcome: { code: "stale_context" } });
    fixture.store.close();
  });

  it("rejects an accepted active-turn command after the turn changes", async () => {
    let promptId = "prompt";
    const fixture = setup(() => ({ promptId, paneId: "w1:p1" }));
    const resolved = new SwarmCommandContextResolver({ config, store: fixture.store, activeTurn: () => ({ promptId, paneId: "w1:p1" }) }).resolve(message, { kind: "stop" });
    if (resolved.outcome !== "resolved") throw new Error("context");
    fixture.store.acceptCommandIntent({ id: "stale-turn", idempotencyKey: "stale-turn-key", laneKey: resolved.laneKey, command: { kind: "stop" }, context: resolved.context, replayPolicy: "non-replayable", acceptedAt: "2026-09-05T00:00:00.000Z" });
    promptId = "replacement-prompt";
    await fixture.gateway.recover();
    expect(fixture.paneControl.stop).not.toHaveBeenCalled();
    expect(fixture.store.getCommandIntent("stale-turn")).toMatchObject({ state: "rejected", outcome: { code: "stale_context" } });
    fixture.store.close();
  });

  it("routes text and CardKit Worker creation through the same durable handler", async () => {
    const { gateway, store, instanceControl } = setup(); const command = { kind: "worker_create" as const, name: "reviewer", agentKind: "traex" as const, model: null, start: false };
    await handle(gateway, message, command);
    const workerCreation = new ProgrammaticWorkerCreation(gateway, 1_000);
    await workerCreation.createWorkerFromCard({ messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} }, "binding", command);
    expect(instanceControl.createWorker).toHaveBeenCalledTimes(2);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get()).toEqual({ count: 2 }); store.close();
  });

  it("deduplicates the same CardKit Worker request but accepts another form submission from the same card", async () => {
    const { workerCreation, store, instanceControl } = setup();
    const action = { messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} };
    const reviewer = { kind: "worker_create" as const, name: "reviewer", agentKind: "traex" as const, model: null, start: false };
    const tester = { ...reviewer, name: "tester" };
    await workerCreation.createWorkerFromCard(action, "binding", reviewer);
    await workerCreation.createWorkerFromCard(action, "binding", reviewer);
    await workerCreation.createWorkerFromCard(action, "binding", tester);
    expect(instanceControl.createWorker).toHaveBeenCalledTimes(2);
    expect(instanceControl.inspect).toHaveBeenCalledTimes(3);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get()).toEqual({ count: 2 });
    store.close();
  });

  it("reconstructs a durable start-failed Worker result after gateway restart", async () => {
    const fixture = setup();
    const failed = { id: "worker", name: "reviewer", workerSessionGeneration: 1 };
    fixture.instanceControl.createWorker.mockResolvedValueOnce({ status: "created-start-failed", instance: failed, error: "runtime unavailable" });
    const action = { messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} };
    const command = { kind: "worker_create" as const, name: "reviewer", agentKind: "traex" as const, model: null, start: true };
    await expect(fixture.workerCreation.createWorkerFromCard(action, "binding", command)).resolves.toMatchObject({ status: "created-start-failed", error: "runtime unavailable" });
    const restarted = new SwarmCommandGateway({ store: fixture.store, resolver: new SwarmCommandContextResolver({ config, store: fixture.store, activeTurn: () => null }), outbound: fixture.outbound, logger: pino({ enabled: false }), provisioning: fixture.provisioning, operationsQuery: fixture.operationsQuery, sessionAdministration: fixture.sessionAdministration, modelSelection: fixture.modelSelection, paneControl: fixture.paneControl, paneClosure: fixture.paneClosure, promptRun: fixture.promptRun, instanceControl: fixture.instanceControl, presentation: applicationPresentation } as never);
    await expect(new ProgrammaticWorkerCreation(restarted, 1_000).createWorkerFromCard(action, "binding", command)).resolves.toMatchObject({ status: "created-start-failed", error: "runtime unavailable" });
    expect(fixture.instanceControl.createWorker).toHaveBeenCalledOnce();
    fixture.store.close();
  });

  it("never replays an uncertain command during recovery", async () => {
    const { gateway, store, sessionAdministration } = setup();
    const resolved = new SwarmCommandContextResolver({ config, store, activeTurn: () => null }).resolve(message, { kind: "rename", title: "New title" });
    if (resolved.outcome !== "resolved") throw new Error("context");
    store.acceptCommandIntent({ id: "interrupted", idempotencyKey: "key", laneKey: resolved.laneKey, command: { kind: "rename", title: "New title" }, context: resolved.context, replayPolicy: "safe-before-effect", acceptedAt: "2026-09-05T00:00:00.000Z" }); store.claimNextCommandIntent();
    await gateway.recover(); expect(sessionAdministration.rename).not.toHaveBeenCalled(); expect(store.getCommandIntent("interrupted")).toMatchObject({ state: "uncertain" }); store.close();
  });

  it("executes an accepted command during startup recovery", async () => {
    const fixture = setup();
    const resolved = new SwarmCommandContextResolver({ config, store: fixture.store, activeTurn: () => null }).resolve(message, { kind: "rename", title: "Recovered title" });
    if (resolved.outcome !== "resolved") throw new Error("context");
    fixture.store.acceptCommandIntent({ id: "accepted", idempotencyKey: "accepted-key", laneKey: resolved.laneKey, command: { kind: "rename", title: "Recovered title" }, context: resolved.context, replayPolicy: "safe-before-effect", acceptedAt: "2026-09-05T00:00:00.000Z" });
    await fixture.gateway.recover();
    expect(fixture.sessionAdministration.rename).toHaveBeenCalledOnce();
    expect(fixture.store.getCommandIntent("accepted")).toMatchObject({ state: "succeeded", attemptCount: 1 });
    fixture.store.close();
  });

  it("converges an accepted command from the durable scan when its wake hint is missed", async () => {
    const fixture = setup();
    fixture.wakeCommand.mockImplementationOnce(() => undefined);

    await expect(fixture.gateway.submit({ source: "literal", message: { ...message, messageId: "missed-wake" }, command: { kind: "rename", title: "Recovered by scan" } }))
      .resolves.toMatchObject({ outcome: "accepted", intent: { state: "accepted" } });
    expect(fixture.sessionAdministration.rename).not.toHaveBeenCalled();

    fixture.gateway.start(5);
    await vi.waitFor(() => expect(fixture.sessionAdministration.rename).toHaveBeenCalledOnce());
    await waitForIntentState(fixture.store, "succeeded");
    await fixture.gateway.stop();
    fixture.store.close();
  });

  it("records a throwing handler as uncertain and never replays it", async () => {
    const { gateway, store, sessionAdministration } = setup();
    sessionAdministration.rename.mockRejectedValueOnce(new Error("observer disconnected"));
    await handle(gateway, message, { kind: "rename", title: "New title" });
    const row = store.database.prepare("SELECT id FROM swarm_command_intents").get() as { id: string };
    await vi.waitFor(() => expect(store.getCommandIntent(row.id)).toMatchObject({ state: "uncertain", outcome: { code: "external_effect_uncertain" } }));
    await gateway.recover();
    expect(sessionAdministration.rename).toHaveBeenCalledOnce();
    store.close();
  });

  it("waits for claimed command work during shutdown", async () => {
    const fixture = setup();
    let release!: () => void;
    fixture.sessionAdministration.rename.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    const handling = handle(fixture.gateway, message, { kind: "rename", title: "New title" });
    await vi.waitFor(() => expect(fixture.sessionAdministration.rename).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = fixture.gateway.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([handling, stopping]);
    expect(stopped).toBe(true);
    await expect(fixture.gateway.submit({ source: "literal", message: { ...message, messageId: "after-stop" }, command: { kind: "rename", title: "Too late" } })).resolves.toMatchObject({ outcome: "rejected", code: "shutting_down" });
    fixture.store.close();
  });
});
