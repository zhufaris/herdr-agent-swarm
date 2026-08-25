import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("pane/thread lifecycle integration", () => {
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
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async observeRuntime(id) { return { pane: id === startedPane.paneId && started ? startedPane : null, traexProcess: started, composerReady: started, evidenceSource: started ? "structured" : "none" }; },
      async createPane() { return createdPane; }, async startTraex() { started = true; },
      async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
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
    await active.coordinator.stop(); await active.projector.stop(); await active.publisher.stop(); store.close();
  });

  it("closes an idle retired pane only after /swarm reset activates its replacement", async () => {
    const oldPane = { paneId: "w1:old", terminalId: "old-terminal", workspaceId: "w1", cwd: "/repo", label: "old", agentState: "done" as const, foregroundExecutables: ["traex"] };
    const newPane = { paneId: "w1:new", terminalId: "new-terminal", workspaceId: "w1", cwd: "/repo", label: "new", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    let oldClosed = false;
    const closePane = vi.fn(async () => { oldClosed = true; });
    let replacementCreated = false;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return replacementCreated ? [oldPane, newPane] : [oldPane]; }, async getPane(id) { return id === oldPane.paneId ? oldPane : replacementCreated && id === newPane.paneId ? newPane : null; },
      async observeRuntime(id) { const pane = id === oldPane.paneId && !oldClosed ? oldPane : replacementCreated && id === newPane.paneId ? newPane : null; return { pane, traexProcess: Boolean(pane), composerReady: pane?.agentState === "idle", evidenceSource: pane ? "structured" : "none" }; },
      async createPane() { replacementCreated = true; return newPane; }, async startTraex() {}, async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}, closePane
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
      async createPane() { throw new Error("new pane creation failed"); }, async startTraex() {}, async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}, closePane
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
      },
      async readOutput() { return "◆ old output that must not reach the topic"; }, async renamePane() {}, async closePane() { throw new Error("must not close a pane with an active prompt"); }
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
    expect(created).toEqual(["fresh session"]);
    expect(oldObserverAborted).toBe(true);
    expect(store.database.prepare("SELECT state FROM prompt_jobs WHERE lark_message_id = 'm2'").get()).toEqual({ state: "cancelled" });
    expect(store.database.prepare("SELECT state, observation_state FROM prompt_jobs WHERE lark_message_id = 'm1'").get()).toEqual({ state: "running", observation_state: "detached" });

    await activeRuntime.coordinator.stop(); await activeRuntime.projector.stop(); await activeRuntime.publisher.stop(); store.close();
  });

  it("attaches a surviving failed reset pane back to its current topic", async () => {
    const pane = { paneId: "w1:survived", terminalId: "term-reset", workspaceId: "w1", cwd: "/repo", label: "survived", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); }, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [pane]; }, async getPane(id) { return id === pane.paneId ? pane : null; },
      async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "failed-reset", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Repo / fresh" });
    store.updateBinding("failed-reset", { paneId: pane.paneId, state: "failed" });
    const activeRuntime = runtime(store, herdr, lark);
    await activeRuntime.coordinator.start();

    await activeRuntime.coordinator.handleMessage({ ...message(4, "/swarm attach repo w1:survived"), mentionsBot: true });

    expect(store.getBinding("failed-reset")).toMatchObject({ state: "active", lifecycle: "active", attachment: "attached", paneId: pane.paneId, traexSessionId: pane.terminalId });
    await activeRuntime.coordinator.stop(); await activeRuntime.projector.stop(); await activeRuntime.publisher.stop(); store.close();
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
      async runPrompt(_paneId, text) { submitted.push(text); await activeTurn; return "done"; }, async readOutput() { return "◆ done\n────────"; }, async renamePane() {}
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
      },
      async readOutput() { return ""; }, async renamePane() {}
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

  it("resumes the FIFO when a detached turn is already idle at the TraeX composer after restart", async () => {
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
      },
      async readOutput() { return restarted ? "◆ first complete\n────────\n❯ Use /skills to list available skills" : "◆ Working…"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active" });

    const firstRuntime = runtime(store, herdr, lark, 10);
    await firstRuntime.coordinator.start();
    await firstRuntime.coordinator.handleMessage(message(30, "first"));
    await vi.waitFor(() => expect(firstController).toBeDefined());
    await firstRuntime.coordinator.handleMessage(message(31, "second"));
    await firstRuntime.coordinator.stop();
    await firstRuntime.projector.stop(); await firstRuntime.publisher.stop();
    expect(store.getOperationalSummary().prompts).toMatchObject({ running: 1, queued: 1 });

    restarted = true;
    store.updateBinding("b1", { lastAgentState: "idle" });
    const secondRuntime = runtime(store, herdr, lark);
    await secondRuntime.coordinator.start();
    await vi.waitFor(() => expect(submitted).toEqual(["first", "second"]), { timeout: 2_000 });
    expect(store.getOperationalSummary().prompts).toMatchObject({ running: 0, queued: 0, delivered: 2 });

    await secondRuntime.coordinator.stop(); await secondRuntime.projector.stop(); await secondRuntime.publisher.stop(); store.close();
  });

  it("keeps a detached turn uncertain when runtime evidence cannot prove completion", async () => {
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "unknown" as const, foregroundExecutables: ["traex"] };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [pane]; }, async getPane() { return pane; },
      async observeRuntime() { return { pane, traexProcess: true, composerReady: false, evidenceSource: "process" }; },
      async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { throw new Error("must not replay"); },
      async readOutput() { return "ambiguous output"; }, async renamePane() {}
    };
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "user", body: "already sent" });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'not_started', attempt_count = 1 WHERE id = 'p1'").run();
    store.markPromptDispatched("p1");
    expect(store.recoverRunningPrompts()).toBe(1);

    const active = runtime(store, herdr, lark, 10);
    await active.coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.listDetachedPrompts()).toMatchObject([{ id: "p1", state: "running", observationState: "detached" }]);

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
      async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt(_paneId, text) { submitted.push(text); return "done"; },
      async readOutput() { return "◆ done\n────────"; }, async renamePane() {}
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
    const herdr: HerdrPort = { async assertWorkspace() {}, async listPanes() { if (failWorkspace) throw new Error("timeout"); return [pane]; }, async getPane() { return pane; }, async createPane() { return pane; }, async startTraex() {}, async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {} };
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

function runtime(store: SqliteBindingStore, herdr: HerdrPort, lark: LarkPort, shutdownGraceMs = 30_000) {
  const bus = new BridgeEventBus();
  const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
  const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
  const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), shutdownGraceMs);
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
