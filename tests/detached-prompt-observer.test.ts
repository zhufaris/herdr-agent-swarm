import { describe, expect, it, vi } from "vitest";
import { DetachedPromptObserver } from "../src/coordinator/detached-prompt-observer.js";

describe("DetachedPromptObserver", () => {
  it("settles only the exact detached transcript turn as completed", async () => {
    const prompt = { id: "p1", bindingId: "b1", state: "running", observationState: "detached", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-09-24T00:00:00.000Z" };
    const binding = { id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working" };
    const settle = vi.fn(() => true);
    const publish = vi.fn(async () => undefined);
    const observer = new DetachedPromptObserver({
      store: { getPrompt: vi.fn(() => prompt), getBinding: vi.fn(() => binding), settleDetachedPrompt: settle, countPendingPrompts: () => 0 },
      herdr: { async observeRuntime() { return { pane: { paneId: "w1:p1", workspaceId: "w1", agentState: "idle", foregroundExecutables: ["traex"] }, traexProcess: true }; } },
      transcript: {
        async openDetached() { return { mode: "typed", output: { text: "answer" } }; },
        async read(source: unknown) { return { source, observation: { turnId: "turn-1", answerDelta: "answer", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-09-24T00:00:00.000Z", finalAnswer: "answer" } } }; },
        own(_binding: unknown, current: unknown, observation: unknown) { return { owned: true, prompt: current, observation }; },
        retain() {}, async publishOwned() {}
      },
      registry: { attachTurn: () => new AbortController(), updateTurnState: vi.fn(), detachTurn: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn() }, isBindingActive: () => true, isStopping: () => false, publish
    } as never);

    await observer.observe(prompt as never);

    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ promptId: "p1", bindingId: "b1", runtime: "idle", terminal: expect.objectContaining({ kind: "completed", answer: "answer" }) }));
    expect(publish).toHaveBeenCalledWith("b1", "TurnCompleted", "herdr", expect.objectContaining({ promptId: "p1", answer: "answer" }));
  });

  it("releases turn ownership and remains detached when the exact transcript cannot open", async () => {
    const prompt = { id: "p1", bindingId: "b1", state: "running", observationState: "detached", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-09-24T00:00:00.000Z" };
    const binding = { id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working" };
    const detachTurn = vi.fn();
    const markDetached = vi.fn();
    const observer = new DetachedPromptObserver({
      store: { getPrompt: vi.fn(() => prompt), getBinding: vi.fn(() => binding), markPromptObservationDetached: markDetached },
      herdr: {},
      transcript: { async openDetached() { throw new Error("transcript unavailable"); } },
      registry: { attachTurn: () => new AbortController(), detachTurn },
      logger: { info: vi.fn(), warn: vi.fn() }, isBindingActive: () => true, isStopping: () => false, publish: vi.fn()
    } as never);

    await observer.observe(prompt as never);

    expect(markDetached).toHaveBeenCalledWith("p1", expect.stringContaining("transcript unavailable"));
    expect(detachTurn).toHaveBeenCalledWith("b1", "p1");
  });
});
