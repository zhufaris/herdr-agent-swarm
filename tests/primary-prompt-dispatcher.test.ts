import { describe, expect, it, vi } from "vitest";
import { PrimaryPromptDispatcher } from "../src/coordinator/primary-prompt-dispatcher.js";

describe("PrimaryPromptDispatcher", () => {
  it("releases a claimed prompt when fresh Herdr state is busy without executing it", async () => {
    const claimed = {
      binding: { id: "b1", generation: 3, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle" },
      prompt: { id: "p1", bindingId: "b1", updatedAt: "claim-version" },
      model: null
    };
    const release = vi.fn(() => true);
    const execute = vi.fn();
    const handoff = vi.fn(async () => undefined);
    let claims = 0;
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt: vi.fn(() => claims++ === 0 ? claimed : null) },
        recovery: { releaseUndispatchedPromptClaim: release },
        session: {}
      },
      herdr: { async getPane() { return { paneId: "w1:p1", workspaceId: "w1", agentState: "working", foregroundExecutables: ["traex"] }; } },
      executor: { execute }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      handoffExternalTurns: handoff, isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(handoff).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith({ promptId: "p1", bindingId: "b1", updatedAt: "claim-version", bindingGeneration: 3, paneId: "w1:p1" });
    expect(execute).not.toHaveBeenCalled();
  });
});
