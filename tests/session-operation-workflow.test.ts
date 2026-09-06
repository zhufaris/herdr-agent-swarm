import { describe, expect, it, vi } from "vitest";
import { CardInteractionWorkflow } from "../src/coordinator/card-interaction-workflow.js";
import { SessionOperationWorkflow } from "../src/coordinator/session-operation-workflow.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { applicationPresentation } from "./helpers/presentation.js";

function harness() {
  const store = new SqliteBindingStore(":memory:");
  store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task", creatorOpenId: "creator" });
  store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
  const rename = vi.fn(async () => true);
  const resume = vi.fn(async () => true);
  const reattach = vi.fn(async () => {});
  const replace = vi.fn(async () => {});
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const workflow = new SessionOperationWorkflow({ store, sessionAdministration: { rename, archive: vi.fn(async () => true), resume }, provisioning: { reset: vi.fn(async () => true), reattach, replace }, paneControl: { stop: vi.fn(async () => true) }, paneClosure: { requestPaneClose: vi.fn(async () => true) }, logger });
  return { store, workflow, rename, resume, reattach, replace, logger };
}

function interaction(store: SqliteBindingStore, id: string): void {
  store.createCardInteraction({ id, bindingId: "b1", bindingGeneration: 1, actorOpenId: "creator", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
}

const action = { messageId: "card-message", chatId: "chat", operatorOpenId: "creator", value: {} };

describe("Session operation workflow", () => {
  it("accepts before waiting for Herdr work and executes once after start", async () => {
    const h = harness();
    interaction(h.store, "i1");
    let release!: () => void;
    h.rename.mockImplementation(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));

    expect(h.workflow.accept(action, h.store.getBinding("b1")!, "i1", "rename", "New title")).toBe("accepted");
    expect(h.store.getCardInteraction("i1")).toMatchObject({ state: "consumed" });
    h.workflow.start();
    await vi.waitFor(() => expect(h.rename).toHaveBeenCalledOnce());
    expect(h.store.getSessionOperation(h.store.listRecoverableSessionOperations()[0]!.id)).toMatchObject({ state: "running" });
    release();
    await h.workflow.stop();
    expect(h.rename).toHaveBeenCalledOnce();
    expect(h.store.listRecoverableSessionOperations()).toEqual([]);
    h.store.close();
  });

  it("deduplicates repeated callbacks without repeating the external operation", async () => {
    const h = harness();
    interaction(h.store, "i1");
    h.store.updateBinding("b1", { state: "orphaned", attachment: "orphaned" });
    const binding = h.store.getBinding("b1")!;

    expect(h.workflow.accept(action, binding, "i1", "replace")).toBe("accepted");
    expect(h.workflow.accept(action, binding, "i1", "replace")).toBe("duplicate");
    h.workflow.start();
    await vi.waitFor(() => expect(h.replace).toHaveBeenCalledOnce());
    await h.workflow.stop();
    expect(h.replace).toHaveBeenCalledOnce();
    h.store.close();
  });

  it("accepts a real More Actions callback before external execution", async () => {
    const h = harness();
    const cards = new CardInteractionWorkflow({
      store: h.store,
      adminOpenIds: ["creator"],
      sessionAdministration: { emitStatus: vi.fn(async () => {}) },
      sessionOperations: h.workflow,
      wakePrompt: vi.fn(),
      presentation: applicationPresentation,
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    const opened = await cards.handle({ messageId: "main-card", chatId: "chat", operatorOpenId: "creator", value: { action: "open_more_actions", bindingId: "b1", bindingGeneration: 1 } });
    const callback = callbackValue(opened!.card!, "session_archive");
    const result = await cards.handle({ messageId: "more-card", chatId: "chat", operatorOpenId: "creator", value: callback });

    expect(result?.toast).toEqual({ type: "success", content: "操作已受理。" });
    expect(h.store.listRecoverableSessionOperations()).toEqual([expect.objectContaining({ kind: "archive", state: "accepted" })]);
    expect(h.store.getCardInteraction(String(callback.interactionId))).toMatchObject({ actionKind: "more_actions", state: "consumed" });
    await h.workflow.stop();
    h.store.close();
  });

  it("rejects an accepted operation when the binding identity changed before dispatch", async () => {
    const h = harness();
    interaction(h.store, "i1");
    h.workflow.accept(action, h.store.getBinding("b1")!, "i1", "rename", "New title");
    h.store.updateBinding("b1", { generation: 2, paneId: "w1:p2", traexSessionId: "terminal-2" });

    h.workflow.start();
    await vi.waitFor(() => expect(h.store.listRecoverableSessionOperations()).toEqual([]));
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.store.database.prepare("SELECT state FROM session_operations").get()).toEqual({ state: "rejected" });
    await h.workflow.stop();
    h.store.close();
  });

  it("rejects a persisted legacy model operation without creating pane-control work", async () => {
    const h = harness();
    interaction(h.store, "i1");
    h.workflow.accept(action, h.store.getBinding("b1")!, "i1", "rename", "Legacy model payload");
    h.store.database.prepare("UPDATE session_operations SET kind = 'model', argument = NULL WHERE interaction_id = 'i1'").run();

    h.workflow.start();
    await vi.waitFor(() => expect(h.store.listRecoverableSessionOperations()).toEqual([]));

    expect(h.store.database.prepare("SELECT state, detail FROM session_operations WHERE interaction_id = 'i1'").get()).toEqual({
      state: "rejected",
      detail: "运行中的 Agent 不支持远程切换模型。请在创建 Agent 时选择模型，或显式替换 Agent 后使用新模型。"
    });
    await h.workflow.stop();
    h.store.close();
  });

  it("marks interrupted running work uncertain without replaying it", async () => {
    const h = harness();
    interaction(h.store, "i1");
    h.store.updateBinding("b1", { state: "orphaned", attachment: "orphaned" });
    h.workflow.accept(action, h.store.getBinding("b1")!, "i1", "reattach", "w1:p2");
    const operation = h.store.claimNextSessionOperation()!;

    await h.workflow.recover();

    expect(h.store.getSessionOperation(operation.id)).toMatchObject({ state: "uncertain" });
    expect(h.reattach).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "session-operation-recovered-uncertain", outcome: "uncertain" }), expect.any(String));
    h.store.close();
  });

  it("does not claim another operation after shutdown begins", async () => {
    const h = harness();
    interaction(h.store, "i1");
    interaction(h.store, "i2");
    let release!: () => void;
    h.rename.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    h.workflow.accept(action, h.store.getBinding("b1")!, "i1", "rename", "First");
    h.workflow.accept(action, h.store.getBinding("b1")!, "i2", "rename", "Second");

    h.workflow.start();
    await vi.waitFor(() => expect(h.rename).toHaveBeenCalledOnce());
    const stopping = h.workflow.stop();
    release();
    await stopping;

    expect(h.rename).toHaveBeenCalledOnce();
    expect(h.store.database.prepare("SELECT state FROM session_operations WHERE argument = 'Second'").get()).toEqual({ state: "accepted" });
    h.store.close();
  });

  it("periodically scans durable accepted work when a wake-up is missed", async () => {
    vi.useFakeTimers();
    const h = harness();
    interaction(h.store, "i1");
    h.workflow.start(1_000);
    h.store.acceptSessionOperation({
      id: "op-missed-wake", idempotencyKey: "interaction:i1:rename", interactionId: "i1", actorOpenId: "creator",
      bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1",
      kind: "rename", argument: "Recovered", now: new Date().toISOString()
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(h.rename).toHaveBeenCalledOnce());
    await h.workflow.stop();
    vi.useRealTimers();
    h.store.close();
  });

  it("contains a drain failure and lets periodic anti-entropy retry", async () => {
    vi.useFakeTimers();
    const h = harness();
    interaction(h.store, "i1");
    h.workflow.accept(action, h.store.getBinding("b1")!, "i1", "rename", "Recovered");
    const claim = vi.spyOn(h.store, "claimNextSessionOperation");
    claim.mockImplementationOnce(() => { throw new Error("sqlite busy"); });

    h.workflow.start(1_000);
    await vi.waitFor(() => expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "session-operation-drain-failed", outcome: "deferred" }), expect.any(String)));
    expect(h.workflow.snapshot()).toMatchObject({ lastFailure: "sqlite busy" });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(h.rename).toHaveBeenCalledOnce());
    await h.workflow.stop();
    vi.useRealTimers();
    h.store.close();
  });
});

function callbackValue(card: object, action: string): Record<string, unknown> {
  const stack: unknown[] = [card];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.value && typeof record.value === "object" && (record.value as Record<string, unknown>).action === action) return record.value as Record<string, unknown>;
    stack.push(...Object.values(record));
  }
  throw new Error(`action not found: ${action}`);
}
