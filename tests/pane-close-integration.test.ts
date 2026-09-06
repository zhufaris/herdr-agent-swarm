import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import type { AgentState } from "../src/domain/types.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { primaryPresentation } from "./helpers/presentation.js";

describe("Lark pane close", () => {
  it("requires confirmation before closing the bound idle pane", async () => {
    const fixture = await setup("idle");

    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));

    expect(fixture.closePane).not.toHaveBeenCalled();
    const cardText = JSON.stringify(fixture.cards.at(-1));
    const confirmation = /\/swarm pane close confirm ([A-Z0-9]{6})/.exec(cardText);
    expect(confirmation?.[1]).toBeTruthy();

    await fixture.coordinator.handleMessage(message(2, `/swarm pane close confirm ${confirmation![1]}`));

    expect(fixture.closePane).toHaveBeenCalledTimes(1);
    expect(fixture.closePane).toHaveBeenCalledWith("w1:p1");
    expect(fixture.store.getBinding(fixture.bindingId)).toMatchObject({ lifecycle: "closed", state: "archived", attachment: "unattached" });
    expect(fixture.store.database.prepare("SELECT state FROM pane_close_requests ORDER BY created_at DESC LIMIT 1").get()).toEqual({ state: "succeeded" });
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("已关闭");
    await fixture.close();
  });

  it("allows a done pane to close after confirmation", async () => {
    const fixture = await setup("done");
    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));
    const code = /\/swarm pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;

    await fixture.coordinator.handleMessage(message(2, `/swarm pane close confirm ${code}`));

    expect(fixture.closePane).toHaveBeenCalledWith("w1:p1");
    expect(fixture.store.getBinding(fixture.bindingId)).toMatchObject({ lifecycle: "closed", state: "archived" });
    await fixture.close();
  });

  it("cascades an exact parent pane close to its Worker pane without touching siblings", async () => {
    const fixture = await setup("idle");
    const child = fixture.store.createWorkerAgentInstance({
      id: "child", projectId: "default", name: "child", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: fixture.bindingId, paneId: "w1:p1", nativeSessionId: "term-1" }, workspace: { id: "ws-child", kind: "shared-read-only", cwd: "/repo/child", branch: null, baseCommit: "base" }
    }, 4).instance;
    const active = fixture.store.attachAgentInstanceRuntime({ instanceId: child.id, expectedGeneration: child.generation, herdrWorkspaceId: "w1", paneId: "w1:child", nativeSessionId: "term-child" })!;
    fixture.store.acceptInstanceTurn({ id: "child-queued", idempotencyKey: "child-queued", actor: { kind: "human", userId: "user" }, projectId: "default", instanceId: active.id, instanceGeneration: active.generation, kind: "turn", text: "work" });
    const sibling = fixture.store.createWorkerAgentInstance({
      id: "sibling", projectId: "default", name: "sibling", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "other-binding", paneId: "w1:other", nativeSessionId: null }, workspace: { id: "ws-sibling", kind: "shared-read-only", cwd: "/repo/sibling", branch: null, baseCommit: "base" }
    }, 4).instance;

    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));
    const code = /\/swarm pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;
    await fixture.coordinator.handleMessage(message(2, `/swarm pane close confirm ${code}`));

    expect(fixture.closePane.mock.calls.map(([paneId]) => paneId)).toEqual(["w1:child", "w1:p1"]);
    expect(fixture.store.getAgentInstance(child.id)).toMatchObject({ workerSessionLifecycle: "terminated", runtimeRef: null });
    expect(fixture.store.getInstanceTurn("child-queued")).toMatchObject({ state: "cancelled" });
    expect(fixture.store.getAgentInstance(sibling.id)).toMatchObject({ workerSessionLifecycle: "active", desiredState: "running" });
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("1 个 Worker Pane");
    await fixture.close();
  });

  it("reports a partial result when a Worker pane close is uncertain", async () => {
    const fixture = await setup("idle");
    const child = fixture.store.createWorkerAgentInstance({
      id: "child-uncertain", projectId: "default", name: "child-uncertain", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: fixture.bindingId, paneId: "w1:p1", nativeSessionId: "term-1" }, workspace: { id: "ws-child-uncertain", kind: "shared-read-only", cwd: "/repo/child-uncertain", branch: null, baseCommit: "base" }
    }, 4).instance;
    fixture.store.attachAgentInstanceRuntime({ instanceId: child.id, expectedGeneration: child.generation, herdrWorkspaceId: "w1", paneId: "w1:child-uncertain", nativeSessionId: "term-child" });
    fixture.closePane.mockRejectedValueOnce(new Error("child close result unknown"));
    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));
    const code = /\/swarm pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;

    await fixture.coordinator.handleMessage(message(2, `/swarm pane close confirm ${code}`));

    expect(fixture.closePane.mock.calls.map(([paneId]) => paneId)).toEqual(["w1:child-uncertain", "w1:p1"]);
    expect(fixture.store.database.prepare("SELECT state FROM worker_pane_close_steps WHERE worker_id = 'child-uncertain'").get()).toEqual({ state: "uncertain" });
    const result = JSON.stringify(fixture.cards.at(-1));
    expect(result).toContain("共 1 个");
    expect(result).toContain("0 个已关闭");
    expect(result).toContain("1 个关闭结果不确定");
    expect(result).not.toContain("已级联关闭 1 个 Worker Pane");
    await fixture.close();
  });

  it("observes unresolved child close steps after restart without reissuing closePane", async () => {
    const fixture = await setup("idle");
    const child = fixture.store.createWorkerAgentInstance({
      id: "child-recovery", projectId: "default", name: "child-recovery", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: fixture.bindingId, paneId: "w1:p1", nativeSessionId: "term-1" }, workspace: { id: "ws-child-recovery", kind: "shared-read-only", cwd: "/repo/child-recovery", branch: null, baseCommit: "base" }
    }, 4).instance;
    const active = fixture.store.attachAgentInstanceRuntime({ instanceId: child.id, expectedGeneration: child.generation, herdrWorkspaceId: "w1", paneId: "w1:child-recovery", nativeSessionId: null })!;
    fixture.store.createPaneCloseRequest({ id: "close-recovery", bindingId: fixture.bindingId, paneId: "w1:p1", actorOpenId: "user", codeHash: "hash", expiresAt: "2999-01-01T00:00:00.000Z" });
    const consumed = fixture.store.consumePaneCloseRequest({ bindingId: fixture.bindingId, paneId: "w1:p1", actorOpenId: "user", codeHash: "hash", now: "2026-09-04T00:00:00.000Z" });
    if (consumed.outcome !== "consumed") throw new Error("fixture close request was not consumed");
    fixture.store.beginWorkerPaneCloseCascade({ operationId: consumed.operationId, bindingId: fixture.bindingId, paneId: "w1:p1", reason: "closing" });
    fixture.setPanePresent(false);

    await fixture.coordinator.start();

    expect(fixture.closePane).not.toHaveBeenCalled();
    expect(fixture.store.database.prepare("SELECT state FROM worker_pane_close_steps WHERE operation_id = 'close-recovery'").get()).toEqual({ state: "succeeded" });
    expect(fixture.store.getAgentInstance(active.id)).toMatchObject({ workerSessionLifecycle: "terminated" });
    await fixture.close();
  });

  it.each(["working", "blocked", "unknown"] as const)("rejects a close request while pane state is %s", async (state) => {
    const fixture = await setup(state);
    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));
    expect(fixture.closePane).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("不能关闭");
    await fixture.close();
  });

  it("rejects the wrong actor and code without consuming a valid confirmation", async () => {
    const fixture = await setup("idle");
    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));
    const code = /\/swarm pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;

    await fixture.coordinator.handleMessage({ ...message(2, `/swarm pane close confirm ${code}`), actorOpenId: "other" });
    await fixture.coordinator.handleMessage(message(3, "/swarm pane close confirm WRONG1"));
    expect(fixture.closePane).not.toHaveBeenCalled();

    await fixture.coordinator.handleMessage(message(4, `/swarm pane close confirm ${code}`));
    expect(fixture.closePane).toHaveBeenCalledTimes(1);
    await fixture.close();
  });

  it("rechecks pane state at confirmation time", async () => {
    const fixture = await setup("idle");
    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));
    const code = /\/swarm pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;
    fixture.setAgentState("working");

    await fixture.coordinator.handleMessage(message(2, `/swarm pane close confirm ${code}`));

    expect(fixture.closePane).not.toHaveBeenCalled();
    expect(fixture.store.getBinding(fixture.bindingId)).toMatchObject({ lifecycle: "active", state: "active" });

    fixture.setAgentState("idle");
    await fixture.coordinator.handleMessage(message(3, `/swarm pane close confirm ${code}`));
    expect(fixture.closePane).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("没有待确认");
    await fixture.close();
  });

  it("fails closed when a persisted terminal identity cannot be verified", async () => {
    const fixture = await setup("idle");
    fixture.setTerminalId(null);

    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));

    expect(fixture.closePane).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("identity");
    await fixture.close();
  });

  it("does not close the captured pane when the binding changes after confirmation is consumed", async () => {
    const fixture = await setup("idle");
    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));
    const code = /\/swarm pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;
    const consume = fixture.store.consumePaneCloseRequest.bind(fixture.store);
    fixture.store.consumePaneCloseRequest = (input) => {
      const result = consume(input);
      if (result.outcome === "consumed") fixture.store.updateBinding(fixture.bindingId, { paneId: "w1:p2" });
      return result;
    };

    await fixture.coordinator.handleMessage(message(2, `/swarm pane close confirm ${code}`));

    expect(fixture.closePane).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("identity");
    await fixture.close();
  });

  it("marks the binding orphaned when the pane disappears before confirmation", async () => {
    const fixture = await setup("idle");
    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));
    const code = /\/swarm pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;
    fixture.setPanePresent(false);

    await fixture.coordinator.handleMessage(message(2, `/swarm pane close confirm ${code}`));

    expect(fixture.closePane).not.toHaveBeenCalled();
    expect(fixture.store.getBinding(fixture.bindingId)).toMatchObject({ attachment: "orphaned", state: "orphaned" });
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("已不存在");
    await fixture.close();
  });

  it("leaves the binding active when pane closure cannot be verified", async () => {
    const fixture = await setup("idle", true);
    await fixture.coordinator.handleMessage(message(1, "/swarm pane close"));
    const code = /\/swarm pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;

    await fixture.coordinator.handleMessage(message(2, `/swarm pane close confirm ${code}`));

    expect(fixture.closePane).toHaveBeenCalledTimes(1);
    expect(fixture.store.getBinding(fixture.bindingId)).toMatchObject({ lifecycle: "active", state: "active" });
    expect(fixture.store.database.prepare("SELECT state FROM pane_close_requests ORDER BY created_at DESC LIMIT 1").get()).toEqual({ state: "uncertain" });
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("关闭失败");
    await fixture.close();
  });
});

