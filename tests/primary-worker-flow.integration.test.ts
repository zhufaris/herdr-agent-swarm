import { createConnection } from "node:net";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePrimaryMcpRequest } from "../src/cli/primary-tools-mcp.js";
import { InstanceMessagingWorkflow } from "../src/coordinator/instance-messaging-workflow.js";
import { PromptRunWorkflow } from "../src/coordinator/prompt-run-workflow.js";
import { WorkerTurnObserver } from "../src/coordinator/worker-turn-observer.js";
import type { AgentRuntimeDriver } from "../src/domain/agent-runtime.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";
import { InstanceWorkScheduler } from "../src/events/instance-work-scheduler.js";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import { PrimaryToolGateway } from "../src/runtime/primary-tool-gateway.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { primaryPresentation, workerPresentation } from "./helpers/presentation.js";

let directory: string | undefined; let store: SqliteBindingStore | undefined; let gateway: PrimaryToolGateway | undefined; let scheduler: InstanceWorkScheduler | undefined; let promptRun: PromptRunWorkflow | undefined;
afterEach(async () => { await promptRun?.stop(); await scheduler?.stop(); await gateway?.stop(); store?.close(); if (directory) await rm(directory, { recursive: true, force: true }); promptRun = undefined; scheduler = undefined; gateway = undefined; store = undefined; directory = undefined; });

