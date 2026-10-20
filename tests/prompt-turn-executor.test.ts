import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { PromptTurnExecutor } from "../src/coordinator/prompt-turn-executor.js";
import type { Binding, PromptJob } from "../src/domain/types.js";
import { createBoundedTurnOutput } from "../src/runtime/bounded-turn-output.js";

const startedAt = "2026-09-30T00:00:01.000Z";
const terminalLifecycle = { turnId: "turn-1", state: "completed" as const, startedAt, finalAnswer: "facade answer" };

describe("PromptTurnExecutor Core settlement", () => {
  it("submits the claimed execution body while preserving the Prompt display body", async () => {
    const facade = vi.fn(async () => ({ outcome: "completed", owned: true, terminal: "completed", prompt: prompt(), output: { emitted: true, text: "facade answer", truncated: false, terminalLifecycle } }));
    const onAcquire = vi.fn();
    const runPrompt = vi.fn(async (...args: Parameters<NonNullable<ConstructorParameters<typeof PromptTurnExecutor>[0]["herdr"]["runPrompt"]>>) => {
      await args[5]?.();
      return "done" as const;
    });
    const executor = executorFor({ facade, runPrompt, onAcquire });
    const displayPrompt = { ...prompt(), body: "[Feishu message 1/2]\nfirst\n\n[Feishu message 2/2]\nsecond" };

    await executor.execute({
      binding: binding(), prompt: displayPrompt, executionBody: "first\n\nsecond", model: null, nativeInputBatch: true
    }, new AbortController(), { transcriptAcquisition: "sessionless-bootstrap" });

    expect(onAcquire).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }), expect.any(AbortSignal), "sessionless-bootstrap");
    expect(runPrompt).toHaveBeenCalledWith("w1:p1", "first\n\nsecond", 1_000, expect.any(Function), expect.any(AbortSignal), expect.any(Function));
    expect(displayPrompt.body).toContain("[Feishu message 1/2]");
  });

  it("settles a completed bridge turn through the binding Prompt facade", async () => {
    const facade = vi.fn(async () => ({ outcome: "completed", owned: true, terminal: "completed", prompt: prompt(), output: { emitted: true, text: "facade answer", truncated: false, terminalLifecycle } }));
    const executor = executorFor({ facade });

    await expect(executor.execute({ binding: binding(), prompt: prompt(), executionBody: "request", model: null, nativeInputBatch: false }, new AbortController())).resolves.toEqual({ observerDetached: false });

    expect(facade).toHaveBeenCalledWith(expect.objectContaining({
      origin: "bridge",
      binding: expect.objectContaining({ id: "b1" }),
      prompt: expect.objectContaining({ id: "p1" }),
      settlement: { kind: "completed", answer: "facade answer", sourceAnswer: "facade answer", replaceAnswer: false }
    }));
  });

  it("carries structured Choice metadata through the ordinary Primary settlement", async () => {
    const completionChoice = {
      version: 2 as const,
      intent: "human_review" as const,
      question: "Continue?",
      default: "continue",
      options: [{ id: "continue", label: "Continue", message: "default" }]
    };
    const terminal = { ...terminalLifecycle, completionChoice };
    const facade = vi.fn(async () => ({ outcome: "completed", owned: true, terminal: "completed", prompt: prompt(), output: { emitted: true, text: "facade answer", truncated: false, terminalLifecycle: terminal } }));
    const executor = executorFor({ facade, terminal });

    await executor.execute({ binding: binding(), prompt: prompt(), executionBody: "request", model: null, nativeInputBatch: false }, new AbortController());

    expect(facade).toHaveBeenCalledWith(expect.objectContaining({
      origin: "bridge",
      settlement: expect.objectContaining({ kind: "completed", completionChoice })
    }));
  });

  it("settles an aborted bridge turn through the binding Prompt facade", async () => {
    const aborted = { turnId: "turn-1", state: "aborted" as const, startedAt, reason: "interrupted" };
    const facade = vi.fn(async () => ({ outcome: "completed", owned: true, terminal: "aborted", prompt: prompt(), output: { emitted: true, text: "partial", truncated: false, terminalLifecycle: aborted } }));
    const executor = executorFor({ facade, terminal: aborted, text: "partial" });

    await expect(executor.execute({ binding: binding(), prompt: prompt(), executionBody: "request", model: null, nativeInputBatch: false }, new AbortController())).resolves.toEqual({ observerDetached: false });

    expect(facade).toHaveBeenCalledWith(expect.objectContaining({
      origin: "bridge",
      settlement: { kind: "failed", error: "TraeX turn was interrupted by a human operator" }
    }));
  });

  it("marks an uncertain bridge turn detached through the binding Prompt facade", async () => {
    const facade = vi.fn(async () => ({ outcome: "detached", owned: true, terminal: null, prompt: prompt(), output: { emitted: false, text: "", truncated: false } }));
    const executor = executorFor({
      facade,
      text: "",
      terminal: undefined,
      runPrompt: async (_paneId, _text, _timeout, _onObservation, _signal, onDispatched) => {
        await onDispatched?.();
        throw new Error("waiter failed after dispatch");
      }
    });

    await expect(executor.execute({ binding: binding(), prompt: prompt(), executionBody: "request", model: null, nativeInputBatch: false }, new AbortController())).resolves.toEqual({ observerDetached: true });

    expect(facade).toHaveBeenCalledWith(expect.objectContaining({
      origin: "bridge",
      settlement: { kind: "detached", notice: "TraeX 请求已尝试投递，但 Bridge 无法确认最终结果：waiter failed after dispatch；不会自动重发。" }
    }));
  });

  it("carries structured Choice metadata after a dispatched waiter fails and drain finds completion", async () => {
    const completionChoice = {
      version: 2 as const,
      intent: "human_review" as const,
      question: "Continue?",
      default: "continue",
      options: [{ id: "continue", label: "Continue", message: "default" }]
    };
    const terminal = { ...terminalLifecycle, completionChoice };
    const facade = vi.fn(async () => ({ outcome: "completed", owned: true, terminal: "completed", prompt: prompt(), output: { emitted: true, text: "facade answer", truncated: false, terminalLifecycle: terminal } }));
    const executor = executorFor({
      facade,
      terminal,
      runPrompt: async (_paneId, _text, _timeout, _onObservation, _signal, onDispatched) => {
        await onDispatched?.();
        throw new Error("waiter failed after dispatch");
      }
    });

    await expect(executor.execute({ binding: binding(), prompt: prompt(), executionBody: "request", model: null, nativeInputBatch: false }, new AbortController())).resolves.toEqual({ observerDetached: false });

    expect(facade).toHaveBeenCalledWith(expect.objectContaining({
      origin: "bridge",
      settlement: expect.objectContaining({ kind: "completed", completionChoice })
    }));
  });
});