async function setup(initialAgentState: AgentState, failClose = false) {
  const cards: object[] = [];
  let panePresent = true;
  let agentState = initialAgentState;
  let terminalId: string | null = "term-1";
  const pane = () => ({ paneId: "w1:p1", terminalId, workspaceId: "w1", cwd: "/repo", label: "task", agentState, foregroundExecutables: ["traex"] });
  const closePane = vi.fn(async () => { if (failClose) throw new Error("pane remained present"); panePresent = false; });
  const lark: LarkPort = {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
    async replyText() { return { messageId: "text-1" }; },
    async replyCard(_root, card) { cards.push(card); return { messageId: `card-${cards.length}` }; },
    async updateCard() {}
  };
  const herdr: HerdrPort = {
    async assertWorkspace() {}, async listPanes() { return panePresent ? [pane()] : []; }, async getPane() { return panePresent ? pane() : null; },
    async createPane() { throw new Error("unused"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {}, closePane
  };
  const store = new SqliteBindingStore(":memory:");
  const bus = new BridgeEventBus();
  const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
  const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
  const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
  await coordinator.start();
  const bindingId = store.findBindingByPane("w1:p1")!.id;
  return { cards, closePane, coordinator, store, bindingId, setAgentState(state: AgentState) { agentState = state; }, setTerminalId(value: string | null) { terminalId = value; }, setPanePresent(value: boolean) { panePresent = value; }, async close() { await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close(); } };
}

function message(index: number, text: string) {
  return { eventId: `event-${index}`, messageId: `message-${index}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false };
}

function config(): BridgeConfig {
  return { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default", description: "Test", workspaceId: "w1", cwd: "/repo", spaceName: "datasage" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 };
}
