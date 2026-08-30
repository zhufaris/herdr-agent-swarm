import { afterEach, describe, expect, it } from "vitest";
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
  const create = (id: string, projectId: string) => { store!.createAgentInstance({ id, projectId, name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }); return store!.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w", paneId: `${id}:pane`, nativeSessionId: null })!; };
  const primary = (projectId = "p1") => {
    store!.createPendingBinding({ id: "binding", projectId, workspaceId: "w", chatId: "c", topicId: "t", rootMessageId: "root", title: "Primary" });
    store!.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane" });
    const view = createQueuedRunCard({ promptId: "parent", bindingId: "binding", title: "parent", workspaceId: "w", paneId: "primary:pane", requestText: "coordinate", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store!.acceptPrompt({ prompt: { id: "parent", bindingId: "binding", larkMessageId: "message", actorOpenId: "u", body: "coordinate" }, view, rootMessageId: "root", answerCard: {} });
    store!.updatePrompt("parent", "running");
    return { projectId, bindingId: "binding", bindingGeneration: 1, parentPromptId: "parent" };
  };
  const driver = { kind: "traex", describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", interrupt: "native", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }), start: async () => undefined, submit: async () => ({ status: "confirmed-delivered" as const }), steer: async () => ({ status: "delivered" as const }), interrupt: async () => ({ status: "interrupted" as const }) } satisfies AgentRuntimeDriver;
  const messaging = new InstanceMessagingWorkflow({ store, drivers: new AgentDriverRegistry([driver]), paneHost: {} as never, wake: () => undefined, idFactory: () => "turn-1" });
  return { create, primary, broker: (identity: { projectId: string; bindingId: string; bindingGeneration: number; parentPromptId: string }) => new PrimaryToolBroker(identity, messaging) };
}

describe("PrimaryToolBroker", () => {
  it("allows the current primary to call an existing same-project worker", async () => {
    const { create, primary, broker } = setup(); const actor = primary(); const worker = create("worker", "p1");
    await expect(broker(actor).promptInstance({ instanceId: worker.id, task: "review", idempotencyKey: "k1" })).resolves.toMatchObject({ accepted: true });
  });

  it.each(["cross-project", "stale-primary"])("denies %s authority", async (kind) => {
    const { create, primary, broker } = setup(); const actor = primary(); const worker = create("worker", "p1"); const other = create("other", "p2");
    const identity = kind === "stale-primary" ? { ...actor, bindingGeneration: 2 } : actor;
    await expect(broker(identity).promptInstance({ instanceId: kind === "cross-project" ? other.id : worker.id, task: "work", idempotencyKey: kind })).rejects.toThrow(/authorized current thread Primary|requested project/);
  });

  it("exposes only the fixed non-topology tool surface", () => {
    const { primary, broker } = setup();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(broker(primary()))).filter((name) => name !== "constructor").sort()).toEqual(["followUpInstance", "inspectInstance", "interruptInstance", "listInstances", "promptInstance", "steerInstance", "waitInstance"].sort());
  });
});
