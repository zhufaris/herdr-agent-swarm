import { createHash } from "node:crypto";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { primaryPresentation } from "./helpers/presentation.js";

describe("attach existing pane command", () => {
  it("resolves a unique exact pane label and stores the stable pane ID", async () => {
    let exposePane = false;
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const replyCards: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, createTopic,
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { replyCards.push(card); return { messageId: "reply-1" }; }, async updateCard() {}
    };
    const pane = { paneId: "w5:p3G", workspaceId: "w5", cwd: "/different/cwd", label: "tidy", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return exposePane ? [pane] : []; }, async getPane() { return null; },
      async createPane() { throw new Error("unexpected createPane"); }, async startTraex() { throw new Error("unexpected startTraex"); },
      async runPrompt() { throw new Error("unexpected runPrompt"); }, async renamePane() { throw new Error("unexpected renamePane"); }
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    exposePane = true;

    await coordinator.handleMessage(command(1, "tidy"));

    expect(store.findBindingByPane("w5:p3G")).toMatchObject({ projectId: "analytics", paneId: "w5:p3G", state: "active" });
    expect(store.loadTopicView(store.findBindingByPane("w5:p3G")!.id)).toMatchObject({ primaryToolsAvailable: false, primaryToolsNotice: expect.stringMatching(/reset.*replace/i) });
    expect(createTopic).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replyCards.at(-1))).toContain("发送话题入口");
    expect(JSON.stringify(replyCards.at(-1))).toContain('\"action\":\"open_project_thread\"');
    expect(JSON.stringify(replyCards.at(-1))).not.toContain("openMessageId");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it.each(["cum7", "CUM7"])("resolves canonical four-character Pane token %s", async (reference) => {
    let exposePane = false;
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const pane = { paneId: "w5:p40", workspaceId: "w5", cwd: "/repo", label: "task-cum7", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, createTopic, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
    const herdr: HerdrPort = { async assertWorkspace() {}, async listPanes() { return exposePane ? [pane] : []; }, async getPane() { return null; }, async createPane() { throw new Error("unused"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} };
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start(); exposePane = true;

    await coordinator.handleMessage(command(1, reference));

    expect(store.findBindingByPane("w5:p40")).toMatchObject({ state: "active" });
    expect(createTopic).toHaveBeenCalledTimes(1);
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("attaches an eligible pane without mutating or starting it and is idempotent", async () => {
    let exposePane = false;
    let onAction: Parameters<LarkPort["start"]>[1];
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const shareThread = vi.fn(async () => ({ messageId: "forwarded-topic" }));
    const replyCards: object[] = [];
    const lark: LarkPort = {
      async start(_onMessage, callback) { onAction = callback; }, async stop() {}, isReady: () => true, createTopic, shareThread,
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { replyCards.push(card); return { messageId: `reply-${replyCards.length}` }; },
      async updateCard() {}
    };
    const createPane = vi.fn<HerdrPort["createPane"]>();
    const startTraex = vi.fn<HerdrPort["startTraex"]>();
    const runPrompt = vi.fn<HerdrPort["runPrompt"]>();
    const renamePane = vi.fn<HerdrPort["renamePane"]>();
    const pane = { paneId: "w5:p3G", workspaceId: "w5", cwd: "/different/cwd", label: "Existing pane", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes(workspaceId) { return exposePane && workspaceId === "w5" ? [pane] : []; },
      async getPane() { return null; }, createPane, startTraex, runPrompt, renamePane
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    exposePane = true;

    await coordinator.handleMessage(command(1));
    expect(store.findBindingByPane("w5:p3G")).toMatchObject({ projectId: "analytics", topicId: "topic-attached", rootMessageId: "root-attached", state: "active" });
    expect(store.loadTopicView(store.findBindingByPane("w5:p3G")!.id)).toMatchObject({ primaryToolsAvailable: false, primaryToolsNotice: expect.stringMatching(/reset.*replace/i) });
    expect(createTopic).toHaveBeenCalledTimes(1);
    expect(createPane).not.toHaveBeenCalled();
    expect(startTraex).not.toHaveBeenCalled();
    expect(runPrompt).not.toHaveBeenCalled();
    expect(renamePane).not.toHaveBeenCalled();

    await coordinator.handleMessage(command(2));
    expect(createTopic).toHaveBeenCalledTimes(1);
    expect(store.listBindings()).toHaveLength(1);
    expect(JSON.stringify(replyCards.at(-1))).toContain("已经连接");
    expect(JSON.stringify(replyCards.at(-1))).toContain("w5:p3G");
    expect(JSON.stringify(replyCards.at(-1))).toContain("发送话题入口");
    const response = JSON.stringify(replyCards.at(-1));
    expect(response).toContain('\"action\":\"open_project_thread\"');
    expect(response).not.toContain("openMessageId");
    expect(response).not.toContain("client/chat/open");
    expect(store.findBindingByPane("w5:p3G")).toMatchObject({ statusMessageId: "root-attached" });

    const button = findActionButton(replyCards.at(-1)!, "open_project_thread");
    await onAction!({ messageId: "reply-2", chatId: "chat", operatorOpenId: "user-1", value: button.value });
    expect(shareThread).toHaveBeenCalledWith("topic-attached", { messageId: "reply-2", chatId: "chat", sourceRootMessageId: "root-attached" });

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("preserves managed Primary tools when attaching the authoritative active pane again", async () => {
    const capability = "managed-capability";
    const createPane = vi.fn<HerdrPort["createPane"]>();
    const startTraex = vi.fn<HerdrPort["startTraex"]>();
    const runPrompt = vi.fn<HerdrPort["runPrompt"]>();
    const renamePane = vi.fn<HerdrPort["renamePane"]>();
    const pane = { paneId: "w5:p3G", workspaceId: "w5", cwd: "/repo", label: "Managed pane", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { throw new Error("unexpected createTopic"); },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard() { return { messageId: "reply-1" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [pane]; },
      async getPane() { return pane; }, createPane, startTraex, runPrompt, renamePane
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "managed", projectId: "analytics", workspaceId: "w5", chatId: "chat", topicId: "topic-managed", rootMessageId: "root-managed", title: "managed" });
    store.updateBinding("managed", { paneId: pane.paneId, state: "active", lifecycle: "active", attachment: "attached" });
    expect(store.setBindingPrimaryToolCapability({ bindingId: "managed", expectedGeneration: 1, capabilityHash: createHash("sha256").update(capability).digest("hex") })).toBe(true);
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage(command(1));

    expect(store.getBinding("managed")).toMatchObject({ paneId: pane.paneId, generation: 1, state: "active" });
    expect(store.hasBindingPrimaryToolCapability("managed", 1)).toBe(true);
    expect(store.verifyBindingPrimaryToolCapability({ bindingId: "managed", expectedGeneration: 1, capabilityHash: createHash("sha256").update(capability).digest("hex") })).toBe(true);
    expect(store.loadTopicView("managed")).toMatchObject({ primaryToolsAvailable: true, primaryToolsNotice: null });
    expect(createPane).not.toHaveBeenCalled();
    expect(startTraex).not.toHaveBeenCalled();
    expect(runPrompt).not.toHaveBeenCalled();
    expect(renamePane).not.toHaveBeenCalled();

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("recovers a same-chat orphaned binding without replaying queued work", async () => {
    let exposePane = false;
    const createTopic = vi.fn(async () => ({ topicId: "unused-topic", rootMessageId: "unused-root" }));
    const runPrompt = vi.fn<HerdrPort["runPrompt"]>();
    const replyCards: object[] = [];
    const pane = { paneId: "w5:p20", terminalId: "term-main", workspaceId: "w5", cwd: "/repo", label: "main", agentState: "done" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, createTopic,
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { replyCards.push(card); return { messageId: `reply-${replyCards.length}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return exposePane ? [pane] : []; }, async getPane() { return pane; },
      async observeRuntime() { return { pane, traexProcess: true, composerReady: true, evidenceSource: "structured" }; },
      async createPane() { throw new Error("unexpected createPane"); }, async startTraex() { throw new Error("unexpected startTraex"); },
      runPrompt, async renamePane() { throw new Error("unexpected renamePane"); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "orphaned", projectId: "analytics", workspaceId: "w5", chatId: "chat", topicId: "old-topic", rootMessageId: "old-root", title: "datasage_semantic_knowledge / main" });
    store.updateBinding("orphaned", { paneId: pane.paneId, state: "active", lifecycle: "active", attachment: "attached" });
    store.transitionBinding("orphaned", { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 2 });
    store.enqueuePrompt({ id: "queued", bindingId: "orphaned", larkMessageId: "queued-message", actorOpenId: "user", body: "must not replay" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    exposePane = true;

    await coordinator.handleMessage(command(1, "main"));

    expect(store.getBinding("orphaned")).toMatchObject({ lifecycle: "archived", attachment: "attached", state: "archived", paneId: "w5:p20", traexSessionId: "term-main" });
    expect(store.listBindings()).toHaveLength(1);
    expect(createTopic).not.toHaveBeenCalled();
    expect(runPrompt).not.toHaveBeenCalled();
    expect(JSON.stringify(replyCards.at(-1))).toContain("发送话题入口");
    expect(JSON.stringify(replyCards.at(-1))).toContain("/swarm resume");
    expect(JSON.stringify(replyCards.at(-1))).not.toContain("已绑定到其他会话");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("requires an explicitly configured exact space name", async () => {
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const replyCards: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, createTopic,
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { replyCards.push(card); return { messageId: `reply-${replyCards.length}` }; },
      async updateCard() {}
    };
    const pane = { paneId: "w5:p3G", workspaceId: "w5", cwd: "/different/cwd", label: "Existing pane", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes(workspaceId) { return workspaceId === "w5" ? [pane] : []; },
      async getPane() { return null; }, async createPane() { throw new Error("unexpected createPane"); },
      async startTraex() { throw new Error("unexpected startTraex"); }, async runPrompt() { throw new Error("unexpected runPrompt"); }, async renamePane() { throw new Error("unexpected renamePane"); }
    };
    const missingExplicitSpace = config();
    missingExplicitSpace.projects[0]!.spaceName = undefined;
    missingExplicitSpace.projects[0]!.cwd = "/repo/datasage_semantic_knowledge";
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(missingExplicitSpace, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage(command(1));

    expect(store.findBindingByPane("w5:p3G")).toBeNull();
    expect(createTopic).not.toHaveBeenCalled();
    expect(JSON.stringify(replyCards.at(-1))).toContain("未找到空间");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("rejects an ambiguous pane label and lists candidate ids", async () => {
    let exposePanes = false; const cards: object[] = [];
    const panes = ["w5:p1", "w5:p2"].map((paneId) => ({ paneId, workspaceId: "w5", cwd: "/repo", label: "tidy", agentState: "idle" as const, foregroundExecutables: ["traex"] }));
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); }, async replyText() { return { messageId: "text" }; }, async replyCard(_root, card) { cards.push(card); return { messageId: "card" }; }, async updateCard() {} };
    const herdr: HerdrPort = { async assertWorkspace() {}, async listPanes() { return exposePanes ? panes : []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} };
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start(); exposePanes = true;

    await coordinator.handleMessage({ ...command(1), text: "/swarm attach datasage_semantic_knowledge tidy" });

    expect(store.listBindings()).toEqual([]);
    expect(JSON.stringify(cards.at(-1))).toContain("w5:p1, w5:p2");
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("rejects an ambiguous canonical Pane token and lists candidate ids", async () => {
    let exposePanes = false; const cards: object[] = [];
    const panes = [
      { paneId: "w5:p1", workspaceId: "w5", cwd: "/repo", label: "task-bb1j", agentState: "idle" as const, foregroundExecutables: ["traex"] },
      { paneId: "w5:p2", workspaceId: "w5", cwd: "/repo", label: "lark_bb1j", agentState: "idle" as const, foregroundExecutables: ["traex"] }
    ];
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); }, async replyText() { return { messageId: "text" }; }, async replyCard(_root, card) { cards.push(card); return { messageId: "card" }; }, async updateCard() {} };
    const herdr: HerdrPort = { async assertWorkspace() {}, async listPanes() { return exposePanes ? panes : []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} };
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start(); exposePanes = true;

    await coordinator.handleMessage(command(1, "bb1j"));

    expect(store.listBindings()).toEqual([]);
    expect(JSON.stringify(cards.at(-1))).toContain("w5:p1, w5:p2");
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("prefers an exact pane ID over a matching pane label", async () => {
    let exposePanes = false;
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const panes = [
      { paneId: "w5:p3G", workspaceId: "w5", cwd: "/different/id", label: "primary", agentState: "idle" as const, foregroundExecutables: ["traex"] },
      { paneId: "w5:p4H", workspaceId: "w5", cwd: "/different/label", label: "w5:p3G", agentState: "idle" as const, foregroundExecutables: ["traex"] }
    ];
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, createTopic, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
    const herdr: HerdrPort = { async assertWorkspace() {}, async listPanes() { return exposePanes ? panes : []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} };
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start(); exposePanes = true;

    await coordinator.handleMessage(command(1, "w5:p3G"));

    expect(store.findBindingByPane("w5:p3G")).toMatchObject({ state: "active" });
    expect(store.findBindingByPane("w5:p4H")).toBeNull();
    expect(createTopic).toHaveBeenCalledTimes(1);
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("does not expose another group's topic link", async () => {
    let exposePane = false;
    const cards: object[] = [];
    const pane = { paneId: "w5:p3G", workspaceId: "w5", cwd: "/different/cwd", label: "tidy", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); }, async replyText() { return { messageId: "text" }; }, async replyCard(_root, card) { cards.push(card); return { messageId: "card" }; }, async updateCard() {} };
    const herdr: HerdrPort = { async assertWorkspace() {}, async listPanes() { return exposePane ? [pane] : []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "other-binding", projectId: "analytics", workspaceId: "w5", chatId: "other-chat", topicId: "secret-topic", rootMessageId: "secret-root", title: "secret" });
    store.updateBinding("other-binding", { paneId: "w5:p3G", state: "active" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start(); exposePane = true;

    await coordinator.handleMessage(command(1, "tidy"));

    const response = JSON.stringify(cards.at(-1));
    expect(response).toContain("已绑定到其他会话");
    expect(response).not.toContain("打开项目话题");
    expect(response).not.toContain("secret-root");
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("rejects a pane that does not belong to the selected project's workspace", async () => {
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const replyCards: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, createTopic,
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { replyCards.push(card); return { messageId: `reply-${replyCards.length}` }; }, async updateCard() {}
    };
    const wrongWorkspacePane = { paneId: "w5:p3G", workspaceId: "w9", cwd: "/repo", label: "Wrong workspace", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [wrongWorkspacePane]; }, async getPane() { return null; },
      async createPane() { throw new Error("unexpected createPane"); }, async startTraex() { throw new Error("unexpected startTraex"); },
      async runPrompt() { throw new Error("unexpected runPrompt"); }, async renamePane() { throw new Error("unexpected renamePane"); }
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage(command(1));

    expect(store.findBindingByPane("w5:p3G")).toBeNull();
    expect(createTopic).not.toHaveBeenCalled();
    expect(JSON.stringify(replyCards.at(-1))).toContain("未找到 Pane");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it.each([
    { name: "an ambiguous space", projects: [config().projects[0]!, { ...config().projects[0]!, id: "analytics-copy", workspaceId: "w6", cwd: "/copy" }], panes: [], expected: "对应多个项目" },
    { name: "a missing pane", projects: config().projects, panes: [], expected: "未找到 Pane" },
    { name: "a pane without TraeX", projects: config().projects, panes: [{ paneId: "w5:p3G", workspaceId: "w5", cwd: "/repo", label: "Shell", agentState: "idle" as const, foregroundExecutables: ["bash"] }], expected: "没有运行 TraeX" }
  ])("rejects $name before creating a binding", async ({ projects, panes, expected }) => {
    let exposePanes = false;
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const replyCards: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, createTopic, async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { replyCards.push(card); return { messageId: `reply-${replyCards.length}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return exposePanes ? panes : []; }, async getPane() { return null; },
      async createPane() { throw new Error("unexpected createPane"); }, async startTraex() { throw new Error("unexpected startTraex"); },
      async runPrompt() { throw new Error("unexpected runPrompt"); }, async renamePane() { throw new Error("unexpected renamePane"); }
    };
    const testConfig = config();
    testConfig.projects = projects;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(testConfig, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    exposePanes = true;

    await coordinator.handleMessage(command(1));

    expect(store.listBindings()).toHaveLength(0);
    expect(createTopic).not.toHaveBeenCalled();
    expect(JSON.stringify(replyCards.at(-1))).toContain(expected);

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });
});

function config(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] },
    herdr: { workspaceId: "w5", workspaceCwd: "/repo", executable: "herdr" },
    projects: [{ id: "analytics", displayName: "Analytics", spaceName: "datasage_semantic_knowledge", description: "Data project", workspaceId: "w5", cwd: "/repo" }],
    defaultProjectId: "analytics", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:",
    http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}

function command(index: number, pane = "w5:p3G") {
  return { eventId: `event-${index}`, messageId: `message-${index}`, chatId: "chat", topicId: null, rootMessageId: `message-${index}`, actorOpenId: "user", text: `/swarm attach datasage_semantic_knowledge ${pane}`, mentionsBot: true, isRootMessage: true };
}

function findActionButton(card: object, action: string): { value: unknown } {
  const elements = (card as { body: { elements: Array<{ behaviors?: Array<{ type?: string; value?: { action?: string } }> }> } }).body.elements;
  const button = elements.find((element) => element.behaviors?.some((behavior) => behavior.type === "callback" && behavior.value?.action === action));
  if (!button) throw new Error(`Missing action button: ${action}`);
  return { value: button.behaviors!.find((behavior) => behavior.type === "callback")!.value };
}
