import { describe, expect, it, vi } from "vitest";
import { AgentInputDrainer } from "../src/coordinator/agent-input-drainer.js";
import type { AgentInputCorePort } from "../src/domain/ports/agent-input.js";
import type { AdmitSubmissionIntentInput, CoreSubmissionReceipt } from "../src/domain/submission-intent.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

describe("AgentInputDrainer", () => {
  it("claims and completes bounded recovery pages without replaying attempted Inputs", async () => {
    const stores = createTestStoreBundle();
    for (let index = 0; index < 9; index += 1) {
      const id = `submission-${String(index).padStart(2, "0")}`;
      stores.agentInputs.admit({ ...submission(id, `message-${index}`), recordedAt: `2026-10-04T03:00:${String(index).padStart(2, "0")}.000Z` });
      if (index % 2 === 0) {
        stores.agentInputs.claimRecorded(id, "2026-10-04T03:01:00.000Z");
        stores.agentInputs.recordUncertain(id, { code: "timeout", detail: null, recordedAt: "2026-10-04T03:02:00.000Z" });
      }
    }
    const submit = vi.fn<AgentInputCorePort["submit"]>(async (input) => ({ outcome: "receipt", receipt: receipt(input.submissionId, "prepared") }));
    const queryReceipt = vi.fn<AgentInputCorePort["queryReceipt"]>(async () => ({ outcome: "absent" }));
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs, core: corePort({ submit, queryReceipt }), recoveryBatchLimit: 4, recoveryConcurrency: 2,
      now: () => "2026-10-04T03:10:00.000Z"
    });

    await drainer.recover();
    expect(submit.mock.calls.length + queryReceipt.mock.calls.length).toBe(4);
    await drainer.recover();
    expect(submit.mock.calls.length + queryReceipt.mock.calls.length).toBe(8);
    await drainer.recover();
    expect(submit.mock.calls.length + queryReceipt.mock.calls.length).toBe(9);
    expect(submit.mock.calls.map(([input]) => input.submissionId)).toEqual(["submission-01", "submission-03", "submission-05", "submission-07"]);
    expect(queryReceipt.mock.calls.map(([id]) => id)).toEqual(["submission-00", "submission-02", "submission-04", "submission-06", "submission-08"]);
  });

  it("supervises a failed later startup page and retries it without replaying Core submission", async () => {
    const stores = createTestStoreBundle();
    for (let index = 0; index < 6; index += 1) {
      const id = `submission-${String(index).padStart(2, "0")}`;
      stores.agentInputs.admit({ ...submission(id, `message-${index}`), recordedAt: `2026-10-04T03:00:${String(index).padStart(2, "0")}.000Z` });
    }
    const complete = stores.agentInputs.completeRecoveryWorkPage.bind(stores.agentInputs);
    let completionAttempt = 0;
    vi.spyOn(stores.agentInputs, "completeRecoveryWorkPage").mockImplementation((input) => {
      completionAttempt += 1;
      if (completionAttempt === 2) throw new Error("injected page-2 commit failure");
      complete(input);
    });
    const submit = vi.fn<AgentInputCorePort["submit"]>(async (input) => ({ outcome: "receipt", receipt: receipt(input.submissionId, "prepared") }));
    const queryReceipt = vi.fn<AgentInputCorePort["queryReceipt"]>(async () => ({ outcome: "absent" }));
    const warn = vi.fn();
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs, core: corePort({ submit, queryReceipt }), recoveryBatchLimit: 2, recoveryConcurrency: 2,
      recoveryRetryInitialMs: 0, logger: { warn }, now: () => "2026-10-04T03:10:00.000Z"
    });

    await drainer.startRecovery();
    await vi.waitFor(() => expect(stores.agentInputs.get("submission-05")).toMatchObject({ state: "prepared" }));
    await drainer.stopRecovery();

    expect(submit.mock.calls.map(([input]) => input.submissionId)).toEqual([
      "submission-00", "submission-01", "submission-02", "submission-03", "submission-04", "submission-05"
    ]);
    expect(queryReceipt.mock.calls.map(([id]) => id)).toEqual(["submission-02", "submission-03"]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "agent-input-startup-recovery-failed", attempt: 1, delayMs: 0, outcome: "retry"
    }), expect.stringContaining("durable scan retained for retry"));
    expect(completionAttempt).toBe(4);
  });

  it("supervises a failed first startup page and retries it without rejecting startup", async () => {
    const stores = createTestStoreBundle();
    for (let index = 0; index < 4; index += 1) {
      const id = `submission-${String(index).padStart(2, "0")}`;
      stores.agentInputs.admit({ ...submission(id, `message-${index}`), recordedAt: `2026-10-04T03:00:${String(index).padStart(2, "0")}.000Z` });
    }
    const complete = stores.agentInputs.completeRecoveryWorkPage.bind(stores.agentInputs);
    let completionAttempt = 0;
    vi.spyOn(stores.agentInputs, "completeRecoveryWorkPage").mockImplementation((input) => {
      completionAttempt += 1;
      if (completionAttempt === 1) throw new Error("injected first page commit failure");
      complete(input);
    });
    const submit = vi.fn<AgentInputCorePort["submit"]>(async (input) => ({ outcome: "receipt", receipt: receipt(input.submissionId, "prepared") }));
    const queryReceipt = vi.fn<AgentInputCorePort["queryReceipt"]>(async () => ({ outcome: "absent" }));
    const warn = vi.fn();
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs, core: corePort({ submit, queryReceipt }), recoveryBatchLimit: 2, recoveryConcurrency: 2,
      recoveryRetryInitialMs: 0, logger: { warn }, now: () => "2026-10-04T03:10:00.000Z"
    });

    await expect(drainer.startRecovery()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(stores.agentInputs.get("submission-03")).toMatchObject({ state: "prepared" }));
    await drainer.stopRecovery();

    expect(submit.mock.calls.map(([input]) => input.submissionId)).toEqual(["submission-00", "submission-01", "submission-02", "submission-03"]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "agent-input-startup-recovery-failed", attempt: 1, delayMs: 0, outcome: "retry" }), expect.stringContaining("durable scan retained for retry"));
    expect(completionAttempt).toBe(3);
  });

  it("coalesces concurrent startup recovery calls while the first page is in flight", async () => {
    const stores = createTestStoreBundle();
    stores.agentInputs.admit(submission("recovery-1", "message-1"));
    stores.agentInputs.claimRecorded("recovery-1", "2026-10-04T03:01:00.000Z");
    stores.agentInputs.recordUncertain("recovery-1", { code: "timeout", detail: null, recordedAt: "2026-10-04T03:02:00.000Z" });
    let release!: () => void;
    const queryReceipt = vi.fn(() => new Promise<{ outcome: "absent" }>((resolve) => { release = () => resolve({ outcome: "absent" }); }));
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs,
      core: corePort({ submit: vi.fn(), queryReceipt }),
      now: () => "2026-10-04T03:10:00.000Z"
    });

    const first = drainer.startRecovery();
    await vi.waitFor(() => expect(queryReceipt).toHaveBeenCalledTimes(1));
    const second = drainer.startRecovery();
    expect(queryReceipt).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
  });

  it("persists the attempt boundary before submitting and adopts the Core receipt", async () => {
    const stores = createTestStoreBundle();
    stores.agentInputs.admit(submission("submission-1", "message-1"));
    const submit = vi.fn<AgentInputCorePort["submit"]>(async () => ({
      outcome: "receipt",
      receipt: receipt("submission-1", "prepared")
    }));
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs,
      core: corePort({ submit }),
      now: () => "2026-10-04T03:10:00.000Z"
    });

    await expect(drainer.drain("submission-1")).resolves.toMatchObject({
      submissionId: "submission-1",
      state: "prepared"
    });
    expect(submit).toHaveBeenCalledWith({
      submissionId: "submission-1",
      paneId: "workspace-1:pane-1",
      terminalId: "terminal-1",
      agentKind: "traex",
      sessionId: "session-1",
      text: "run the audit",
      input: { schemaVersion: 2, text: "run the audit" }
    });
    expect(stores.agentInputs.get("submission-1")).toMatchObject({
      state: "prepared",
      attemptedAt: "2026-10-04T03:10:00.000Z",
      receipt: { state: "prepared" }
    });
  });

  it("queries uncertain A without resending it while independently submitting B", async () => {
    const stores = createTestStoreBundle();
    stores.agentInputs.admit(submission("submission-a", "message-a"));
    stores.agentInputs.claimRecorded("submission-a", "2026-10-04T03:01:00.000Z");
    stores.agentInputs.recordUncertain("submission-a", {
      code: "transport_timeout",
      detail: null,
      recordedAt: "2026-10-04T03:02:00.000Z"
    });
    stores.agentInputs.admit(submission("submission-b", "message-b"));
    const submit = vi.fn<AgentInputCorePort["submit"]>(async (input) => {
      if (input.submissionId === "submission-a") throw new Error("uncertain A must never be submitted again");
      return { outcome: "receipt", receipt: receipt("submission-b", "prepared") };
    });
    const queryReceipt = vi.fn<AgentInputCorePort["queryReceipt"]>(async () => ({ outcome: "absent" }));
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs,
      core: corePort({ submit, queryReceipt }),
      now: () => "2026-10-04T03:10:00.000Z"
    });

    await drainer.recover();

    expect(queryReceipt).toHaveBeenCalledExactlyOnceWith("submission-a");
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ submissionId: "submission-b" }));
    expect(stores.agentInputs.get("submission-a")).toMatchObject({
      state: "uncertain",
      uncertainty: { code: "receipt_not_found" }
    });
    expect(stores.agentInputs.get("submission-b")).toMatchObject({ state: "prepared" });
  });

  it("preserves a typed choice through durable draining and fails closed when Core lacks v4", async () => {
    const stores = createTestStoreBundle();
    stores.agentInputs.admit({
      ...submission("typed-choice", "choice-message"),
      input: {
        schemaVersion: 2,
        text: "approve",
        choice: { actionSetId: "actions-1", optionId: "approve", sourceMessageId: "om-source" }
      },
      text: "approve"
    });
    const submit = vi.fn<AgentInputCorePort["submit"]>();
    const capabilities = vi.fn<AgentInputCorePort["capabilities"]>(async () => ({
      agentInputSubmissionV2: true,
      agentInputSubmissionV3: true,
      agentInputTypedMessageV1: false
    }));
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs,
      core: corePort({ capabilities, submit }),
      now: () => "2026-10-04T03:10:00.000Z"
    });

    await expect(drainer.drain("typed-choice")).resolves.toMatchObject({
      state: "uncertain",
      uncertainty: { code: "agent_input_typed_message_v1_unavailable" }
    });
    expect(capabilities).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("preserves a typed choice through durable draining when Core advertises v4", async () => {
    const stores = createTestStoreBundle();
    const input = {
      schemaVersion: 2 as const,
      text: "approve",
      choice: { actionSetId: "actions-1", optionId: "approve", sourceMessageId: "om-source" }
    };
    stores.agentInputs.admit({ ...submission("typed-choice", "choice-message"), input, text: input.text });
    const submit = vi.fn<AgentInputCorePort["submit"]>(async (request) => ({
      outcome: "receipt", receipt: receipt(request.submissionId, "prepared")
    }));
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs,
      core: corePort({
        async capabilities() { return { agentInputSubmissionV2: true, agentInputSubmissionV3: true, agentInputTypedMessageV1: true }; },
        submit
      }),
      now: () => "2026-10-04T03:10:00.000Z"
    });

    await expect(drainer.drain("typed-choice")).resolves.toMatchObject({ state: "prepared" });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ input, text: "approve" }));
  });

  it("retries a typed choice after a capability mismatch without querying or resending after a possible effect", async () => {
    const stores = createTestStoreBundle();
    const input = {
      schemaVersion: 2 as const,
      text: "approve",
      choice: { actionSetId: "actions-1", optionId: "approve", sourceMessageId: "om-source" }
    };
    stores.agentInputs.admit({ ...submission("typed-recovery", "choice-message"), input, text: input.text });
    let typedSupported = false;
    const submit = vi.fn<AgentInputCorePort["submit"]>(async (request) => ({
      outcome: "receipt", receipt: receipt(request.submissionId, "prepared")
    }));
    const queryReceipt = vi.fn<AgentInputCorePort["queryReceipt"]>();
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs,
      core: corePort({
        async capabilities() {
          return { agentInputSubmissionV2: true, agentInputSubmissionV3: true, agentInputTypedMessageV1: typedSupported };
        },
        submit,
        queryReceipt
      }),
      now: () => "2026-10-04T03:10:00.000Z"
    });

    await drainer.recover();
    expect(stores.agentInputs.get("typed-recovery")).toMatchObject({
      state: "uncertain",
      uncertainty: { code: "agent_input_typed_message_v1_unavailable" }
    });
    expect(submit).not.toHaveBeenCalled();
    expect(queryReceipt).not.toHaveBeenCalled();

    typedSupported = true;
    await drainer.recover();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ input }));
    expect(queryReceipt).not.toHaveBeenCalled();
    expect(stores.agentInputs.get("typed-recovery")).toMatchObject({ state: "prepared" });
  });

  it("adopts an exact accepted receipt during recovery without replaying Agent Input", async () => {
    const stores = createTestStoreBundle();
    stores.agentInputs.admit(submission("submission-a", "message-a"));
    stores.agentInputs.claimRecorded("submission-a", "2026-10-04T03:01:00.000Z");
    stores.agentInputs.recordUncertain("submission-a", {
      code: "transport_timeout", detail: null, recordedAt: "2026-10-04T03:02:00.000Z"
    });
    const submit = vi.fn<AgentInputCorePort["submit"]>();
    const queryReceipt = vi.fn<AgentInputCorePort["queryReceipt"]>(async () => ({
      outcome: "receipt",
      receipt: {
        ...receipt("submission-a", "observed"),
        turnId: "turn-a",
        startedAt: "2026-10-04T03:00:30.000Z"
      }
    }));
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs,
      core: corePort({ submit, queryReceipt }),
      now: () => "2026-10-04T03:10:00.000Z"
    });

    await drainer.recover();

    expect(submit).not.toHaveBeenCalled();
    expect(queryReceipt).toHaveBeenCalledExactlyOnceWith("submission-a");
    expect(stores.agentInputs.get("submission-a")).toMatchObject({
      state: "observed", receipt: { sessionId: "session-1", turnId: "turn-a", startedAt: "2026-10-04T03:00:30.000Z" }
    });
    expect(stores.agentInputs.listPendingCanonicalRecoveries()).toEqual([
      expect.objectContaining({ submissionId: "submission-a", state: "observed" })
    ]);
  });

  it("converges a duplicate drain without a second Core submission", async () => {
    const stores = createTestStoreBundle();
    stores.agentInputs.admit(submission("submission-duplicate", "message-duplicate"));
    const submit = vi.fn<AgentInputCorePort["submit"]>(async () => ({
      outcome: "receipt",
      receipt: receipt("submission-duplicate", "prepared")
    }));
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs,
      core: corePort({ submit }),
      now: () => "2026-10-04T03:10:00.000Z"
    });

    await drainer.drain("submission-duplicate");
    await drainer.drain("submission-duplicate");

    expect(submit).toHaveBeenCalledOnce();
    expect(stores.agentInputs.get("submission-duplicate")).toMatchObject({ state: "prepared" });
  });

  it("persists a structured Core rejection as terminal cancellation", async () => {
    const stores = createTestStoreBundle();
    stores.agentInputs.admit(submission("submission-rejected", "message-rejected"));
    const drainer = new AgentInputDrainer({
      store: stores.agentInputs,
      core: corePort({ async submit() {
        return { outcome: "rejected", failure: { code: "agent_blocked", detail: "Agent is blocked" } };
      } }),
      now: () => "2026-10-04T03:10:00.000Z"
    });

    await drainer.drain("submission-rejected");

    expect(stores.agentInputs.get("submission-rejected")).toMatchObject({
      state: "cancelled",
      cancellation: { code: "agent_blocked", detail: "Agent is blocked" }
    });
  });
});

