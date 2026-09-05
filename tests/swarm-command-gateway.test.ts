import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SwarmCommandContextResolver } from "../src/coordinator/swarm-command-context-resolver.js";
import { SwarmCommandGateway } from "../src/coordinator/swarm-command-gateway.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

const project = { id: "project", displayName: "Project", spaceName: "space", description: "project", workspaceId: "w1", cwd: "/repo", maxInstances: 4 };
const config = { projects: [project], defaultProjectId: "project", lark: { adminOpenIds: ["admin"] } } as never;
const message = { eventId: "event", messageId: "message", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "admin", text: "", mentionsBot: true, isRootMessage: false };

function setup(activeTurn: () => { promptId: string; paneId: string } | null = () => ({ promptId: "prompt", paneId: "w1:p1" })) {
  const store = new SqliteBindingStore(":memory:");
  store.createPendingBinding({ id: "binding", creatorOpenId: "admin", projectId: "project", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
  store.updateBinding("binding", { paneId: "w1:p1", traexSessionId: "terminal", state: "active", lifecycle: "active", attachment: "attached" });
  const provisioning = { selectProject: vi.fn(async () => undefined), reset: vi.fn(async () => true), attach: vi.fn(async () => true), reattach: vi.fn(async () => undefined), replace: vi.fn(async () => undefined) };
  const operationsQuery = { listSpaces: vi.fn(async () => undefined), listSessions: vi.fn(async () => undefined), listFailures: vi.fn(async () => undefined) };
  const sessionAdministration = { emitStatus: vi.fn(async () => undefined), rename: vi.fn(async () => true), archive: vi.fn(async () => true), resume: vi.fn(async () => true) };
  const modelSelection = { runModel: vi.fn(async () => true) }; const paneControl = { stop: vi.fn(async () => true), steer: vi.fn(async () => true) };
  const paneClosure = { requestPaneClose: vi.fn(async () => true), confirmPaneClose: vi.fn(async () => true) }; const promptRun = {
    awake: vi.fn(async () => ({ outcome: "none", reason: "no_detached_prompt" })),
    skipDetached: vi.fn(() => ({ outcome: "skipped" as const, promptId: "detached-prompt", outboxReserved: true }))
  };
  const worker = { id: "worker", name: "reviewer" }; const instanceControl = { createWorker: vi.fn(async () => ({ status: "created" as const, instance: worker })), inspect: vi.fn(() => ({ instance: worker })) };
  const outbound = { enqueueCard: vi.fn(async () => undefined) }; const resolver = new SwarmCommandContextResolver({ config, store, activeTurn });
  const gateway = new SwarmCommandGateway({ store, resolver, outbound, logger: pino({ enabled: false }), provisioning, operationsQuery, sessionAdministration, modelSelection, paneControl, paneClosure, promptRun, instanceControl } as never);
  return { store, gateway, provisioning, operationsQuery, sessionAdministration, modelSelection, paneControl, paneClosure, promptRun, instanceControl, outbound };
}

describe("SwarmCommandGateway", () => {
  it.each([
    [{ kind: "help" }, "outbound", "enqueueCard"], [{ kind: "projects" }, "provisioning", "selectProject"], [{ kind: "spaces" }, "operationsQuery", "listSpaces"],
    [{ kind: "sessions" }, "operationsQuery", "listSessions"], [{ kind: "failures" }, "operationsQuery", "listFailures"], [{ kind: "status" }, "sessionAdministration", "emitStatus"],
    [{ kind: "model", name: null }, "modelSelection", "runModel"]
  ] as const)("runs query %j without a durable intent", async (command, owner, method) => {
    const fixture = setup(); await fixture.gateway.handle(message, command); expect((fixture[owner] as never)[method]).toHaveBeenCalled();
    expect(fixture.store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get()).toEqual({ count: 0 }); fixture.store.close();
  });

  it("audits a query without creating a command intent", async () => {
    const fixture = setup();
    await fixture.gateway.handle(message, { kind: "status" });
    expect(fixture.store.database.prepare("SELECT action, target, outcome FROM audit_log WHERE action = 'swarm.status'").get()).toEqual({ action: "swarm.status", target: "binding:binding", outcome: "success" });
    expect(fixture.store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get()).toEqual({ count: 0 });
    fixture.store.close();
  });

  it("deduplicates a mutation before invoking its owning handler", async () => {
    const { gateway, store, sessionAdministration } = setup(); const command = { kind: "rename" as const, title: "New title" };
    await gateway.handle(message, command); await gateway.handle(message, command);
    expect(sessionAdministration.rename).toHaveBeenCalledOnce();
    expect(store.database.prepare("SELECT state, attempt_count FROM swarm_command_intents").all()).toEqual([{ state: "succeeded", attempt_count: 1 }]); store.close();
  });

  it.each([
    [{ kind: "new", title: null }, "provisioning", "selectProject"],
    [{ kind: "reset", title: null }, "provisioning", "reset"],
    [{ kind: "attach", spaceName: "space", paneId: "w1:p2" }, "provisioning", "attach"],
    [{ kind: "rename", title: "New title" }, "sessionAdministration", "rename"],
    [{ kind: "close" }, "sessionAdministration", "archive"],
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
    await fixture.gateway.handle({ ...message, messageId: `mutation-${command.kind}` }, command);
    expect((fixture[owner] as never)[method]).toHaveBeenCalled();
    const row = fixture.store.database.prepare("SELECT id FROM swarm_command_intents").get() as { id: string };
    expect(fixture.store.getCommandIntent(row.id)).toMatchObject({ command: { kind: command.kind }, state: "succeeded", attemptCount: 1 });
    fixture.store.close();
  });

  it("skips a durable detached blocker without requiring an in-memory active turn and deduplicates redelivery", async () => {
    const fixture = setup(() => null);
    const skipMessage = { ...message, messageId: "skip-message" };

    await fixture.gateway.handle(skipMessage, { kind: "skip" });
    await fixture.gateway.handle(skipMessage, { kind: "skip" });

    expect(fixture.promptRun.skipDetached).toHaveBeenCalledOnce();
    expect(fixture.promptRun.skipDetached).toHaveBeenCalledWith("binding", 1, "admin", "skip-message", "root");
    expect(fixture.outbound.enqueueCard).toHaveBeenCalledWith("root", "skip:skip-message", expect.any(Object));
    expect(JSON.stringify(fixture.outbound.enqueueCard.mock.calls.at(-1)?.[2])).toMatch(/detached-prompt|结果仍不确定/);
    expect(fixture.store.database.prepare("SELECT state, attempt_count FROM swarm_command_intents").all()).toEqual([{ state: "succeeded", attempt_count: 1 }]);
    fixture.store.close();
  });

  it.each([
    [{ outcome: "none" as const }, "当前没有 detached prompt", "succeeded"],
    [{ outcome: "stale" as const }, "上下文已变化", "rejected"]
  ])("renders detached skip outcome %# without changing another prompt", async (result, expectedText, intentState) => {
    const fixture = setup(() => null);
    fixture.promptRun.skipDetached.mockReturnValueOnce(result);
    await fixture.gateway.handle({ ...message, messageId: `skip-${result.outcome}` }, { kind: "skip" });
    expect(JSON.stringify(fixture.outbound.enqueueCard.mock.calls.at(-1)?.[2])).toContain(expectedText);
    expect(fixture.store.database.prepare("SELECT state FROM swarm_command_intents").get()).toEqual({ state: intentState });
    fixture.store.close();
  });

  it.each([
    [{ kind: "reattach", paneId: "w1:p2" }, "当前会话不处于 orphaned 状态，无需重新连接。"],
    [{ kind: "replace" }, "只有 orphaned 会话可以创建 replacement Pane。"]
  ] as const)("preserves the visible rejection for %j outside orphaned state", async (command, reason) => {
    const { gateway, store, outbound } = setup();
    await gateway.handle({ ...message, messageId: `rejected-${command.kind}` }, command);
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
    await fixture.gateway.handle({ ...message, messageId: `orphaned-${command.kind}` }, command);
    expect(fixture.provisioning[method]).toHaveBeenCalledOnce();
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
    await gateway.handle(message, command);
    await gateway.createWorkerFromCard({ messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} }, "binding", command);
    expect(instanceControl.createWorker).toHaveBeenCalledTimes(2);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get()).toEqual({ count: 2 }); store.close();
  });

  it("deduplicates the same CardKit Worker request but accepts another form submission from the same card", async () => {
    const { gateway, store, instanceControl } = setup();
    const action = { messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} };
    const reviewer = { kind: "worker_create" as const, name: "reviewer", agentKind: "traex" as const, model: null, start: false };
    const tester = { ...reviewer, name: "tester" };
    await gateway.createWorkerFromCard(action, "binding", reviewer);
    await gateway.createWorkerFromCard(action, "binding", reviewer);
    await gateway.createWorkerFromCard(action, "binding", tester);
    expect(instanceControl.createWorker).toHaveBeenCalledTimes(2);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM swarm_command_intents").get()).toEqual({ count: 2 });
    store.close();
  });

  it("reconstructs a durable start-failed Worker result after gateway restart", async () => {
    const fixture = setup();
    const failed = { id: "worker", name: "reviewer" };
    fixture.instanceControl.createWorker.mockResolvedValueOnce({ status: "created-start-failed", instance: failed, error: "runtime unavailable" });
    const action = { messageId: "card", chatId: "chat", operatorOpenId: "admin", value: {} };
    const command = { kind: "worker_create" as const, name: "reviewer", agentKind: "traex" as const, model: null, start: true };
    await expect(fixture.gateway.createWorkerFromCard(action, "binding", command)).resolves.toMatchObject({ status: "created-start-failed", error: "runtime unavailable" });
    const restarted = new SwarmCommandGateway({ store: fixture.store, resolver: new SwarmCommandContextResolver({ config, store: fixture.store, activeTurn: () => null }), outbound: fixture.outbound, logger: pino({ enabled: false }), provisioning: fixture.provisioning, operationsQuery: fixture.operationsQuery, sessionAdministration: fixture.sessionAdministration, modelSelection: fixture.modelSelection, paneControl: fixture.paneControl, paneClosure: fixture.paneClosure, promptRun: fixture.promptRun, instanceControl: fixture.instanceControl } as never);
    await expect(restarted.createWorkerFromCard(action, "binding", command)).resolves.toMatchObject({ status: "created-start-failed", error: "runtime unavailable" });
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

  it("records a throwing handler as uncertain and never replays it", async () => {
    const { gateway, store, sessionAdministration } = setup();
    sessionAdministration.rename.mockRejectedValueOnce(new Error("observer disconnected"));
    await gateway.handle(message, { kind: "rename", title: "New title" });
    const row = store.database.prepare("SELECT id FROM swarm_command_intents").get() as { id: string };
    expect(store.getCommandIntent(row.id)).toMatchObject({ state: "uncertain", outcome: { code: "external_effect_uncertain" } });
    await gateway.recover();
    expect(sessionAdministration.rename).toHaveBeenCalledOnce();
    store.close();
  });

  it("waits for claimed command work during shutdown", async () => {
    const fixture = setup();
    let release!: () => void;
    fixture.sessionAdministration.rename.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    const handling = fixture.gateway.handle(message, { kind: "rename", title: "New title" });
    await vi.waitFor(() => expect(fixture.sessionAdministration.rename).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = fixture.gateway.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([handling, stopping]);
    expect(stopped).toBe(true);
    fixture.store.close();
  });
});
