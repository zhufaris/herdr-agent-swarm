import { describe, expect, it, vi } from "vitest";
import { DetachedPromptObserver } from "../src/coordinator/detached-prompt-observer.js";

describe("DetachedPromptObserver", () => {
  it("awaits prompt-specific downstream convergence before recovered observation returns", async () => {
    let release!: () => void;
    const downstream = new Promise<void>((resolve) => { release = resolve; });
    const prompt = { id: "p1", bindingId: "b1", state: "running", observationState: "detached", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-09-24T00:00:00.000Z" };
    const binding = { id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working" };
    const onSettled = vi.fn(async () => downstream);
    const observer = new DetachedPromptObserver({
      store: { getPrompt: vi.fn(() => prompt), getBinding: vi.fn(() => binding), settleDetachedPrompt: vi.fn(() => ({ settled: true })), countPendingPrompts: () => 0 },
      herdr: { async observeRuntime() { return { pane: { paneId: "w1:p1", workspaceId: "w1", agentState: "idle", foregroundExecutables: ["traex"] }, traexProcess: true }; } },
      transcript: {
        async openDetached() { return { mode: "typed", output: { text: "answer" } }; },
        async read(source: unknown) { return { source, observation: { turnId: "turn-1", answerDelta: "answer", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-09-24T00:00:00.000Z", finalAnswer: "answer" } } }; },
        own(_binding: unknown, current: unknown, observation: unknown) { return { owned: true, prompt: current, observation }; },
        retain() {}, async publishOwned() {}
      },
      registry: { attachTurn: () => new AbortController(), updateTurnState: vi.fn(), detachTurn: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn() }, isBindingActive: () => true, isStopping: () => false,
      publish: vi.fn(async () => undefined), onSettled
    } as never);

    let returned = false;
    const recovery = observer.observe(prompt as never).then(() => { returned = true; });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith("p1"));
    expect(returned).toBe(false);
    release();
    await recovery;
    expect(returned).toBe(true);
  });

  it("settles only the exact detached transcript turn as completed", async () => {
    const order: string[] = [];
    const prompt = { id: "p1", bindingId: "b1", state: "running", observationState: "detached", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-09-24T00:00:00.000Z" };
    const binding = { id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working" };
    const settle = vi.fn(() => { order.push("settled"); return { settled: true, completionActionEligibility: { outcome: "deferred" } }; });
    const publish = vi.fn(async () => { order.push("published"); });
    const onSettled = vi.fn(() => { order.push("delivery-hint"); });
    const completionChoice = {
      version: 2 as const,
      intent: "human_review" as const,
      question: "Continue?",
      default: "continue",
      options: [{ id: "continue", label: "Continue", message: "default" }]
    };
    const observer = new DetachedPromptObserver({
      store: { getPrompt: vi.fn(() => prompt), getBinding: vi.fn(() => binding), settleDetachedPrompt: settle, countPendingPrompts: () => 0 },
      herdr: { async observeRuntime() { return { pane: { paneId: "w1:p1", workspaceId: "w1", agentState: "idle", foregroundExecutables: ["traex"] }, traexProcess: true }; } },
      transcript: {
        async openDetached() { return { mode: "typed", output: { text: "answer" } }; },
        async read(source: unknown) { return { source, observation: { turnId: "turn-1", answerDelta: "answer", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-09-24T00:00:00.000Z", finalAnswer: "answer", completionChoice } } }; },
        own(_binding: unknown, current: unknown, observation: unknown) { return { owned: true, prompt: current, observation }; },
        retain() {}, async publishOwned() {}
      },
      registry: { attachTurn: () => new AbortController(), updateTurnState: vi.fn(), detachTurn: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn() }, isBindingActive: () => true, isStopping: () => false, publish, onSettled
    } as never);

    await observer.observe(prompt as never);

    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ promptId: "p1", bindingId: "b1", runtime: "idle", terminal: expect.objectContaining({ kind: "completed", answer: "answer", completionChoice }) }));
    expect(publish).toHaveBeenCalledWith("b1", "TurnCompleted", "herdr", expect.objectContaining({ promptId: "p1", answer: "answer" }));
    expect(onSettled).toHaveBeenCalledWith("p1");
    expect(order).toEqual(["settled", "published", "delivery-hint"]);
  });

  it("continues with a proven goal child before settling the detached prompt", async () => {
    const prompt = { id: "p1", bindingId: "b1", state: "running", observationState: "detached", transcriptTurnId: "root", transcriptTurnStartedAt: "2026-09-24T00:00:00.000Z" };
    const binding = { id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working" };
    const root = { mode: "typed", output: { text: "root answer" } };
    const child = { mode: "typed", output: { text: "child answer" } };
    const observations = [
      { turnId: "root", answerDelta: "root answer", turnLifecycle: { turnId: "root", state: "completed" as const, startedAt: "2026-09-24T00:00:00.000Z", finalAnswer: "root answer" } },
      { turnId: "child", answerDelta: "child answer", turnLifecycle: { turnId: "child", state: "completed" as const, startedAt: "2026-09-24T00:01:00.000Z", finalAnswer: "child answer" } }
    ];
    const openContinuation = vi.fn(async (source: unknown) => source === root ? child : source);
    const settle = vi.fn(() => ({ settled: true, completionActionEligibility: { outcome: "deferred" } }));
    const observer = new DetachedPromptObserver({
      store: { getPrompt: vi.fn(() => prompt), getBinding: vi.fn(() => binding), settleDetachedPrompt: settle, countPendingPrompts: () => 0 },
      herdr: { async observeRuntime() { return { pane: { paneId: "w1:p1", workspaceId: "w1", agentState: "idle", foregroundExecutables: ["traex"] }, traexProcess: true }; } },
      transcript: {
        async openDetached() { return root; },
        async openProvenDetachedContinuation(source: unknown) { return openContinuation(source); },
        async read(source: unknown) { return { source, observation: observations.shift() ?? { answerDelta: "" } }; },
        own(_binding: unknown, current: unknown, observation: unknown) { return { owned: true, prompt: current, observation }; },
        retain() {}, async publishOwned() {}
      },
      registry: { attachTurn: () => new AbortController(), updateTurnState: vi.fn(), detachTurn: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn() }, isBindingActive: () => true, isStopping: () => false, publish: vi.fn()
    } as never);

    await observer.observe(prompt as never);

    expect(openContinuation.mock.calls[0]?.[0]).toBe(root);
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ terminal: expect.objectContaining({ kind: "completed", answer: "child answer" }) }));
  });

  it("wakes delivery after an explicit detached abort is durably published", async () => {
    const order: string[] = [];
    const prompt = { id: "p1", bindingId: "b1", state: "running", observationState: "detached", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-09-24T00:00:00.000Z" };
    const binding = { id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working" };
    const observer = new DetachedPromptObserver({
      store: {
        getPrompt: vi.fn(() => prompt), getBinding: vi.fn(() => binding), countPendingPrompts: () => 0,
        settleDetachedPrompt: vi.fn(() => { order.push("settled"); return { settled: true }; })
      },
      herdr: { async observeRuntime() { return { pane: { paneId: "w1:p1", workspaceId: "w1", agentState: "idle", foregroundExecutables: ["traex"] }, traexProcess: true }; } },
      transcript: {
        async openDetached() { return { mode: "typed", output: { text: "" } }; },
        async read(source: unknown) { return { source, observation: { turnId: "turn-1", answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "aborted", startedAt: "2026-09-24T00:00:00.000Z", reason: "interrupted" } } }; },
        own(_binding: unknown, current: unknown, observation: unknown) { return { owned: true, prompt: current, observation }; },
        retain() {}, async publishOwned() {}
      },
      registry: { attachTurn: () => new AbortController(), updateTurnState: vi.fn(), detachTurn: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn() }, isBindingActive: () => true, isStopping: () => false,
      async publish() { order.push("published"); }, onSettled() { order.push("delivery-hint"); }
    } as never);

    await observer.observe(prompt as never);

    expect(order).toEqual(["settled", "published", "delivery-hint"]);
  });

  it("releases turn ownership and remains detached when the exact transcript cannot open", async () => {
    const prompt = { id: "p1", bindingId: "b1", state: "running", observationState: "detached", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-09-24T00:00:00.000Z" };
    const binding = { id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working" };
    const detachTurn = vi.fn();
    const markDetached = vi.fn();
    const onSettled = vi.fn();
    const observer = new DetachedPromptObserver({
      store: { getPrompt: vi.fn(() => prompt), getBinding: vi.fn(() => binding), markPromptObservationDetached: markDetached },
      herdr: {},
      transcript: { async openDetached() { throw new Error("transcript unavailable"); } },
      registry: { attachTurn: () => new AbortController(), detachTurn },
      logger: { info: vi.fn(), warn: vi.fn() }, isBindingActive: () => true, isStopping: () => false, publish: vi.fn(), onSettled
    } as never);

    await observer.observe(prompt as never);

    expect(markDetached).toHaveBeenCalledWith("p1", expect.stringContaining("transcript unavailable"));
    expect(detachTurn).toHaveBeenCalledWith("b1", "p1");
    expect(onSettled).not.toHaveBeenCalled();
  });
});
