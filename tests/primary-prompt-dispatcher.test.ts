import { describe, expect, it, vi } from "vitest";
import { PrimaryPromptDispatcher } from "../src/coordinator/primary-prompt-dispatcher.js";

describe("PrimaryPromptDispatcher", () => {
  it("uses the observed turn path for the first ordinary prompt before TraeX has created a native session", async () => {
    const claimed = {
      binding: {
        id: "b1", generation: 1, workspaceId: "w1", paneId: "w1:p1", traexSessionId: "term-1",
        state: "active", lifecycle: "active", lastAgentState: "idle", agentKind: "traex",
        agentSessionSource: null, agentSessionAgent: null, agentSessionKind: null, agentSessionValue: null
      },
      prompt: { id: "p1", bindingId: "b1", body: "first task", updatedAt: "claim-version" },
      executionBody: "first task",
      model: null
    };
    const release = vi.fn(() => true);
    const markPromptNativeQueued = vi.fn(() => true);
    const queuePrompt = vi.fn(async () => ({ submissionId: "p1" }));
    const execute = vi.fn(async () => ({ observerDetached: false }));
    const detachTurn = vi.fn();
    let claims = 0;
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt: vi.fn(() => claims++ === 0 ? claimed : null), markPromptNativeQueued },
        recovery: { releaseUndispatchedPromptClaim: release }, session: { getBinding: vi.fn(() => claimed.binding) }
      },
      herdr: {
        getPane: vi.fn(async () => ({
          paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", agentKind: "traex", agentState: "idle",
          foregroundExecutables: ["traex"], agentSession: null
        })),
        supportsPromptQueue: vi.fn(async () => true), queuePrompt
      },
      executor: { execute }, registry: { attachTurn: vi.fn(() => new AbortController()), detachTurn }, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(queuePrompt).not.toHaveBeenCalled();
    expect(markPromptNativeQueued).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(claimed, expect.any(AbortController));
    expect(detachTurn).toHaveBeenCalledWith("b1", "p1");
    expect(release).not.toHaveBeenCalled();
  });

  it("submits a selected model through the distinct native Core queue", async () => {
    const claimed = {
      binding: {
        id: "b1", generation: 3, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle",
        agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
      },
      prompt: { id: "p1", bindingId: "b1", body: "next", updatedAt: "claim-version" },
      executionBody: "next",
      model: { revision: 4, name: "gpt-5.4" }
    };
    const queueModelPrompt = vi.fn(async () => ({ submissionId: "p1" }));
    const fencePromptNativeSubmission = vi.fn(() => true);
    const markPromptNativeQueued = vi.fn(() => true);
    const execute = vi.fn();
    let claims = 0;
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt: vi.fn(() => claims++ === 0 ? claimed : null), fencePromptNativeSubmission, markPromptNativeQueued },
        recovery: { releaseUndispatchedPromptClaim: vi.fn() },
        session: { getBinding: vi.fn(() => claimed.binding) }
      },
      herdr: {
        getPane: vi.fn(async () => ({ paneId: "w1:p1", workspaceId: "w1", agentState: "idle", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } })),
        supportsPromptQueue: vi.fn(async () => true),
        supportsModelPrompt: vi.fn(async () => true),
        queuePrompt: vi.fn(),
        queueModelPrompt
      },
      executor: { execute }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(queueModelPrompt).toHaveBeenCalledWith("w1:p1", "next", {
      model: "gpt-5.4", submissionId: "p1", expectedSessionId: "session-1"
    });
    expect(fencePromptNativeSubmission.mock.invocationCallOrder[0]).toBeLessThan(queueModelPrompt.mock.invocationCallOrder[0]!);
    expect(markPromptNativeQueued).toHaveBeenCalledWith(expect.objectContaining({ promptId: "p1", submissionId: "p1" }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("requeues a selected model when Core lacks the distinct model prompt contract", async () => {
    const claimed = {
      binding: {
        id: "b1", generation: 3, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle",
        agentSessionKind: "id", agentSessionValue: "session-1"
      },
      prompt: { id: "p1", bindingId: "b1", body: "next", updatedAt: "claim-version" },
      executionBody: "next",
      model: { revision: 4, name: "gpt-5.4" }
    };
    const release = vi.fn(() => true);
    const execute = vi.fn();
    const queueModelPrompt = vi.fn();
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt: vi.fn(() => claimed), markPromptNativeQueued: vi.fn() },
        recovery: { releaseUndispatchedPromptClaim: release }, session: { getBinding: vi.fn() }
      },
      herdr: {
        getPane: vi.fn(), supportsPromptQueue: vi.fn(async () => true),
        supportsModelPrompt: vi.fn(async () => false), queuePrompt: vi.fn(), queueModelPrompt
      },
      executor: { execute }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(release).toHaveBeenCalledOnce();
    expect(queueModelPrompt).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves an ordinary prompt queued while the current turn is working", async () => {
    const claimed = {
      binding: {
        id: "b1", generation: 3, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working",
        agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
      },
      prompt: { id: "p1", bindingId: "b1", body: "next", updatedAt: "claim-version" },
      executionBody: "next",
      model: null
    };
    const release = vi.fn(() => true);
    const execute = vi.fn();
    const markPromptNativeQueued = vi.fn(() => true);
    const queuePrompt = vi.fn(async () => ({ submissionId: "p1" }));
    const handoff = vi.fn(async () => undefined);
    const claimNextDispatchablePrompt = vi.fn(() => null);
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt, markPromptNativeQueued },
        recovery: { releaseUndispatchedPromptClaim: release },
        session: { getBinding: vi.fn(() => claimed.binding) }
      },
      herdr: {
        async getPane() { return { paneId: "w1:p1", workspaceId: "w1", agentState: "working", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } }; },
        async supportsPromptQueue() { return true; },
        queuePrompt
      },
      executor: { execute }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      handoffExternalTurns: handoff, isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(claimNextDispatchablePrompt).toHaveBeenCalledWith("b1");
    expect(queuePrompt).not.toHaveBeenCalled();
    expect(markPromptNativeQueued).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["working", "blocked"] as const)("releases a formed Native Input Batch when the fresh Pane is %s", async (agentState) => {
    const claimed = {
      binding: {
        id: "b1", generation: 3, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: agentState,
        agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
      },
      prompt: { id: "batch-1", bindingId: "b1", body: "[Feishu message 1/1]\nnext", updatedAt: "claim-version" },
      executionBody: "next",
      model: null,
      nativeInputBatch: true
    };
    const markPromptNativeQueued = vi.fn(() => true);
    const applyPromptNativeSubmissionReceipt = vi.fn(() => true);
    const fencePromptNativeSubmission = vi.fn(() => true);
    const queuePrompt = vi.fn(async () => ({
      submissionId: "batch-1",
      receipt: {
        submissionId: "batch-1", terminalId: "terminal-1", agentKind: "traex" as const,
        sessionId: "session-1", state: "accepted" as const, createdAt: 10, updatedAt: 11
      }
    }));
    const convergeMainCard = vi.fn(async () => undefined);
    const markPromptObservationDetached = vi.fn();
    const releaseUndispatchedPromptClaim = vi.fn(() => true);
    let claims = 0;
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt: vi.fn(() => claims++ === 0 ? claimed : null), fencePromptNativeSubmission, markPromptNativeQueued, applyPromptNativeSubmissionReceipt },
        recovery: { releaseUndispatchedPromptClaim, markPromptObservationDetached },
        session: { getBinding: vi.fn(() => claimed.binding) }
      },
      herdr: {
        getPane: vi.fn(async () => ({
          paneId: "w1:p1", workspaceId: "w1", agentState, foregroundExecutables: ["traex"],
          agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
        })),
        supportsPromptQueue: vi.fn(async () => true),
        queuePrompt
      },
      executor: { execute: vi.fn() }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(releaseUndispatchedPromptClaim).toHaveBeenCalledWith({
      promptId: "batch-1", bindingId: "b1", updatedAt: "claim-version", bindingGeneration: 3, paneId: "w1:p1"
    });
    expect(queuePrompt).not.toHaveBeenCalled();
    expect(fencePromptNativeSubmission).not.toHaveBeenCalled();
    expect(applyPromptNativeSubmissionReceipt).not.toHaveBeenCalled();
    expect(markPromptNativeQueued).not.toHaveBeenCalled();
    expect(markPromptObservationDetached).not.toHaveBeenCalled();
    expect(convergeMainCard).not.toHaveBeenCalled();
  });

  it.each([
    ["idle", true],
    ["done", true],
    ["idle", false]
  ] as const)("uses the observed turn path for a %s formed batch before TraeX has created a native session (native queue: %s)", async (agentState, nativeQueueAvailable) => {
    const claimed = {
      binding: {
        id: "b1", generation: 3, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working",
        agentSessionSource: null, agentSessionAgent: null, agentSessionKind: null, agentSessionValue: null
      },
      prompt: { id: "batch-1", bindingId: "b1", body: "[Feishu message 1/1]\nnext", updatedAt: "claim-version" },
      executionBody: "next",
      model: null,
      nativeInputBatch: true
    };
    const release = vi.fn(() => true);
    const queuePrompt = vi.fn();
    const execute = vi.fn(async () => ({ observerDetached: false }));
    const detachTurn = vi.fn();
    let claims = 0;
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: {
          claimNextDispatchablePrompt: vi.fn(() => claims++ === 0 ? claimed : null),
          fencePromptNativeSubmission: vi.fn(),
          markPromptNativeQueued: vi.fn()
        },
        recovery: { releaseUndispatchedPromptClaim: release },
        session: { getBinding: vi.fn(() => claimed.binding) }
      },
      herdr: {
        getPane: vi.fn(async () => ({
          paneId: "w1:p1", workspaceId: "w1", agentState,
          foregroundExecutables: ["traex"], agentSession: null
        })),
        supportsPromptQueue: vi.fn(async () => nativeQueueAvailable),
        queuePrompt
      },
      executor: { execute }, registry: { attachTurn: vi.fn(() => new AbortController()), detachTurn }, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(release).not.toHaveBeenCalled();
    expect(queuePrompt).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(claimed, expect.any(AbortController), { transcriptAcquisition: "sessionless-bootstrap" });
    expect(detachTurn).toHaveBeenCalledWith("b1", "batch-1");
  });

  it("keeps Prompt ID authoritative when a native queue receipt returns a different submission ID", async () => {
    const claimed = {
      binding: {
        id: "b1", generation: 3, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle",
        agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
      },
      prompt: { id: "p1", bindingId: "b1", body: "next", updatedAt: "claim-version" },
      executionBody: "next",
      model: null
    };
    const fencePromptNativeSubmission = vi.fn(() => true);
    const markPromptNativeQueued = vi.fn(() => true);
    const applyPromptNativeSubmissionReceipt = vi.fn(() => true);
    let claims = 0;
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt: vi.fn(() => claims++ === 0 ? claimed : null), fencePromptNativeSubmission, markPromptNativeQueued, applyPromptNativeSubmissionReceipt },
        recovery: { releaseUndispatchedPromptClaim: vi.fn() }, session: { getBinding: vi.fn(() => claimed.binding) }
      },
      herdr: {
        getPane: vi.fn(async () => ({ paneId: "w1:p1", workspaceId: "w1", agentState: "idle", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } })),
        supportsPromptQueue: vi.fn(async () => true),
        queuePrompt: vi.fn(async () => ({ submissionId: "wrong-id" }))
      },
      executor: { execute: vi.fn() }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(applyPromptNativeSubmissionReceipt).toHaveBeenCalledWith({
      promptId: "p1", bindingId: "b1", submissionId: "p1", dispatchedAt: expect.any(String),
      state: "uncertain", notice: "Native submission receipt identity mismatch"
    });
    expect(markPromptNativeQueued).not.toHaveBeenCalled();
  });

  it("keeps a working Pane prompt queued when no exact native session identity exists", async () => {
    const claimed = {
      binding: {
        id: "b1", generation: 1, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working",
        agentSessionKind: null, agentSessionValue: null
      },
      prompt: { id: "p1", bindingId: "b1", body: "next", updatedAt: "claim-version" },
      executionBody: "next",
      model: null
    };
    const release = vi.fn(() => true);
    const queuePrompt = vi.fn();
    const execute = vi.fn();
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt: vi.fn(() => claimed), markPromptNativeQueued: vi.fn() },
        recovery: { releaseUndispatchedPromptClaim: release }, session: { getBinding: vi.fn() }
      },
      herdr: {
        getPane: vi.fn(async () => ({ paneId: "w1:p1", workspaceId: "w1", agentState: "working", foregroundExecutables: ["traex"], agentSession: null })),
        supportsPromptQueue: vi.fn(async () => true), queuePrompt
      },
      executor: { execute }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(release).toHaveBeenCalledOnce();
    expect(queuePrompt).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves working-state work queued when Core does not support native prompt receipts", async () => {
    const claimNextDispatchablePrompt = vi.fn(() => null);
    const queuePrompt = vi.fn();
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt, markPromptNativeQueued: vi.fn() },
        recovery: { releaseUndispatchedPromptClaim: vi.fn() },
        session: { getBinding: vi.fn() }
      },
      herdr: { getPane: vi.fn(), supportsPromptQueue: vi.fn(async () => false), queuePrompt },
      executor: { execute: vi.fn() }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(claimNextDispatchablePrompt).toHaveBeenCalledWith("b1");
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it("requeues only when Core proves the native submission was not accepted", async () => {
    const claimed = {
      binding: { id: "b1", generation: 1, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle", agentSessionKind: "id", agentSessionValue: "session-1" },
      prompt: { id: "p1", bindingId: "b1", body: "next", updatedAt: "claim-version" }, executionBody: "next", model: null
    };
    const release = vi.fn(() => true);
    const releaseRejectedNativeSubmission = vi.fn(() => true);
    const fencePromptNativeSubmission = vi.fn(() => true);
    const markPromptNativeQueued = vi.fn();
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt: vi.fn(() => claimed), fencePromptNativeSubmission, markPromptNativeQueued, releaseRejectedNativeSubmission },
        recovery: { releaseUndispatchedPromptClaim: release }, session: { getBinding: vi.fn() }
      },
      herdr: {
        getPane: vi.fn(async () => ({ paneId: "w1:p1", workspaceId: "w1", agentState: "idle", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } })),
        supportsPromptQueue: vi.fn(async () => true),
        queuePrompt: vi.fn(async () => ({
          submissionId: "p1",
          receipt: {
            submissionId: "p1", terminalId: "terminal-1", agentKind: "traex" as const,
            sessionId: "session-1", state: "rejected" as const, createdAt: 10, updatedAt: 11
          }
        }))
      },
      executor: { execute: vi.fn() }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(releaseRejectedNativeSubmission).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(markPromptNativeQueued).not.toHaveBeenCalled();
  });

  it("requeues when Core reports the native session identity was missing before submission", async () => {
    const claimed = {
      binding: { id: "b1", generation: 1, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle", agentSessionKind: "id", agentSessionValue: "session-1" },
      prompt: { id: "p1", bindingId: "b1", body: "next", updatedAt: "claim-version" }, executionBody: "next", model: null
    };
    const release = vi.fn(() => true);
    const releaseRejectedNativeSubmission = vi.fn(() => true);
    const fencePromptNativeSubmission = vi.fn(() => true);
    const markPromptNativeQueued = vi.fn();
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt: vi.fn(() => claimed), fencePromptNativeSubmission, markPromptNativeQueued, releaseRejectedNativeSubmission },
        recovery: { releaseUndispatchedPromptClaim: release }, session: { getBinding: vi.fn() }
      },
      herdr: {
        getPane: vi.fn(async () => ({ paneId: "w1:p1", workspaceId: "w1", agentState: "idle", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } })),
        supportsPromptQueue: vi.fn(async () => true),
        queuePrompt: vi.fn(async () => { throw new Error('{"error":{"code":"session_identity_missing"}}'); })
      },
      executor: { execute: vi.fn() }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(releaseRejectedNativeSubmission).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(markPromptNativeQueued).not.toHaveBeenCalled();
  });

  it("detaches a possibly accepted native submission without replay", async () => {
    const claimed = {
      binding: { id: "b1", generation: 1, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle", agentSessionKind: "id", agentSessionValue: "session-1" },
      prompt: { id: "p1", bindingId: "b1", body: "next", updatedAt: "claim-version" }, executionBody: "next", model: null
    };
    const release = vi.fn(() => true);
    const fencePromptNativeSubmission = vi.fn(() => true);
    const markPromptNativeQueued = vi.fn(() => true);
    const applyPromptNativeSubmissionReceipt = vi.fn(() => true);
    let claims = 0;
    const dispatcher = new PrimaryPromptDispatcher({
      stores: {
        dispatch: { claimNextDispatchablePrompt: vi.fn(() => claims++ === 0 ? claimed : null), fencePromptNativeSubmission, markPromptNativeQueued, applyPromptNativeSubmissionReceipt },
        recovery: { releaseUndispatchedPromptClaim: release }, session: { getBinding: vi.fn() }
      },
      herdr: {
        getPane: vi.fn(async () => ({ paneId: "w1:p1", workspaceId: "w1", agentState: "idle", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } })),
        supportsPromptQueue: vi.fn(async () => true),
        queuePrompt: vi.fn(async () => ({
          submissionId: "p1",
          receipt: {
            submissionId: "p1", terminalId: "terminal-1", agentKind: "traex" as const,
            sessionId: "session-1", state: "uncertain" as const, createdAt: 10, updatedAt: 11
          }
        }))
      },
      executor: { execute: vi.fn() }, registry: {}, scheduler: { wake: vi.fn() }, logger: { warn: vi.fn() },
      isStopping: () => false, convergeMainCard: async () => undefined, archiveDrainedBinding: async () => undefined
    } as never);

    await dispatcher.drain("b1");

    expect(release).not.toHaveBeenCalled();
    expect(applyPromptNativeSubmissionReceipt).toHaveBeenCalledWith(expect.objectContaining({
      promptId: "p1", bindingId: "b1", submissionId: "p1", state: "uncertain", notice: expect.stringContaining("uncertain")
    }));
    expect(markPromptNativeQueued).not.toHaveBeenCalled();
  });
});