function corePort(overrides: Partial<AgentInputCorePort> = {}): AgentInputCorePort {
  return {
    async capabilities() { return { agentInputSubmissionV2: true, agentInputSubmissionV3: true }; },
    async submit() { throw new Error("unexpected submit"); },
    async queryReceipt() { throw new Error("unexpected receipt query"); },
    ...overrides
  };
}

function submission(submissionId: string, sourceMessageKey: string): AdmitSubmissionIntentInput {
  return {
    submissionId,
    ingressSource: "feishu:primary",
    sourceMessageKey,
    actor: {
      kind: "human",
      id: "user-1",
      gatewayId: "feishu:primary",
      chatId: "chat-1",
      topicId: "topic-1",
      rootMessageId: "root-1"
    },
    text: "run the audit",
    owner: { kind: "primary", id: "binding-1", generation: 3 },
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    expectedAgentKind: "traex",
    expectedSessionId: "session-1",
    input: { schemaVersion: 2, text: "run the audit" },
    recordedAt: "2026-10-04T03:00:00.000Z"
  };
}

function receipt(submissionId: string, state: "prepared" | "observed" | "terminal" | "cancelled"): CoreSubmissionReceipt {
  return {
    submissionId,
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    agentKind: "traex",
    sessionId: "session-1",
    state,
    turnId: null,
    startedAt: null,
    terminalState: null,
    createdAt: Date.parse("2026-10-04T03:10:00.000Z"),
    updatedAt: Date.parse("2026-10-04T03:10:00.000Z")
  };
}
