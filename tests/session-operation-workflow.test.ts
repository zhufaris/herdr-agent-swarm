import { describe, expect, it, vi } from "vitest";
import { SessionOperationWorkflow } from "../src/coordinator/session-operation-workflow.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

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

function seedLegacy(store: SqliteBindingStore, id: string, kind: "rename" | "resume" | "reattach", argument: string | null): void {
  store.createCardInteraction({ id: `interaction-${id}`, bindingId: "b1", bindingGeneration: 1, actorOpenId: "creator", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
  expect(store.acceptSessionOperation({
    id, idempotencyKey: `legacy:${id}`, interactionId: `interaction-${id}`, actorOpenId: "creator",
    bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1",
    kind: "rename", argument: argument ?? "Legacy", now: new Date().toISOString()
  }).outcome).toBe("accepted");
  store.database.prepare("UPDATE session_operations SET kind = ?, argument = ? WHERE id = ?").run(kind, argument, id);
}

describe("Session operation startup recovery", () => {
  it("marks interrupted running work uncertain without invoking its handler", async () => {
    const h = harness();
    seedLegacy(h.store, "op-1", "reattach", "w1:p2");
    h.store.claimNextSessionOperation();

    await h.workflow.recover();

    expect(h.store.getSessionOperation("op-1")).toMatchObject({ state: "uncertain", attemptCount: 1 });
    expect(h.reattach).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "session-operation-recovered-uncertain", outcome: "uncertain" }), expect.any(String));
    h.store.close();
  });

  it("drains all accepted legacy operations sequentially to terminal state", async () => {
    const h = harness();
    seedLegacy(h.store, "op-1", "rename", "First");
    seedLegacy(h.store, "op-2", "resume", null);
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    h.rename.mockImplementation(async () => {
      active += 1; maximumActive = Math.max(maximumActive, active); order.push("rename:start");
      await Promise.resolve();
      order.push("rename:end"); active -= 1;
      return true;
    });
    h.resume.mockImplementation(async () => {
      active += 1; maximumActive = Math.max(maximumActive, active); order.push("resume:start");
      await Promise.resolve();
      order.push("resume:end"); active -= 1;
      return true;
    });

    await h.workflow.recover();

    expect(order).toEqual(["rename:start", "rename:end", "resume:start", "resume:end"]);
    expect(maximumActive).toBe(1);
    expect(h.store.getSessionOperation("op-1")).toMatchObject({ state: "succeeded", attemptCount: 1 });
    expect(h.store.getSessionOperation("op-2")).toMatchObject({ state: "succeeded", attemptCount: 1 });
    expect(h.store.listRecoverableSessionOperations()).toEqual([]);
    h.store.close();
  });

  it("has no production admission or periodic scanner surface", async () => {
    vi.useFakeTimers();
    const h = harness();

    expect("accept" in h.workflow).toBe(false);
    expect("start" in h.workflow).toBe(false);
    expect("wake" in h.workflow).toBe(false);
    await h.workflow.recover();
    seedLegacy(h.store, "op-1", "rename", "Late legacy row");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.rename).not.toHaveBeenCalled();
    expect(h.store.getSessionOperation("op-1")).toMatchObject({ state: "accepted", attemptCount: 0 });
    vi.useRealTimers();
    h.store.close();
  });

  it("fails startup recovery when the accepted legacy queue cannot be claimed", async () => {
    const h = harness();
    seedLegacy(h.store, "op-1", "rename", "Pending");
    vi.spyOn(h.store, "claimNextSessionOperation").mockImplementationOnce(() => { throw new Error("sqlite busy"); });

    await expect(h.workflow.recover()).rejects.toThrow("sqlite busy");
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.store.getSessionOperation("op-1")).toMatchObject({ state: "accepted" });
    h.store.close();
  });
});
