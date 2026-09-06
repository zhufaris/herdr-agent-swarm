import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { PrimaryToolGateway } from "../src/runtime/primary-tool-gateway.js";
import { InstanceMessagingWorkflow } from "../src/coordinator/instance-messaging-workflow.js";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import type { AgentRuntimeDriver } from "../src/domain/agent-runtime.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { workerPresentation } from "./helpers/presentation.js";

let directory: string | undefined; let store: SqliteBindingStore | undefined; let gateway: PrimaryToolGateway | undefined;
afterEach(async () => { await gateway?.stop(); store?.close(); if (directory) await rm(directory, { recursive: true, force: true }); gateway = undefined; store = undefined; directory = undefined; });

describe("Primary tool gateway", () => {
  it("executes at most one request per connection and closes idle clients", async () => {
    directory = await mkdtemp(join(tmpdir(), "primary-tools-framing-"));
    store = new SqliteBindingStore(join(directory, "bridge.db"));
    createPrimary(store);
    const messaging = { interrupt: vi.fn(() => new Promise(() => undefined)) } as never;
    const socketPath = join(directory, "tools.sock");
    gateway = new PrimaryToolGateway(socketPath, process.execPath, [], store, messaging, pino({ enabled: false }), [], { idleTimeoutMs: 25 });
    const launch = gateway.issueBinding("binding", 1);
    await gateway.start();
    const payload = { bindingId: "binding", generation: 1, capability: launch.environment.SWARM_PRIMARY_CAPABILITY, tool: "interruptInstance", arguments: { instanceId: "worker", idempotencyKey: "interrupt" } };
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(`${JSON.stringify(payload)}\n`);
    await vi.waitFor(() => expect(messaging.interrupt).toHaveBeenCalledOnce());
    socket.write(`${JSON.stringify(payload)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messaging.interrupt).toHaveBeenCalledOnce();
    socket.destroy();

    const idle = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => { idle.once("connect", resolve); idle.once("error", reject); });
    await new Promise<void>((resolve) => idle.once("close", () => resolve()));
    expect(idle.destroyed).toBe(true);
  });

  it("derives the parent turn server-side and rejects forged or stale credentials", async () => {
    directory = await mkdtemp(join(tmpdir(), "primary-tools-"));
    store = new SqliteBindingStore(join(directory, "bridge.db"));
    createPrimary(store, "parent-server-owned");
    store.createAgentInstance({ id: "worker", projectId: "p1", name: "worker", role: "worker", agentKind: "codex", model: null, parent: { bindingId: "binding", paneId: "p", nativeSessionId: null }, workerSessionLifecycle: "active", desiredState: "running", workspace: { id: "worker-ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    store.createAgentInstance({ id: "other-worker", projectId: "p2", name: "other-worker", role: "worker", agentKind: "codex", model: null, parent: { bindingId: "other-binding", paneId: "other-primary-pane", nativeSessionId: null }, workerSessionLifecycle: "active", desiredState: "running", workspace: { id: "other-worker-ws", kind: "shared-read-only", cwd: "/other", branch: null, baseCommit: "base" } });
    store.createAgentInstance({ id: "legacy-primary", projectId: "p1", name: "legacy-primary", role: "primary", agentKind: "codex", model: null, desiredState: "running", workspace: { id: "legacy-primary-ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const driver = { kind: "codex", describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "terminal-input", interrupt: "terminal-signal", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }), start: async () => undefined, submit: async () => ({ status: "confirmed-delivered" as const }) } satisfies AgentRuntimeDriver;
    const messaging = new InstanceMessagingWorkflow({ store, drivers: new AgentDriverRegistry([driver]), paneHost: {} as never, turnControl: { steer: async () => { throw new Error("not active"); } } as never, wake: vi.fn(), idFactory: () => "worker-turn", presentation: workerPresentation });
    const socketPath = join(directory, "tools.sock");
    gateway = new PrimaryToolGateway(socketPath, process.execPath, ["dist/cli/primary-tools-mcp.js"], store, messaging, pino({ enabled: false }));
    const launch = gateway.issueBinding("binding", 1);
    store.attachAgentInstanceRuntime({ instanceId: "worker", expectedGeneration: 1, herdrWorkspaceId: "w", paneId: "q", nativeSessionId: null });
    await gateway.start();
    const capability = launch.environment.SWARM_PRIMARY_CAPABILITY!;
    await expect(call(socketPath, { bindingId: "binding", generation: 1, capability, tool: "promptInstance", arguments: { instanceId: "worker", task: "review", idempotencyKey: "child", projectId: "forged", parentPromptId: "forged" } })).resolves.toMatchObject({ ok: true, result: { accepted: true, turn: { actor: { kind: "thread-primary", parentPromptId: "parent-server-owned" } } } });
    await expect(call(socketPath, { bindingId: "binding", generation: 1, capability: "0".repeat(64), tool: "listInstances", arguments: {} })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid or stale/) });
    await expect(call(socketPath, { bindingId: "binding", generation: 2, capability, tool: "listInstances", arguments: {} })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid or stale/) });
    await expect(call(socketPath, { bindingId: "binding", generation: 1, capability, tool: "inspectInstance", arguments: { instanceId: "other-worker" } })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/authorized current thread Primary/) });
    await expect(call(socketPath, { bindingId: "binding", generation: 1, capability, tool: "inspectInstance", arguments: { instanceId: "legacy-primary" } })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/only Workers owned by this Primary pane/) });
    await expect(call(socketPath, { bindingId: "binding", instanceId: "primary", generation: 1, capability, tool: "listInstances", arguments: {} })).resolves.toMatchObject({ ok: false });

    store.updatePrompt("parent-server-owned", "delivered");
    await expect(call(socketPath, { bindingId: "binding", generation: 1, capability, tool: "listInstances", arguments: {} })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/active ordinary binding prompt/) });
    store.updateBinding("binding", { state: "archived", lifecycle: "archived" });
    await expect(call(socketPath, { bindingId: "binding", generation: 1, capability, tool: "listInstances", arguments: {} })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid or stale/) });
  });

  it("keeps a persisted capability valid across gateway restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "primary-tools-restart-")); const path = join(directory, "bridge.db"); const socketPath = join(directory, "tools.sock");
    store = new SqliteBindingStore(path);
    createPrimary(store);
    const capability = "a".repeat(64); const capabilityHash = createHash("sha256").update(capability).digest("hex");
    expect(store.setBindingPrimaryToolCapability({ bindingId: "binding", expectedGeneration: 1, capabilityHash })).toBe(true);
    const messaging = new InstanceMessagingWorkflow({ store, drivers: new AgentDriverRegistry([]), paneHost: {} as never, turnControl: { steer: async () => { throw new Error("not active"); } } as never, wake: () => undefined, idFactory: () => "unused", presentation: workerPresentation });
    gateway = new PrimaryToolGateway(socketPath, process.execPath, [], store, messaging, pino({ enabled: false })); await gateway.start(); await gateway.stop(); await gateway.start();
    await expect(call(socketPath, { bindingId: "binding", generation: 1, capability, tool: "listInstances", arguments: {} })).resolves.toMatchObject({ ok: true });
  });

  it("rejects a current-generation credential when the only running prompt belongs to an earlier generation", async () => {
    directory = await mkdtemp(join(tmpdir(), "primary-tools-generation-"));
    store = new SqliteBindingStore(join(directory, "bridge.db"));
    createPrimary(store, "generation-1");
    store.updateBinding("binding", { generation: 2 });
    const messaging = new InstanceMessagingWorkflow({ store, drivers: new AgentDriverRegistry([]), paneHost: {} as never, turnControl: { steer: async () => { throw new Error("not active"); } } as never, wake: () => undefined, idFactory: () => "unused", presentation: workerPresentation });
    const socketPath = join(directory, "tools.sock");
    gateway = new PrimaryToolGateway(socketPath, process.execPath, [], store, messaging, pino({ enabled: false }));
    const launch = gateway.issueBinding("binding", 2);
    await gateway.start();

    await expect(call(socketPath, { bindingId: "binding", generation: 2, capability: launch.environment.SWARM_PRIMARY_CAPABILITY, tool: "listInstances", arguments: {} })).resolves.toMatchObject({
      ok: false, error: expect.stringMatching(/active ordinary binding prompt/)
    });
  });

  it("rejects a stale capability after a caller-selected pane is attached", async () => {
    directory = await mkdtemp(join(tmpdir(), "primary-tools-reattach-"));
    store = new SqliteBindingStore(join(directory, "bridge.db"));
    createPrimary(store);
    const capability = "b".repeat(64);
    store.setBindingPrimaryToolCapability({ bindingId: "binding", expectedGeneration: 1, capabilityHash: createHash("sha256").update(capability).digest("hex") });
    store.updateBinding("binding", { state: "orphaned", attachment: "orphaned" });
    store.attachBindingPane("binding", { paneId: "w:selected", terminalId: "selected-terminal", workspaceId: "w", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"] }, false);
    const messaging = new InstanceMessagingWorkflow({ store, drivers: new AgentDriverRegistry([]), paneHost: {} as never, turnControl: { steer: async () => { throw new Error("not active"); } } as never, wake: () => undefined, idFactory: () => "unused", presentation: workerPresentation });
    const socketPath = join(directory, "tools.sock");
    gateway = new PrimaryToolGateway(socketPath, process.execPath, [], store, messaging, pino({ enabled: false }));
    await gateway.start();

    await expect(call(socketPath, { bindingId: "binding", generation: 1, capability, tool: "listInstances", arguments: {} })).resolves.toMatchObject({
      ok: false, error: expect.stringMatching(/invalid or stale/)
    });
  });
});

function call(socketPath: string, payload: object): Promise<unknown> { return new Promise((resolve, reject) => { const socket = createConnection(socketPath); let output = ""; socket.setEncoding("utf8"); socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`)); socket.on("data", (chunk) => { output += chunk; }); socket.once("end", () => resolve(JSON.parse(output))); socket.once("error", reject); }); }
function createPrimary(target: SqliteBindingStore, promptId = "parent"): void {
  target.createPendingBinding({ id: "binding", projectId: "p1", workspaceId: "w", chatId: "c", topicId: "t", rootMessageId: "root", title: "Primary" });
  target.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "p" });
  const view = createQueuedRunCard({ promptId, bindingId: "binding", title: "parent", workspaceId: "w", paneId: "p", requestText: "coordinate", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
  target.acceptPrompt({ prompt: { id: promptId, bindingId: "binding", larkMessageId: `message-${promptId}`, actorOpenId: "u", body: "coordinate" }, view, rootMessageId: "root", answerCard: {} });
  target.updatePrompt(promptId, "running");
}
