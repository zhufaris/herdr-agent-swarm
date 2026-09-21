import { existsSync } from "node:fs";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNaturalLanguageCommandRuntime } from "../src/runtime/natural-language-command-runtime.js";

const projects = [
  { id: "datasage", displayName: "DataSage", spaceName: "datasage-space", description: "Data", workspaceId: "w1", cwd: "/repo" }
];

describe("NaturalLanguageCommandRuntime", () => {
  it("provides idempotent lifecycle and deterministic interpretation when Controller is disabled", async () => {
    const runtime = createNaturalLanguageCommandRuntime({ projects });

    await runtime.start();
    await runtime.start();
    await expect(runtime.interpret("查看项目")).resolves.toMatchObject({
      outcome: "command",
      source: "deterministic",
      family: "swarm",
      command: { kind: "projects" }
    });
    await expect(runtime.interpret("看看 reviewer 然后决定怎么办")).resolves.toEqual({ outcome: "unresolved" });
    await runtime.stop();
    await runtime.stop();
  });

  it("admits only unresolved input to the enabled Controller FIFO", async () => {
    const directory = await mkdtemp(join(tmpdir(), "natural-language-runtime-"));
    const store = memoryStore();
    const herdr = herdrPort();
    herdr.runPrompt.mockImplementation(async (_pane: string, _prompt: string, _timeout: number, _observe: unknown, _signal: unknown, onDispatched: () => void) => {
      onDispatched();
      store.finishControllerInterpretation("job-1", 1, { outcome: "task", source: "controller" }, new Date().toISOString());
      return "done";
    });
    const runtime = createNaturalLanguageCommandRuntime({
      projects,
      controller: {
        store, herdr, project: projects[0]!, socketPath: join(directory, "controller.sock"),
        traexExecutable: "traex", mcpCommand: "node", mcpArgs: ["controller-tools"],
        turnTimeoutMs: 100, logger: logger(), idFactory: () => "job-1",
        capabilityFactory: () => "a".repeat(64), pollIntervalMs: 1
      }
    });
    const message = { eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "admin", text: "看看 reviewer 然后决定怎么办", mentionsBot: true, isRootMessage: true };

    await runtime.start();
    await expect(runtime.interpret("查看项目", message)).resolves.toMatchObject({ outcome: "command", source: "deterministic" });
    expect(store.acceptControllerInterpretation).not.toHaveBeenCalled();
    await expect(runtime.interpret(message.text, message)).resolves.toEqual({ outcome: "task", source: "controller" });
    expect(store.acceptControllerInterpretation).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("degrades to deterministic-only interpretation when Controller startup fails", async () => {
    const store = memoryStore();
    const log = logger();
    const runtime = createNaturalLanguageCommandRuntime({
      projects,
      controller: {
        store, herdr: herdrPort(), project: projects[0]!, socketPath: join(tmpdir(), "missing-parent", "controller.sock"),
        traexExecutable: "traex", mcpCommand: "node", mcpArgs: ["controller-tools"],
        turnTimeoutMs: 100, logger: log, pollIntervalMs: 1
      }
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    await expect(runtime.interpret("查看项目")).resolves.toMatchObject({ outcome: "command", source: "deterministic" });
    await expect(runtime.interpret("看看 reviewer 然后决定怎么办")).resolves.toEqual({ outcome: "unresolved" });
    expect(store.acceptControllerInterpretation).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "natural-language-controller-unavailable", outcome: "degraded" }), expect.any(String));
    await runtime.stop();
  });

  it("recovers durable jobs before the Controller endpoint accepts calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "natural-language-recovery-"));
    const socketPath = join(directory, "controller.sock");
    const store = memoryStore();
    store.recoverControllerInterpretations.mockImplementation(() => {
      expect(existsSync(socketPath)).toBe(false);
      return 0;
    });
    const runtime = createNaturalLanguageCommandRuntime({ projects, controller: controllerOptions(store, herdrPort(), socketPath) });

    await runtime.start();

    expect(store.recoverControllerInterpretations).toHaveBeenCalledOnce();
    await expect(access(socketPath)).resolves.toBeUndefined();
    await runtime.stop();
  });

  it("persists a possibly dispatched job before closing the Controller endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "natural-language-shutdown-"));
    const socketPath = join(directory, "controller.sock");
    const store = memoryStore();
    const herdr = herdrPort();
    let dispatched!: () => void;
    const wasDispatched = new Promise<void>((resolve) => { dispatched = resolve; });
    herdr.runPrompt.mockImplementation(async (_pane: string, _prompt: string, _timeout: number, _observe: unknown, signal: AbortSignal, onDispatched: () => void) => {
      onDispatched();
      dispatched();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return "unreachable";
    });
    store.failControllerInterpretation.mockImplementation((_id, _generation, state, error, at) => {
      expect(state).toBe("uncertain");
      expect(existsSync(socketPath)).toBe(true);
      return store.setFailed(state, error, at);
    });
    const runtime = createNaturalLanguageCommandRuntime({ projects, controller: controllerOptions(store, herdr, socketPath) });

    await runtime.start();
    const interpreting = runtime.interpret("看看 reviewer 然后决定怎么办", message);
    await wasDispatched;
    await runtime.stop();

    await expect(interpreting).resolves.toEqual({ outcome: "unresolved" });
    expect(store.getControllerInterpretation("job-1")).toMatchObject({ state: "uncertain" });
    await expect(access(socketPath)).rejects.toThrow();
  });

  it("records a pre-dispatch Controller failure as failed rather than uncertain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "natural-language-pre-dispatch-"));
    const store = memoryStore();
    const herdr = herdrPort();
    herdr.runPrompt.mockRejectedValue(new Error("submission rejected"));
    const runtime = createNaturalLanguageCommandRuntime({ projects, controller: controllerOptions(store, herdr, join(directory, "controller.sock")) });

    await runtime.start();
    await expect(runtime.interpret(message.text, message)).resolves.toEqual({ outcome: "unresolved" });

    expect(store.getControllerInterpretation("job-1")).toMatchObject({ state: "failed", error: "submission rejected" });
    await runtime.stop();
  });

  it("reuses only the exact persisted Controller runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "natural-language-reuse-"));
    const store = memoryStore();
    const herdr = herdrPort();
    const runtime = createNaturalLanguageCommandRuntime({ projects, controller: controllerOptions(store, herdr, join(directory, "controller.sock")) });

    await runtime.start();

    expect(herdr.createPane).not.toHaveBeenCalled();
    expect(herdr.startAgent).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("creates one dedicated read-only Controller and persists its verified identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "natural-language-create-"));
    const store = memoryStore(null);
    const pane = controllerPane({ paneId: "w1:p5", terminalId: "term-5", sessionId: "session-5" });
    const herdr = herdrPort(pane);
    const runtime = createNaturalLanguageCommandRuntime({ projects, controller: controllerOptions(store, herdr, join(directory, "controller.sock")) });

    await runtime.start();

    expect(herdr.createPane).toHaveBeenCalledWith("w1", "/repo", expect.objectContaining({ placement: "dedicated-tab", title: "herdr-swarm-controller" }));
    expect(herdr.startAgent).toHaveBeenCalledWith("w1:p5", expect.objectContaining({ name: "herdr-swarm-controller", useConfiguredPermissionMode: false, args: expect.arrayContaining(["--sandbox", "read-only", "--ask-for-approval", "never"]) }));
    expect(store.saveControllerRuntime).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, paneId: "w1:p5", terminalId: "term-5", nativeSessionId: "session-5" }), expect.any(String));
    await runtime.stop();
  });

  it("retries startup in the exact reserved shell Pane and accepts terminal identity before the first Agent session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "natural-language-shell-"));
    const store = memoryStore(null);
    const shell = controllerPane({ paneId: "w1:p5", terminalId: "term-5", sessionId: null, agentKind: null, agentState: "unknown", foregroundExecutables: ["bash"] });
    const ready = controllerPane({ paneId: "w1:p5", terminalId: "term-5", sessionId: null });
    const herdr = herdrPort(ready);
    herdr.listPanes.mockResolvedValue([shell]);
    herdr.startAgent.mockRejectedValue(new Error("agent session not available before first turn"));
    const runtime = createNaturalLanguageCommandRuntime({ projects, controller: controllerOptions(store, herdr, join(directory, "controller.sock")) });

    await runtime.start();

    expect(herdr.createPane).not.toHaveBeenCalled();
    expect(herdr.startAgent).toHaveBeenCalledWith("w1:p5", expect.objectContaining({ useConfiguredPermissionMode: false }));
    expect(store.saveControllerRuntime).toHaveBeenCalledWith(expect.objectContaining({ terminalId: "term-5", nativeSessionId: "term-5", state: "active" }), expect.any(String));
    await runtime.stop();
  });

  it("degrades without choosing when multiple Controller Panes require reconciliation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "natural-language-multiple-"));
    const store = memoryStore(null);
    const herdr = herdrPort();
    herdr.listPanes.mockResolvedValue([controllerPane({ paneId: "w1:p1" }), controllerPane({ paneId: "w1:p2" })]);
    const log = logger();
    const runtime = createNaturalLanguageCommandRuntime({ projects, controller: { ...controllerOptions(store, herdr, join(directory, "controller.sock")), logger: log } });

    await runtime.start();

    await expect(runtime.interpret(message.text, message)).resolves.toEqual({ outcome: "unresolved" });
    expect(herdr.createPane).not.toHaveBeenCalled();
    expect(herdr.startAgent).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "controller-runtime-unavailable", outcome: "degraded" }), expect.any(String));
    await runtime.stop();
  });

  it("recovers possibly dispatched work as uncertain without redispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "natural-language-no-replay-"));
    const store = memoryStore();
    store.recoverControllerInterpretations.mockReturnValue(1);
    const herdr = herdrPort();
    const runtime = createNaturalLanguageCommandRuntime({ projects, controller: controllerOptions(store, herdr, join(directory, "controller.sock")) });

    await runtime.start();

    expect(store.recoverControllerInterpretations).toHaveBeenCalledOnce();
    expect(herdr.runPrompt).not.toHaveBeenCalled();
    await runtime.stop();
  });
});

