import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { LarkPort, OutboundIntentPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { LarkOutboxDispatcher as ProductionLarkOutboxDispatcher } from "../src/events/lark-outbox-dispatcher.js";
import { OutboundIntentWriter } from "../src/events/outbound-intent-writer.js";
import { InProcessOutboundWorkNotifier } from "../src/events/outbound-work-notifier.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { answerElementId, createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { StartupViewConverger } from "../src/coordinator/startup-view-converger.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { answerStreamContent, renderAnswerStreamPage } from "../src/runtime/answer-stream.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { createWorkerMainView } from "../src/domain/worker-main-view.js";
import type { OutboundWorkNotifier } from "../src/events/outbound-work-notifier.js";
import { GatewayDeliveryError, type GatewayDeliveryPort, type PreparedGatewayDelivery } from "../src/gateways/contract/plugin.js";
import { createFeishuCompatibilityDelivery } from "../src/gateways/feishu/plugin.js";

class LarkOutboxDispatcher extends ProductionLarkOutboxDispatcher {
  constructor(store: SqliteBindingStore, lark: LarkPort, logger: Logger, work: OutboundWorkNotifier = new InProcessOutboundWorkNotifier(logger), safetyScanIntervalMs = 30_000) {
    super(store, createFeishuCompatibilityDelivery(lark), logger, work, safetyScanIntervalMs);
  }
}

afterEach(() => vi.useRealTimers());

describe("Lark channel publisher", () => {
  it("checkpoints Worker Main creation and emits a session-scoped convergence hint", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "primary-root", title: "Primary" });
    const worker = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-1", bindingGeneration: 2, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const view = createWorkerMainView({ workerId: worker.id, workerSessionGeneration: 1, parentBindingId: "binding-1", parentBindingGeneration: 2, parentPaneId: "primary-pane", workerName: worker.name, ownerName: "Primary", runtimeGeneration: worker.generation, runtimeState: worker.observedState, runtimeAttached: false, desiredState: worker.desiredState, parentActive: false, workspace: "/repo", branch: null, model: null, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.reserveWorkerMainCard(view, "primary-root", { schema: "2.0" });
    const replyCard = vi.fn(async () => ({ messageId: "worker-main-message", cardId: "worker-main-card" }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard }), pino({ enabled: false }));
    const checkpoint = vi.fn();
    publisher.onWorkerMainCheckpoint(checkpoint);

    await publisher.requestScan(true);

    expect(replyCard).toHaveBeenCalledOnce();
    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ messageId: "worker-main-message", cardId: "worker-main-card", deliveredVersion: 1 });
    expect(store.listPendingCardContextInvalidations()).toContainEqual(expect.objectContaining({ targetKind: "worker-session", targetId: worker.id, targetGeneration: 1, reason: "worker-main.delivered" }));
    expect(checkpoint).toHaveBeenCalledWith(worker.id, 1, 1);
    store.close();
  });

  it("creates a group-root pane entry and atomically activates its thread alias", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "chat", topicId: "canonical-topic", rootMessageId: "canonical-root", title: "Primary" });
    store.updateBinding("binding-1", { paneId: "w1:p1", statusMessageId: "canonical-root", state: "active", lifecycle: "active", attachment: "attached" });
    expect(store.reservePaneThreadAlias({ publicationKey: "publish-1", actionMessageId: "directory-card", bindingId: "binding-1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "canonical-root", targetChatId: "chat", card: { schema: "2.0" } })).toBe("reserved");
    const createTopic = vi.fn(async () => ({ topicId: "alias-topic", rootMessageId: "alias-root" }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ createTopic }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(createTopic).toHaveBeenCalledWith({ schema: "2.0" }, "publish-1", "chat");
    expect(store.findBindingByLarkScope("alias-topic", "alias-root")).toMatchObject({ id: "binding-1" });
    expect(store.database.prepare("SELECT state, topic_id, root_message_id FROM binding_thread_aliases WHERE publication_key = 'publish-1'").get()).toEqual({ state: "active", topic_id: "alias-topic", root_message_id: "alias-root" });
    expect(store.reservePaneThreadAlias({ publicationKey: "publish-1", actionMessageId: "directory-card", bindingId: "binding-1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "canonical-root", targetChatId: "chat", card: { schema: "2.0" } })).toBe("duplicate");
    expect(store.listPendingOutboundReplies()).toEqual([]);
    store.updateBinding("binding-1", { generation: 2 });
    expect(store.findBindingByLarkScope("alias-topic", "alias-root")).toBeNull();
    store.close();
  });

  it("creates a canonical group-root Worker Main Card and emits its session checkpoint", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "primary-topic", rootMessageId: "primary-root", title: "Primary" });
    store.updateBinding("binding-1", { paneId: "primary-pane", statusMessageId: "primary-root", state: "active", lifecycle: "active", attachment: "attached" });
    const worker = store.createWorkerAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "binding-1", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: null }, workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
    const view = createWorkerMainView({ workerId: worker.id, workerSessionGeneration: 1, parentBindingId: "binding-1", parentBindingGeneration: 1, parentPaneId: "primary-pane", workerName: worker.name, ownerName: "Primary", runtimeGeneration: worker.generation, runtimeState: worker.observedState, runtimeAttached: false, desiredState: worker.desiredState, parentActive: true, workspace: "/repo", branch: null, model: null, occurredAt: "2026-09-11T00:00:00.000Z" });
    store.saveWorkerMainView(view);
    store.workerSessionThreads.reserve({ publicationKey: "worker-thread:reviewer:1", workerId: worker.id, workerSessionGeneration: 1, parentBindingId: "binding-1", parentBindingGeneration: 1, parentPaneId: "primary-pane", targetChatId: "chat", mode: "canonical-main", viewVersion: view.viewVersion, card: { schema: "2.0" } });
    const createTopic = vi.fn(async () => ({ topicId: "worker-topic", rootMessageId: "worker-root" }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ createTopic }), pino({ enabled: false }));
    const checkpoint = vi.fn();
    publisher.onWorkerMainCheckpoint(checkpoint);

    await publisher.requestScan(true);

    expect(createTopic).toHaveBeenCalledWith({ schema: "2.0" }, "worker-thread:reviewer:1", "chat");
    expect(store.workerSessionThreads.resolveScope({ chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root" })).toMatchObject({ kind: "active", target: { workerId: worker.id, rootMessageId: "worker-root" } });
    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ messageId: "worker-root", deliveredVersion: view.viewVersion });
    expect(checkpoint).toHaveBeenCalledWith(worker.id, 1, view.viewVersion);
    store.close();
  });

  it("still checkpoints a delivered legacy Worker task card and emits a turn-scoped convergence hint", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const view = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: "review", queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
    store.acceptInstanceTurnWithCard({ id: "turn-1", idempotencyKey: "lark:m1", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review", parentTurnId: null, sourceMessageId: "m1", view, render: renderWorkerTurnCard });
    store.enqueueOutboundReply({ id: "legacy-create", idempotencyKey: "worker-turn:create:turn-1:0", workerTurnId: "turn-1", viewVersion: view.viewVersion, rootMessageId: "root-1", kind: "stream_card_create", payload: JSON.stringify({ card: renderWorkerTurnCard(view), stream: { pageIndex: 0, pageStart: 0, elementId: view.elementId } }) });
    const create = vi.fn(async () => ({ messageId: "worker-message-1", cardId: "worker-card-1" }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyStreamingCard: create }), pino({ enabled: false }));
    const checkpoint = vi.fn();
    publisher.onWorkerTurnCheckpoint(checkpoint);

    await publisher.requestScan(true);

    expect(create).toHaveBeenCalledOnce();
    expect(store.loadWorkerTurnCard("turn-1")).toMatchObject({ messageId: "worker-message-1", cardId: "worker-card-1", deliveredVersion: 1 });
    expect(store.listWorkerTurnCardPages("turn-1")).toEqual([expect.objectContaining({ pageIndex: 0, messageId: "worker-message-1", cardId: "worker-card-1", state: "active" })]);
    expect(checkpoint).toHaveBeenCalledWith("turn-1", 2);
    store.close();
  });

  it("permanently rejects cross-turn Worker card, message, and element targets", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    for (const turnId of ["turn-a", "turn-b", "turn-c", "turn-d"]) {
      const view = createQueuedWorkerTurnCard({ turnId, instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: turnId, queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
      store.acceptInstanceTurnWithCard({ id: turnId, idempotencyKey: turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: turnId, parentTurnId: null, sourceMessageId: `message-${turnId}`, view, render: renderWorkerTurnCard });
      const createId = `legacy-create-${turnId}`;
      store.enqueueOutboundReply({ id: createId, idempotencyKey: `worker-turn:create:${turnId}:0`, workerTurnId: turnId, viewVersion: view.viewVersion, rootMessageId: "root-1", kind: "stream_card_create", payload: JSON.stringify({ card: renderWorkerTurnCard(view), stream: { pageIndex: 0, pageStart: 0, elementId: view.elementId } }) });
      store.markOutboundReplyDelivered(createId, `worker-message-${turnId}`, `worker-card-${turnId}`);
    }
    store.enqueueOutboundReply({ id: "wrong-turn", idempotencyKey: "wrong-turn", workerTurnId: "turn-b", viewVersion: 1, rootMessageId: "worker-card-turn-a", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: "worker_turn_turn_a_0", content: "x", sequence: 1 }) });
    store.enqueueOutboundReply({ id: "wrong-card", idempotencyKey: "wrong-card", workerTurnId: "turn-c", viewVersion: 1, rootMessageId: "worker-card-turn-a", kind: "stream_finish", payload: JSON.stringify({ pageIndex: 0, summary: "done", sequence: 1 }) });
    store.enqueueOutboundReply({ id: "wrong-element", idempotencyKey: "wrong-element", workerTurnId: "turn-d", viewVersion: 1, rootMessageId: "worker-card-turn-d", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: "worker_turn_turn_a_0", content: "x", sequence: 1 }) });
    store.enqueueOutboundReply({ id: "wrong-message", idempotencyKey: "wrong-message", workerTurnId: "turn-a", viewVersion: 2, rootMessageId: "worker-message-turn-b", kind: "card_update", payload: JSON.stringify({ schema: "2.0" }) });
    const stream = vi.fn(async () => {});
    const finish = vi.fn(async () => {});
    const update = vi.fn(async () => {});
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ streamCardContent: stream, finishStreamingCard: finish, updateCard: update }), pino({ enabled: false }));

    await publisher.requestScan(true);

    expect(stream).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(store.database.prepare("SELECT id, state, failure_class FROM outbound_replies WHERE id LIKE 'wrong-%' ORDER BY id").all()).toEqual([
      { id: "wrong-card", state: "dead_letter", failure_class: "permanent" },
      { id: "wrong-element", state: "dead_letter", failure_class: "permanent" },
      { id: "wrong-message", state: "dead_letter", failure_class: "permanent" },
      { id: "wrong-turn", state: "dead_letter", failure_class: "permanent" }
    ]);
    store.close();
  });
  it("checkpoints a delivered Main Card version and emits a convergence hint", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1" });
    store.reserveMainCard({ ...initialTopicView("b1"), title: "Version 2", viewVersion: 2, deliveredVersion: 1 }, "root-1", { version: 2 });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ updateCard: vi.fn(async () => {}) }), pino({ enabled: false }));
    const checkpoint = vi.fn();
    publisher.onMainCardCheckpoint(checkpoint);

    await publisher.requestScan(true);

    expect(store.loadTopicView("b1")).toMatchObject({ viewVersion: 2, deliveredVersion: 2 });
    expect(checkpoint).toHaveBeenCalledWith("b1", 2);
    store.close();
  });

  it("does not reinterpret a successful delivery when a checkpoint listener fails", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1" });
    store.reserveMainCard({ ...initialTopicView("b1"), title: "Version 2", viewVersion: 2, deliveredVersion: 1 }, "root-1", { version: 2 });
    const updateCard = vi.fn(async () => {});
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ updateCard }), logger);
    publisher.onMainCardCheckpoint(() => { throw new Error("checkpoint failed"); });

    await expect(publisher.requestScan(true)).resolves.toBeUndefined();

    expect(updateCard).toHaveBeenCalledOnce();
    expect(store.database.prepare("SELECT state, attempt_count FROM outbound_replies").get()).toEqual({ state: "delivered", attempt_count: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "gateway-outbox-checkpoint-listener-failed", outcome: "isolated" }), expect.any(String));
    store.close();
  });

  it("uses a contiguous CardKit sequence when Main Card view versions skip", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1" });
    store.reserveMainCard({ ...initialTopicView("b1"), title: "Version 7", viewVersion: 7, deliveredVersion: 6 }, "root-1", { version: 7 });
    const updateCardKit = vi.fn(async () => {});
    const updateCard = vi.fn(async () => {});
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ updateCardKit, updateCard }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(updateCardKit).toHaveBeenCalledWith("main-1", { version: 7 }, 1);
    expect(store.getBinding("b1")?.statusCardSequence).toBe(1);

    store.reserveMainCard({ ...initialTopicView("b1"), title: "Version 10", viewVersion: 10, deliveredVersion: 7 }, "root-1", { version: 10 });
    await publisher.requestScan();

    expect(updateCardKit).toHaveBeenLastCalledWith("main-1", { version: 10 }, 2);
    expect(store.getBinding("b1")?.statusCardSequence).toBe(2);
    store.close();
  });

  it("rebuilds a locked Main Card once instead of retrying its stale message target", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "locked-main" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Current", viewVersion: 2, deliveredVersion: 1 });
    store.reserveMainCard(store.loadTopicView("b1")!, "root-1", { version: 2 });
    const locked = Object.assign(new Error("Request failed with status code 400"), { response: { status: 400, data: { code: 230099, msg: "card action is lock" } } });
    const updateCard = vi.fn(async () => { throw locked; });
    const replyCard = vi.fn(async () => ({ messageId: "replacement-main" }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ updateCard, replyCard }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(updateCard).toHaveBeenCalledOnce();
    expect(replyCard).toHaveBeenCalledOnce();
    expect(store.getBinding("b1")?.statusMessageId).toBe("replacement-main");
    expect(store.loadTopicView("b1")).toMatchObject({ viewVersion: 2, deliveredVersion: 2 });
    expect(store.database.prepare("SELECT kind, state, attempt_count, lark_error_code FROM outbound_replies ORDER BY delivery_order").all()).toEqual([
      { kind: "card_update", state: "dead_letter", attempt_count: 1, lark_error_code: "230099" },
      { kind: "card_reply", state: "delivered", attempt_count: 1, lark_error_code: null }
    ]);
    store.close();
  });

  it("rebuilds a Main Card after a CardKit sequence conflict", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "stale-main" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Current", viewVersion: 8, deliveredVersion: 7 });
    store.reserveMainCard(store.loadTopicView("b1")!, "root-1", { version: 8 });
    const conflict = Object.assign(new Error('Lark CardKit update failed (code=300317, msg="sequence number compare failed")'), { larkCode: 300317 });
    const updateCardKit = vi.fn(async () => { throw conflict; });
    const replyCard = vi.fn(async () => ({ messageId: "replacement-main" }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ updateCardKit, replyCard }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(updateCardKit).toHaveBeenCalledOnce();
    expect(replyCard).toHaveBeenCalledOnce();
    expect(store.getBinding("b1")?.statusMessageId).toBe("replacement-main");
    expect(store.loadTopicView("b1")).toMatchObject({ viewVersion: 8, deliveredVersion: 8 });
    expect(store.database.prepare("SELECT kind, state, attempt_count, lark_error_code FROM outbound_replies ORDER BY delivery_order").all()).toEqual([
      { kind: "card_update", state: "dead_letter", attempt_count: 1, lark_error_code: "300317" },
      { kind: "card_reply", state: "delivered", attempt_count: 1, lark_error_code: null }
    ]);
    store.close();
  });

  it("does not rebuild a Main Card when a non-CardKit update returns a sequence conflict", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1" });
    store.reserveMainCard({ ...initialTopicView("b1"), viewVersion: 2, deliveredVersion: 1 }, "root-1", { version: 2 });
    const conflict = Object.assign(new Error("sequence conflict"), { larkCode: 300317 });
    const updateCard = vi.fn(async () => { throw conflict; });
    const replyCard = vi.fn(async () => ({ messageId: "replacement-main" }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ updateCard, replyCard }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(updateCard).toHaveBeenCalledOnce();
    expect(replyCard).not.toHaveBeenCalled();
    expect(store.getBinding("b1")?.statusMessageId).toBe("main-1");
    expect(store.database.prepare("SELECT kind, state, lark_error_code FROM outbound_replies").all()).toEqual([
      { kind: "card_update", state: "dead_letter", lark_error_code: "300317" }
    ]);
    store.close();
  });

  it("records only the explicit session-status reply as the binding status card", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "status-1" });
    const replyCard = vi.fn(async () => ({ messageId: "operation-1" }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard }), pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueCard("root-1", "model:operation-1:confirmed", { schema: "2.0" }, "b1");

    expect(store.getBinding("b1")?.statusMessageId).toBe("status-1");
    replyCard.mockResolvedValueOnce({ messageId: "status-2" });
    await connectedWriter(store, publisher).enqueueCard("root-1", "status-card:b1", { schema: "2.0" }, "b1", "session_status");
    expect(store.getBinding("b1")?.statusMessageId).toBe("status-2");
    store.close();
  });

  it("creates one CardKit answer and streams cumulative content without patching the message", async () => {
    const create = vi.fn(async () => ({ messageId: "answer-1", cardId: "cardkit-1" }));
    const stream = vi.fn(async () => {});
    const updateCard = vi.fn(async () => {});
    const lark = fakeLark({ replyStreamingCard: create, streamCardContent: stream, updateCard });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    await publisher.requestScan();
    await connectedWriter(store, publisher).enqueueStreamContent("b1", "p1", "cardkit-1", answerElementId("p1", 0), "Working\nDone", 2);

    expect(create).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledWith("cardkit-1", answerElementId("p1", 0), "Working\nDone", 2);
    expect(updateCard).not.toHaveBeenCalled();
    store.close();
  });

  it("checkpoints an empty legacy stream update without calling Lark", async () => {
    const stream = vi.fn(async () => {});
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    store.enqueueOutboundReply({ id: "empty-content", idempotencyKey: "empty-content", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: "", sequence: 2 }) });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ streamCardContent: stream }), pino({ enabled: false }));
    const checkpoint = vi.fn();
    publisher.onAnswerCheckpoint(checkpoint);

    await publisher.requestScan();

    expect(stream).not.toHaveBeenCalled();
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'empty-content'").get()).toEqual({ state: "delivered" });
    expect(checkpoint).toHaveBeenCalledWith("p1", 2);
    store.close();
  });

  it("finalizes an Answer stream through settings without replacing the card tree", async () => {
    const finish = vi.fn(async () => {});
    const updateCard = vi.fn(async () => {});
    const lark = fakeLark({ finishStreamingCard: finish, updateCard });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueStreamFinish("b1", "p1", "cardkit-1", "Completed", 3);

    expect(finish).toHaveBeenCalledWith("cardkit-1", 3, "Completed");
    expect(updateCard).not.toHaveBeenCalled();
    store.close();
  });

  it("rejects a stream target belonging to another prompt", async () => {
    const stream = vi.fn(async () => {});
    const lark = fakeLark({ streamCardContent: stream });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const first = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "First", workspaceId: "w1", paneId: "w1:p1", requestText: "first", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "first" }, view: first, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    const second = createQueuedRunCard({ promptId: "p2", bindingId: "b1", title: "Second", workspaceId: "w1", paneId: "w1:p1", requestText: "second", queuePosition: 1, occurredAt: "later" });
    store.acceptPrompt({ prompt: { id: "p2", bindingId: "b1", larkMessageId: "user-2", actorOpenId: "u1", body: "second" }, view: second, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) { if (reply.promptId === "p2") store.markOutboundReplyDelivered(reply.id, "answer-2", "cardkit-2"); }
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));

    await expect(connectedWriter(store, publisher).enqueueStreamContent("b1", "p2", "cardkit-1", "answer-content-p1-0", "wrong target", 2)).rejects.toThrow(/target mismatch/);
    expect(stream).not.toHaveBeenCalled();
    store.close();
  });

  it("dismisses a stale old-page stream event so the continuation lane can advance", async () => {
    const stream = vi.fn(async () => {});
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    store.database.exec("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1'; INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 1, 'answer-2', 'cardkit-2', 'answer_content_p1_1', 3500, 0, 'active', 'streaming', 'now', 'now'); UPDATE run_cards SET answer_message_id = 'answer-2', answer_card_id = 'cardkit-2', answer_element_id = 'answer_content_p1_1', answer_page_index = 1, answer_page_start = 3500 WHERE prompt_id = 'p1';");
    store.enqueueOutboundReply({ id: "stale-content", idempotencyKey: "stream:p1:cardkit-1:2", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ elementId: answerElementId("p1", 0), content: "stale", sequence: 2 }) });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ streamCardContent: stream }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(stream).not.toHaveBeenCalled();
    expect(store.database.prepare("SELECT state, error FROM outbound_replies WHERE id = 'stale-content'").get()).toEqual({ state: "dismissed", error: "Answer stream superseded by a continuation page" });
    expect(store.getOperationalSummary().deadLetters).toBe(0);
    store.close();
  });

  it("quarantines a permanently rejected Answer sequence without crossing its content boundary", async () => {
    const permanent = Object.assign(new Error("invalid sequence"), { response: { status: 400, data: { code: 200740 } } });
    const stream = vi.fn(async () => { throw permanent; });
    const replyText = vi.fn(async () => ({ messageId: "text-1" }));
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    for (const sequence of [1, 2]) store.enqueueOutboundReply({
      id: `content-${sequence}`, idempotencyKey: `content-${sequence}`, bindingId: "b1", promptId: "p1", viewVersion: sequence, cardRole: "answer",
      rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: `snapshot-${sequence}`, sequence })
    });
    store.enqueueOutboundReply({ id: "unrelated", idempotencyKey: "unrelated", rootMessageId: "root-2", kind: "text", payload: "still deliver" });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ streamCardContent: stream, replyText }), pino({ enabled: false }));
    const checkpoint = vi.fn();
    const workflow = new AnswerPageWorkflow(store, () => {}, primaryPresentation, pino({ enabled: false }));
    let convergence = Promise.resolve();
    publisher.onAnswerCheckpoint((promptId, version) => { checkpoint(promptId, version); convergence = workflow.converge(promptId); });

    await publisher.requestScan();

    expect(stream).toHaveBeenCalledTimes(1);
    expect(replyText).toHaveBeenCalledTimes(1);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(store.database.prepare("SELECT id, state FROM outbound_replies WHERE id IN ('content-1','content-2') ORDER BY delivery_order").all()).toEqual([
      { id: "content-1", state: "dead_letter" }, { id: "content-2", state: "dismissed" }
    ]);
    await convergence;
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.listAnswerPages("p1")).toMatchObject([{ pageIndex: 0, sourceStart: 0, state: "active" }]);
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = 'content-1'").get()).toEqual({ state: "active", action: "blocked" });
    await publisher.stop();
    store.close();
  });

  it("keeps a failed card pending and delivers it during a later drain", async () => {
    let fail = true;
    const cards: object[] = [];
    const lark = fakeLark({ async replyCard(_root, card) { if (fail) throw Object.assign(new Error("temporary"), { response: { status: 503 } }); cards.push(card); return { messageId: "card-1" }; } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    publisher.start();

    await connectedWriter(store, publisher).enqueueCard("root-1", "standalone:1", { schema: "2.0" });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    fail = false;
    await publisher.requestScan(true);
    expect(cards).toEqual([{ schema: "2.0" }]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    await publisher.stop(); store.close();
  });

  it("persists one prepared Gateway plan before claim and reuses it across retries", async () => {
    const plans: PreparedGatewayDelivery[] = [];
    let fail = true;
    const gateway: GatewayDeliveryPort = {
      prepare: vi.fn((intent) => ({ protocolVersion: 1, gatewayId: "feishu:primary", profileId: "feishu-cardkit-v1", rendererRevision: 1, operation: intent.kind, intent })),
      execute: vi.fn(async (plan) => {
        plans.push(structuredClone(plan));
        if (fail) throw new GatewayDeliveryError({ failureClass: "transient", effectCertainty: "rejected", providerCode: null, httpStatus: 503, safeMessage: "unavailable" });
        return { refs: [{ gatewayId: "feishu:primary", kind: "message", opaqueId: "message-1" }] };
      })
    };
    const store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "frozen-plan", idempotencyKey: "frozen-plan", rootMessageId: "root-1", kind: "card_reply", payload: '{"schema":"2.0"}' });
    const publisher = new ProductionLarkOutboxDispatcher(store, gateway, pino({ enabled: false }), new InProcessOutboundWorkNotifier(pino({ enabled: false })));

    await publisher.requestScan(true);
    const persisted = store.getOutboundReply("frozen-plan")!;
    expect(persisted).toMatchObject({ state: "pending", attemptCount: 1, gatewayPlanJson: expect.any(String), gatewayPlanHash: expect.any(String) });
    fail = false;
    await publisher.requestScan(true);

    expect(gateway.prepare).toHaveBeenCalledTimes(1);
    expect(gateway.execute).toHaveBeenCalledTimes(2);
    expect(plans).toHaveLength(2);
    expect(plans[1]).toEqual(plans[0]);
    expect(store.getOutboundReply("frozen-plan")).toMatchObject({ state: "delivered", gatewayPlanJson: persisted.gatewayPlanJson, gatewayPlanHash: persisted.gatewayPlanHash });
    await publisher.stop(); store.close();
  });

  it("retries a failed final folded Answer Card update without recreating the answer", async () => {
    let fail = true;
    const updateCard = vi.fn(async () => { if (fail) throw Object.assign(new Error("temporary"), { response: { status: 503 } }); });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ updateCard }), pino({ enabled: false }));
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");

    store.enqueueOutboundReply({
      id: "final-fold", idempotencyKey: "answer-final-fold:p1:0:cardkit-1", bindingId: "b1", promptId: "p1", viewVersion: 9, cardRole: "answer",
      rootMessageId: "answer-1", kind: "card_update", payload: JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "collapsible_panel" }] } })
    });

    await publisher.requestScan();
    expect(store.listPendingOutboundReplies()).toMatchObject([{ id: "final-fold", kind: "card_update", rootMessageId: "answer-1" }]);
    fail = false;
    await publisher.requestScan(true);

    expect(updateCard).toHaveBeenCalledTimes(2);
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'final-fold'").get()).toEqual({ state: "delivered" });
    store.close();
  });

  it("signals the projector after a continuation card succeeds on retry", async () => {
    let fail = true;
    const created = vi.fn(async () => {
      if (fail) throw Object.assign(new Error("temporary"), { response: { status: 503 } });
      return { messageId: "answer-2", cardId: "cardkit-2" };
    });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyStreamingCard: created }), pino({ enabled: false }));
    const resumed = vi.fn();
    publisher.onAnswerCheckpoint(resumed);
    store.enqueueOutboundReply({
      id: "page-2", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 7, cardRole: "answer",
      rootMessageId: "root-1", kind: "stream_card_create",
      payload: JSON.stringify({ card: { schema: "2.0", body: { elements: [{ element_id: answerElementId("p1", 1) }] } }, stream: { pageIndex: 1, pageStart: 28_000, elementId: answerElementId("p1", 1) } })
    });

    await publisher.requestScan();
    expect(resumed).not.toHaveBeenCalled();
    fail = false;
    await publisher.requestScan(true);

    expect(created).toHaveBeenCalledTimes(2);
    expect(resumed).toHaveBeenCalledWith("p1", 8);
    store.close();
  });

  it("archives a closed Answer stream and continues on a new static Answer Card", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "cardkit-1");
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "running", answer: "partial answer", answerSegments: ["partial answer"], viewVersion: 2 });
    const workflow = new AnswerPageWorkflow(store, () => {}, primaryPresentation, pino({ enabled: false }));
    await workflow.converge("p1");

    const streamClosed = Object.assign(new Error("Lark CardKit content update failed (code=300309, msg=streaming mode is closed)"), { larkCode: 300309 });
    const updateCard = vi.fn(async () => {});
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      streamCardContent: vi.fn(async () => { throw streamClosed; }), updateCard,
      replyStreamingCard: vi.fn(async () => ({ messageId: "answer-2", cardId: "cardkit-2" }))
    }), pino({ enabled: false }));
    let convergence = Promise.resolve();
    publisher.onAnswerCheckpoint((promptId) => { convergence = workflow.converge(promptId); });

    await publisher.requestScan(true);
    await convergence;

    expect(store.listAnswerPages("p1")).toEqual(expect.arrayContaining([expect.objectContaining({ pageIndex: 0, state: "frozen", deliveryMode: "static", messageId: "answer-1" })]));
    expect(store.getOperationalSummary()).toMatchObject({ deadLetters: 1, unresolvedDeadLetters: 1, outboxQuarantines: { active: 0, released: 1, byLaneClass: { answer_stream: 1 } } });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "stream_card_create", cardRole: "answer", rootMessageId: "root-1" })]);

    await publisher.requestScan();
    await convergence;

    expect(updateCard).toHaveBeenCalledOnce();
    expect(updateCard.mock.calls[0]![0]).toBe("answer-2");
    expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 0, deliveryRecoveries: { recovered: 1 } });
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen", deliveryMode: "static", messageId: "answer-1" }),
      expect.objectContaining({ pageIndex: 1, state: "active", deliveryMode: "static", messageId: "answer-2" })
    ]);
    expect(store.listPendingOutboundReplies()).toEqual([]);

    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "later answer", answerSegments: ["later answer"], viewVersion: 3 });
    await workflow.converge("p1");
    await publisher.requestScan();

    expect(updateCard).toHaveBeenCalledTimes(2);
    expect(updateCard.mock.calls[1]![0]).toBe("answer-2");
    expect(JSON.stringify(updateCard.mock.calls[1]![1])).toContain("later answer");
    expect(store.listPendingOutboundReplies()).toEqual([]);
    await publisher.stop();
    store.close();
  });

  it("does not replace an Answer when stream finalization returns the closed-content code", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "cardkit-1");
    const closed = Object.assign(new Error("streaming mode is closed"), { larkCode: 300309 });
    const finishStreamingCard = vi.fn(async () => { throw closed; });
    const replyStreamingCard = vi.fn(async () => ({ messageId: "answer-2", cardId: "cardkit-2" }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ finishStreamingCard, replyStreamingCard }), pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueStreamFinish("b1", "p1", "cardkit-1", "Completed", 2);

    expect(finishStreamingCard).toHaveBeenCalledOnce();
    expect(replyStreamingCard).not.toHaveBeenCalled();
    expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "active", deliveryMode: "streaming", messageId: "answer-1" })]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.getOperationalSummary()).toMatchObject({ deadLetters: 1, outboxQuarantines: { active: 1, byLaneClass: { answer_stream: 1 } } });
    store.close();
  });

  it("streams canonical content from the preserved offset after a lightweight startup replacement is delivered", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "cardkit-1");
    const answer = Array.from({ length: 14_000 }, (_, index) => `line-${index}`).join("\n");
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer, answerSegments: [answer], viewVersion: 20 });
    store.database.prepare("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1'").run();
    store.database.prepare("INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 12, 'answer-12', 'cardkit-12', ?, 100000, 0, 'active', 'streaming', 'now', 'now')").run(answerElementId("p1", 12));
    store.database.prepare("UPDATE run_cards SET answer_message_id = 'answer-12', answer_card_id = 'cardkit-12', answer_element_id = ?, answer_page_index = 12, answer_page_start = 100000 WHERE prompt_id = 'p1'").run(answerElementId("p1", 12));
    expect(store.reserveAnswerContinuation({
      promptId: "p1", pageIndex: 12, cardId: "cardkit-12", messageId: "answer-12", summary: "continued", finalizedCard: {}, nextPageIndex: 13, nextPageStart: 109_267,
      nextElementId: answerElementId("p1", 13), rootMessageId: "root-1", viewVersion: 20,
      card: { body: { elements: [{ tag: "markdown", element_id: answerElementId("p1", 13), content: "x".repeat(10_000) }] } }
    })).toBe("reserved");
    const finish = store.listPendingOutboundReplies().find((reply) => reply.kind === "stream_finish")!;
    store.markOutboundReplyDelivered(finish.id, "cardkit-12");
    const failedCreate = store.listPendingOutboundReplies().find((reply) => reply.kind === "stream_card_create")!;
    store.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = ?").run(failedCreate.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.markOutboundReplyFailedWithQuarantine(failedCreate.id, "timeout", { failureClass: "transient", httpStatus: 504, larkErrorCode: "2200" });
    }
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: ["p1"], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, terminalizedQuarantines: 0 });

    const create = vi.fn(async () => ({ messageId: "answer-13", cardId: "cardkit-13" }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      replyStreamingCard: create,
      async streamCardContent() { throw Object.assign(new Error("content temporarily unavailable"), { response: { status: 503 } }); }
    }), pino({ enabled: false }));
    const workflow = new AnswerPageWorkflow(store, () => {}, primaryPresentation, pino({ enabled: false }));
    let convergence = Promise.resolve();
    publisher.onAnswerCheckpoint((promptId) => { convergence = workflow.converge(promptId); });

    await publisher.requestScan();
    await convergence;

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toBe("root-1");
    expect(JSON.stringify(create.mock.calls[0]![1])).toContain("正在恢复本页内容");
    expect(store.getActiveAnswerPage("p1")).toMatchObject({ pageIndex: 13, sourceStart: 109_267, messageId: "answer-13", cardId: "cardkit-13" });
    const content = store.listPendingOutboundReplies().find((reply) => reply.kind === "stream_content")!;
    expect(JSON.parse(content.payload)).toMatchObject({
      pageIndex: 13, elementId: answerElementId("p1", 13),
      content: renderAnswerStreamPage(answerStreamContent(store.loadRunCard("p1")!), 109_267).page
    });
    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(0);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.markOutboundReplyFailedWithQuarantine(content.id, "timeout", { failureClass: "transient", httpStatus: 504, larkErrorCode: "2200" });
    }
    await workflow.converge("p1");

    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen" }),
      expect.objectContaining({ pageIndex: 12, state: "frozen" }),
      expect.objectContaining({ pageIndex: 13, sourceStart: 109_267, state: "active", messageId: "answer-13", cardId: "cardkit-13" })
    ]);
    expect(store.listPendingOutboundReplies().some((reply) => reply.kind === "stream_card_create")).toBe(false);
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = ?").get(content.id)).toEqual({ state: "dead_letter" });
    await publisher.stop();
    store.close();
  });

  it("reuses a checkpointed CardKit entity when replying is retried", async () => {
    let failReply = true;
    const create = vi.fn(async () => ({ cardId: "cardkit-1" }));
    const reply = vi.fn(async (_root: string, cardId: string, idempotencyKey: string) => {
      if (failReply) throw Object.assign(new Error("temporary"), { response: { status: 503 } });
      return { messageId: `message-for-${cardId}-${idempotencyKey}` };
    });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ createStreamingCard: create, replyStreamingCardReference: reply }), pino({ enabled: false }));

    await publisher.requestScan();
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.listPendingOutboundReplies()[0]).toMatchObject({ cardIdCheckpoint: "cardkit-1" });
    failReply = false;
    await publisher.requestScan(true);

    expect(create).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenLastCalledWith("root-1", "cardkit-1", "run-card:create:p1:answer");
    expect(store.loadRunCard("p1")).toMatchObject({ answerMessageId: "message-for-cardkit-1-run-card:create:p1:answer", answerCardId: "cardkit-1" });
    store.close();
  });

  it("does not retry an idempotent reply whose remote outcome is uncertain", async () => {
    const logicalMessages = new Map<string, string>();
    let firstAttempt = true;
    const reply = vi.fn(async (_root: string, _cardId: string, idempotencyKey: string) => {
      const messageId = logicalMessages.get(idempotencyKey) ?? `message-${logicalMessages.size + 1}`;
      logicalMessages.set(idempotencyKey, messageId);
      if (firstAttempt) { firstAttempt = false; throw Object.assign(new Error("timeout after acceptance"), { code: "ETIMEDOUT" }); }
      return { messageId };
    });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async createStreamingCard() { return { cardId: "cardkit-1" }; },
      replyStreamingCardReference: reply
    }), pino({ enabled: false }));

    await publisher.requestScan();
    await publisher.requestScan(true);

    expect(reply.mock.calls.map((call) => call[2])).toEqual(["run-card:create:p1:answer"]);
    expect(logicalMessages).toEqual(new Map([["run-card:create:p1:answer", "message-1"]]));
    expect(store.loadRunCard("p1")).toMatchObject({ answerMessageId: null, answerCardId: null });
    expect(store.database.prepare("SELECT state, failure_class, effect_certainty FROM outbound_replies WHERE prompt_id = ?").get("p1")).toEqual({ state: "dead_letter", failure_class: "unknown", effect_certainty: "uncertain" });
    expect(store.getOperationalSummary()).toMatchObject({ uncertainDeliveryEffects: 1, eligibleDeadLetterRecoveries: 0, outboxQuarantines: { active: 1 } });
    store.close();
  });

  it("dead-letters content rejected by Lark on the first attempt", async () => {
    const rejection = Object.assign(new Error("content rejected"), { response: { status: 400, data: { code: 230028 } } });
    const replyCard = vi.fn(async () => { throw rejection; });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard }), pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueCard("root-1", "content-rejected", { schema: "2.0" });
    await publisher.requestScan(true);

    expect(replyCard).toHaveBeenCalledOnce();
    const persisted = store.database.prepare("SELECT id FROM outbound_replies WHERE idempotency_key = ?").get("content-rejected") as { id: string };
    expect(store.getOutboundReply(persisted.id)).toMatchObject({
      state: "dead_letter", attemptCount: 1, failureClass: "permanent",
      effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230028"
    });
    expect(store.getOperationalSummary().eligibleDeadLetterRecoveries).toBe(0);
    store.close();
  });

  it("dead-letters a stale continuation create without calling Lark or retrying", async () => {
    const create = vi.fn(async () => ({ messageId: "answer-2", cardId: "cardkit-2" }));
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    store.enqueueOutboundReply({ id: "stale-page", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "root-1", kind: "stream_card_create", payload: JSON.stringify({ card: {}, stream: { pageIndex: 2, pageStart: 20_000, elementId: answerElementId("p1", 2) } }) });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyStreamingCard: create }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(create).not.toHaveBeenCalled();
    expect(store.getOperationalSummary().deadLetters).toBe(1);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.loadRunCard("p1")).toMatchObject({ answerCardId: "cardkit-1", answerPageIndex: 0 });
    store.close();
  });

  it.each([
    { name: "non-derived metadata id", metadataId: "element_wrong", cardId: "element_wrong" },
    { name: "card id differing from metadata", metadataId: answerElementId("p1", 1), cardId: "element_wrong" }
  ])("dead-letters a continuation with $name", async ({ metadataId, cardId }) => {
    const create = vi.fn(async () => ({ messageId: "answer-2", cardId: "cardkit-2" }));
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    store.enqueueOutboundReply({
      id: "invalid-page", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "root-1", kind: "stream_card_create",
      payload: JSON.stringify({ card: { body: { elements: [{ element_id: cardId }] } }, stream: { pageIndex: 1, pageStart: 20_000, elementId: metadataId } })
    });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyStreamingCard: create }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(create).not.toHaveBeenCalled();
    expect(store.getOperationalSummary().deadLetters).toBe(1);
    store.close();
  });

  it("logs retry and dead-letter decisions without card payloads", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const debug = vi.fn();
    const logger = { warn, error, debug } as unknown as Logger;
    const lark = fakeLark({ async replyCard() { throw Object.assign(new Error("network unavailable"), { response: { status: 503 } }); } });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const publisher = new LarkOutboxDispatcher(store, lark, logger);

    await connectedWriter(store, publisher).enqueueCard("root-1", "failure:1", { secret: "private card payload" }, "b1");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "gateway-outbox-retry-scheduled", replyKind: "card_reply", attempt: 1, outcome: "retry" }), expect.any(String));
    for (let attempt = 0; attempt < 4; attempt += 1) await publisher.requestScan(true);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "gateway-outbox-dead-lettered", attempt: 5, outcome: "dead_letter" }), expect.any(String));
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain("private card payload");
    expect(store.getOperationalSummary()).toMatchObject({ deadLetters: 1, pendingOutbox: 0 });
    store.close();
  });

  it("does not serialize Axios request details into delivery failure logs", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const logger = { warn, error, debug: vi.fn() } as unknown as Logger;
    const failure = Object.assign(new Error("Request failed with status code 400"), {
      code: "ERR_BAD_REQUEST",
      config: { headers: { Authorization: "Bearer top-secret" }, data: "private card payload" },
      request: { _header: "Authorization: Bearer top-secret" },
      response: { status: 400, data: { code: 230099, msg: "card action is lock", private: "response body" } }
    });
    const lark = fakeLark({ async updateCard() { throw failure; } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, logger);

    await connectedWriter(store, publisher).enqueueCardUpdate(null, "card-1", "failure:safe-error", { secret: "private card payload" });

    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      event: "gateway-outbox-dead-lettered", deliveryOperation: "update_card", deliveryTarget: "operation-result",
      err: { name: "Error", message: "Request failed with status code 400", code: "ERR_BAD_REQUEST", status: 400, larkCode: 230099 }
    }), "Gateway outbox reply was permanently rejected");
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/top-secret|private card payload|response body|Authorization|config|request|response/);
    await publisher.stop();
    store.close();
  });

  it("persists unknown generic 400 failures and never automatically reopens them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    const failure = Object.assign(new Error("Request failed with status code 400"), { response: { status: 400, data: {} } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ async updateCard() { throw failure; } }), pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "unknown-400", idempotencyKey: "unknown-400", rootMessageId: "card-1", kind: "card_update", payload: "{}" });

    for (let attempt = 0; attempt < 5; attempt += 1) await publisher.requestScan(true);
    expect(store.database.prepare("SELECT state, failure_class, http_status, auto_recovery_count FROM outbound_replies WHERE id = 'unknown-400'").get()).toEqual({ state: "dead_letter", failure_class: "unknown", http_status: 400, auto_recovery_count: 0 });
    vi.setSystemTime(new Date("2026-08-25T01:00:00.000Z"));
    await publisher.requestScan();
    expect(store.database.prepare("SELECT state, auto_recovery_count FROM outbound_replies WHERE id = 'unknown-400'").get()).toEqual({ state: "dead_letter", auto_recovery_count: 0 });
    await publisher.stop();
    store.close();
    vi.useRealTimers();
  });

  it("blocks independent lanes after 429 and resumes automatically at the app cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const calls: string[] = [];
    let limited = true;
    const replyCard = vi.fn(async (rootMessageId: string) => {
      calls.push(rootMessageId);
      if (rootMessageId === "root-1" && limited) throw Object.assign(new Error("rate limited"), { response: { status: 429, headers: { "retry-after": "5" } } });
      return { messageId: `message-${rootMessageId}` };
    });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard }), pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueCard("root-1", "limited", {});
    store.enqueueOutboundReply({ id: "independent", idempotencyKey: "independent", rootMessageId: "root-2", kind: "card_reply", payload: "{}" });
    await publisher.requestScan(true);
    expect(calls).toEqual(["root-1"]);

    limited = false;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toEqual(["root-1"]);
    await vi.advanceTimersByTimeAsync(251);
    await vi.waitFor(() => expect(calls).toEqual(expect.arrayContaining(["root-1", "root-2"])));
    expect(store.listPendingOutboundReplies()).toEqual([]);

    await publisher.stop();
    random.mockRestore();
    store.close();
    vi.useRealTimers();
  });

  it("restores the app cooldown timer after dispatcher restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const directory = mkdtempSync(join(tmpdir(), "herdr-dispatch-cooldown-"));
    const path = join(directory, "bridge.db");
    let store = new SqliteBindingStore(path);
    store.enqueueOutboundReply({ id: "limited", idempotencyKey: "limited", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "independent", idempotencyKey: "independent", rootMessageId: "root-2", kind: "card_reply", payload: "{}" });
    const claim = store.claimOutboundReply("limited", null)!;
    store.markOutboundReplyFailedWithQuarantine(claim, "rate limited", { failureClass: "transient", effectCertainty: "rejected", httpStatus: 429, larkErrorCode: null }, 5_000);
    store.close();

    store = new SqliteBindingStore(path);
    const replyCard = vi.fn(async (rootMessageId: string) => ({ messageId: `message-${rootMessageId}` }));
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard }), pino({ enabled: false }));
    publisher.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(replyCard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(251);
    await vi.waitFor(() => expect(replyCard).toHaveBeenCalledTimes(2));
    expect(store.listPendingOutboundReplies()).toEqual([]);

    await publisher.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    random.mockRestore();
    vi.useRealTimers();
  });

  it("automatically reopens one cooled transient dead letter and delivers it without another recovery round", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    let unavailable = true;
    const updateCard = vi.fn(async () => {
      if (unavailable) throw Object.assign(new Error("upstream unavailable"), { response: { status: 503 } });
    });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ updateCard }), pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "recoverable", idempotencyKey: "recoverable", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    for (let attempt = 0; attempt < 5; attempt += 1) await publisher.requestScan(true);
    expect(store.database.prepare("SELECT state, failure_class FROM outbound_replies WHERE id = 'recoverable'").get()).toEqual({ state: "dead_letter", failure_class: "transient" });

    vi.setSystemTime(new Date("2026-08-25T00:05:00.000Z"));
    unavailable = false;
    await publisher.requestScan();
    expect(store.database.prepare("SELECT state, auto_recovery_count FROM outbound_replies WHERE id = 'recoverable'").get()).toEqual({ state: "delivered", auto_recovery_count: 1 });
    expect(updateCard).toHaveBeenCalledTimes(6);
    await publisher.stop();
    store.close();
    vi.useRealTimers();
  });

  it("waits for an in-flight card delivery before stopping", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => { started = resolve; });
    let delivered = false;
    const lark = fakeLark({ async replyCard() { started(); await gate; delivered = true; return { messageId: "card-1" }; } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    publisher.start();
    const publishing = connectedWriter(store, publisher).enqueueCard("root-1", "standalone:stop", { schema: "2.0" });
    await deliveryStarted;
    expect(publisher.snapshot()).toMatchObject({ state: "running", activeDeliveries: 1, scanPending: false });
    let stopped = false;
    const stopping = publisher.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    expect(publisher.snapshot()).toMatchObject({ state: "stopping", activeDeliveries: 1 });
    release();
    await Promise.all([publishing, stopping]);
    expect(delivered).toBe(true);
    expect(publisher.snapshot()).toMatchObject({
      state: "stopping", activeDeliveries: 0, lastScanOutcome: "delivered"
    });
    expect(publisher.snapshot().lastDeliveryAt).not.toBeNull();
    store.close();
  });

  it("reports sanitized idle and failed scan diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async replyCard() { throw new Error("secret delivery detail"); }
    }), pino({ enabled: false }));

    expect(publisher.snapshot()).toEqual({
      state: "idle", activeDeliveries: 0, scanPending: false, lastScanAt: null,
      lastScanOutcome: null, lastSuccessfulScanAt: null, lastScanFailureAt: null, consecutiveScanFailures: 0,
      lastDeliveryAt: null, lastDeliveryFailureAt: null
    });
    store.enqueueOutboundReply({ id: "private-reply-id", idempotencyKey: "private-key", rootMessageId: "private-root", kind: "card_reply", payload: "private payload" });
    await publisher.requestScan();

    expect(publisher.snapshot()).toEqual({
      state: "idle", activeDeliveries: 0, scanPending: false,
      lastScanAt: "2026-08-24T00:00:00.000Z", lastScanOutcome: "failed",
      lastSuccessfulScanAt: "2026-08-24T00:00:00.000Z", lastScanFailureAt: null, consecutiveScanFailures: 0,
      lastDeliveryAt: null, lastDeliveryFailureAt: "2026-08-24T00:00:00.000Z"
    });
    expect(JSON.stringify(publisher.snapshot())).not.toMatch(/private|secret/);
    await publisher.stop();
    store.close();
    vi.useRealTimers();
  });

  it("delivers successive versions to the same request card", async () => {
    const versions: string[] = [];
    const lark = fakeLark({ async updateCard(_messageId, card) { versions.push(JSON.stringify(card)); } });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    await connectedWriter(store, publisher).enqueueRunCardUpdate("b1", "p1", "card-1", 2, "task", { version: 2 });
    await connectedWriter(store, publisher).enqueueRunCardUpdate("b1", "p1", "card-1", 3, "task", { version: 3 });
    expect(versions).toEqual([JSON.stringify({ version: 2 }), JSON.stringify({ version: 3 })]);
    store.close();
  });

  it("does not replay remote success when the local delivery checkpoint fails", async () => {
    const store = new SqliteBindingStore(":memory:");
    const sent = vi.fn(async () => {});
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ updateCard: sent }), pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "first", idempotencyKey: "first", rootMessageId: "message", kind: "card_update", payload: "{}" });
    const checkpoint = vi.spyOn(store, "markOutboundReplyDelivered").mockImplementationOnce(() => { throw new Error("disk failure"); });
    const failed = vi.spyOn(store, "markOutboundReplyFailedWithQuarantine");
    try {
      await expect(publisher.requestScan()).rejects.toThrow("outbound_checkpoint_uncertain");
      checkpoint.mockRestore();
      await publisher.requestScan(true);
      expect(sent).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
      expect(store.getOutboundReply("first")).toMatchObject({ state: "pending", attemptCount: 0 });
      expect(store.claimOutboundReply("first", null)).toBeNull();
    } finally { checkpoint.mockRestore(); await publisher.stop(); store.close(); }
  });

  it("waits for sibling deliveries before surfacing one uncertain checkpoint", async () => {
    let releaseSibling!: () => void;
    const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
    const started: string[] = [];
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async updateCard(messageId) { started.push(messageId); if (messageId === "sibling") await siblingGate; }
    }), pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "uncertain", idempotencyKey: "uncertain", rootMessageId: "uncertain", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "sibling", idempotencyKey: "sibling", rootMessageId: "sibling", kind: "card_update", payload: "{}" });
    const checkpoint = vi.spyOn(store, "markOutboundReplyDelivered").mockImplementation((claim, messageId) => {
      if (claim.reply.id === "uncertain") throw new Error("disk failure");
      checkpoint.mockRestore();
      return store.markOutboundReplyDelivered(claim, messageId);
    });
    const draining = publisher.requestScan();
    try {
      await vi.waitFor(() => expect(started).toEqual(expect.arrayContaining(["uncertain", "sibling"])));
      let settled = false;
      void draining.then(() => { settled = true; }, () => { settled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      releaseSibling();
      await expect(draining).rejects.toThrow("outbound_checkpoint_uncertain");
      expect(publisher.snapshot().activeDeliveries).toBe(0);
    } finally { checkpoint.mockRestore(); releaseSibling(); await draining.catch(() => {}); await publisher.stop(); store.close(); }
  });

  it("retains Worker Main in-flight updates while coalescing only unclaimed successors", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const enqueue = (version: number) => store.enqueueOutboundReply({ id: `v${version}`, idempotencyKey: `worker-main:update:reviewer:1:${version}`, workerId: "reviewer", workerSessionGeneration: 1, viewVersion: version, rootMessageId: "main", kind: "card_update", payload: JSON.stringify({ version }) });
    try {
      enqueue(1);
      const claim = store.claimOutboundReply("v1", null)!;
      enqueue(2);
      enqueue(3);
      expect(store.listPendingOutboundReplies().map((row) => row.id)).toEqual(["v1", "v3"]);
      expect(store.markOutboundReplyDelivered(claim, "main")).toBe(true);
      expect(store.listPendingOutboundReplies().map((row) => row.id)).toEqual(["v3"]);
    } finally { store.close(); }
  });

  it("rejects in-flight key reuse and delivers a distinct successor before acknowledging it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sent: object[] = [];
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async updateCard(_messageId, card) { sent.push(card); await gate; }
    }), pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "original", idempotencyKey: "snapshot", rootMessageId: "message", kind: "card_update", payload: JSON.stringify({ version: 1 }), viewVersion: 1 });
    const draining = publisher.requestScan();
    try {
      await vi.waitFor(() => expect(sent).toEqual([{ version: 1 }]));
      expect(() => store.enqueueOutboundReply({ id: "replacement", idempotencyKey: "snapshot", rootMessageId: "message", kind: "card_update", payload: JSON.stringify({ version: 2 }), viewVersion: 2 })).toThrow("outbound_idempotency_conflict");
      store.enqueueOutboundReply({ id: "replacement", idempotencyKey: "snapshot:2", rootMessageId: "message", kind: "card_update", payload: JSON.stringify({ version: 2 }), viewVersion: 2 });
      expect(store.getOutboundReply("replacement")?.state).toBe("pending");
      release();
      await draining;
      expect(sent).toEqual([{ version: 1 }, { version: 2 }]);
      expect(store.getOutboundReply("original")).toMatchObject({ state: "delivered", viewVersion: 1, payload: JSON.stringify({ version: 1 }) });
      expect(store.getOutboundReply("replacement")).toMatchObject({ state: "delivered", viewVersion: 2 });
      expect(store.listPendingOutboundReplies()).toEqual([]);
    } finally { release(); await draining; await publisher.stop(); store.close(); }
  });

  it("fills a free delivery slot with late interactive work without waiting for the slow batch", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const started: string[] = [];
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async updateCard(messageId) { started.push(messageId); if (messageId === "slow") await slow; },
      async replyCard() { started.push("interactive"); return { messageId: "interactive-message" }; }
    }), pino({ enabled: false }));
    for (const id of ["slow", "fast-1", "fast-2", "fast-3"]) store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: id, kind: "card_update", payload: "{}" });
    const draining = publisher.requestScan();
    try {
      await vi.waitFor(() => expect(publisher.snapshot().activeDeliveries).toBe(1));
      store.enqueueOutboundReply({ id: "interactive", idempotencyKey: "interactive", rootMessageId: "root", kind: "card_reply", payload: "{}" });
      void publisher.requestScan();
      await vi.waitFor(() => expect(started).toContain("interactive"));
      expect(publisher.snapshot().activeDeliveries).toBe(1);
      releaseSlow();
      await draining;
    } finally { releaseSlow(); await draining; await publisher.stop(); store.close(); }
  });

  it("does not claim queued work after stop while active deliveries settle", async () => {
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async updateCard(messageId) {
        started.push(messageId);
        await new Promise<void>((resolve) => releases.set(messageId, resolve));
      }
    }), pino({ enabled: false }));
    for (const id of ["one", "two", "three", "four", "five"]) store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: id, kind: "card_update", payload: "{}" });
    const draining = publisher.requestScan();
    await vi.waitFor(() => expect(started).toHaveLength(4));

    const stopping = publisher.stop();
    releases.get("one")!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).not.toContain("five");
    for (const id of ["two", "three", "four"]) releases.get(id)!();
    await Promise.all([draining, stopping]);

    expect(store.getOutboundReply("five")).toMatchObject({ state: "pending" });
    store.close();
  });

  it("reserves one of every four dispatches for durable history work when both classes are due", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async updateCard(messageId) { started.push(messageId); await gate; }
    }), pino({ enabled: false }));
    for (let index = 0; index < 8; index += 1) store.enqueueOutboundReply({ id: `live-${index}`, idempotencyKey: `live-${index}`, rootMessageId: `live-${index}`, kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "history", idempotencyKey: "history", workClass: "history", rootMessageId: "history", kind: "card_update", payload: "{}" });

    const draining = publisher.requestScan();
    try {
      await vi.waitFor(() => expect(started).toHaveLength(4));
      expect(started.slice(0, 3)).toEqual(["live-0", "live-1", "live-2"]);
      expect(started[3]).toBe("history");
    } finally {
      release();
      await draining;
      await publisher.stop();
      store.close();
    }
  });

  it("delivers independent targets concurrently", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const delivered: string[] = [];
    const lark = fakeLark({
      async updateCard(messageId) {
        if (messageId === "slow-card") await slowGate;
        delivered.push(messageId);
      }
    });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "slow", idempotencyKey: "card-update:slow", rootMessageId: "slow-card", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "fast", idempotencyKey: "card-update:fast", rootMessageId: "fast-card", kind: "card_update", payload: "{}" });

    const draining = publisher.requestScan();
    await vi.waitFor(() => expect(delivered).toEqual(["fast-card"]));
    releaseSlow();
    await draining;

    expect(delivered).toEqual(["fast-card", "slow-card"]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    store.close();
  });

  it("delivers a new Answer Card creation ahead of stalled historical Answer updates", async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const started: string[] = [];
    const lark = fakeLark({
      async updateCard(messageId) { started.push(messageId); await oldGate; },
      async replyStreamingCard() { started.push("interactive-answer"); return { messageId: "answer-message", cardId: "answer-card" }; }
    });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "old-binding", workspaceId: "old-workspace", chatId: "old-chat", topicId: "old-topic", rootMessageId: "old-root", title: "Old task" });
    for (let index = 0; index < 8; index += 1) {
      const promptId = `old-prompt-${index}`;
      const oldView = createQueuedRunCard({ promptId, bindingId: "old-binding", title: "Old answer", workspaceId: "old-workspace", paneId: "old-pane", requestText: "old", queuePosition: 1, occurredAt: "now" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "old-binding", larkMessageId: `old-message-${index}`, actorOpenId: "u1", body: "old" }, view: oldView, rootMessageId: "old-root", answerCard: {} });
      for (const reply of store.listPendingOutboundReplies()) { if (reply.promptId === promptId) store.markOutboundReplyDelivered(reply.id, `old-answer-${index}`, `old-card-${index}`); }
      store.enqueueOutboundReply({
        id: `old-${index}`, idempotencyKey: `old-${index}`, bindingId: "old-binding", promptId, cardRole: "answer",
        rootMessageId: `old-card-${index}`, kind: "card_update", payload: "{}"
      });
    }
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));

    const draining = publisher.requestScan();
    await vi.waitFor(() => expect(started).toContain("interactive-answer"));
    releaseOld();
    await draining;

    expect(store.getActiveAnswerPage("p1")).toMatchObject({ messageId: "answer-message", cardId: "answer-card" });
    expect(store.listPendingOutboundReplies()).toEqual([]);
    store.close();
  });

  it("delivers a live Answer in the first batch after startup convergence creates historical card work", async () => {
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
    const started: string[] = [];
    const store = new SqliteBindingStore(":memory:");
    for (let index = 0; index < 8; index += 1) {
      const bindingId = `history-binding-${index}`;
      const promptId = `history-prompt-${index}`;
      store.createPendingBinding({ bindingId, id: bindingId, projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: `topic-${index}`, rootMessageId: `root-${index}`, title: `History ${index}` });
      store.updateBinding(bindingId, { paneId: `wH:p${index}`, statusMessageId: `main-${index}`, state: "active", lifecycle: "active", attachment: "attached" });
      store.saveTopicView({ ...initialTopicView(bindingId), title: `History ${index}`, workspaceId: "wH", spaceName: "herdr-lark-bridge", paneId: `wH:p${index}`, phase: "done", viewVersion: 2, deliveredVersion: 1 });
      const queued = createQueuedRunCard({ promptId, bindingId, title: `History ${index}`, workspaceId: "wH", spaceName: "herdr-lark-bridge", paneId: `wH:p${index}`, requestText: "old", queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId, larkMessageId: `history-message-${index}`, actorOpenId: "u1", body: "old" }, view: queued, rootMessageId: `root-${index}`, answerCard: {} });
      const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === promptId)!;
      store.markOutboundReplyDelivered(create.id, `answer-message-${index}`, `answer-card-${index}`);
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase: "completed", answer: "durable history", answerSegments: ["durable history"], viewVersion: 3, answerDeliveredVersion: 1 });
    }
    const startup = new StartupViewConverger({
      config: { projects: [{ id: "bridge", displayName: "Bridge", spaceName: "herdr-lark-bridge", description: "Bridge", workspaceId: "wH", cwd: "/work/bridge" }] } as never,
      stores: { startupViews: store, answerPages: store, mainCards: store },
      outbound: { enqueueRunCardUpdate: vi.fn() } as unknown as OutboundIntentPort,
      outboundWork: { wake: () => {}, subscribe: () => () => {} },
      presentation: primaryPresentation
    });
    await startup.converge();

    store.createPendingBinding({ id: "live-binding", workspaceId: "wH", chatId: "chat", topicId: "live-topic", rootMessageId: "live-root", title: "Live" });
    const liveView = createQueuedRunCard({ promptId: "live-prompt", bindingId: "live-binding", title: "Live", workspaceId: "wH", paneId: "wH:live", requestText: "now", queuePosition: 1, occurredAt: "2026-09-12T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "live-prompt", bindingId: "live-binding", larkMessageId: "live-message", actorOpenId: "u1", body: "now" }, view: liveView, rootMessageId: "live-root", answerCard: {} });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async updateCard(messageId) { started.push(messageId); await historyGate; },
      async streamCardContent(cardId) { started.push(cardId); await historyGate; },
      async replyStreamingCard(rootMessageId) { started.push(rootMessageId); return { messageId: "live-answer-message", cardId: "live-answer-card" }; }
    }), pino({ enabled: false }));

    const draining = publisher.requestScan();
    try {
      await vi.waitFor(() => expect(started).toContain("live-root"));
      expect(started.indexOf("live-root")).toBeLessThan(4);
    } finally {
      releaseHistory();
      await draining;
      await publisher.stop();
      store.close();
    }
  });

  it("stops a scan when a delivered lane head does not advance", async () => {
    const updateCard = vi.fn(async () => {});
    const store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "stuck", idempotencyKey: "stuck", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    vi.spyOn(store, "markOutboundReplyDelivered").mockImplementation(() => true);
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ updateCard }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(updateCard).toHaveBeenCalledOnce();
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ id: "stuck" })]);
    await publisher.stop();
    store.close();
  });

  it("keeps updates for the same target ordered while other targets progress", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const delivered: string[] = [];
    const lark = fakeLark({
      async updateCard(messageId, card) {
        const marker = `${messageId}:${(card as { version: number }).version}`;
        if (marker === "same-card:1") await firstGate;
        delivered.push(marker);
      }
    });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "same-1", idempotencyKey: "card-update:same:1", rootMessageId: "same-card", kind: "card_update", payload: JSON.stringify({ version: 1 }) });
    store.enqueueOutboundReply({ id: "same-2", idempotencyKey: "card-update:same:2", rootMessageId: "same-card", kind: "card_update", payload: JSON.stringify({ version: 2 }) });
    store.enqueueOutboundReply({ id: "other", idempotencyKey: "card-update:other", rootMessageId: "other-card", kind: "card_update", payload: JSON.stringify({ version: 1 }) });

    const draining = publisher.requestScan();
    await vi.waitFor(() => expect(delivered).toEqual(["other-card:1"]));
    releaseFirst();
    await draining;

    expect(delivered).toEqual(["other-card:1", "same-card:1", "same-card:2"]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    store.close();
  });

  it("keeps a backed-off Answer lane head ahead of later finish work", async () => {
    let failContent = true;
    const delivered: string[] = [];
    const lark = fakeLark({
      async streamCardContent() {
        if (failContent) throw Object.assign(new Error("temporary"), { response: { status: 503 } });
        delivered.push("content");
      },
      async finishStreamingCard() { delivered.push("finish"); }
    });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueStreamContent("b1", "p1", "cardkit-1", answerElementId("p1", 0), "content", 2);
    await connectedWriter(store, publisher).enqueueStreamFinish("b1", "p1", "cardkit-1", "Completed", 3);

    expect(delivered).toEqual([]);
    failContent = false;
    await publisher.requestScan(true);
    expect(delivered).toEqual(["content", "finish"]);
    store.close();
  });

  it("preserves Answer lane ordering after the store is reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-answer-lane-restart-"));
    const path = join(directory, "bridge.db");
    let store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    store.enqueueOutboundReply({ id: "content", idempotencyKey: "content", bindingId: "b1", promptId: "p1", cardRole: "answer", rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ elementId: answerElementId("p1", 0), content: "done", sequence: 2 }) });
    store.enqueueOutboundReply({ id: "finish", idempotencyKey: "finish", bindingId: "b1", promptId: "p1", cardRole: "answer", rootMessageId: "cardkit-1", kind: "stream_finish", payload: JSON.stringify({ summary: "Done", sequence: 3 }) });
    store.markOutboundReplyFailed("content", "temporary", 60_000);
    store.close();

    store = new SqliteBindingStore(path);
    const delivered: string[] = [];
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async streamCardContent() { delivered.push("content"); },
      async finishStreamingCard() { delivered.push("finish"); }
    }), pino({ enabled: false }));
    await publisher.requestScan();
    expect(delivered).toEqual([]);
    await publisher.requestScan(true);
    expect(delivered).toEqual(["content", "finish"]);
    await publisher.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("bounds delivery concurrency across independent targets", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const lark = fakeLark({ async updateCard() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    for (let index = 0; index < 10; index += 1) {
      store.enqueueOutboundReply({ id: `reply-${index}`, idempotencyKey: `reply-${index}`, rootMessageId: `card-${index}`, kind: "card_update", payload: "{}" });
    }

    const draining = publisher.requestScan();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(peak).toBe(4);
    while (store.listPendingOutboundReplies().length > 0 || active > 0) {
      const release = releases.shift();
      if (release) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await draining;

    expect(peak).toBe(4);
    store.close();
  });

  it("automatically wakes a backed-off delivery when it becomes due", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const lark = fakeLark({ async replyCard() {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error("temporary"), { response: { status: 503 } });
      return { messageId: "card-1" };
    } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueCard("root-1", "automatic-retry", {});
    expect(attempt).toBe(1);
    await vi.advanceTimersByTimeAsync(1_300);
    await vi.waitFor(() => expect(attempt).toBe(2));
    expect(store.listPendingOutboundReplies()).toEqual([]);

    await publisher.stop();
    store.close();
    vi.useRealTimers();
  });

  it.each([
    { header: "5", delay: 5_000 },
    { header: "Sun, 24 Aug 2026 00:00:09 GMT", delay: 9_000 },
    { header: { get: () => "7" }, delay: 7_000 }
  ])("honors HTTP 429 Retry-After $header", async ({ header, delay }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    const headers = typeof header === "object" ? header : { "retry-after": header };
    const error = Object.assign(new Error("rate limited"), { response: { status: 429, headers } });
    const lark = fakeLark({ async replyCard() { throw error; } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueCard("root-1", `rate-limit-${header}`, {});

    expect(store.listPendingOutboundReplies()[0]?.nextAttemptAt).toBe(new Date(Date.now() + delay).toISOString());
    await publisher.stop();
    store.close();
    vi.useRealTimers();
  });

  it("preserves a previously attempted version ahead of its successor", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.enqueueOutboundReply({ id: "old", idempotencyKey: "run-card:update:p1:task:2", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "task", rootMessageId: "card-1", kind: "card_update", payload: "old" });
    store.markOutboundReplyFailed("old", "temporary");
    store.enqueueOutboundReply({ id: "new", idempotencyKey: "run-card:update:p1:task:3", bindingId: "b1", promptId: "p1", viewVersion: 3, cardRole: "task", rootMessageId: "card-1", kind: "card_update", payload: "new" });
    expect(store.listPendingOutboundReplies()).toMatchObject([{ id: "old", viewVersion: 2, payload: "old", attemptCount: 1 }, { id: "new", viewVersion: 3, payload: "new" }]);
    store.close();
  });

  it("delivers durable work found during startup without a new wake-up", async () => {
    const delivered = vi.fn(async () => ({ messageId: "card-1" }));
    const store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "before-start", idempotencyKey: "before-start", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    const work = new InProcessOutboundWorkNotifier();
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard: delivered }), pino({ enabled: false }), work);

    publisher.start();
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));

    await publisher.stop();
    store.close();
  });

  it("contains a rejected startup scan, retries it, and resets failure diagnostics after recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    const store = new SqliteBindingStore(":memory:");
    const recover = vi.spyOn(store, "recoverEligibleDeadLetters")
      .mockImplementationOnce(() => { throw new Error("database busy"); });
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const publisher = new LarkOutboxDispatcher(store, fakeLark({}), logger);

    publisher.start();
    await vi.waitFor(() => expect(publisher.snapshot().consecutiveScanFailures).toBe(1));
    expect(publisher.snapshot()).toMatchObject({
      lastScanOutcome: "failed",
      lastScanFailureAt: "2026-08-29T00:00:00.000Z",
      lastSuccessfulScanAt: null
    });
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(publisher.snapshot().consecutiveScanFailures).toBe(0));
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(publisher.snapshot()).toMatchObject({
      lastScanOutcome: "idle",
      lastScanFailureAt: "2026-08-29T00:00:00.000Z"
    });
    expect(Date.parse(publisher.snapshot().lastSuccessfulScanAt ?? "")).toBeGreaterThan(Date.parse("2026-08-29T00:00:00.000Z"));

    await publisher.stop();
    store.close();
  });

  it("discovers durable work on the safety scan after a lost wake-up", async () => {
    vi.useFakeTimers();
    const delivered = vi.fn(async () => ({ messageId: "card-1" }));
    const store = new SqliteBindingStore(":memory:");
    const work = new InProcessOutboundWorkNotifier();
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard: delivered }), pino({ enabled: false }), work, 100);
    publisher.start();
    await publisher.requestScan();
    store.enqueueOutboundReply({ id: "lost-wake", idempotencyKey: "lost-wake", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));

    await publisher.stop();
    store.close();
    vi.useRealTimers();
  });

  it("coalesces duplicate wake-ups and ignores wake-ups after stop", async () => {
    const delivered = vi.fn(async () => ({ messageId: "card-1" }));
    const store = new SqliteBindingStore(":memory:");
    const work = new InProcessOutboundWorkNotifier();
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard: delivered }), pino({ enabled: false }), work);
    publisher.start();
    await publisher.requestScan();
    store.enqueueOutboundReply({ id: "duplicate-wake", idempotencyKey: "duplicate-wake", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });

    work.wake(); work.wake(); work.wake();
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
    await publisher.stop();
    store.enqueueOutboundReply({ id: "after-stop", idempotencyKey: "after-stop", rootMessageId: "root-2", kind: "card_reply", payload: "{}" });
    work.wake();
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(delivered).toHaveBeenCalledTimes(1);
    expect(store.listPendingOutboundReplies()).toMatchObject([{ id: "after-stop" }]);
    store.close();
  });
});

function fakeLark(overrides: Partial<LarkPort>): LarkPort {
  return {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
    async replyText() { return { messageId: "text-1" }; },
    async replyCard() { return { messageId: "card-1" }; },
    async updateCard() {}, ...overrides
  };
}

function connectedWriter(store: SqliteBindingStore, dispatcher: LarkOutboxDispatcher): OutboundIntentPort {
  const writer = new OutboundIntentWriter(store, {
    subscribe: () => () => {},
    wake: () => {}
  });
  return new Proxy(writer, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await Reflect.apply(value, target, args);
        await dispatcher.requestScan();
      };
    }
  });
}