function executorFor(input: {
  facade: ReturnType<typeof vi.fn>;
  text?: string;
  terminal?: { turnId: string; state: "completed" | "aborted"; startedAt: string; finalAnswer?: string; completionChoice?: { version: 2; intent: "human_review"; question: string; default: string; options: Array<{ id: string; label: string; message: string }> }; reason?: string };
  runPrompt?: (...args: Parameters<NonNullable<ConstructorParameters<typeof PromptTurnExecutor>[0]["herdr"]["runPrompt"]>>) => Promise<Binding["lastAgentState"]>;
  onAcquire?: ReturnType<typeof vi.fn>;
}): PromptTurnExecutor {
  const output = createBoundedTurnOutput(input.text ?? "facade answer");
  const source = { mode: "typed" as const, cursor: { async readDelta() { return ""; } }, emitted: Boolean(output.text), output, ...(input.terminal === undefined ? {} : { terminalLifecycle: input.terminal }) };
  const forbidden = vi.fn(() => { throw new Error("direct settlement bypassed facade"); });
  return new PromptTurnExecutor({
    store: {
      countPendingPrompts: vi.fn(() => 0),
      markPromptDispatched: vi.fn(),
      getPrompt: vi.fn(() => prompt()),
      getBinding: vi.fn(() => binding()),
      observePrimaryPromptState: vi.fn(() => ({ outcome: "applied", binding: binding(), notification: { outcome: "none" } })),
      completeTurn: forbidden,
      failPrompt: forbidden,
      markPromptObservationDetached: forbidden
    },
    herdr: {
      runPrompt: input.runPrompt ?? (async (_paneId, _text, _timeout, _onObservation, _signal, onDispatched) => {
        await onDispatched?.();
        return "done";
      })
    },
    transcript: {
      acquire: vi.fn(async (...args) => { input.onAcquire?.(...args); return source; }),
      observeAttached: vi.fn(async ({ updateSource }) => { updateSource(source); }),
      recoverFirstTurn: vi.fn(async (_source, durableBinding) => ({ source, binding: durableBinding })),
      drain: vi.fn(async () => source)
    },
    bindingPrompts: { applyCoreObservation: input.facade },
    logger: pino({ enabled: false }),
    turnTimeoutMs: 1_000,
    isBindingActive: vi.fn(() => true),
    isStopping: vi.fn(() => false),
    updateTurnState: vi.fn(),
    renderHumanReviewNotification: vi.fn(() => ({})),
    wakeOutbound: vi.fn(),
    convergeMainCard: vi.fn(async () => undefined),
    releaseUndispatched: vi.fn(() => false),
    observeDetached: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined)
  } as never);
}

function binding(): Binding {
  return {
    id: "b1", gatewayId: "feishu:primary", creatorOpenId: null, projectId: "project-a", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root",
    retiredTopicId: null, retiredRootMessageId: null, replacesBindingId: null, reservedTopicId: null, reservedRootMessageId: null, resetMessageId: null,
    paneId: "w1:p1", paneToken: null, traexSessionId: null, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1",
    title: "Primary", agentKind: "traex", state: "active", statusMessageId: "main", statusCardSequence: 1, lastAgentState: "working",
    lastOutputFingerprint: null, lifecycle: "active", attachment: "attached", generation: 1, provisioningCheckpoint: "activated",
    degradationCount: 0, hasCompletedTurn: false, lastObservedAt: null, archivedAt: null, lastActivityAt: startedAt, createdAt: startedAt, updatedAt: startedAt
  };
}

function prompt(): PromptJob {
  return {
    id: "p1", bindingId: "b1", larkMessageId: "message-1", ingressSource: "feishu", sourceMessageKey: "message-1", actorOpenId: "u1", body: "work",
    executionOrigin: "bridge", parentPromptId: null, priority: "normal", wasDetached: false, dispatchedAt: null, nativeSubmissionId: null,
    transcriptTurnId: "turn-1", transcriptTurnStartedAt: startedAt, modelName: null, modelRevision: null, observationState: "attached", state: "running",
    attemptCount: 1, error: null, createdAt: startedAt, updatedAt: startedAt
  };
}