function logger() { return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }; }

function memoryStore(initialRuntime: any = { generation: 1, paneId: "w1:p1", terminalId: "term-1", nativeSessionId: "session-1", state: "active", createdAt: "now", updatedAt: "now" }) {
  let runtime: any = initialRuntime;
  let job: any = null;
  const store = {
    recoverControllerInterpretations: vi.fn(() => 0), getControllerRuntime: vi.fn(() => runtime),
    saveControllerRuntime: vi.fn((input, at) => runtime = { ...input, createdAt: at, updatedAt: at }), markControllerRuntimeStale: vi.fn(() => true),
    acceptControllerInterpretation: vi.fn((input) => { job ??= { id: input.id, sourceMessageId: input.message.messageId, message: input.message, controllerGeneration: input.controllerGeneration, capabilityHash: input.capabilityHash, state: "accepted", result: null, runtimeTurnId: null, dispatchedAt: null, error: null, createdAt: input.acceptedAt, updatedAt: input.acceptedAt }; return { job, inserted: true }; }),
    claimNextControllerInterpretation: vi.fn((generation, capabilityHash, at) => { if (job?.state !== "accepted") return null; job = { ...job, controllerGeneration: generation, capabilityHash, state: "dispatching", updatedAt: at }; return job; }),
    markControllerInterpretationDispatched: vi.fn((_id, _generation, runtimeTurnId, at) => { if (job?.state !== "dispatching") return null; job = { ...job, state: "observing", runtimeTurnId, dispatchedAt: at, updatedAt: at }; return job; }),
    finishControllerInterpretation: vi.fn((_id, _generation, result, at) => { if (!["dispatching", "observing"].includes(job?.state)) return null; job = { ...job, state: result.outcome === "command" ? "succeeded" : result.outcome, result, updatedAt: at }; return job; }),
    failControllerInterpretation: vi.fn((_id, _generation, state, error, at) => { if (!["dispatching", "observing"].includes(job?.state)) return null; job = { ...job, state, error, updatedAt: at }; return job; }),
    getControllerInterpretation: vi.fn(() => job),
    setFailed(state: string, error: string, at: string) { job = { ...job, state, error, updatedAt: at }; return job; }
  };
  return store;
}

