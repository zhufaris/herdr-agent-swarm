import { describe, expect, it, vi } from "vitest";
import { CommandIntentObserver } from "../src/coordinator/command-intent-observer.js";
import type { CommandIntent } from "../src/domain/command-intent.js";

const context = { chatId: "chat", topicId: null, rootMessageId: "root", sourceMessageId: "message", actorOpenId: "admin", projectId: "project", workspaceId: "workspace", primary: null };
function intent(state: CommandIntent["state"], outcome: CommandIntent["outcome"] = null): CommandIntent {
  return { id: "intent", idempotencyKey: "key", laneKey: "project:project", command: { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: true }, context, replayPolicy: "reconcilable", state, attemptCount: state === "accepted" ? 0 : 1, outcome, claimedAt: null, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z" };
}

describe("CommandIntentObserver", () => {
  it("returns a typed pending observation without changing durable work", async () => {
    const store = { getCommandIntent: vi.fn(() => intent("accepted")) };
    const observer = new CommandIntentObserver({ store, instances: { inspect: vi.fn() } as never, pollIntervalMs: 1 });
    await expect(observer.observe("intent", 2)).resolves.toMatchObject({ outcome: "pending", intent: { state: "accepted" } });
    expect(store.getCommandIntent).toHaveBeenCalled();
  });

  it("reloads SQLite until a pending intent reaches its durable terminal state", async () => {
    const worker = { id: "worker", name: "reviewer" };
    const store = { getCommandIntent: vi.fn()
      .mockReturnValueOnce(intent("executing"))
      .mockReturnValueOnce(intent("succeeded", { code: "completed", detail: null, operationKind: "worker", operationId: "worker" })) };
    const observer = new CommandIntentObserver({ store, instances: { inspect: vi.fn(() => ({ instance: worker })) } as never, pollIntervalMs: 1 });
    await expect(observer.observe("intent", 20)).resolves.toMatchObject({ outcome: "succeeded", workerResult: { status: "created", instance: worker } });
    expect(store.getCommandIntent).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["succeeded", "created", null],
    ["created_start_failed", "created-start-failed", "runtime unavailable"]
  ] as const)("reconstructs durable Worker outcome %s from the Instance store", async (code, status, detail) => {
    const worker = { id: "worker", name: "reviewer" };
    const observer = new CommandIntentObserver({
      store: { getCommandIntent: vi.fn(() => intent("succeeded", { code, detail, operationKind: "worker", operationId: "worker" })) },
      instances: { inspect: vi.fn(() => ({ instance: worker })) } as never
    });
    await expect(observer.observe("intent")).resolves.toMatchObject({ outcome: "succeeded", workerResult: { status, instance: worker }, ...(detail ? { workerResult: { status, instance: worker, error: detail } } : {}) });
  });

  it.each(["rejected", "failed", "uncertain"] as const)("reports durable terminal state %s without inspecting a Worker", async (state) => {
    const inspect = vi.fn();
    const observer = new CommandIntentObserver({ store: { getCommandIntent: vi.fn(() => intent(state, { code: state, detail: "safe detail", operationKind: null, operationId: null })) }, instances: { inspect } as never });
    await expect(observer.observe("intent")).resolves.toMatchObject({ outcome: state, intent: { state } });
    expect(inspect).not.toHaveBeenCalled();
  });
});
