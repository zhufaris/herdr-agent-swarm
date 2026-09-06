import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { PrimaryToolBroker } from "../src/runtime/primary-tool-broker.js";
import { InstanceMessagingWorkflow } from "../src/coordinator/instance-messaging-workflow.js";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import type { AgentRuntimeDriver } from "../src/domain/agent-runtime.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

function setup() {
  store = new SqliteBindingStore(":memory:");
  const create = (id: string, projectId: string) => { store!.createAgentInstance({ id, projectId, name: id, role: "worker", agentKind: "traex", model: null, parent: projectId === "p1" ? { bindingId: "binding", paneId: "primary:pane", nativeSessionId: null } : { bindingId: "other-binding", paneId: "other-primary:pane", nativeSessionId: null }, workerSessionLifecycle: "active", desiredState: "running", workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }); return store!.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w", paneId: `${id}:pane`, nativeSessionId: null })!; };
  const primary = (projectId = "p1") => {
    store!.createPendingBinding({ id: "binding", projectId, workspaceId: "w", chatId: "c", topicId: "t", rootMessageId: "root", title: "Primary" });
    store!.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane" });
    const view = createQueuedRunCard({ promptId: "parent", bindingId: "binding", title: "parent", workspaceId: "w", paneId: "primary:pane", requestText: "coordinate", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store!.acceptPrompt({ prompt: { id: "parent", bindingId: "binding", larkMessageId: "message", actorOpenId: "u", body: "coordinate" }, view, rootMessageId: "root", answerCard: {} });
    store!.updatePrompt("parent", "running");
    return { projectId, bindingId: "binding", bindingGeneration: 1, parentPromptId: "parent", sourceMessageId: "message", rootMessageId: "root" };
  };
  const driver = { kind: "traex", describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", interrupt: "native", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }), start: async () => undefined, submit: async () => ({ status: "confirmed-delivered" as const }), steer: async () => ({ status: "delivered" as const }), interrupt: async () => ({ status: "interrupted" as const }) } satisfies AgentRuntimeDriver;
  const messaging = new InstanceMessagingWorkflow({ store, drivers: new AgentDriverRegistry([driver]), paneHost: {} as never, turnControl: { steer: async () => { throw new Error("not active"); } } as never, wake: () => undefined, idFactory: () => "turn-1" });
  const workerCards = { show: vi.fn((input) => ({ accepted: true as const, delivery: "queued" as const, worker: { id: "worker", name: input.workerName, workerSessionGeneration: 1 }, cards: ["worker-main", "worker-task"] as ["worker-main", "worker-task"], taskTurnId: null })) };
  return { create, primary, workerCards, broker: (identity: { projectId: string; bindingId: string; bindingGeneration: number; parentPromptId: string; sourceMessageId: string; rootMessageId: string }) => new PrimaryToolBroker(identity, messaging, workerCards) };
}

describe("PrimaryToolBroker", () => {
  it("allows the current primary to call an existing same-project worker", async () => {
    const { create, primary, broker } = setup(); const actor = primary(); const worker = create("worker", "p1");
    await expect(broker(actor).promptInstance({ instanceId: worker.id, task: "review", idempotencyKey: "k1" })).resolves.toMatchObject({ accepted: true });
  });

  it("creates a card-backed follow-up for an explicit settled Worker turn", async () => {
    const { create, primary, broker } = setup(); const actor = primary(); const worker = create("worker", "p1");
    store!.acceptInstanceTurn({ id: "parent-turn", idempotencyKey: "parent-key", actor: { kind: "human", userId: "u" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review" });
    store!.completeInstanceTurn({ turnId: "parent-turn", expectedGeneration: worker.generation, result: "done" });
    await expect(broker(actor).followUpInstance({ instanceId: worker.id, parentTurnId: "parent-turn", text: "continue", idempotencyKey: "follow-key" })).resolves.toMatchObject({ accepted: true, card: { parentTurnId: "parent-turn", rootMessageId: "root" } });
    expect(store!.getInstanceTurn("turn-1")).toMatchObject({ kind: "followup", parentTurnId: "parent-turn" });
  });

  it.each(["cross-project", "stale-primary"])("denies %s authority", async (kind) => {
    const { create, primary, broker } = setup(); const actor = primary(); const worker = create("worker", "p1"); const other = create("other", "p2");
    const identity = kind === "stale-primary" ? { ...actor, bindingGeneration: 2 } : actor;
    await expect(broker(identity).promptInstance({ instanceId: kind === "cross-project" ? other.id : worker.id, task: "work", idempotencyKey: kind })).rejects.toThrow(/authorized current thread Primary|requested project/);
  });

  it("exposes only the fixed non-topology tool surface", () => {
    const { primary, broker } = setup();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(broker(primary()))).filter((name) => name !== "constructor").sort()).toEqual(["followUpInstance", "inspectInstance", "interruptInstance", "listInstances", "promptInstance", "showWorkerCards", "steerInstance", "waitInstance"].sort());
  });

  it("passes only server-owned Primary scope to Worker card display", () => {
    const { primary, broker, workerCards } = setup(); const identity = primary();
    expect(broker(identity).showWorkerCards({ workerName: "reviewer", idempotencyKey: "display-1" })).toMatchObject({ accepted: true, delivery: "queued" });
    expect(workerCards.show).toHaveBeenCalledWith({ ...identity, workerName: "reviewer", idempotencyKey: "display-1" });
    expect(() => broker(identity).showWorkerCards({ workerName: 1 as never, idempotencyKey: "display-2" })).toThrow(/requires workerName/);
  });
});
