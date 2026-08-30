import pino from "pino";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { SessionAdministrationWorkflow } from "../src/coordinator/session-administration-workflow.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { PrimaryToolGateway } from "../src/runtime/primary-tool-gateway.js";

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";

describe("pane/thread lifecycle integration", () => {
  it("commits queued cancellation before FIFO events and wakes outbound work once", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    for (const id of ["p1", "p2"]) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: "start" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "user", body: id }, view, rootMessageId: "root", answerCard: {} });
    }
    const bus = new BridgeEventBus(); const observed: Array<{ promptId: string; occurredAt: string }> = [];
    bus.onBridgeEvent("assert-durable-cancellation", (event) => {
      if (event.type !== "PromptCancelled") return;
      expect(store.getPrompt(event.payload.promptId)).toMatchObject({ state: "cancelled", observationState: "completed" });
      expect(store.loadRunCard(event.payload.promptId)).toMatchObject({ phase: "failed", notice: event.payload.reason, updatedAt: event.occurredAt });
      observed.push({ promptId: event.payload.promptId, occurredAt: event.occurredAt });
    });
    const wake = vi.fn(() => {
      expect(store.getBinding("b1")).toMatchObject({ lifecycle: "archived", state: "archived" });
      expect(store.listPendingOutboundReplies()).toContainEqual(expect.objectContaining({ bindingId: "b1", targetRole: "session_status", kind: "card_update" }));
    }); const workflow = new SessionAdministrationWorkflow({
      config: config(), store, herdr: {} as never, lifecycleEvents: bus, outbound: { enqueueCard: vi.fn() }, outboundWork: { wake }, scheduler: { wake: vi.fn() }, isBindingBusy: () => false
    });

    await workflow.archive(message(1, "/swarm close"), store.getBinding("b1"));

    expect(observed.map(({ promptId }) => promptId)).toEqual(["p1", "p2"]);
    expect(new Set(observed.map(({ occurredAt }) => occurredAt)).size).toBe(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.getBinding("b1")).toMatchObject({ lifecycle: "archived", state: "archived" });
    store.close();
  });

  it("does not publish, wake, transition, or audit when queued cancellation rolls back", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active" });
    vi.spyOn(store, "cancelQueuedPromptsWithProjection").mockImplementation(() => { throw new Error("cancel failed"); });
    const transition = vi.spyOn(store, "transitionBinding"); const audit = vi.spyOn(store, "audit");
    const publish = vi.fn(); const wake = vi.fn(); const workflow = new SessionAdministrationWorkflow({
      config: config(), store, herdr: {} as never, lifecycleEvents: { publish }, outbound: { enqueueCard: vi.fn() }, outboundWork: { wake }, scheduler: { wake: vi.fn() }, isBindingBusy: () => false
    });

    await expect(workflow.archive(message(1, "/swarm close"), store.getBinding("b1"))).rejects.toThrow("cancel failed");

    expect(publish).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled(); expect(transition).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
    expect(store.getBinding("b1")).toMatchObject({ lifecycle: "active", state: "active" });
    store.close();
  });

  it("persists the post-start native identity when replacing an orphaned pane", async () => {
    const createdPane = { paneId: "w1:new", terminalId: null, workspaceId: "w1", cwd: "/repo", label: "replacement", agentState: "unknown" as const, foregroundExecutables: [] };
    const startedPane = {
      ...createdPane,
      terminalId: "new-terminal",
      agentState: "idle" as const,
      foregroundExecutables: ["traex"],
      agentSession: { source: "traex", agent: "traex", kind: "id" as const, value: "native-session-1" }
    };
    let started = false;
    let createdOptions: Parameters<HerdrPort["createPane"]>[2];
    let startedArgs: string[] | undefined;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async observeRuntime(id) { return { pane: id === startedPane.paneId && started ? startedPane : null, traexProcess: started, composerReady: started, evidenceSource: started ? "structured" : "none" }; },
      async createPane(_workspaceId, _cwd, options) { createdOptions = options; return createdPane; }, async startTraex(_paneId, _executable, args) { started = true; startedArgs = args; },
      async runPrompt() { return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "orphaned", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Repo / old" });
    store.updateBinding("orphaned", { paneId: "w1:old", traexSessionId: "old-terminal", statusMessageId: "root", state: "orphaned", lifecycle: "active", attachment: "orphaned", lastAgentState: "unknown" });
    const active = runtime(store, herdr, lark);
    await active.coordinator.start();

    await active.coordinator.handleMessage({ ...message(0, "/swarm replace"), mentionsBot: true });

    expect(store.getBinding("orphaned")).toMatchObject({
      paneId: "w1:new", traexSessionId: "new-terminal", generation: 2, attachment: "attached",
      agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "native-session-1"
    });
    expect(createdOptions).toMatchObject({ bindingId: "orphaned", generation: 2, projectId: "repo", environment: { SWARM_PRIMARY_CAPABILITY: "test-orphaned-2" } });
    expect(startedArgs).toEqual(primaryToolArgs("orphaned", 2));
    expect(store.hasBindingPrimaryToolCapability("orphaned", 2)).toBe(true);
    await active.coordinator.stop(); await active.projector.stop(); await active.publisher.stop(); store.close();
  });

  it("closes an idle retired pane only after /swarm reset activates its replacement", async () => {
    const oldPane = { paneId: "w1:old", terminalId: "old-terminal", workspaceId: "w1", cwd: "/repo", label: "old", agentState: "done" as const, foregroundExecutables: ["traex"] };
    const newPane = { paneId: "w1:new", terminalId: "new-terminal", workspaceId: "w1", cwd: "/repo", label: "new", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    let oldClosed = false;
    const closePane = vi.fn(async () => { oldClosed = true; });
    const createdTitles: string[] = [];
    let createdOptions: Parameters<HerdrPort["createPane"]>[2];
    let startedArgs: string[] | undefined;
    let replacementCreated = false;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return replacementCreated ? [oldPane, newPane] : [oldPane]; }, async getPane(id) { return id === oldPane.paneId ? oldPane : replacementCreated && id === newPane.paneId ? newPane : null; },
      async observeRuntime(id) { const pane = id === oldPane.paneId && !oldClosed ? oldPane : replacementCreated && id === newPane.paneId ? newPane : null; return { pane, traexProcess: Boolean(pane), composerReady: pane?.agentState === "idle", evidenceSource: pane ? "structured" : "none" }; },
      async createPane(_workspaceId, _cwd, options) { replacementCreated = true; createdTitles.push(options?.title ?? ""); createdOptions = options; return newPane; }, async startTraex(_paneId, _executable, args) { startedArgs = args; }, async runPrompt() { return "done"; }, async renamePane() {}, closePane
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "old", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Repo / old" });
    store.updateBinding("old", { paneId: oldPane.paneId, traexSessionId: oldPane.terminalId, statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "done" });
    const active = runtime(store, herdr, lark);
    await active.coordinator.start();

    await active.coordinator.handleMessage({ ...message(1, "/swarm reset fresh"), mentionsBot: true });

    await vi.waitFor(() => expect(store.findBindingByLarkScope("topic", "root")?.paneId).toBe(newPane.paneId));
    await vi.waitFor(() => expect(store.getBinding("old")?.lifecycle).toBe("closed"));
    expect(closePane).toHaveBeenCalledWith(oldPane.paneId);
    expect(createdTitles).toEqual(["fresh"]);
    const replacementId = store.findBindingByLarkScope("topic", "root")!.id;
    expect(createdOptions).toMatchObject({ bindingId: replacementId, generation: 1, projectId: "repo", environment: { SWARM_PRIMARY_CAPABILITY: `test-${replacementId}-1` } });
    expect(startedArgs).toEqual(primaryToolArgs(replacementId, 1));
    expect(store.hasBindingPrimaryToolCapability(replacementId, 1)).toBe(true);
    expect(store.findBindingByLarkScope("topic", "root")?.title).toBe("repo / fresh");
    expect(store.getBinding("old")).toMatchObject({ lifecycle: "closed", attachment: "unattached" });
    expect(store.listRetiredPaneCleanupOperations(["succeeded"])).toMatchObject([{ oldBindingId: "old", replacementBindingId: expect.any(String), paneId: oldPane.paneId, state: "succeeded" }]);
    await active.coordinator.stop(); await active.projector.stop(); await active.publisher.stop(); store.close();
  });

  it("leaves the old pane untouched when replacement provisioning fails", async () => {
    const oldPane = { paneId: "w1:old", terminalId: "old-terminal", workspaceId: "w1", cwd: "/repo", label: "old", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const closePane = vi.fn(async () => undefined);
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [oldPane]; }, async getPane(id) { return id === oldPane.paneId ? oldPane : null; },
      async createPane() { throw new Error("new pane creation failed"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {}, closePane
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "old", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Repo / old" });
    store.updateBinding("old", { paneId: oldPane.paneId, traexSessionId: oldPane.terminalId, statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const active = runtime(store, herdr, lark);
    await active.coordinator.start();

    await active.coordinator.handleMessage({ ...message(1, "/swarm reset fresh"), mentionsBot: true });

    expect(closePane).not.toHaveBeenCalled();
    expect(store.getBinding("old")).toMatchObject({ lifecycle: "active", state: "active", paneId: oldPane.paneId });
    expect(store.findBindingByLarkScope("topic", "root")).toMatchObject({ id: "old", state: "active" });
    await active.coordinator.stop(); await active.projector.stop(); await active.publisher.stop(); store.close();
  });

  it("resets a degraded unregistered TraeX binding without writing to or closing the old pane", async () => {
    const oldPane = { paneId: "w1:old", terminalId: "old-terminal", workspaceId: "w1", cwd: "/repo", label: "old", agentKind: null, agentState: "unknown" as const, foregroundExecutables: ["traex"] };
    const newPane = { paneId: "w1:new", terminalId: "new-terminal", workspaceId: "w1", cwd: "/repo", label: "new", agentKind: "codex" as const, agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const runPrompt = vi.fn(async () => "done");
    const closePane = vi.fn(async () => undefined);
    let replacementCreated = false;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("/swarm reset must reuse the existing topic"); },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return replacementCreated ? [oldPane, newPane] : [oldPane]; }, async getPane(id) { return id === oldPane.paneId ? oldPane : replacementCreated && id === newPane.paneId ? newPane : null; },
      async observeRuntime(id) {
        const pane = id === oldPane.paneId ? oldPane : replacementCreated && id === newPane.paneId ? newPane : null;
        return { pane, traexProcess: Boolean(pane), composerReady: pane?.agentKind === "codex" && pane.agentState === "idle", evidenceSource: pane ? "structured" : "none" };
      },
      async createPane() { replacementCreated = true; return newPane; }, async startTraex() {}, runPrompt, async renamePane() {}, closePane
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "old", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Repo / old" });
    store.updateBinding("old", { paneId: oldPane.paneId, traexSessionId: oldPane.terminalId, statusMessageId: "root", state: "active", lifecycle: "active", attachment: "degraded", lastAgentState: "unknown" });
    const active = runtime(store, herdr, lark);
    await active.coordinator.start();

    await active.coordinator.handleMessage({ ...message(1, "/swarm reset recover agent"), mentionsBot: true });

    await vi.waitFor(() => expect(store.findBindingByLarkScope("topic", "root")?.paneId).toBe(newPane.paneId));
    expect(store.findBindingByLarkScope("topic", "root")).toMatchObject({ attachment: "attached", lifecycle: "active", lastAgentState: "idle", paneId: newPane.paneId });
    expect(store.getBinding("old")).toMatchObject({ lifecycle: "archived", attachment: "degraded", paneId: oldPane.paneId });
    expect(runPrompt).not.toHaveBeenCalled();
    expect(closePane).not.toHaveBeenCalled();
    await active.coordinator.stop(); await active.projector.stop(); await active.publisher.stop(); store.close();
  });

  it("resets a working topic into a new pane without stopping or delivering the old session", async () => {
    const submitted: string[] = [];
    const created: string[] = [];
    let oldObserverAborted = false;
    const oldPane = { paneId: "w1:old", terminalId: "old-terminal", workspaceId: "w1", cwd: "/repo", label: "old", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const newPane = { paneId: "w1:new", terminalId: "new-terminal", workspaceId: "w1", cwd: "/repo", label: "new", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { throw new Error("/swarm reset must not create another Lark topic"); },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async replyStreamingCard() { return { messageId: `card-${Math.random()}`, cardId: `cardkit-${Math.random()}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [oldPane]; }, async getPane(id) { return id === oldPane.paneId ? oldPane : id === newPane.paneId ? newPane : null; },
      async observeRuntime(id) { const pane = id === oldPane.paneId ? oldPane : id === newPane.paneId ? newPane : null; return { pane, traexProcess: Boolean(pane), composerReady: pane?.agentState === "idle", evidenceSource: pane ? "structured" : "none" }; },
      async createPane(_workspaceId, _cwd, options) { created.push(options?.title ?? ""); return newPane; }, async startTraex() {},
      async runPrompt(_paneId, text, _timeout, _observation, signal, onDispatched) {
        submitted.push(text); await onDispatched?.();
        await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => { oldObserverAborted = true; reject(new Error("observer detached")); }, { once: true }));
        return "done";
      }, async renamePane() {}, async closePane() { throw new Error("must not close a pane with an active prompt"); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "old", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Repo / old" });
    store.updateBinding("old", { paneId: oldPane.paneId, traexSessionId: oldPane.terminalId, statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const activeRuntime = runtime(store, herdr, lark);
    await activeRuntime.coordinator.start();

    await activeRuntime.coordinator.handleMessage({ ...message(1, "old request"), mentionsBot: true });
    await vi.waitFor(() => expect(submitted).toEqual(["old request"]));
    await activeRuntime.coordinator.handleMessage({ ...message(2, "queued old request") });
    await activeRuntime.coordinator.handleMessage({ ...message(3, "/swarm reset fresh session"), mentionsBot: true });

    await vi.waitFor(() => expect(store.findBindingByLarkScope("topic", "root")?.paneId).toBe(newPane.paneId));
    const retired = store.getBinding("old")!;
    const replacement = store.findBindingByLarkScope("topic", "root")!;
    expect(retired).toMatchObject({ id: "old", lifecycle: "archived", topicId: null, retiredTopicId: "topic", paneId: oldPane.paneId });
    expect(replacement).toMatchObject({ lifecycle: "active", topicId: "topic", rootMessageId: "root", paneId: newPane.paneId });
    expect(created).toHaveLength(1);
    expect(created[0]).toBe("fresh session");
    expect(replacement.title).toBe(`repo / ${created[0]}`);
    expect(oldObserverAborted).toBe(true);
    expect(store.database.prepare("SELECT state FROM prompt_jobs WHERE lark_message_id = 'm2'").get()).toEqual({ state: "cancelled" });
    expect(store.database.prepare("SELECT state, observation_state FROM prompt_jobs WHERE lark_message_id = 'm1'").get()).toEqual({ state: "running", observation_state: "detached" });

    await activeRuntime.coordinator.stop(); await activeRuntime.projector.stop(); await activeRuntime.publisher.stop(); store.close();
  });

  it("keeps Primary tools unavailable when attaching a caller-selected failed-reset pane with a stale capability row", async () => {
    const directory = await mkdtemp(join(tmpdir(), "failed-reset-tools-"));
    const pane = { paneId: "w1:survived", terminalId: "term-reset", workspaceId: "w1", cwd: "/repo", label: "survived", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); }, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [pane]; }, async getPane(id) { return id === pane.paneId ? pane : null; },
      async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "failed-reset", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Repo / fresh" });
    const staleCapability = "a".repeat(64);
    store.setBindingPrimaryToolCapability({ bindingId: "failed-reset", expectedGeneration: 1, capabilityHash: createHash("sha256").update(staleCapability).digest("hex") });
    store.updateBinding("failed-reset", { paneId: pane.paneId, state: "failed" });
    const activeRuntime = runtime(store, herdr, lark);
    await activeRuntime.coordinator.start();

    await activeRuntime.coordinator.handleMessage({ ...message(4, "/swarm attach repo w1:survived"), mentionsBot: true });

    expect(store.getBinding("failed-reset")).toMatchObject({ state: "active", lifecycle: "active", attachment: "attached", paneId: pane.paneId, traexSessionId: pane.terminalId });
    expect(store.loadTopicView("failed-reset")).toMatchObject({ primaryToolsAvailable: false, primaryToolsNotice: expect.stringMatching(/reset.*replace/i) });
    const socketPath = join(directory, "primary-tools.sock");
    const gateway = new PrimaryToolGateway(socketPath, process.execPath, [], store, {} as never, pino({ enabled: false }));
    await gateway.start();
    await expect(callGateway(socketPath, { bindingId: "failed-reset", generation: 1, capability: staleCapability, tool: "listInstances", arguments: {} })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid or stale/) });
    await gateway.stop();
    await activeRuntime.coordinator.stop(); await activeRuntime.projector.stop(); await activeRuntime.publisher.stop(); store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("drains the active turn, cancels queued work, then archives without closing the pane", async () => {
    let finish!: () => void;
    const activeTurn = new Promise<void>((resolve) => { finish = resolve; });
    const submitted: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text) { submitted.push(text); await activeTurn; return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage(message(1, "first"));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    await coordinator.handleMessage(message(2, "second"));
    await coordinator.handleMessage({ ...message(3, "/swarm close"), mentionsBot: true });

    expect(store.listBindings()[0]).toMatchObject({ lifecycle: "draining", state: "active" });
    expect(store.getOperationalSummary().prompts).toMatchObject({ running: 1, cancelled: 1 });
    finish();
    await vi.waitFor(() => expect(store.listBindings()[0]).toMatchObject({ lifecycle: "archived", state: "archived" }));
    expect(submitted).toHaveLength(1);

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("bounds shutdown, cancels only the active waiter, and leaves queued work durable", async () => {
    const submitted: string[] = [];
    const warnings: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text, _timeout, _observation, signal, onDispatched) {
        submitted.push(text);
        await onDispatched?.();
        await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Bridge shutdown interrupted prompt wait; resend the Lark message to retry")), { once: true }));
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const logger = { info: vi.fn(), warn: (value: object) => warnings.push(value), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), silent: vi.fn(), level: "silent", child: () => logger } as unknown as ReturnType<typeof pino>;
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 10);
    await coordinator.start();

    await coordinator.handleMessage(message(20, "active"));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    await coordinator.handleMessage(message(21, "queued"));
    await coordinator.stop();

    expect(submitted).toHaveLength(1);
    expect(store.getOperationalSummary().prompts).toMatchObject({ running: 1, failed: 0, queued: 1 });
    expect(store.database.prepare("SELECT id, state, observation_state, error FROM prompt_jobs ORDER BY created_at").all()).toMatchObject([
      { state: "running", observation_state: "detached" }, { state: "queued", observation_state: "not_started" }
    ]);
    expect(warnings).toContainEqual(expect.objectContaining({ event: "bridge-shutdown-turns-aborted", activeTurns: 1 }));
    await projector.stop(); await publisher.stop(); store.close();
  });

  it("does not complete a detached turn from false Herdr idle before canonical transcript completion", async () => {
    const submitted: string[] = [];
    let firstController: AbortSignal | undefined;
    let firstDispatched = false;
    let restarted = false;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async updateCard() {}
    };
    const pane = () => ({ paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: (restarted ? "idle" : firstDispatched ? "working" : "idle") as AgentState, foregroundExecutables: ["traex"] });
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [pane()]; }, async getPane() { return pane(); },
      async observeRuntime() { return { pane: pane(), traexProcess: true, composerReady: restarted, evidenceSource: "structured" }; },
      async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text, _timeout, _observation, signal, onDispatched) {
        submitted.push(text);
        firstDispatched = true;
        await onDispatched?.();
        if (text === "first") {
          firstController = signal;
          await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("observer detached")), { once: true }));
        }
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active" });

    const firstRuntime = runtime(store, herdr, lark, 10);
    await firstRuntime.coordinator.start();
    await firstRuntime.coordinator.handleMessage(message(30, "first"));
    await vi.waitFor(() => expect(firstController).toBeDefined());
    const firstPrompt = store.database.prepare("SELECT id FROM prompt_jobs WHERE lark_message_id = 'm30'").get() as { id: string };
    const turnStartedAt = new Date(Date.parse(store.getPrompt(firstPrompt.id)!.dispatchedAt!) + 250).toISOString();
    expect(store.claimPromptTranscriptTurn({ promptId: firstPrompt.id, bindingId: "b1", turnId: "turn-1", startedAt: turnStartedAt })).toMatchObject({ state: "claimed" });
    await firstRuntime.coordinator.handleMessage(message(31, "second"));
    await firstRuntime.coordinator.stop();
    await firstRuntime.projector.stop(); await firstRuntime.publisher.stop();
    expect(store.getOperationalSummary().prompts).toMatchObject({ running: 1, queued: 1 });
    store.saveRunCard({ ...store.loadRunCard(firstPrompt.id)!, answer: "LEGACY_UNPROVEN_ANSWER_SENTINEL", answerSegments: ["LEGACY_UNPROVEN_ANSWER_SENTINEL"], answerDraft: "", answerDraftTransient: false });

    restarted = true;
    store.updateBinding("b1", { lastAgentState: "idle" });
    let lifecycleState: "active" | "completed" = "active";
    const lifecycleStartedAt = turnStartedAt;
    let answerDelta = "";
    let toolActivities: Array<{ key: string; kind: "read"; label: string; state: "active" | "done" }> = [];
    const transcriptReader = {
      async open() {
        return { mode: "typed" as const, cursor: {
          async readDelta() { return ""; },
          async readObservation() {
            const nextDelta = answerDelta;
            answerDelta = "";
            const nextToolActivities = toolActivities;
            toolActivities = [];
            return { turnId: "turn-1", answerDelta: nextDelta, ...(nextToolActivities.length ? { toolActivities: nextToolActivities } : {}), turnLifecycle: {
              turnId: "turn-1", state: lifecycleState, startedAt: lifecycleStartedAt,
              ...(lifecycleState === "completed" ? { finalAnswer: "Recovered answer" } : {})
            } };
          }
        } };
      }
    };
    const secondRuntime = runtime(store, herdr, lark, 30_000, transcriptReader);
    await secondRuntime.coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(submitted).toEqual(["first"]);
    expect(store.listDetachedPrompts()).toMatchObject([{ id: firstPrompt.id, state: "running", observationState: "detached" }]);

    answerDelta = "Live detached JSONL update";
    toolActivities = [{ key: "tool:read-1", kind: "read", label: "Read · src/main.ts", state: "active" }];
    await vi.waitFor(() => expect(store.loadRunCard(firstPrompt.id)!.answer).toContain("Live detached JSONL update"), { timeout: 2_000 });
    expect(store.loadRunCard(firstPrompt.id)!.progressEvents).toMatchObject([{ key: "tool:read-1", kind: "read", label: "Read · src/main.ts", state: "active" }]);
    expect(store.listDetachedPrompts()).toMatchObject([{ id: firstPrompt.id, state: "running", observationState: "detached" }]);
    expect(submitted).toEqual(["first"]);

    lifecycleState = "completed";
    toolActivities = [{ key: "tool:read-1", kind: "read", label: "Read · src/main.ts", state: "done" }];
    await vi.waitFor(() => expect(submitted).toEqual(["first", "second"]), { timeout: 2_000 });
    expect(store.getOperationalSummary().prompts).toMatchObject({ running: 0, queued: 0, delivered: 2 });
    expect(store.loadRunCard(firstPrompt.id)).toMatchObject({ phase: "completed", answer: "Recovered answer" });
    expect(store.loadRunCard(firstPrompt.id)!.progressEvents).toMatchObject([{ key: "tool:read-1", kind: "read", label: "Read · src/main.ts", state: "done" }]);
    expect(store.loadRunCard(firstPrompt.id)!.answer).not.toMatch(/SECRET_DETACHED_TERMINAL_SENTINEL|LEGACY_UNPROVEN_ANSWER_SENTINEL/);

    await secondRuntime.coordinator.stop(); await secondRuntime.projector.stop(); await secondRuntime.publisher.stop(); store.close();
  });

  it("keeps a detached turn uncertain when runtime evidence cannot prove completion", async () => {
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "unknown" as const, foregroundExecutables: ["traex"] };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [pane]; }, async getPane() { return pane; },
      async observeRuntime() { return { pane, traexProcess: true, composerReady: false, evidenceSource: "process" }; },
      async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { throw new Error("must not replay"); }, async renamePane() {}
    };
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "user", body: "already sent" });
    store.enqueuePrompt({ id: "p2", bindingId: "b1", larkMessageId: "m2", actorOpenId: "user", body: "queued" });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'not_started', attempt_count = 1 WHERE id = 'p1'").run();
    store.markPromptDispatched("p1");
    expect(store.recoverRunningPrompts()).toBe(1);

    const transcriptOpen = vi.fn(async () => ({ mode: "typed" as const, cursor: { async readDelta() { return "forbidden"; } } }));
    const warnings: Array<Record<string, unknown>> = [];
    const logger = pino({ level: "warn" }, { write(chunk: string) { warnings.push(JSON.parse(chunk) as Record<string, unknown>); } });
    const active = runtime(store, herdr, lark, 10, { open: transcriptOpen }, logger);
    await active.coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.listDetachedPrompts()).toMatchObject([{ id: "p1", state: "running", observationState: "detached" }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(transcriptOpen).not.toHaveBeenCalled();
    expect(store.getPrompt("p2")).toMatchObject({ state: "queued", observationState: "not_started" });
    const diagnostics = warnings.filter((record) => record.event === "detached-turn-identity-missing");
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toMatch(/already sent|forbidden|Live detached|Recovered answer/i);

    await active.coordinator.stop(); await active.projector.stop(); await active.publisher.stop(); store.close();
  });

  it("ignores a completed manual turn for a detached prompt owned by another turn", async () => {
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const runPrompt = vi.fn(async () => "done" as const);
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [pane]; }, async getPane() { return pane; },
      async observeRuntime() { return { pane, traexProcess: true, composerReady: true, evidenceSource: "structured" }; },
      async waitForRuntimeChange() { await new Promise((resolve) => setTimeout(resolve, 1)); },
      async createPane() { throw new Error("not used"); }, async startTraex() {}, runPrompt, async renamePane() {}
    };
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; }, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    for (const [id, position] of [["p1", 1], ["p2", 2]] as const) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: position, occurredAt: "2026-08-30T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "user", body: id }, view, rootMessageId: "root", answerCard: {} });
    }
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'not_started', attempt_count = 1 WHERE id = 'p1'").run();
    store.markPromptDispatched("p1", "2026-08-30T00:00:01.000Z");
    expect(store.claimPromptTranscriptTurn({ promptId: "p1", bindingId: "b1", turnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", startedAt: "2026-08-30T00:00:01.250Z" })).toMatchObject({ state: "claimed" });
    store.markPromptObservationDetached("p1", "recovering");
    let releaseRead!: () => void; let reads = 0;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const transcriptReader = { async open() { return { mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() {
      await readGate; reads += 1;
      const observedTurnId = reads < 4 ? "01a052d3-9c14-70e1-a375-397e2ecb55e9" : "01a052d3-9c14-70e1-a375-397e2ecb55ea";
      return { turnId: observedTurnId, answerDelta: "manual output", mainStatus: { statusTitle: "manual" }, turnLifecycle: { turnId: observedTurnId, state: "completed" as const, startedAt: "2026-08-30T00:00:02.000Z" } };
    } } }; } };
    const warnings: Array<Record<string, unknown>> = [];
    const logger = pino({ level: "warn" }, { write(chunk: string) { warnings.push(JSON.parse(chunk) as Record<string, unknown>); } });
    const active = runtime(store, herdr, lark, 10, transcriptReader, logger);
    await active.coordinator.start(); await new Promise((resolve) => setTimeout(resolve, 30));
    const before = store.loadRunCard("p1")!;
    releaseRead(); await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(5));
    const after = store.loadRunCard("p1")!;
    expect({ answer: after.answer, progressEvents: after.progressEvents, statusTitle: after.statusTitle, viewVersion: after.viewVersion, activityAt: after.activityAt }).toEqual({ answer: before.answer, progressEvents: before.progressEvents, statusTitle: before.statusTitle, viewVersion: before.viewVersion, activityAt: before.activityAt });
    expect(store.getPrompt("p1")).toMatchObject({ state: "running", observationState: "detached", transcriptTurnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9" });
    expect(store.getPrompt("p2")).toMatchObject({ state: "queued" });
    expect(runPrompt).not.toHaveBeenCalled();
    expect(warnings.filter((record) => record.event === "transcript-turn-conflict")).toHaveLength(2);
    await active.coordinator.stop(); await active.projector.stop(); await active.publisher.stop(); store.close();
  });

  it("reattaches an orphaned session without replay, then resumes explicitly", async () => {
    const submitted: string[] = [];
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [pane]; }, async getPane(id) { return id === pane.paneId ? pane : null; },
      async observeRuntime(id) { return { pane: id === pane.paneId ? pane : null, traexProcess: id === pane.paneId, composerReady: id === pane.paneId, evidenceSource: id === pane.paneId ? "structured" : "none" }; },
      async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt(_paneId, text) { submitted.push(text); return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active" });
    store.transitionBinding("b1", { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 2 });
    store.enqueuePrompt({ id: "queued", bindingId: "b1", larkMessageId: "old-message", actorOpenId: "user", body: "do not replay" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ ...message(10, "/swarm reattach w1:p1"), mentionsBot: true });
    expect(store.listBindings()[0]).toMatchObject({ lifecycle: "archived", attachment: "attached", generation: 1 });
    expect(store.loadTopicView("b1")).toMatchObject({ primaryToolsAvailable: false, primaryToolsNotice: expect.stringMatching(/reset.*replace/i) });
    expect(submitted).toEqual([]);

    await coordinator.handleMessage({ ...message(11, "/swarm resume"), mentionsBot: true });
    expect(store.listBindings()[0]).toMatchObject({ lifecycle: "active", attachment: "attached", lastAgentState: "idle", generation: 1 });
    // The queued job has no delivered cards, so it remains visible/non-runnable instead of being replayed.
    expect(submitted).toEqual([]);
    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("uses hysteresis for transient workspace probe failures", async () => {
    let failWorkspace = false;
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; }, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
    const herdr: HerdrPort = { async assertWorkspace() {}, async listPanes() { if (failWorkspace) throw new Error("timeout"); return [pane]; }, async getPane() { return pane; }, async createPane() { return pane; }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active" });
    const bus = new BridgeEventBus(); const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    failWorkspace = true;
    await coordinator.reconcile();
    expect(store.listBindings()[0]).toMatchObject({ attachment: "degraded", degradationCount: 1 });
    await coordinator.reconcile();
    expect(store.listBindings()[0]).toMatchObject({ attachment: "orphaned", degradationCount: 2, state: "orphaned" });
    await coordinator.stop(); await publisher.stop(); store.close();
  });
});

function message(index: number, text: string) {
  return { eventId: `e${index}`, messageId: `m${index}`, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false };
}

function runtime(store: SqliteBindingStore, herdr: HerdrPort, lark: LarkPort, shutdownGraceMs = 30_000, transcriptReader?: import("../src/domain/ports.js").TraexTranscriptReaderPort, logger = pino({ enabled: false })) {
  const bus = new BridgeEventBus();
  const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
  const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
  const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, shutdownGraceMs, undefined, undefined, transcriptReader);
  return { coordinator, projector, publisher };
}

function config(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
    herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" },
    projects: [{ id: "repo", displayName: "Repo", spaceName: "repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "repo", projectsConfigPath: "test", traex: { executable: "traex" },
    databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}

function primaryToolArgs(bindingId: string, generation: number): string[] {
  return [
    "-c", 'mcp_servers.herdr_agent_swarm.command="node"',
    "-c", `mcp_servers.herdr_agent_swarm.args=["primary-tools","--binding","${bindingId}","--generation","${generation}"]`,
    "-c", 'mcp_servers.herdr_agent_swarm.env_vars=["SWARM_PRIMARY_CAPABILITY"]'
  ];
}

function callGateway(socketPath: string, payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let output = "";
    socket.setEncoding("utf8"); socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`)); socket.on("data", (chunk) => { output += chunk; });
    socket.once("end", () => resolve(JSON.parse(output))); socket.once("error", reject);
  });
}