function herdrPort(pane: any = controllerPane()) {
  return { getPane: vi.fn(async () => pane), listPanes: vi.fn(async () => []), createPane: vi.fn(async () => pane), startAgent: vi.fn(async () => undefined), runPrompt: vi.fn(async () => "done") } as any;
}

function controllerPane(overrides: { paneId?: string; terminalId?: string; sessionId?: string | null; agentKind?: string | null; agentState?: string; foregroundExecutables?: string[] } = {}) {
  const paneId = overrides.paneId ?? "w1:p1";
  const terminalId = overrides.terminalId ?? "term-1";
  const sessionId = overrides.sessionId === undefined ? "session-1" : overrides.sessionId;
  return { paneId, tabId: paneId.replace(":p", ":t"), terminalId, agentSession: sessionId ? { source: "herdr:traex", agent: "traex", kind: "id", value: sessionId } : null, agentKind: overrides.agentKind === undefined ? "traex" : overrides.agentKind, workspaceId: "w1", cwd: "/repo", label: "herdr-swarm-controller", agentState: overrides.agentState ?? "idle", foregroundExecutables: overrides.foregroundExecutables ?? ["traex"] };
}

const message = { eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "admin", text: "看看 reviewer 然后决定怎么办", mentionsBot: true, isRootMessage: true };

function controllerOptions(store: ReturnType<typeof memoryStore>, herdr: ReturnType<typeof herdrPort>, socketPath: string) {
  return { store, herdr, project: projects[0]!, socketPath, traexExecutable: "traex", mcpCommand: "node", mcpArgs: ["controller-tools"], turnTimeoutMs: 100, logger: logger(), idFactory: () => "job-1", capabilityFactory: () => "a".repeat(64), pollIntervalMs: 1 };
}
