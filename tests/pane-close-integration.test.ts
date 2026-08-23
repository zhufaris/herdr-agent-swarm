import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import type { AgentState } from "../src/domain/types.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardProjector } from "../src/events/card-projector.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("Lark pane close", () => {
  it("requires confirmation before closing the bound idle pane", async () => {
    const fixture = await setup("idle");

    await fixture.coordinator.handleMessage(message(1, "/herdr pane close"));

    expect(fixture.closePane).not.toHaveBeenCalled();
    const cardText = JSON.stringify(fixture.cards.at(-1));
    const confirmation = /\/herdr pane close confirm ([A-Z0-9]{6})/.exec(cardText);
    expect(confirmation?.[1]).toBeTruthy();

    await fixture.coordinator.handleMessage(message(2, `/herdr pane close confirm ${confirmation![1]}`));

    expect(fixture.closePane).toHaveBeenCalledTimes(1);
    expect(fixture.closePane).toHaveBeenCalledWith("w1:p1");
    expect(fixture.store.getBinding(fixture.bindingId)).toMatchObject({ lifecycle: "closed", state: "archived", attachment: "unattached" });
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("已关闭");
    await fixture.close();
  });

  it.each(["working", "blocked", "unknown"] as const)("rejects a close request while pane state is %s", async (state) => {
    const fixture = await setup(state);
    await fixture.coordinator.handleMessage(message(1, "/herdr pane close"));
    expect(fixture.closePane).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("不能关闭");
    await fixture.close();
  });

  it("rejects the wrong actor and code without consuming a valid confirmation", async () => {
    const fixture = await setup("idle");
    await fixture.coordinator.handleMessage(message(1, "/herdr pane close"));
    const code = /\/herdr pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;

    await fixture.coordinator.handleMessage({ ...message(2, `/herdr pane close confirm ${code}`), actorOpenId: "other" });
    await fixture.coordinator.handleMessage(message(3, "/herdr pane close confirm WRONG1"));
    expect(fixture.closePane).not.toHaveBeenCalled();

    await fixture.coordinator.handleMessage(message(4, `/herdr pane close confirm ${code}`));
    expect(fixture.closePane).toHaveBeenCalledTimes(1);
    await fixture.close();
  });

  it("rechecks pane state at confirmation time", async () => {
    const fixture = await setup("idle");
    await fixture.coordinator.handleMessage(message(1, "/herdr pane close"));
    const code = /\/herdr pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;
    fixture.setAgentState("working");

    await fixture.coordinator.handleMessage(message(2, `/herdr pane close confirm ${code}`));

    expect(fixture.closePane).not.toHaveBeenCalled();
    expect(fixture.store.getBinding(fixture.bindingId)).toMatchObject({ lifecycle: "active", state: "active" });
    await fixture.close();
  });

  it("leaves the binding active when pane closure cannot be verified", async () => {
    const fixture = await setup("idle", true);
    await fixture.coordinator.handleMessage(message(1, "/herdr pane close"));
    const code = /\/herdr pane close confirm ([A-Z0-9]{6})/.exec(JSON.stringify(fixture.cards.at(-1)))![1]!;

    await fixture.coordinator.handleMessage(message(2, `/herdr pane close confirm ${code}`));

    expect(fixture.closePane).toHaveBeenCalledTimes(1);
    expect(fixture.store.getBinding(fixture.bindingId)).toMatchObject({ lifecycle: "active", state: "active" });
    expect(JSON.stringify(fixture.cards.at(-1))).toContain("关闭失败");
    await fixture.close();
  });
});

async function setup(initialAgentState: AgentState, failClose = false) {
  const cards: object[] = [];
  let panePresent = true;
  let agentState = initialAgentState;
  const pane = () => ({ paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState, foregroundExecutables: ["traex"] });
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
    async createPane() { throw new Error("unused"); }, async startTraex() {}, async runPrompt() { return "done"; },
    async readOutput() { return ""; }, async renamePane() {}, closePane
  };
  const store = new SqliteBindingStore(":memory:");
  const bus = new BridgeEventBus();
  const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
  const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
  const coordinator = new SyncCoordinator(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
  await coordinator.start();
  const bindingId = store.findBindingByPane("w1:p1")!.id;
  return { cards, closePane, coordinator, store, bindingId, setAgentState(state: AgentState) { agentState = state; }, async close() { await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close(); } };
}

function message(index: number, text: string) {
  return { eventId: `event-${index}`, messageId: `message-${index}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false };
}

function config(): BridgeConfig {
  return { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default", description: "Test", workspaceId: "w1", cwd: "/repo", spaceName: "datasage" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 };
}
