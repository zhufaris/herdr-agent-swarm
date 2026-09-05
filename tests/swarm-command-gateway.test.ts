import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SwarmCommandContextResolver } from "../src/coordinator/swarm-command-context-resolver.js";
import { SwarmCommandGateway } from "../src/coordinator/swarm-command-gateway.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

const project = { id: "project", displayName: "Project", spaceName: "space", description: "project", workspaceId: "w1", cwd: "/repo", maxInstances: 4 };
const config = { projects: [project], defaultProjectId: "project", lark: { adminOpenIds: ["admin"] } } as never;
const message = { eventId: "event", messageId: "message", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "admin", text: "", mentionsBot: true, isRootMessage: false };

function setup() {
  const store = new SqliteBindingStore(":memory:");
  store.createPendingBinding({ id: "binding", creatorOpenId: "admin", projectId: "project", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
  store.updateBinding("binding", { paneId: "w1:p1", traexSessionId: "terminal", state: "active", lifecycle: "active", attachment: "attached" });
  const provisioning = { selectProject: vi.fn(async () => undefined), reset: vi.fn(async () => true), attach: vi.fn(async () => true), reattach: vi.fn(async () => undefined), replace: vi.fn(async () => undefined) };
  const operationsQuery = { listSpaces: vi.fn(async () => undefined), listSessions: vi.fn(async () => undefined), listFailures: vi.fn(async () => undefined) };
  const sessionAdministration = { emitStatus: vi.fn(async () => undefined), rename: vi.fn(async () => true), archive: vi.fn(async () => true), resume: vi.fn(async () => true) };
  const modelSelection = { runModel: vi.fn(async () => true) }; const paneControl = { stop: vi.fn(async () => true), steer: vi.fn(async () => true) };
  const paneClosure = { requestPaneClose: vi.fn(async () => true), confirmPaneClose: vi.fn(async () => true) }; const promptRun = { awake: vi.fn(async () => ({ outcome: "none", reason: "no_detached_prompt" })) };
  const worker = { id: "worker", name: "reviewer" }; const instanceControl = { createWorker: vi.fn(async () => ({ status: "created" as const, instance: worker })), inspect: vi.fn(() => ({ instance: worker })) };
  const outbound = { enqueueCard: vi.fn(async () => undefined) }; const resolver = new SwarmCommandContextResolver({ config, store, activeTurn: () => ({ promptId: "prompt", paneId: "w1:p1" }) });
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
});
