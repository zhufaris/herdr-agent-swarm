import { afterEach, describe, expect, it } from "vitest";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { PrimaryToolBroker } from "../src/runtime/primary-tool-broker.js";
import { InstanceMessagingWorkflow } from "../src/coordinator/instance-messaging-workflow.js";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import type { AgentRuntimeDriver } from "../src/domain/agent-runtime.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

function setup() {
  store = new SqliteBindingStore(":memory:");
  const create = (id: string, projectId: string, role: "primary" | "worker") => { store!.createAgentInstance({ id, projectId, name: id, role, agentKind: "traex", model: null, desiredState: "running", workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }); return store!.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w", paneId: `${id}:pane`, nativeSessionId: null })!; };
  const driver = { kind: "traex", describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "terminal-input", interrupt: "terminal-signal", approvals: "terminal", modelSelection: "runtime", usageReporting: true }), start: async () => undefined, submit: async () => ({ status: "confirmed-delivered" as const }), steer: async () => ({ status: "delivered" as const }), interrupt: async () => ({ status: "interrupted" as const }) } satisfies AgentRuntimeDriver;
  const messaging = new InstanceMessagingWorkflow({ store, drivers: new AgentDriverRegistry([driver]), paneHost: {} as never, wake: () => undefined, idFactory: () => "turn-1" });
  return { create, broker: (identity: { projectId: string; instanceId: string; generation: number; parentTurnId: string }) => new PrimaryToolBroker(identity, messaging) };
}

describe("PrimaryToolBroker", () => {
  it("allows the current primary to call an existing same-project worker", async () => {
    const { create, broker } = setup(); const primary = create("primary", "p1", "primary"); const worker = create("worker", "p1", "worker");
    await expect(broker({ projectId: "p1", instanceId: primary.id, generation: primary.generation, parentTurnId: "parent" }).promptInstance({ instanceId: worker.id, task: "review", idempotencyKey: "k1" })).resolves.toMatchObject({ accepted: true });
  });

  it.each(["cross-project", "worker-caller", "stale-primary"])("denies %s authority", async (kind) => {
    const { create, broker } = setup(); const primary = create("primary", "p1", "primary"); const worker = create("worker", "p1", "worker"); const other = create("other", "p2", "worker");
    const identity = kind === "worker-caller" ? { projectId: "p1", instanceId: worker.id, generation: worker.generation, parentTurnId: "p" } : { projectId: "p1", instanceId: primary.id, generation: kind === "stale-primary" ? 1 : primary.generation, parentTurnId: "p" };
    await expect(broker(identity).promptInstance({ instanceId: kind === "cross-project" ? other.id : worker.id, task: "work", idempotencyKey: kind })).rejects.toThrow(/authorized current primary|requested project/);
  });

  it("exposes only the fixed non-topology tool surface", () => {
    const { create, broker } = setup(); const primary = create("primary", "p1", "primary");
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(broker({ projectId: "p1", instanceId: primary.id, generation: primary.generation, parentTurnId: "p" }))).filter((name) => name !== "constructor").sort()).toEqual(["followUpInstance", "inspectInstance", "interruptInstance", "listInstances", "promptInstance", "steerInstance", "waitInstance"].sort());
  });
});
