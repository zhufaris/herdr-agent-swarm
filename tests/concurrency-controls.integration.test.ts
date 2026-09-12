import pino from "pino";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort, TraexTranscriptReaderPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { InProcessInboundWorkNotifier } from "../src/events/inbound-work-notifier.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import type { BridgeEvent } from "../src/domain/events.js";
import { TraexTranscriptReader } from "../src/runtime/traex-transcript.js";

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";

describe("coordinator concurrency controls", () => {
  it("terminalizes a prompt when its durable dispatch checkpoint fails", async () => {
    const runPrompt = vi.fn(async (_paneId: string, _text: string, _timeoutMs: number, _onObservation: Parameters<HerdrPort["runPrompt"]>[3], _signal: AbortSignal | undefined, onDispatched: Parameters<HerdrPort["runPrompt"]>[5]) => {
      await onDispatched?.();
      return "done" as const;
    });
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async createPane() { throw new Error("not used"); }, async startTraex() {},
      runPrompt,
      async renamePane() {}
    };
    const { coordinator, publisher, store } = fixture(herdr);
    try {
      await coordinator.start();
      store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", hasCompletedTurn: true });
      store.markPromptDispatched = () => { throw new Error("dispatch checkpoint failed"); };
      await coordinator.handleMessage({ eventId: "prompt-e1", messageId: "prompt-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "do work", mentionsBot: false, isRootMessage: false });

      await vi.waitFor(() => expect(runPrompt).toHaveBeenCalledOnce(), { timeout: 4_000 });
      await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "failed", notice: "dispatch checkpoint failed" }));
      const promptId = store.listRunCards("b1")[0]!.promptId;
      expect(store.getPrompt(promptId)).toMatchObject({ state: "failed", observationState: "completed", dispatchedAt: null, error: "dispatch checkpoint failed" });
      expect(store.listDetachedPrompts()).toEqual([]);
      expect(store.scanDurablePromptWork().hints).not.toContainEqual(expect.objectContaining({ kind: "detached-observer-ready", promptId }));
    } finally {
      await coordinator.stop(); await publisher.stop(); store.close();
    }
  });

  it("persists the pre-call dispatch timestamp after delayed successful submission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    let workflowStore!: SqliteBindingStore;
    let dispatchResult: ReturnType<SqliteBindingStore["claimPromptTranscriptTurn"]> | undefined;
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, _onObservation, _signal, onDispatched) {
        vi.setSystemTime(new Date("2026-08-30T12:00:05.000Z"));
        await onDispatched?.();
        const prompt = workflowStore.listRunCards("b1")[0]!;
        dispatchResult = workflowStore.claimPromptTranscriptTurn({
          promptId: prompt.promptId, bindingId: "b1", turnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", startedAt: "2026-08-30T12:00:00.250Z"
        });
        return "done";
      },
      async renamePane() {}
    };
    const { coordinator, publisher, store } = fixture(herdr);
    workflowStore = store;
    try {
      await coordinator.start();
      store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", hasCompletedTurn: true });
      await coordinator.handleMessage({ eventId: "prompt-e1", messageId: "prompt-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "do work", mentionsBot: false, isRootMessage: false });

      await vi.waitFor(() => expect(dispatchResult).toMatchObject({ state: "claimed" }));
      expect(dispatchResult).toMatchObject({ prompt: { dispatchedAt: "2026-08-30T12:00:00.000Z", transcriptTurnStartedAt: "2026-08-30T12:00:00.250Z" } });
    } finally {
      await coordinator.stop(); await publisher.stop(); store.close(); vi.useRealTimers();
    }
  });

  it("continues startup after a recoverable view convergence stage fails", async () => {
    const store = new SqliteBindingStore(":memory:");
    const originalListBindings = store.listBindings.bind(store);
    let first = true;
    store.listBindings = () => { if (first) { first = false; throw new Error("one startup view is unreadable"); } return originalListBindings(); };
    const lark = quietLark();
    const start = vi.spyOn(lark, "start");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, emptyHerdr(), lark, bus, publisher, pino({ enabled: false }));

    await expect(coordinator.start()).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toMatchObject({
      state: "degraded", completedAt: expect.any(String),
      stages: expect.arrayContaining([
        { name: "view-convergence", state: "failed", error: "one startup view is unreadable", durationMs: expect.any(Number) },
        { name: "runtime-reconciliation", state: "completed", durationMs: expect.any(Number) }
      ])
    });

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("checks configured workspaces concurrently during startup", async () => {
    const release = new Map<string, () => void>();
    const assertWorkspace = vi.fn((workspaceId: string) => new Promise<void>((resolve) => { release.set(workspaceId, resolve); }));
    const herdr = { ...emptyHerdr(), assertWorkspace };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const startupConfig = { ...config(), projects: [
      { id: "one", displayName: "One", description: "One", workspaceId: "w1", cwd: "/one" },
      { id: "two", displayName: "Two", description: "Two", workspaceId: "w2", cwd: "/two" }
    ], defaultProjectId: "one" };
    const coordinator = createTestRouter(startupConfig, store, herdr, lark, bus, publisher, pino({ enabled: false }));

    const startup = coordinator.start();
    await vi.waitFor(() => expect(assertWorkspace.mock.calls.sort()).toEqual([["w1", "one"], ["w2", "two"]]));
    release.get("w1")!();
    release.get("w2")!();
    await startup;

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("coalesces concurrent reconciliation calls into one workspace scan", async () => {
    let block = false;
    let release!: () => void;
    let blocked = Promise.resolve();
    let scans = 0;
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { scans += 1; if (block) await blocked; return []; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async renamePane() {}
    };
    const { coordinator, publisher, store } = fixture(herdr);
    await coordinator.start();
    scans = 0; block = true; blocked = new Promise<void>((resolve) => { release = resolve; });

    const first = coordinator.reconcile();
    const second = coordinator.reconcile();
    await vi.waitFor(() => expect(scans).toBe(1));
    release();
    await Promise.all([first, second]);
    expect(scans).toBe(1);

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("uses scoped binding queries for one reconciliation pass", async () => {
    const { coordinator, publisher, store } = fixture(emptyHerdr());
    await coordinator.start();
    const original = store.listBindingsByState.bind(store);
    const states: string[] = [];
    store.listBindingsByState = (state) => { states.push(state); return original(state); };
    store.listBindings = () => { throw new Error("reconcile must not load every binding"); };

    await coordinator.reconcile();

    expect(states).toEqual(["active", "orphaned"]);
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("fails only affected run cards when a Pane is missing", async () => {
    const { coordinator, publisher, store } = fixture(emptyHerdr());
    await coordinator.start();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    for (const [promptId, phase] of [["running", "running"], ["blocked", "blocked"], ["queued", "queued"], ["done", "completed"]] as const) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-08-23T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "m1", answerCard: {} });
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase });
    }
    await coordinator.reconcile();

    expect(store.loadRunCard("running")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.loadRunCard("blocked")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.loadRunCard("queued")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.getPrompt("queued")).toMatchObject({ state: "cancelled", observationState: "completed" });
    expect(store.loadRunCard("done")).toMatchObject({ phase: "completed", viewVersion: 1 });
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("accepts concurrent inbound messages without waiting for Lark delivery", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const replies: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard(rootMessageId) { if (rootMessageId === "m1") await firstBlocked; replies.push(rootMessageId); return { messageId: `card-${rootMessageId}` }; },
      async updateCard() {}
    };
    const { coordinator, publisher, store } = fixture(emptyHerdr(), lark);
    await coordinator.start();
    const first = coordinator.handleMessage(message(1));
    await vi.waitFor(() => expect(store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'e1'").get()).toMatchObject({ state: "accepted" }));
    const second = coordinator.handleMessage(message(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'e2'").get()).toMatchObject({ state: "accepted" });
    await vi.waitFor(() => expect(replies).toEqual(["m2"]));

    releaseFirst();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(replies).toEqual(["m2", "m1"]));
    expect(store.database.prepare("SELECT state FROM inbound_messages ORDER BY created_at, event_id").all()).toEqual([{ state: "accepted" }, { state: "accepted" }]);
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("routes an alias-thread reply to the existing Binding while keeping its Answer in the alias thread", async () => {
    const herdr = emptyHerdr();
    const { coordinator, publisher, store } = fixture(herdr);
    try {
      await coordinator.start();
      store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "canonical-topic", rootMessageId: "canonical-root", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "canonical-root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
      store.reservePaneThreadAlias({ publicationKey: "publish-alias", actionMessageId: "directory-card", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "canonical-root", targetChatId: "chat", card: {} });
      const creation = store.listPendingOutboundReplies().find((reply) => reply.kind === "group_card_create")!;
      store.markOutboundReplyDelivered(creation.id, "alias-root", undefined, "alias-topic");

      await coordinator.handleMessage({ eventId: "alias-e1", messageId: "alias-m1", chatId: "chat", topicId: "alias-topic", rootMessageId: "alias-root", actorOpenId: "user", text: "continue here", mentionsBot: false, isRootMessage: false });
      const prompt = store.listRunCards("b1").find((view) => view.requestText === "continue here")!;
      expect(prompt).toBeDefined();
      const answerCreate = store.database.prepare("SELECT prompt_id, kind, root_message_id, state FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create'").get(prompt.promptId) as { prompt_id: string; kind: string; root_message_id: string; state: string };
      expect(answerCreate).toMatchObject({ prompt_id: prompt.promptId, kind: "stream_card_create", root_message_id: "alias-root" });
      expect(answerCreate.state).not.toBe("dead_letter");
      expect(store.getBinding("b1")).toMatchObject({ rootMessageId: "canonical-root", topicId: "canonical-topic" });
    } finally { await coordinator.stop(); await publisher.stop(); store.close(); }
  });

  it("rejects topology-changing commands from an alias thread", async () => {
    const cards: object[] = [];
    const lark = quietLark();
    lark.replyCard = async (_root, card) => { cards.push(card); return { messageId: "rejection" }; };
    const { coordinator, publisher, store } = fixture(emptyHerdr(), lark);
    try {
      await coordinator.start();
      store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "canonical-topic", rootMessageId: "canonical-root", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "canonical-root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
      store.reservePaneThreadAlias({ publicationKey: "publish-alias", actionMessageId: "directory-card", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "canonical-root", targetChatId: "chat", card: {} });
      const creation = store.listPendingOutboundReplies().find((reply) => reply.kind === "group_card_create")!;
      store.markOutboundReplyDelivered(creation.id, "alias-root", undefined, "alias-topic");

      await coordinator.handleMessage({ eventId: "alias-reset", messageId: "alias-command", chatId: "chat", topicId: "alias-topic", rootMessageId: "alias-root", actorOpenId: "user", text: "/swarm reset", mentionsBot: false, isRootMessage: false });
      await vi.waitFor(() => expect(cards.some((card) => JSON.stringify(card).includes("原始 Main Card 话题"))).toBe(true));
      expect(store.getBinding("b1")).toMatchObject({ generation: 1, paneId: "w1:p1" });
    } finally { await coordinator.stop(); await publisher.stop(); store.close(); }
  });

  it("persists a Lark callback before acknowledging it and consumes it in the background", async () => {
    let onMessage!: Parameters<LarkPort["start"]>[0];
    let releaseAcceptance!: () => void;
    const acceptanceBlocked = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
    const inboundWork = new InProcessInboundWorkNotifier();
    const stopBlocker = inboundWork.subscribe(() => acceptanceBlocked);
    const lark: LarkPort = {
      ...quietLark(),
      async start(handler) { onMessage = handler; }
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, emptyHerdr(), lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, inboundWork);

    try {
      await coordinator.start();
      const acknowledged = onMessage(message(1));
      await expect(acknowledged).resolves.toBeUndefined();
      expect(store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'e1'").get()).toMatchObject({ state: "processing" });

      releaseAcceptance();
      await vi.waitFor(() => expect(store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'e1'").get()).toMatchObject({ state: "accepted" }));
    } finally {
      releaseAcceptance();
      await coordinator.stop(); stopBlocker(); await publisher.stop(); store.close();
    }
  });

  it("automatically retries a failed durable inbound acceptance without another message", async () => {
    let onMessage!: Parameters<LarkPort["start"]>[0];
    let attempts = 0;
    const inboundWork = new InProcessInboundWorkNotifier();
    const stopFailure = inboundWork.subscribe(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary inbound failure");
    });
    const lark: LarkPort = {
      ...quietLark(),
      async start(handler) { onMessage = handler; }
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, emptyHerdr(), lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, inboundWork);

    try {
      await coordinator.start();
      await expect(onMessage(message(1))).resolves.toBeUndefined();
      await vi.waitFor(() => expect(coordinator.inboundSnapshot()).toMatchObject({ state: "retry_wait", retryAttempt: 1, nextRetryAt: expect.any(String), lastFailure: "temporary inbound failure" }));
      await vi.waitFor(() => expect(attempts).toBe(2));
      expect(store.database.prepare("SELECT state, error FROM inbound_messages WHERE event_id = 'e1'").get()).toEqual({ state: "accepted", error: null });
      expect(coordinator.inboundSnapshot()).toMatchObject({ state: "idle", retryAttempt: 0, nextRetryAt: null, lastAcceptedAt: expect.any(String), lastFailureAt: expect.any(String) });
    } finally {
      await coordinator.stop(); stopFailure(); await publisher.stop(); store.close();
    }
  });

  it("starts a queued prompt while its initial answer card retries independently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    let failReply = true;
    let runCount = 0;
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", title: "Task", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; },
      async createPane() { throw new Error("not used"); },
      async startTraex() {},
      async runPrompt() { runCount += 1; return "done"; },
      async renamePane() {}
    };
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard() { return { messageId: "legacy" }; },
      async updateCard() {},
      async createStreamingCard() { return { cardId: "cardkit-1" }; },
      async replyStreamingCardReference() {
        if (failReply) { failReply = false; throw Object.assign(new Error("temporary"), { response: { status: 503 } }); }
        return { messageId: "answer-1" };
      },
      async streamCardContent() {},
      async finishStreamingCard() {}
    };
    const { coordinator, publisher, store } = fixture(herdr, lark);
    try {
      store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
      await coordinator.start();

      await coordinator.handleMessage({ eventId: "prompt-e1", messageId: "prompt-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "do work", mentionsBot: false, isRootMessage: false });

      await vi.waitFor(() => expect(runCount).toBe(1));
      await vi.advanceTimersByTimeAsync(1_300);
      await vi.waitFor(() => expect(store.loadRunCard(store.listRunCards("b1")[0]!.promptId)?.answerMessageId).toBe("answer-1"));
      expect(store.listRunCards("b1")[0]).toMatchObject({ sessionTitle: "Task" });
      expect(runCount).toBe(1);
    } finally {
      await coordinator.stop(); await publisher.stop(); store.close(); vi.useRealTimers();
    }
  });

  it("keeps a committed unavailable-output result completed when a lifecycle subscriber fails", async () => {
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", title: "Task", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; },
      async createPane() { throw new Error("not used"); },
      async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, _onObservation, _signal, onDispatched) { await onDispatched?.(); return "done"; },
      async renamePane() {}
    };
    const { coordinator, publisher, store, bus } = fixture(herdr);
    const lifecycleTypes: string[] = [];
    bus.onBridgeEvent("lifecycle-sequence", (event) => { lifecycleTypes.push(event.type); });
    bus.onBridgeEvent("failing-projector", (event) => {
      if (event.type === "TurnCompleted") throw new Error("projection failed");
    });
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "prompt-e1", messageId: "prompt-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "do work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE }));

    const promptId = store.listRunCards("b1")[0]!.promptId;
    expect(store.getPrompt(promptId)).toMatchObject({ state: "delivered", observationState: "completed", error: null });
    expect(lifecycleTypes).toContain("TurnStarted");
    expect(lifecycleTypes).toContain("TurnCompleted");
    expect(lifecycleTypes).not.toContain("RunQueuePositionChanged");
    await vi.waitFor(() => expect(bus.snapshot()).toMatchObject({ subscriberFailures: 1, lastFailedSubscriber: "failing-projector" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("streams typed transcript output and ignores misleading terminal code markers", async () => {
    let terminalReads = 0;
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const deltas = [
      "Typed **analysis**",
      "```bash\nnpm test\n```\n\n```text\n12 tests passed\n```",
      "```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n```"
    ];
    const transcriptReader: TraexTranscriptReaderPort = {
      async open(session) {
        expect(session).toEqual({ source: "herdr:traex", agent: "traex", kind: "id", value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });
        return { mode: "typed", cursor: { async readDelta() { return ""; }, async readObservation() {
          return { turnId, freshTurnStart: true, answerDelta: deltas.shift() ?? "", turnLifecycle: { turnId, state: "active", startedAt: new Date().toISOString() } };
        } } };
      }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: "• Bash fake terminal command\nnot typed" });
        await onObservation?.({ state: "working", stateSource: "herdr", output: "+ fake terminal diff" });
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const scheduler = undefined;
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, scheduler, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    const terminalReadsBeforePrompt = terminalReads;
    await coordinator.handleMessage({ eventId: "typed-e1", messageId: "typed-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "do typed work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));
    const answer = store.listRunCards("b1")[0]!.answer;
    expect(answer).toContain("Typed **analysis**");
    expect(answer).toContain("```bash\nnpm test\n```");
    expect(answer).toContain("```diff");
    expect(answer).not.toMatch(/fake terminal|misleading terminal/);
    expect(terminalReads - terminalReadsBeforePrompt).toBe(0);
    expect(records).toContainEqual(expect.objectContaining({ event: "turn-started", outputMode: "typed" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("routes one typed observation to independent Answer and Main Card projections", async () => {
    let reads = 0;
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          reads += 1;
          return reads === 1 ? {
            turnId, freshTurnStart: true,
            answerDelta: "Visible answer",
            toolActivities: [{ key: "tool:call-test", kind: "test" as const, label: "Command · npm test", state: "done" as const }],
            mainStatus: { statusTitle: "Verifying deployment", tokenCount: 1_234, planSteps: [
              { key: "plan:0", label: "Run checks", state: "active" as const }
            ] },
            turnLifecycle: { turnId, state: "active" as const, startedAt: new Date().toISOString() }
          } : { turnId, answerDelta: "", turnLifecycle: { turnId, state: "active" as const, startedAt: new Date().toISOString() } };
        }
      } }; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) { await onDispatched?.(); await onObservation?.({ state: "working", stateSource: "herdr", output: "ignored terminal" }); return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const observed: Extract<BridgeEvent, { type: "TurnOutputObserved" }>[] = [];
    bus.onBridgeEvent("observation-test", (item) => { if (item.type === "TurnOutputObserved") observed.push(item); });
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "split-e1", messageId: "split-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "split output", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));
    expect(observed[0]?.payload.observation.answer).toMatchObject({ snapshot: "Visible answer", toolActivities: [{ key: "tool:call-test", kind: "test", label: "Command · npm test", state: "done" }] });
    expect(observed[0]?.payload.observation.main.status).toMatchObject({ statusTitle: "Verifying deployment", tokenCount: 1_234, planSteps: [{ key: "plan:0", kind: "step", state: "active" }] });
    expect(store.listRunCards("b1")[0]!.answer).toBe("Visible answer");

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("publishes attached transcript output only after claiming its exact turn", async () => {
    const turnA = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const turnB = "01a052d3-9c14-70e1-a375-397e2ecb55ea";
    let reads = 0;
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          reads += 1;
          if (reads === 1) return { answerDelta: "must stay buffered" };
          if (reads === 2) return { turnId: turnA, freshTurnStart: true, answerDelta: "owned answer", turnLifecycle: { turnId: turnA, state: "active" as const, startedAt: new Date().toISOString() } };
          return { turnId: turnB, answerDelta: "manual answer", mainStatus: { statusTitle: "Manual turn" }, turnLifecycle: { turnId: turnB, state: "active" as const, startedAt: new Date().toISOString() } };
        }
      } }; }
    };
    const runPrompt = vi.fn(async (_paneId: string, _text: string, _timeoutMs: number, onObservation: Parameters<HerdrPort["runPrompt"]>[3], _signal: AbortSignal | undefined, onDispatched: Parameters<HerdrPort["runPrompt"]>[5]) => {
      await onDispatched?.();
      await onObservation?.({ state: "working", stateSource: "herdr", output: "ignored" });
      await onObservation?.({ state: "working", stateSource: "herdr", output: "ignored again" });
      return "done" as const;
    });
    const herdr: HerdrPort = { ...emptyHerdr(), async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; }, runPrompt };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const observed: Extract<BridgeEvent, { type: "TurnOutputObserved" }>[] = [];
    bus.onBridgeEvent("owned-observation-test", (event) => {
      if (event.type !== "TurnOutputObserved") return;
      expect(store.getPrompt(event.payload.promptId)?.transcriptTurnId).toBe(turnA);
      observed.push(event);
    });
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "owned-e1", messageId: "owned-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "owned work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }), { timeout: 4_000 });
    expect(runPrompt).toHaveBeenCalledOnce();
    expect(store.getPrompt(store.listRunCards("b1")[0]!.promptId)?.transcriptTurnId).toBe(turnA);
    expect(observed.map((event) => event.payload.observation.answer.snapshot)).toEqual(["owned answer"]);
    expect(store.listRunCards("b1")[0]!.answer).toBe("owned answer");

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("publishes attached transcript output while the Herdr prompt waiter is still running", async () => {
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const startedAt = new Date(Date.now() + 100).toISOString();
    let reads = 0;
    let releasePrompt!: () => void;
    const promptCompletion = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          reads += 1;
          if (reads === 1) return { answerDelta: "" };
          return {
            turnId, freshTurnStart: reads === 2, answerDelta: reads === 2 ? "Visible before completion" : "",
            turnLifecycle: { turnId, state: reads >= 4 ? "completed" as const : "active" as const, startedAt, ...(reads >= 4 ? { finalAnswer: "Visible before completion" } : {}) }
          };
        }
      } }; }
    };
    const runPrompt = vi.fn(async (_paneId: string, _text: string, _timeoutMs: number, _onObservation: Parameters<HerdrPort["runPrompt"]>[3], _signal: AbortSignal | undefined, onDispatched: Parameters<HerdrPort["runPrompt"]>[5]) => {
      await promptCompletion;
      await onDispatched?.();
      return "done" as const;
    });
    const herdr: HerdrPort = {
      ...emptyHerdr(), runPrompt,
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; }
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const observed: Extract<BridgeEvent, { type: "TurnOutputObserved" }>[] = [];
    bus.onBridgeEvent("live-attached-output-test", (event) => { if (event.type === "TurnOutputObserved") observed.push(event); });
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", hasCompletedTurn: true, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "live-e1", messageId: "live-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "stream while waiting", mentionsBot: false, isRootMessage: false });

    await vi.waitFor(() => expect(runPrompt).toHaveBeenCalledOnce(), { timeout: 2_000 });
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect({ observed: observed.map((event) => event.payload.observation.answer.snapshot), prompt: store.getPrompt(store.listRunCards("b1")[0]!.promptId) }).toMatchObject({ observed: expect.arrayContaining(["Visible before completion"]) });
    expect(runPrompt).toHaveBeenCalledOnce();
    expect(store.getPrompt(store.listRunCards("b1")[0]!.promptId)).toMatchObject({ state: "running", observationState: "attached", transcriptTurnId: turnId });

    releasePrompt();
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: "Visible before completion" }));
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("preserves the live transcript cursor when an attached waiter becomes detached", async () => {
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const startedAt = new Date(Date.now() + 100).toISOString();
    let reads = 0;
    let emittedAfterDetach = false;
    let finishTurn = false;
    let store!: SqliteBindingStore;
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: {
      async readDelta() { return ""; },
      async readObservation() {
        reads += 1;
        const prompt = store.listRunCards("b1")[0];
        const detached = prompt ? store.getPrompt(prompt.promptId)?.observationState === "detached" : false;
        if (!detached) return { turnId, freshTurnStart: reads === 1, answerDelta: "", turnLifecycle: { turnId, state: "active" as const, startedAt } };
        if (!emittedAfterDetach) {
          emittedAfterDetach = true;
          return { turnId, answerDelta: "First commentary after stall", turnLifecycle: { turnId, state: "active" as const, startedAt } };
        }
        if (!finishTurn) return { turnId, answerDelta: "", turnLifecycle: { turnId, state: "active" as const, startedAt } };
        return { turnId, answerDelta: "", turnLifecycle: { turnId, state: "completed" as const, startedAt, finalAnswer: "First commentary after stall" } };
      }
    } }));
    const transcriptReader: TraexTranscriptReaderPort = { open };
    const runPrompt = vi.fn(async (_paneId: string, _text: string, _timeoutMs: number, _onObservation: Parameters<HerdrPort["runPrompt"]>[3], _signal: AbortSignal | undefined, onDispatched: Parameters<HerdrPort["runPrompt"]>[5]) => {
      await onDispatched?.();
      await new Promise((resolve) => setTimeout(resolve, 350));
      throw new Error("agent_prompt_stalled");
    });
    const herdr: HerdrPort = {
      ...emptyHerdr(), runPrompt,
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async observeRuntime() { return { pane: { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "working" }, traexProcess: true, composerReady: false, evidenceSource: "structured" }; }
    };
    store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const observed: Extract<BridgeEvent, { type: "TurnOutputObserved" }>[] = [];
    bus.onBridgeEvent("detached-cursor-handoff-test", (event) => { if (event.type === "TurnOutputObserved") observed.push(event); });
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", hasCompletedTurn: true, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "handoff-e1", messageId: "handoff-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "handoff cursor", mentionsBot: false, isRootMessage: false });
    const target = () => store.listRunCards("b1").find(({ requestText }) => requestText === "handoff cursor")!;
    await vi.waitFor(() => expect(observed.map((event) => event.payload.observation.answer.snapshot)).toEqual(["First commentary after stall"]), { timeout: 2_000 });
    expect(store.getPrompt(target().promptId)).toMatchObject({ state: "running", observationState: "detached", wasDetached: true, transcriptTurnId: turnId });
    finishTurn = true;
    await vi.waitFor(() => expect(target()).toMatchObject({ phase: "completed", answer: "First commentary after stall" }), { timeout: 2_000 });
    expect({
      observed: observed.map((event) => event.payload.observation.answer.snapshot), reads, opens: open.mock.calls.length, dispatches: runPrompt.mock.calls.length,
      prompt: store.getPrompt(target().promptId)
    }).toMatchObject({
      observed: ["First commentary after stall"], reads: expect.any(Number), opens: 1, dispatches: 1,
      prompt: { observationState: "completed", wasDetached: true, transcriptTurnId: turnId }
    });

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("recovers a dispatched turn when Herdr reports stalled before observing it", async () => {
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    let startedAt = "";
    let reads = 0;
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          reads += 1;
          return { turnId, freshTurnStart: true, answerDelta: reads === 1 ? "Recovered answer" : "", turnLifecycle: { turnId, state: "completed" as const, startedAt, finalAnswer: "Recovered answer" } };
        }
      } }; }
    };
    const runPrompt = vi.fn(async (_paneId: string, _text: string, _timeoutMs: number, _onObservation: Parameters<HerdrPort["runPrompt"]>[3], _signal: AbortSignal | undefined, onDispatched: Parameters<HerdrPort["runPrompt"]>[5]) => {
      await onDispatched?.();
      startedAt = new Date(Date.now() + 100).toISOString();
      throw new Error("agent_prompt_stalled");
    });
    const herdr: HerdrPort = {
      ...emptyHerdr(), runPrompt,
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async observeRuntime() { return { pane: { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }, traexProcess: true, composerReady: true, evidenceSource: "structured" }; }
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", hasCompletedTurn: true, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "stalled-e1", messageId: "stalled-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "recover me", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(runPrompt).toHaveBeenCalledOnce());
    expect(runPrompt.mock.calls[0]?.[1]).toBe("recover me");
    const target = () => store.listRunCards("b1").find(({ requestText }) => requestText === "recover me")!;
    await vi.waitFor(() => expect(target()).toMatchObject({ phase: "completed", answer: "Recovered answer" }), { timeout: 7_000 });
    expect(runPrompt).toHaveBeenCalledOnce();
    expect(store.getPrompt(target().promptId)).toMatchObject({ state: "delivered", transcriptTurnId: turnId, transcriptTurnStartedAt: startedAt });

    await coordinator.stop(); await publisher.stop(); store.close();
  }, 10_000);

  it("does not recover an old transcript turn after Herdr reports stalled", async () => {
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: { async readDelta() { return ""; }, async readObservation() {
        return { turnId, freshTurnStart: true, answerDelta: "Old answer", turnLifecycle: { turnId, state: "completed" as const, startedAt: "2020-01-01T00:00:00.000Z", finalAnswer: "Old answer" } };
      } } }; }
    };
    const runPrompt = vi.fn(async (_paneId: string, _text: string, _timeoutMs: number, _onObservation: Parameters<HerdrPort["runPrompt"]>[3], _signal: AbortSignal | undefined, onDispatched: Parameters<HerdrPort["runPrompt"]>[5]) => { await onDispatched?.(); throw new Error("agent_prompt_stalled"); });
    const herdr: HerdrPort = { ...emptyHerdr(), runPrompt, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; } };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", hasCompletedTurn: true, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "old-stalled-e1", messageId: "old-stalled-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "do not recover old", mentionsBot: false, isRootMessage: false });
    const target = () => store.listRunCards("b1").find(({ requestText }) => requestText === "do not recover old")!;
    await vi.waitFor(() => expect(store.getPrompt(target().promptId)).toMatchObject({ state: "running", observationState: "detached" }));
    expect(store.getPrompt(target().promptId)?.transcriptTurnId).toBeNull();
    expect(target().answer).toBe("");
    expect(runPrompt).toHaveBeenCalledOnce();

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("fails a prompt proven not started and continues the binding FIFO", async () => {
    let rejectFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { rejectFirst = resolve; });
    const runPrompt = vi.fn(async (_paneId: string, text: string, _timeoutMs: number, _onObservation: Parameters<HerdrPort["runPrompt"]>[3], _signal: AbortSignal | undefined, onDispatched: Parameters<HerdrPort["runPrompt"]>[5]) => {
      if (text === "/ti") {
        await firstMayFinish;
        throw new Error('{"error":{"code":"agent_prompt_not_started","message":"No matching TraeX turn started"}}');
      }
      await onDispatched?.();
      return "done" as const;
    });
    const herdr: HerdrPort = { ...emptyHerdr(), runPrompt, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; } };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", hasCompletedTurn: true });

    try {
      await coordinator.start();
      await coordinator.handleMessage({ eventId: "not-started-e1", messageId: "not-started-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "/ti", mentionsBot: false, isRootMessage: false });
      await vi.waitFor(() => expect(runPrompt).toHaveBeenCalledOnce());
      await coordinator.handleMessage({ eventId: "not-started-e2", messageId: "not-started-m2", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "second queued work", mentionsBot: false, isRootMessage: false });
      rejectFirst();

      await vi.waitFor(() => expect(runPrompt).toHaveBeenCalledTimes(2));
      const cards = () => store.listRunCards("b1");
      await vi.waitFor(() => expect(cards().find(({ requestText }) => requestText === "second queued work")).toMatchObject({ phase: "completed" }));
      const first = cards().find(({ requestText }) => requestText === "/ti")!;
      expect(store.getPrompt(first.promptId)).toMatchObject({ state: "failed", observationState: "completed", dispatchedAt: null, transcriptTurnId: null });
      expect(runPrompt.mock.calls.map((call) => call[1])).toEqual(["/ti", "second queued work"]);
    } finally {
      rejectFirst();
      await coordinator.stop(); await publisher.stop(); store.close();
    }
  });

  it("rejects transcript output whose lifecycle predates dispatch tolerance", async () => {
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() { return { turnId, freshTurnStart: true, answerDelta: "baseline answer", turnLifecycle: { turnId, state: "active" as const, startedAt: "2020-01-01T00:00:00.000Z" } }; }
      } }; }
    };
    const herdr: HerdrPort = {
      ...emptyHerdr(),
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.(); await onObservation?.({ state: "working", stateSource: "herdr", output: "ignored" }); return "done";
      }
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const observed: BridgeEvent[] = [];
    bus.onBridgeEvent("old-lifecycle-test", (event) => { if (event.type === "TurnOutputObserved") observed.push(event); });
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "old-e1", messageId: "old-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "new work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE }));
    expect(store.getPrompt(store.listRunCards("b1")[0]!.promptId)?.transcriptTurnId).toBeNull();
    expect(observed).toEqual([]);

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("does not claim an inherited baseline lifecycle near the dispatch boundary", async () => {
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() { return { turnId, answerDelta: "baseline answer", turnLifecycle: { turnId, state: "active" as const, startedAt: new Date(Date.now() - 500).toISOString() } }; }
      } }; }
    };
    const herdr: HerdrPort = {
      ...emptyHerdr(),
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.(); await onObservation?.({ state: "working", stateSource: "herdr", output: "ignored" }); return "done";
      }
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const observed: BridgeEvent[] = [];
    bus.onBridgeEvent("baseline-lifecycle-test", (event) => { if (event.type === "TurnOutputObserved") observed.push(event); });
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "baseline-e1", messageId: "baseline-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "new work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE }));
    expect(store.getPrompt(store.listRunCards("b1")[0]!.promptId)?.transcriptTurnId).toBeNull();
    expect(observed).toEqual([]);

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("boundedly drains a real transcript to claim a turn after inherited and unscoped batches", async () => {
    const sessionId = "01a03eb1-c193-7531-83c0-e6c6f70143d4";
    const turnA = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const turnB = "01a052d3-9c14-70e1-a375-397e2ecb55ea";
    const root = await mkdtemp(join(tmpdir(), "attached-turn-drain-"));
    const path = join(root, "2026", "08", "30", `rollout-${sessionId}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    const envelope = (type: string, payload: unknown) => `${JSON.stringify({ type, payload })}\n`;
    const mutation = (items: unknown[]) => envelope("history_mutation", { operation: "append", items });
    await writeFile(path, [envelope("session_meta", { id: sessionId }), envelope("event_msg", { type: "task_started", turn_id: turnA, started_at: Math.floor(Date.now() / 1_000) })].join(""));
    const transcriptReader = new TraexTranscriptReader({ sessionsRoot: root });
    const runPrompt = vi.fn(async (_paneId: string, _text: string, _timeoutMs: number, _onObservation: Parameters<HerdrPort["runPrompt"]>[3], _signal: AbortSignal | undefined, onDispatched: Parameters<HerdrPort["runPrompt"]>[5]) => {
      await onDispatched?.();
      const nowSeconds = Math.floor(Date.now() / 1_000);
      await appendFile(path, [
        envelope("event_msg", { type: "task_complete", turn_id: turnA, started_at: nowSeconds, completed_at: nowSeconds }),
        mutation([{ type: "message", id: "unscoped", role: "assistant", content: [{ type: "output_text", text: "Must not publish" }] }]),
        envelope("event_msg", { type: "task_started", turn_id: turnB, started_at: nowSeconds }),
        mutation([{ type: "message", id: "answer-b", role: "assistant", content: [{ type: "output_text", text: "Owned B answer" }] }]),
        envelope("event_msg", { type: "task_complete", turn_id: turnB, started_at: nowSeconds, completed_at: nowSeconds })
      ].join(""));
      return "done" as const;
    });
    const herdr: HerdrPort = { ...emptyHerdr(), async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; }, runPrompt };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    try {
      store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: sessionId });
      await coordinator.start();
      await coordinator.handleMessage({ eventId: "drain-e1", messageId: "drain-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "new B work", mentionsBot: false, isRootMessage: false });
      await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: "Owned B answer" }));
      expect(store.getPrompt(store.listRunCards("b1")[0]!.promptId)?.transcriptTurnId).toBe(turnB);
      expect(runPrompt).toHaveBeenCalledOnce();
    } finally {
      await coordinator.stop(); await publisher.stop(); store.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it("stops a bounded final drain before republishing an identical owned observation", async () => {
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    let reads = 0;
    const repeated = { turnId, freshTurnStart: true, answerDelta: "Owned once", turnLifecycle: { turnId, state: "active" as const, startedAt: new Date().toISOString() } };
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: { async readDelta() { return ""; }, async readObservation() { reads += 1; return repeated; } } }; }
    };
    const runPrompt = vi.fn(async (_paneId: string, _text: string, _timeoutMs: number, _onObservation: Parameters<HerdrPort["runPrompt"]>[3], _signal: AbortSignal | undefined, onDispatched: Parameters<HerdrPort["runPrompt"]>[5]) => {
      await onDispatched?.(); return "done" as const;
    });
    const herdr: HerdrPort = { ...emptyHerdr(), async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; }, runPrompt };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const observed: BridgeEvent[] = [];
    bus.onBridgeEvent("repeat-owned-test", (event) => { if (event.type === "TurnOutputObserved") observed.push(event); });
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "repeat-e1", messageId: "repeat-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "repeat work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));
    expect(reads).toBe(2);
    expect(observed).toHaveLength(1);
    expect(store.listRunCards("b1")[0]!.answer).toBe("Owned once");

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("keeps terminal text out of the Answer when no session identity exists", async () => {
    const transcriptReader: TraexTranscriptReaderPort = {
      async open(session) {
        expect(session).toBeNull();
        return { mode: "unavailable", reason: "missing_session_identity" };
      }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, _onObservation, _signal, onDispatched) { await onDispatched?.(); return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "terminal-e1", messageId: "terminal-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "terminal work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE }), { timeout: 4_000 });
    expect(store.listRunCards("b1")[0]!.answer).not.toContain("SECRET_TERMINAL_SENTINEL");
    expect(records).toContainEqual(expect.objectContaining({ event: "turn-started", outputMode: "unavailable", unavailableReason: "missing_session_identity" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("waits for a first-turn Herdr session identity before marking structured output unavailable", async () => {
    const sessionId = "01a04440-4348-78a1-ac78-60927a085826";
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    let store!: SqliteBindingStore;
    const opens: Array<string | null> = [];
    const transcriptReader: TraexTranscriptReaderPort = {
      async open(session) {
        opens.push(session?.value ?? null);
        if (!session) {
          store.updateBindingMetadata("b1", { agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: sessionId });
          return { mode: "unavailable", reason: "missing_session_identity" };
        }
        expect(session).toEqual({ source: "herdr:traex", agent: "traex", kind: "id", value: sessionId });
        let read = false;
        return { mode: "typed", cursor: { async readDelta() { return ""; }, async readObservation() {
          const freshTurnStart = !read; const answerDelta = read ? "" : "authoritative JSONL answer"; read = true;
          return { turnId, freshTurnStart, answerDelta, turnLifecycle: { turnId, state: "active", startedAt: new Date().toISOString() } };
        } } };
      }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ ignored terminal text" });
        return "done";
      }, async renamePane() {}
    };
    store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "late-session-e1", messageId: "late-session-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "first turn", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));

    expect(opens).toEqual([null, sessionId]);
    expect(store.listRunCards("b1")[0]!.answer).toBe("authoritative JSONL answer");
    expect(records).toContainEqual(expect.objectContaining({ event: "traex-transcript-source-upgraded", outcome: "typed" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("adopts a native session created by first dispatch and reads its exact transcript", async () => {
    const sessionId = "01a04440-4348-78a1-ac78-60927a085826";
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    let startedAt = new Date().toISOString();
    let dispatched = false;
    let transcriptAvailable = false;
    const opens: Array<string | null> = [];
    const transcriptReader: TraexTranscriptReaderPort = {
      async open(session) {
        opens.push(session?.value ?? null);
        if (!session) return { mode: "unavailable", reason: "missing_session_identity" };
        if (!transcriptAvailable) return { mode: "unavailable", reason: "transcript_not_found" };
        let emitted = false;
        return { mode: "typed", cursor: { async readDelta() { return ""; }, async readObservation() {
          if (emitted) return { answerDelta: "" };
          emitted = true;
          return { turnId, freshTurnStart: true, requestText: "first native turn", answerDelta: "authoritative first-turn answer", turnLifecycle: { turnId, state: "completed", startedAt, finalAnswer: "authoritative first-turn answer" } };
        } } };
      },
      async openFirstTurn(session) { return this.open(session); }
    };
    const runPrompt = vi.fn(async (_paneId: string, _text: string, _timeoutMs: number, _onObservation: Parameters<HerdrPort["runPrompt"]>[3], _signal: AbortSignal | undefined, onDispatched: Parameters<HerdrPort["runPrompt"]>[5]) => {
      dispatched = true;
      startedAt = new Date().toISOString();
      await onDispatched?.();
      await vi.waitFor(() => expect(transcriptAvailable).toBe(true));
      return "done" as const;
    });
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", terminalId: "terminal-1", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, runPrompt, async renamePane() {},
      async observeRuntime() {
        if (!dispatched) return { pane: { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", terminalId: "terminal-1", foregroundExecutables: ["traex"], agentState: "idle" }, traexProcess: true, composerReady: true, evidenceSource: "structured" };
        transcriptAvailable = true;
        return { pane: { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", terminalId: "terminal-1", foregroundExecutables: ["traex"], agentState: "working", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: sessionId } }, traexProcess: true, composerReady: true, evidenceSource: "structured" };
      }
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "terminal-1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "first-native-e1", messageId: "first-native-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "first native turn", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: "authoritative first-turn answer" }), { timeout: 8_000 });

    expect(runPrompt).toHaveBeenCalledOnce();
    expect(store.getBinding("b1")).toMatchObject({ generation: 1, traexSessionId: "terminal-1", agentSessionSource: "herdr:traex", agentSessionValue: sessionId });
    expect(store.getPrompt(store.listRunCards("b1")[0]!.promptId)).toMatchObject({ transcriptTurnId: turnId, transcriptTurnStartedAt: startedAt });
    expect(opens).toContain(sessionId);

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("waits for a first-turn transcript to appear after its session identity is known", async () => {
    const sessionId = "01a04440-4348-78a1-ac78-60927a085826";
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    let opens = 0;
    const transcriptReader: TraexTranscriptReaderPort = {
      async open(session) {
        opens += 1;
        expect(session).toEqual({ source: "herdr:traex", agent: "traex", kind: "id", value: sessionId });
        if (opens === 1) return { mode: "unavailable", reason: "transcript_not_found" };
        let read = false;
        return { mode: "typed", cursor: { async readDelta() { return ""; }, async readObservation() {
          const freshTurnStart = !read; const answerDelta = read ? "" : "JSONL created after session report"; read = true;
          return { turnId, freshTurnStart, answerDelta, turnLifecycle: { turnId, state: "active", startedAt: new Date().toISOString() } };
        } } };
      }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ ignored terminal text" });
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: sessionId });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "late-transcript-e1", messageId: "late-transcript-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "first turn", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));

    expect(opens).toBe(2);
    expect(store.listRunCards("b1")[0]!.answer).toBe("JSONL created after session report");
    expect(records).toContainEqual(expect.objectContaining({ event: "traex-transcript-source-upgraded", outcome: "typed" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("keeps terminal output out of the Answer when typed transcript reading fails", async () => {
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: { async readDelta() { throw new Error("transcript unavailable"); } } }; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ SECRET_TRANSCRIPT_FAILURE_TERMINAL" });
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "fallback-e1", messageId: "fallback-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "fallback work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE }));
    expect(store.listRunCards("b1")[0]!.answer).not.toContain("SECRET_TRANSCRIPT_FAILURE_TERMINAL");
    expect(records).toContainEqual(expect.objectContaining({ event: "traex-transcript-read-failed", unavailableReason: "transcript_read_failed", outcome: "structured_output_unavailable" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("ignores terminal redraws when structured output is unavailable", async () => {
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "unavailable", reason: "transcript_not_found" }; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: `◆ ${"old terminal line\n".repeat(2500)}` });
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ replacement terminal answer" });
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "redraw-e1", messageId: "redraw-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "redraw work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));
    const answer = store.listRunCards("b1")[0]!.answer;
    expect(answer).toBe(STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE);
    expect(answer).not.toContain("replacement terminal answer");

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("does not mix terminal text into an answer after typed output was established", async () => {
    let reads = 0;
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: { async readDelta() { return ""; }, async readObservation() {
        reads += 1;
        if (reads === 1) return { turnId, freshTurnStart: true, answerDelta: "authoritative typed answer", turnLifecycle: { turnId, state: "active" as const, startedAt: new Date().toISOString() } };
        throw new Error("transcript interrupted");
      } } }; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ first terminal screen" });
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ terminal after typed failure" });
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "mixed-e1", messageId: "mixed-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "typed then fail", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: "authoritative typed answer" }));
    expect(store.listRunCards("b1")[0]!.answer).not.toContain("terminal");
    expect(records).toContainEqual(expect.objectContaining({ event: "traex-transcript-read-failed", unavailableReason: "transcript_read_failed", outcome: "typed_output_preserved" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });
});

function fixture(herdr: HerdrPort, lark: LarkPort = quietLark()) {
  const store = new SqliteBindingStore(":memory:");
  const bus = new BridgeEventBus();
  const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
  const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
  return { coordinator, publisher, store, bus };
}

function emptyHerdr(): HerdrPort {
  return { async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} };
}

function quietLark(): LarkPort {
  return { async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; }, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
}

function collectingLogger(): { logger: ReturnType<typeof pino>; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const destination = { write(chunk: string) { records.push(JSON.parse(chunk) as Record<string, unknown>); } };
  return { logger: pino({ level: "trace" }, destination), records };
}

function message(index: number) {
  return { eventId: `e${index}`, messageId: `m${index}`, chatId: "chat", topicId: `m${index}`, rootMessageId: `m${index}`, actorOpenId: "user", text: "/swarm help", mentionsBot: true, isRootMessage: true };
}

function config(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] },
    herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" },
    projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
    defaultProjectId: "repo", projectsConfigPath: "test", traex: { executable: "traex", permissionMode: "auto", sessionsRoot: "/tmp/traex-sessions" }, databasePath: ":memory:",
    http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}
