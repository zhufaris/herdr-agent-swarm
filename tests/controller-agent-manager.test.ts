import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CONTROLLER_DISALLOWED_TOOLS, ControllerAgentManager, controllerAgentArguments } from "../src/runtime/controller-agent-manager.js";

const project = { id: "default", displayName: "Default", description: "Default project", workspaceId: "w1", cwd: "/repo" };
const message = { eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "admin", text: "看看 reviewer 然后决定怎么办", mentionsBot: true, isRootMessage: true };

describe("ControllerAgentManager", () => {
  it("reuses only the exact persisted Controller runtime", async () => {
    const store = memoryStore({ generation: 4, paneId: "w1:p4", terminalId: "term-4", nativeSessionId: "session-4", state: "active", createdAt: "now", updatedAt: "now" });
    const herdr = herdrPort({ paneId: "w1:p4", tabId: "w1:t4", terminalId: "term-4", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-4" }, agentKind: "traex", workspaceId: "w1", cwd: "/repo", label: "herdr-swarm-controller", agentState: "idle", foregroundExecutables: ["traex"] });
    const manager = createManager(store, herdr);
    await manager.start();
    expect(herdr.createPane).not.toHaveBeenCalled();
    expect(herdr.startAgent).not.toHaveBeenCalled();
    await manager.stop();
  });

  it("creates a dedicated read-only Controller and persists verified identity", async () => {
    const store = memoryStore(null);
    const pane = { paneId: "w1:p5", tabId: "w1:t5", terminalId: "term-5", agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-5" }, agentKind: "traex", workspaceId: "w1", cwd: "/repo", label: "herdr-swarm-controller", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr = herdrPort(pane);
    const manager = createManager(store, herdr);
    await manager.start();
    expect(herdr.createPane).toHaveBeenCalledWith("w1", "/repo", expect.objectContaining({ placement: "dedicated-tab", title: "herdr-swarm-controller" }));
    expect(herdr.startAgent).toHaveBeenCalledWith("w1:p5", expect.objectContaining({ name: "herdr-swarm-controller", useConfiguredPermissionMode: false, args: expect.arrayContaining(["--sandbox", "read-only", "--ask-for-approval", "never"]) }));
    expect(store.saveControllerRuntime).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, paneId: "w1:p5", terminalId: "term-5", nativeSessionId: "session-5" }), expect.any(String));
    await manager.stop();
  });

  it("retries startup in the exact reserved Controller shell pane", async () => {
    const store = memoryStore(null);
    const shell = { paneId: "w1:p5", tabId: "w1:t5", terminalId: "term-5", agentSession: null, agentKind: null, workspaceId: "w1", cwd: "/repo", label: "herdr-swarm-controller", agentState: "unknown" as const, foregroundExecutables: ["bash"] };
    const ready = { ...shell, agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-5" }, agentKind: "traex", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr = herdrPort(ready);
    herdr.listPanes.mockResolvedValue([shell]);
    const manager = createManager(store, herdr);
    await manager.start();
    expect(herdr.createPane).not.toHaveBeenCalled();
    expect(herdr.startAgent).toHaveBeenCalledWith("w1:p5", expect.objectContaining({ useConfiguredPermissionMode: false }));
    await manager.stop();
  });

  it("accepts a named ready Controller before TraeX publishes its first session id", async () => {
    const store = memoryStore(null);
    const shell = { paneId: "w1:p5", tabId: "w1:t5", terminalId: "term-5", agentSession: null, agentKind: null, workspaceId: "w1", cwd: "/repo", label: "herdr-swarm-controller", agentState: "unknown" as const, foregroundExecutables: ["bash"] };
    const ready = { ...shell, agentKind: "traex", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr = herdrPort(ready);
    herdr.listPanes.mockResolvedValue([shell]);
    herdr.startAgent.mockRejectedValue(new Error("agent session not available before first turn"));
    const manager = createManager(store, herdr);
    await manager.start();
    expect(store.saveControllerRuntime).toHaveBeenCalledWith(expect.objectContaining({ terminalId: "term-5", nativeSessionId: "term-5", state: "active" }), expect.any(String));
    await manager.stop();
  });

  it("dispatches one job and returns only its structured MCP result", async () => {
    const runtime = { generation: 1, paneId: "w1:p1", terminalId: "term-1", nativeSessionId: "session-1", state: "active" as const, createdAt: "now", updatedAt: "now" };
    const store = memoryStore(runtime);
    const herdr = herdrPort({ paneId: "w1:p1", terminalId: "term-1", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, agentKind: "traex", workspaceId: "w1", cwd: "/repo", label: "herdr-swarm-controller", agentState: "idle", foregroundExecutables: ["traex"] });
    herdr.runPrompt.mockImplementation(async (_pane: string, _prompt: string, _timeout: number, _observe: unknown, _signal: unknown, onDispatched: () => void) => {
      onDispatched();
      store.finishControllerInterpretation("job-1", 1, { outcome: "command", source: "controller", family: "swarm", command: { kind: "panes" } }, new Date().toISOString());
      return "done";
    });
    const manager = createManager(store, herdr);
    await manager.start();
    await expect(manager.interpret(message.text, message)).resolves.toEqual({ outcome: "command", source: "controller", family: "swarm", command: { kind: "panes" } });
    expect(herdr.runPrompt).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("marks a possibly dispatched request uncertain and never requeues it", async () => {
    const runtime = { generation: 1, paneId: "w1:p1", terminalId: "term-1", nativeSessionId: "session-1", state: "active" as const, createdAt: "now", updatedAt: "now" };
    const store = memoryStore(runtime);
    const herdr = herdrPort({ paneId: "w1:p1", terminalId: "term-1", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, agentKind: "traex", workspaceId: "w1", cwd: "/repo", label: "herdr-swarm-controller", agentState: "idle", foregroundExecutables: ["traex"] });
    herdr.runPrompt.mockImplementation(async (_pane: string, _prompt: string, _timeout: number, _observe: unknown, _signal: unknown, onDispatched: () => void) => { onDispatched(); throw new Error("connection lost"); });
    const manager = createManager(store, herdr);
    await manager.start();
    await expect(manager.interpret(message.text, message)).resolves.toEqual({ outcome: "unresolved" });
    expect(store.getControllerInterpretation("job-1")).toMatchObject({ state: "uncertain" });
    expect(herdr.runPrompt).toHaveBeenCalledTimes(1);
    await manager.stop();
  });
});

describe("controllerAgentArguments", () => {
  it("allows only the Controller MCP tools and explicitly denies ambient capabilities", () => {
    const args = controllerAgentArguments("node", ["controller-tools"]);
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ask-for-approval", "never"]));
    expect(args.filter((value) => value === "--allowed-tool")).toHaveLength(3);
    expect(optionValues(args, "--allowed-tool")).toEqual([
      "mcp__herdr_swarm_controller__get_interpretation_context",
      "mcp__herdr_swarm_controller__inspect_swarm_target",
      "mcp__herdr_swarm_controller__submit_interpretation",
    ]);
    expect(optionValues(args, "--disallowed-tool")).toEqual(CONTROLLER_DISALLOWED_TOOLS);
    expect(CONTROLLER_DISALLOWED_TOOLS).toEqual(expect.arrayContaining([
      "exec", "functions.exec", "multi_tool_use.parallel", "exec_command",
      "apply_patch", "Read", "Write", "web_search",
      "browser_use", "request_user_input", "spawn_agent",
      "collaboration__spawn_agent", "update_plan",
    ]));
    expect(CONTROLLER_DISALLOWED_TOOLS).not.toContain(expect.stringContaining("herdr_swarm_controller"));
  });
});

function optionValues(args: readonly string[], option: string): string[] {
  return args.flatMap((value, index) => value === option ? [args[index + 1]!] : []);
}

function createManager(store: ReturnType<typeof memoryStore>, herdr: ReturnType<typeof herdrPort>) {
  return new ControllerAgentManager({ store, herdr, project, traexExecutable: "traex", mcpCommand: "node", mcpArgs: ["controller-tools"], turnTimeoutMs: 100, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, idFactory: () => "job-1", capabilityFactory: () => "a".repeat(64), pollIntervalMs: 1 });
}

function memoryStore(runtime: any) {
  let currentRuntime = runtime; let job: any = null;
  return {
    recoverControllerInterpretations: vi.fn(() => 0), getControllerRuntime: vi.fn(() => currentRuntime),
    saveControllerRuntime: vi.fn((input, at) => currentRuntime = { ...input, createdAt: at, updatedAt: at }), markControllerRuntimeStale: vi.fn(() => true),
    acceptControllerInterpretation: vi.fn((input) => { job ??= { id: input.id, sourceMessageId: input.message.messageId, message: input.message, controllerGeneration: input.controllerGeneration, capabilityHash: input.capabilityHash, state: "accepted", result: null, runtimeTurnId: null, dispatchedAt: null, error: null, createdAt: input.acceptedAt, updatedAt: input.acceptedAt }; return { job, inserted: true }; }),
    claimNextControllerInterpretation: vi.fn((generation, capabilityHash, at) => { if (job?.state !== "accepted") return null; job = { ...job, controllerGeneration: generation, capabilityHash, state: "dispatching", updatedAt: at }; return job; }),
    markControllerInterpretationDispatched: vi.fn((_id, _generation, runtimeTurnId, at) => { if (job?.state !== "dispatching") return null; job = { ...job, state: "observing", runtimeTurnId, dispatchedAt: at, updatedAt: at }; return job; }),
    finishControllerInterpretation: vi.fn((_id, _generation, result, at) => { if (!["dispatching", "observing"].includes(job?.state)) return null; job = { ...job, state: result.outcome === "command" ? "succeeded" : result.outcome, result, updatedAt: at }; return job; }),
    failControllerInterpretation: vi.fn((_id, _generation, state, error, at) => { if (!["dispatching", "observing"].includes(job?.state)) return null; job = { ...job, state, error, updatedAt: at }; return job; }),
    getControllerInterpretation: vi.fn(() => job)
  };
}

function herdrPort(pane: any) {
  return { getPane: vi.fn(async () => pane), listPanes: vi.fn(async () => []), createPane: vi.fn(async () => pane), startAgent: vi.fn(async () => undefined), runPrompt: vi.fn(async () => "done") } as any;
}
