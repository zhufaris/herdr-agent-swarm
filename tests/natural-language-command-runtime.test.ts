import { mkdtemp } from "node:fs/promises";
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
});

function logger() { return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }; }

function memoryStore() {
  let runtime: any = { generation: 1, paneId: "w1:p1", terminalId: "term-1", nativeSessionId: "session-1", state: "active", createdAt: "now", updatedAt: "now" };
  let job: any = null;
  return {
    recoverControllerInterpretations: vi.fn(() => 0), getControllerRuntime: vi.fn(() => runtime),
    saveControllerRuntime: vi.fn((input, at) => runtime = { ...input, createdAt: at, updatedAt: at }), markControllerRuntimeStale: vi.fn(() => true),
    acceptControllerInterpretation: vi.fn((input) => { job ??= { id: input.id, sourceMessageId: input.message.messageId, message: input.message, controllerGeneration: input.controllerGeneration, capabilityHash: input.capabilityHash, state: "accepted", result: null, runtimeTurnId: null, dispatchedAt: null, error: null, createdAt: input.acceptedAt, updatedAt: input.acceptedAt }; return { job, inserted: true }; }),
    claimNextControllerInterpretation: vi.fn((generation, capabilityHash, at) => { if (job?.state !== "accepted") return null; job = { ...job, controllerGeneration: generation, capabilityHash, state: "dispatching", updatedAt: at }; return job; }),
    markControllerInterpretationDispatched: vi.fn((_id, _generation, runtimeTurnId, at) => { if (job?.state !== "dispatching") return null; job = { ...job, state: "observing", runtimeTurnId, dispatchedAt: at, updatedAt: at }; return job; }),
    finishControllerInterpretation: vi.fn((_id, _generation, result, at) => { if (!["dispatching", "observing"].includes(job?.state)) return null; job = { ...job, state: result.outcome === "command" ? "succeeded" : result.outcome, result, updatedAt: at }; return job; }),
    failControllerInterpretation: vi.fn((_id, _generation, state, error, at) => { if (!["dispatching", "observing"].includes(job?.state)) return null; job = { ...job, state, error, updatedAt: at }; return job; }),
    getControllerInterpretation: vi.fn(() => job)
  };
}

function herdrPort() {
  const pane = { paneId: "w1:p1", tabId: "w1:t1", terminalId: "term-1", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, agentKind: "traex", workspaceId: "w1", cwd: "/repo", label: "herdr-swarm-controller", agentState: "idle", foregroundExecutables: ["traex"] };
  return { getPane: vi.fn(async () => pane), listPanes: vi.fn(async () => []), createPane: vi.fn(async () => pane), startAgent: vi.fn(async () => undefined), runPrompt: vi.fn(async () => "done") } as any;
}
