import { createConnection } from "node:net";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePrimaryMcpRequest } from "../src/cli/primary-tools-mcp.js";
import { InstanceMessagingWorkflow } from "../src/coordinator/instance-messaging-workflow.js";
import type { AgentInstance } from "../src/domain/agent-instance.js";
import type { AgentRuntimeDriver } from "../src/domain/agent-runtime.js";
import { InstanceWorkScheduler } from "../src/events/instance-work-scheduler.js";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import { PrimaryToolGateway } from "../src/runtime/primary-tool-gateway.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

let directory: string | undefined;
let store: SqliteBindingStore | undefined;
let gateway: PrimaryToolGateway | undefined;
let scheduler: InstanceWorkScheduler | undefined;

afterEach(async () => {
  await scheduler?.stop();
  await gateway?.stop();
  store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  scheduler = undefined; gateway = undefined; store = undefined; directory = undefined;
});

describe("Primary to Worker product flow", () => {
  it("discovers, delegates to, waits for, and summarizes one Worker exactly once", async () => {
    directory = await mkdtemp(join(tmpdir(), "primary-worker-flow-"));
    store = new SqliteBindingStore(join(directory, "bridge.db"));
    store.createAgentInstance(instanceInput("primary", "primary"));
    let primary!: AgentInstance;
    const worker = createInstance(store, "worker", "worker");
    let nextTurn = 0;
    let workerSubmitCount = 0;
    const toolCalls: string[] = [];

    let callPrimaryTool!: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    const driver: AgentRuntimeDriver = {
      kind: "traex",
      describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", interrupt: "native", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }),
      start: async () => undefined,
      submit: vi.fn(async (runtime, _text, onDispatched) => {
        onDispatched?.();
        if (runtime.paneId === worker.runtimeRef!.paneId) { workerSubmitCount += 1; return { status: "confirmed-delivered" as const, runtimeCursor: "WORKER_OK" }; }
        const listed = await callPrimaryTool("list_instances", {}) as AgentInstance[];
        expect(listed.find(({ id }) => id === worker.id)).toMatchObject({ role: "worker", projectId: "project" });
        const first = await callPrimaryTool("prompt_instance", { instanceId: worker.id, task: "Reply with WORKER_OK", idempotencyKey: "primary-to-worker-flow" }) as { inserted: boolean };
        expect(first.inserted).toBe(true);
        let cursor = "0";
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const waited = await callPrimaryTool("wait_instance", { instanceId: worker.id, afterCursor: cursor, timeoutMs: 25 }) as { events: Array<{ kind: string }>; cursor: string };
          cursor = waited.cursor;
          if (waited.events.some(({ kind }) => kind === "turn.completed")) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const inspected = await callPrimaryTool("inspect_instance", { instanceId: worker.id }) as { turns: Array<{ state: string; result: string | null }> };
        expect(inspected.turns).toContainEqual(expect.objectContaining({ state: "completed", result: "WORKER_OK" }));
        const duplicate = await callPrimaryTool("prompt_instance", { instanceId: worker.id, task: "Reply with WORKER_OK", idempotencyKey: "primary-to-worker-flow" }) as { inserted: boolean };
        expect(duplicate.inserted).toBe(false);
        return { status: "confirmed-delivered" as const, runtimeCursor: "PRIMARY_SUMMARY: WORKER_OK" };
      })
    };
    const drivers = new AgentDriverRegistry([driver]);
    let messaging!: InstanceMessagingWorkflow;
    scheduler = new InstanceWorkScheduler({ store, drivers });
    messaging = new InstanceMessagingWorkflow({ store, drivers, paneHost: {} as never, wake: (instanceId) => scheduler!.wake(instanceId), idFactory: () => `turn-${++nextTurn}` });
    const socketPath = join(directory, "primary-tools.sock");
    gateway = new PrimaryToolGateway(socketPath, process.execPath, [], store, messaging, pino({ enabled: false }));
    const launch = gateway.issue("primary", 1);
    const capability = launch.environment.SWARM_PRIMARY_CAPABILITY!;
    primary = store.attachAgentInstanceRuntime({ instanceId: "primary", expectedGeneration: 1, herdrWorkspaceId: "herdr", paneId: "primary:pane", nativeSessionId: null })!;
    await gateway.start();
    callPrimaryTool = async (name, args) => {
      toolCalls.push(name);
      const response = await handlePrimaryMcpRequest({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }, async (tool, arguments_) => {
        const envelope = await callGateway(socketPath, { instanceId: primary.id, generation: primary.generation, capability, tool, arguments: arguments_ }) as { ok: boolean; result?: unknown; error?: string };
        if (!envelope.ok) throw new Error(envelope.error ?? "Primary tool gateway rejected the request");
        return envelope.result;
      }) as { result?: { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> } };
      if (response.result?.isError) throw new Error(response.result.content?.[0]?.text ?? `Primary tool ${name} failed`);
      return response.result?.structuredContent;
    };

    await messaging.submit({ idempotencyKey: "human-to-primary", actor: { kind: "human", userId: "operator", channel: "feishu" }, projectId: "project", targetInstanceId: primary.id, content: { kind: "turn", text: "Ask Worker and summarize the result" } });
    await vi.waitFor(() => expect(store!.listInstanceTurns(primary.id).items[0]?.state).toBe("completed"));

    const primaryTurns = store.listInstanceTurns(primary.id).items;
    const workerTurns = store.listInstanceTurns(worker.id).items;
    expect(toolCalls.slice(0, 2)).toEqual(["list_instances", "prompt_instance"]);
    expect(toolCalls.filter((name) => name === "wait_instance").length).toBeGreaterThanOrEqual(1);
    expect(toolCalls.slice(-2)).toEqual(["inspect_instance", "prompt_instance"]);
    expect(toolCalls.filter((name) => name === "prompt_instance")).toHaveLength(2);
    expect(workerTurns).toHaveLength(1);
    expect(workerTurns[0]).toMatchObject({ state: "completed", actor: { kind: "primary-agent", instanceId: primary.id, parentTurnId: primaryTurns[0]!.id } });
    expect(store.listInstanceEvents(worker.id).map(({ kind }) => kind)).toContain("turn.completed");
    expect(primaryTurns).toHaveLength(1);
    expect(primaryTurns[0]).toMatchObject({ state: "completed", result: "PRIMARY_SUMMARY: WORKER_OK" });
    expect(workerSubmitCount).toBe(1);

  });
});

function createInstance(store: SqliteBindingStore, id: string, role: "primary" | "worker"): AgentInstance {
  store.createAgentInstance(instanceInput(id, role));
  return store.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "herdr", paneId: `${id}:pane`, nativeSessionId: null })!;
}

function instanceInput(id: string, role: "primary" | "worker") {
  return { id, projectId: "project", name: id, role, agentKind: "traex" as const, model: null, desiredState: "running" as const, workspace: { id: `workspace-${id}`, kind: role === "primary" ? "main-checkout" as const : "shared-read-only" as const, cwd: "/repo", branch: null, baseCommit: "base" } };
}

function callGateway(socketPath: string, payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let output = "";
    socket.setEncoding("utf8"); socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`)); socket.on("data", (chunk) => { output += chunk; });
    socket.once("end", () => resolve(JSON.parse(output))); socket.once("error", reject);
  });
}
