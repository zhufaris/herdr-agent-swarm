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

let directory: string | undefined; let store: SqliteBindingStore | undefined; let gateway: PrimaryToolGateway | undefined;
afterEach(async () => { await gateway?.stop(); store?.close(); if (directory) await rm(directory, { recursive: true, force: true }); gateway = undefined; store = undefined; directory = undefined; });

describe("Primary tool gateway", () => {
  it("executes at most one request per connection and closes idle clients", async () => {
    directory = await mkdtemp(join(tmpdir(), "primary-tools-framing-"));
    store = new SqliteBindingStore(join(directory, "bridge.db"));
    store.createAgentInstance({ id: "primary", projectId: "p1", name: "primary", role: "primary", agentKind: "codex", model: null, desiredState: "running", workspace: { id: "primary-ws", kind: "main-checkout", cwd: "/repo", branch: null, baseCommit: "base" } });
    const messaging = { interrupt: vi.fn(() => new Promise(() => undefined)) } as never;
    const socketPath = join(directory, "tools.sock");
    gateway = new PrimaryToolGateway(socketPath, process.execPath, [], store, messaging, pino({ enabled: false }), [], { idleTimeoutMs: 25 });
    const launch = gateway.issue("primary", 1);
    store.attachAgentInstanceRuntime({ instanceId: "primary", expectedGeneration: 1, herdrWorkspaceId: "w", paneId: "p", nativeSessionId: null });
    store.acceptInstanceTurn({ id: "parent", idempotencyKey: "parent", actor: { kind: "human", userId: "u" }, projectId: "p1", instanceId: "primary", instanceGeneration: 2, kind: "turn", text: "coordinate" });
    store.claimNextInstanceTurn("primary", 2);
    await gateway.start();
    const payload = { instanceId: "primary", generation: 2, capability: launch.environment.SWARM_PRIMARY_CAPABILITY, tool: "interruptInstance", arguments: { instanceId: "worker", idempotencyKey: "interrupt" } };
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
    store.createAgentInstance({ id: "primary", projectId: "p1", name: "primary", role: "primary", agentKind: "codex", model: null, desiredState: "running", workspace: { id: "primary-ws", kind: "main-checkout", cwd: "/repo", branch: null, baseCommit: "base" } });
    store.createAgentInstance({ id: "worker", projectId: "p1", name: "worker", role: "worker", agentKind: "codex", model: null, desiredState: "running", workspace: { id: "worker-ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const driver = { kind: "codex", describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "terminal-input", interrupt: "terminal-signal", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }), start: async () => undefined, submit: async () => ({ status: "confirmed-delivered" as const }) } satisfies AgentRuntimeDriver;
    const messaging = new InstanceMessagingWorkflow({ store, drivers: new AgentDriverRegistry([driver]), paneHost: {} as never, wake: vi.fn(), idFactory: () => "worker-turn" });
    const socketPath = join(directory, "tools.sock");
    gateway = new PrimaryToolGateway(socketPath, process.execPath, ["dist/cli/primary-tools-mcp.js"], store, messaging, pino({ enabled: false }));
    const launch = gateway.issue("primary", 1);
    store.attachAgentInstanceRuntime({ instanceId: "primary", expectedGeneration: 1, herdrWorkspaceId: "w", paneId: "p", nativeSessionId: null });
    store.attachAgentInstanceRuntime({ instanceId: "worker", expectedGeneration: 1, herdrWorkspaceId: "w", paneId: "q", nativeSessionId: null });
    store.acceptInstanceTurn({ id: "parent-server-owned", idempotencyKey: "parent", actor: { kind: "human", userId: "u" }, projectId: "p1", instanceId: "primary", instanceGeneration: 2, kind: "turn", text: "coordinate" });
    store.claimNextInstanceTurn("primary", 2);
    await gateway.start();
    const capability = launch.environment.SWARM_PRIMARY_CAPABILITY!;
    await expect(call(socketPath, { instanceId: "primary", generation: 2, capability, tool: "promptInstance", arguments: { instanceId: "worker", task: "review", idempotencyKey: "child", projectId: "forged", parentTurnId: "forged" } })).resolves.toMatchObject({ ok: true, result: { accepted: true, turn: { actor: { parentTurnId: "parent-server-owned" } } } });
    await expect(call(socketPath, { instanceId: "primary", generation: 2, capability: "0".repeat(64), tool: "listInstances", arguments: {} })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid or stale/) });
  });

  it("keeps a persisted capability valid across gateway restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "primary-tools-restart-")); const path = join(directory, "bridge.db"); const socketPath = join(directory, "tools.sock");
    store = new SqliteBindingStore(path);
    store.createAgentInstance({ id: "primary", projectId: "p1", name: "primary", role: "primary", agentKind: "codex", model: null, desiredState: "running", workspace: { id: "ws", kind: "main-checkout", cwd: "/repo", branch: null, baseCommit: "base" } });
    const capability = "a".repeat(64); const capabilityHash = createHash("sha256").update(capability).digest("hex");
    expect(store.setPrimaryToolCapability({ instanceId: "primary", expectedGeneration: 1, credentialGeneration: 2, capabilityHash })).toBe(true);
    store.attachAgentInstanceRuntime({ instanceId: "primary", expectedGeneration: 1, herdrWorkspaceId: "w", paneId: "p", nativeSessionId: null });
    store.acceptInstanceTurn({ id: "parent", idempotencyKey: "parent", actor: { kind: "human", userId: "u" }, projectId: "p1", instanceId: "primary", instanceGeneration: 2, kind: "turn", text: "coordinate" }); store.claimNextInstanceTurn("primary", 2);
    const messaging = new InstanceMessagingWorkflow({ store, drivers: new AgentDriverRegistry([]), paneHost: {} as never, wake: () => undefined, idFactory: () => "unused" });
    gateway = new PrimaryToolGateway(socketPath, process.execPath, [], store, messaging, pino({ enabled: false })); await gateway.start(); await gateway.stop(); await gateway.start();
    await expect(call(socketPath, { instanceId: "primary", generation: 2, capability, tool: "listInstances", arguments: {} })).resolves.toMatchObject({ ok: true });
  });
});

function call(socketPath: string, payload: object): Promise<unknown> { return new Promise((resolve, reject) => { const socket = createConnection(socketPath); let output = ""; socket.setEncoding("utf8"); socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`)); socket.on("data", (chunk) => { output += chunk; }); socket.once("end", () => resolve(JSON.parse(output))); socket.once("error", reject); }); }