describe("Primary to Worker product flow", () => {
  it("lets one binding prompt delegate to one Worker exactly once without creating another Primary prompt", async () => {
    directory = await mkdtemp(join(tmpdir(), "primary-worker-flow-")); store = new SqliteBindingStore(join(directory, "bridge.db"));
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "primary-prompt", bindingId: "binding", title: "coordinate", workspaceId: "herdr", paneId: "primary:pane", requestText: "ask Worker", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "primary-prompt", bindingId: "binding", larkMessageId: "message", actorOpenId: "operator", body: "ask Worker" }, view, rootMessageId: "root", answerCard: {} });
    store.createAgentInstance({ id: "worker", projectId: "project", name: "worker", role: "worker", agentKind: "traex", model: null, parent: { bindingId: "binding", paneId: "primary:pane", nativeSessionId: null }, workerSessionLifecycle: "active", desiredState: "running", workspace: { id: "worker-ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    store.createAgentInstance({ id: "sibling-worker", projectId: "project", name: "sibling", role: "worker", agentKind: "traex", model: null, parent: { bindingId: "other-binding", paneId: "other-primary:pane", nativeSessionId: null }, workerSessionLifecycle: "active", desiredState: "stopped", workspace: { id: "sibling-worker-ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const workerSessionId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const worker = store.attachAgentInstanceRuntime({ instanceId: "worker", expectedGeneration: 1, herdrWorkspaceId: "herdr", paneId: "worker:pane", nativeSessionId: workerSessionId })!;
    let workerSubmitCount = 0; const driver: AgentRuntimeDriver = { kind: "traex", describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", interrupt: "native", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }), start: async () => undefined, submit: vi.fn(async (_runtime, _text, hooks) => { workerSubmitCount += 1; await hooks?.onDispatched?.(); return { status: "confirmed-delivered" }; }) };
    const drivers = new AgentDriverRegistry([driver]);
    const workerRuntimeTurnId = "01a052d3-9c14-70e1-a375-397e2ecb5501";
    let workerTranscriptRead = false;
    const workerTurns = new WorkerTurnObserver({ store, transcriptReader: { async open() { return { mode: "typed" as const, cursor: {
      async readDelta() { return ""; },
      async readObservation() {
        if (workerTranscriptRead) return { answerDelta: "" };
        workerTranscriptRead = true;
        return { turnId: workerRuntimeTurnId, freshTurnStart: true, answerDelta: "WORKER_OK", turnLifecycle: { turnId: workerRuntimeTurnId, state: "completed" as const, startedAt: "2026-08-30T00:00:01.000Z" } };
      }
    } }; } }, wakeInstance: (instanceId) => scheduler?.wake(instanceId), wakeOutbound: () => {}, presentation: workerPresentation });
    scheduler = new InstanceWorkScheduler({ store, drivers, observer: workerTurns, presentation: workerPresentation });
    const messaging = new InstanceMessagingWorkflow({ store, drivers, paneHost: {} as never, turnControl: { steer: async () => { throw new Error("not active"); } } as never, wake: (id) => scheduler!.wake(id), idFactory: () => "worker-turn", presentation: workerPresentation });
    const socketPath = join(directory, "primary-tools.sock"); gateway = new PrimaryToolGateway(socketPath, process.execPath, [], store, messaging, pino({ enabled: false }));
    const launch = gateway.issueBinding("binding", 1); await gateway.start();
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const response = await handlePrimaryMcpRequest({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }, async (tool, arguments_) => {
        const envelope = await callGateway(socketPath, { bindingId: "binding", generation: 1, capability: launch.environment.SWARM_PRIMARY_CAPABILITY, tool, arguments: arguments_ }) as { ok: boolean; result?: unknown; error?: string };
        if (!envelope.ok) throw new Error(envelope.error); return envelope.result;
      }) as { result?: { structuredContent?: unknown } }; return response.result?.structuredContent;
    };
    let primaryAnswer = "";
    const primaryHerdr = {
      async runPrompt(_paneId: string, _text: string, _timeoutMs: number, _onObservation?: unknown, _signal?: AbortSignal, onDispatched?: () => void) {
        onDispatched?.();
        expect(await invoke("list_instances", {})).toMatchObject([{ id: worker.id }]);
        expect(await invoke("prompt_instance", { instanceId: "sibling-worker", task: "must reject", idempotencyKey: "cross-primary" })).toBeUndefined();
        expect(await invoke("prompt_instance", { instanceId: worker.id, task: "Reply WORKER_OK", idempotencyKey: "child" })).toMatchObject({ inserted: true });
        await vi.waitFor(() => expect(store!.getInstanceTurn("worker-turn")?.state).toBe("completed"));
        const inspected = await invoke("inspect_instance", { instanceId: worker.id }) as { turns: Array<{ result: string | null }> };
        primaryAnswer = `PRIMARY_RESULT: ${inspected.turns[0]!.result}`;
        expect(await invoke("prompt_instance", { instanceId: worker.id, task: "Reply WORKER_OK", idempotencyKey: "child" })).toMatchObject({ inserted: false });
        return "done" as const;
      }
    } as never;
    const promptScheduler = new InProcessPromptWorkScheduler();
    const primaryTurnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9"; let transcriptRead = false;
    promptRun = new PromptRunWorkflow({ store, herdr: primaryHerdr, bus: new BridgeEventBus(), scheduler: promptScheduler, outboundWork: { wake() {} }, presentation: primaryPresentation, logger: pino({ enabled: false }), turnTimeoutMs: 1_000, transcriptReader: { async open() { return { mode: "typed" as const, cursor: {
      async readDelta() { return ""; },
      async readObservation() {
        const answerDelta = transcriptRead ? "" : primaryAnswer; transcriptRead = true; primaryAnswer = "";
        return { turnId: primaryTurnId, ...(answerDelta ? { freshTurnStart: true } : {}), answerDelta, turnLifecycle: { turnId: primaryTurnId, state: "completed" as const, startedAt: new Date().toISOString() } };
      }
    } }; } } });
    promptRun.start(); promptScheduler.wake({ kind: "prompt-ready", bindingId: "binding" });
    await vi.waitFor(() => expect(store!.getPrompt("primary-prompt")?.state).toBe("delivered"));
    expect(store.listInstanceTurns(worker.id).items).toEqual([expect.objectContaining({ state: "completed", result: "WORKER_OK", actor: { kind: "thread-primary", projectId: "project", bindingId: "binding", bindingGeneration: 1, parentPromptId: "primary-prompt" } })]);
    expect(store.getPrompt("primary-prompt")).toMatchObject({ state: "delivered" });
    expect(store.loadRunCard("primary-prompt")).toMatchObject({ phase: "completed", answer: "PRIMARY_RESULT: WORKER_OK" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 1 }); expect(workerSubmitCount).toBe(1);
  });
});

function callGateway(socketPath: string, payload: object): Promise<unknown> { return new Promise((resolve, reject) => { const socket = createConnection(socketPath); let output = ""; socket.setEncoding("utf8"); socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`)); socket.on("data", (chunk) => { output += chunk; }); socket.once("end", () => resolve(JSON.parse(output))); socket.once("error", reject); }); }
