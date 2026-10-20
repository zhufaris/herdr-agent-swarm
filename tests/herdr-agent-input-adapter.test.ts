import { describe, expect, it, vi } from "vitest";
import { HerdrAgentInputAdapter } from "../src/adapters/herdr-agent-input-adapter.js";
import { CommandError, type CommandRunner } from "../src/infra/command-runner.js";

describe("HerdrAgentInputAdapter", () => {
  it("detects the versioned Agent Input capability without treating legacy Core as supported", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => ({
      stdout: JSON.stringify({ result: {
        type: "agent_events_capabilities",
        exact_turn_recovery_v1: true,
        historical_turn_index_recovery_v1: true,
        session_turn_enumeration_v1: true,
        ...(args.includes("legacy") ? {} : {
          agent_input_submission_v2: true,
          agent_input_submission_v3: true,
          agent_input_typed_message_v1: true
        })
      } }),
      stderr: ""
    }));
    const current = new HerdrAgentInputAdapter({ run }, "herdr");

    await expect(current.capabilities()).resolves.toEqual({
      agentInputSubmissionV2: true,
      agentInputSubmissionV3: true,
      agentInputTypedMessageV1: true
    });
    expect(run).toHaveBeenCalledWith("herdr", ["agent", "events", "capabilities"], 2_000);

    const legacyRun = vi.fn<CommandRunner["run"]>(async () => ({
      stdout: JSON.stringify({ result: {
        type: "agent_events_capabilities",
        exact_turn_recovery_v1: true,
        historical_turn_index_recovery_v1: true,
        session_turn_enumeration_v1: true
      } }),
      stderr: ""
    }));
    const legacy = new HerdrAgentInputAdapter({ run: legacyRun }, "herdr");

    await expect(legacy.capabilities()).resolves.toEqual({
      agentInputSubmissionV2: false,
      agentInputSubmissionV3: false,
      agentInputTypedMessageV1: false
    });
  });

  it("submits one immutable input under exact Core fences and normalizes its receipt", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => ({
      stdout: JSON.stringify({ result: {
        type: "agent_input_submission_v3",
        submission_id: "input-1",
        pane_id: "w1:p2",
        terminal_id: "terminal-1",
        agent_kind: "traex",
        session_id: "session-1",
        state: "observed",
        turn_id: "turn-1",
        started_at: "2026-10-04T03:00:00.000Z",
        created_at_ms: 1_791_213_249_000,
        updated_at_ms: 1_791_213_249_500
      } }),
      stderr: ""
    }));
    const adapter = new HerdrAgentInputAdapter({ run }, "herdr");

    await expect(adapter.submit({
      submissionId: "input-1",
      paneId: "w1:p2",
      terminalId: "terminal-1",
      agentKind: "traex",
      sessionId: "session-1",
      text: "continue",
      input: plainInput("continue")
    })).resolves.toEqual({
      outcome: "receipt",
      receipt: {
        submissionId: "input-1",
        paneId: "w1:p2",
        terminalId: "terminal-1",
        agentKind: "traex",
        sessionId: "session-1",
        state: "observed",
        turnId: "turn-1",
        startedAt: "2026-10-04T03:00:00.000Z",
        terminalState: null,
        createdAt: 1_791_213_249_000,
        updatedAt: 1_791_213_249_500
      }
    });
    expect(run).toHaveBeenCalledWith("herdr", [
      "agent", "input", "w1:p2", "continue",
      "--expected-terminal-id", "terminal-1",
      "--expected-agent-kind", "traex",
      "--submission-id", "input-1",
      "--expected-session-id", "session-1"
    ], 2_000);
  });

  it("submits a choice-bearing typed input through Core v4 without dropping metadata", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => ({
      stdout: JSON.stringify({ result: {
        type: "agent_input_submission_v4",
        submission_id: "choice-input-1",
        pane_id: "w1:p2",
        terminal_id: "terminal-1",
        agent_kind: "traex",
        session_id: "session-1",
        state: "prepared",
        created_at_ms: 1_791_213_249_000,
        updated_at_ms: 1_791_213_249_000
      } }),
      stderr: ""
    }));
    const adapter = new HerdrAgentInputAdapter({ run }, "herdr");

    await expect(adapter.submit({
      submissionId: "choice-input-1",
      paneId: "w1:p2",
      terminalId: "terminal-1",
      agentKind: "traex",
      sessionId: "session-1",
      text: "批准并继续",
      input: {
        schemaVersion: 2,
        text: "批准并继续",
        choice: { actionSetId: "actions-1", optionId: "approve", sourceMessageId: "om_source" }
      }
    })).resolves.toMatchObject({ outcome: "receipt", receipt: { submissionId: "choice-input-1", state: "prepared" } });
    expect(run).toHaveBeenCalledWith("herdr", [
      "agent", "input-v4", "w1:p2", "批准并继续",
      "--expected-terminal-id", "terminal-1",
      "--expected-agent-kind", "traex",
      "--expected-session-id", "session-1",
      "--submission-id", "choice-input-1",
      "--action-set-id", "actions-1",
      "--option-id", "approve",
      "--source-message-id", "om_source"
    ], 2_000);
  });

  it("rejects a choice-bearing input without a session before invoking Core", async () => {
    const run = vi.fn<CommandRunner["run"]>();
    const adapter = new HerdrAgentInputAdapter({ run }, "herdr");

    await expect(adapter.submit({
      submissionId: "choice-without-session",
      paneId: "w1:p2",
      terminalId: "terminal-1",
      agentKind: "traex",
      sessionId: null,
      text: "批准并继续",
      input: {
        schemaVersion: 2,
        text: "批准并继续",
        choice: { actionSetId: "actions-1", optionId: "approve", sourceMessageId: "om_source" }
      }
    })).resolves.toEqual({
      outcome: "rejected",
      failure: { code: "typed_input_session_required", detail: "Typed Agent Input requires an expected session identity" }
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns a definite rejection for a sessionless input rejected before terminal delivery", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => {
      throw new Error('{"error":{"code":"agent_blocked","message":"Agent is blocked"}}');
    });
    const adapter = new HerdrAgentInputAdapter({ run }, "herdr");

    await expect(adapter.submit({
      submissionId: "input-2",
      paneId: "w1:p2",
      terminalId: "terminal-1",
      agentKind: "traex",
      sessionId: null,
      text: "continue later",
      input: plainInput("continue later")
    })).resolves.toEqual({
      outcome: "rejected",
      failure: { code: "agent_blocked", detail: "Agent is blocked" }
    });
    expect(run).toHaveBeenCalledWith("herdr", [
      "agent", "input", "w1:p2", "continue later",
      "--expected-terminal-id", "terminal-1",
      "--expected-agent-kind", "traex",
      "--submission-id", "input-2"
    ], 2_000);
  });

  it("treats an invalid submission identity as a definite pre-effect rejection", async () => {
    const adapter = new HerdrAgentInputAdapter({
      run: vi.fn(async () => { throw new Error('{"error":{"code":"invalid_submission_identity","message":"Submission identity is invalid"}}'); })
    }, "herdr");

    await expect(adapter.submit({
      submissionId: "invalid-input",
      paneId: "w1:p2",
      terminalId: "terminal-1",
      agentKind: "traex",
      sessionId: "session-1",
      text: "default",
      input: plainInput("default")
    })).resolves.toEqual({
      outcome: "rejected",
      failure: { code: "invalid_submission_identity", detail: "Submission identity is invalid" }
    });
  });

  it.each([
    ["invalid_human_input_message", "Typed human input is invalid"],
    ["invalid_choice_selection_ref", "Typed choice reference is invalid"]
  ] as const)("treats Core %s as a definite typed-input rejection", async (code, message) => {
    const adapter = new HerdrAgentInputAdapter({
      run: vi.fn(async () => { throw new Error(JSON.stringify({ error: { code, message } })); })
    }, "herdr");

    await expect(adapter.submit({
      submissionId: "invalid-typed-input",
      paneId: "w1:p2",
      terminalId: "terminal-1",
      agentKind: "traex",
      sessionId: "session-1",
      text: "approve",
      input: {
        schemaVersion: 2,
        text: "approve",
        choice: { actionSetId: "actions-1", optionId: "approve", sourceMessageId: "message-1" }
      }
    })).resolves.toEqual({
      outcome: "rejected",
      failure: { code, detail: message }
    });
  });

  it("keeps a submission uncertain when Core returns malformed JSON after the attempt boundary", async () => {
    const adapter = new HerdrAgentInputAdapter({
      run: vi.fn(async () => ({ stdout: "not-json", stderr: "" }))
    }, "herdr");

    await expect(adapter.submit({
      submissionId: "input-3",
      paneId: "w1:p2",
      terminalId: "terminal-1",
      agentKind: "traex",
      sessionId: null,
      text: "continue",
      input: plainInput("continue")
    })).resolves.toEqual({
      outcome: "uncertain",
      failure: { code: "malformed_json", detail: null }
    });
  });

  it("queries the durable v3 receipt by caller submission identity", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => ({
      stdout: JSON.stringify({ result: {
        type: "agent_input_submission_v3",
        submission_id: "input-4",
        pane_id: "w1:p2",
        terminal_id: "terminal-1",
        agent_kind: "pi",
        session_id: "session-2",
        state: "prepared",
        created_at_ms: 20_000,
        updated_at_ms: 20_000
      } }),
      stderr: ""
    }));
    const adapter = new HerdrAgentInputAdapter({ run }, "herdr");

    await expect(adapter.queryReceipt("input-4")).resolves.toEqual({
      outcome: "receipt",
      receipt: {
        submissionId: "input-4",
        paneId: "w1:p2",
        terminalId: "terminal-1",
        agentKind: "pi",
        sessionId: "session-2",
        state: "prepared",
        turnId: null,
        startedAt: null,
        terminalState: null,
        createdAt: 20_000,
        updatedAt: 20_000
      }
    });
    expect(run).toHaveBeenCalledWith("herdr", [
      "agent", "events", "submission", "--submission-id", "input-4"
    ], 2_000);
  });

  it("accepts a v4 receipt when querying a typed submission during recovery", async () => {
    const adapter = new HerdrAgentInputAdapter({
      run: vi.fn(async () => ({ stdout: JSON.stringify({ result: {
        type: "agent_input_submission_v4",
        submission_id: "typed-input-query",
        pane_id: "w1:p2",
        terminal_id: "terminal-1",
        agent_kind: "traex",
        session_id: "session-1",
        state: "observed",
        turn_id: "turn-1",
        created_at_ms: 20_000,
        updated_at_ms: 21_000
      } }), stderr: "" }))
    }, "herdr");

    await expect(adapter.queryReceipt("typed-input-query")).resolves.toMatchObject({
      outcome: "receipt",
      receipt: { submissionId: "typed-input-query", state: "observed", sessionId: "session-1" }
    });
  });

  it("accepts a v3 observed receipt when recovering a submission", async () => {
    const run = vi.fn<CommandRunner["run"]>(async () => ({
      stdout: JSON.stringify({ result: {
        type: "agent_input_submission_v3",
        submission_id: "input-query",
        pane_id: "w1:p2",
        terminal_id: "terminal-1",
        agent_kind: "traex",
        session_id: "session-1",
        state: "observed",
        turn_id: "turn-1",
        created_at_ms: 20_000,
        updated_at_ms: 21_000
      } }),
      stderr: ""
    }));
    const adapter = new HerdrAgentInputAdapter({ run }, "herdr");

    await expect(adapter.queryReceipt("input-query")).resolves.toMatchObject({
      outcome: "receipt",
      receipt: { submissionId: "input-query", state: "observed", sessionId: "session-1" }
    });
  });

  it("keeps a timed-out Core submission uncertain", async () => {
    const adapter = new HerdrAgentInputAdapter({
      run: vi.fn(async () => { throw new CommandError("herdr", ["agent", "input"], "timed out", true); })
    }, "herdr");

    await expect(adapter.submit({
      submissionId: "input-timeout",
      paneId: "w1:p2",
      terminalId: "terminal-1",
      agentKind: "traex",
      sessionId: null,
      text: "continue",
      input: plainInput("continue")
    })).resolves.toEqual({
      outcome: "uncertain",
      failure: { code: "transport_timeout", detail: null }
    });
  });

  it("reports an absent durable receipt without manufacturing a rejection", async () => {
    const adapter = new HerdrAgentInputAdapter({
      run: vi.fn(async () => { throw new Error('{"error":{"code":"submission_not_found","message":"missing"}}'); })
    }, "herdr");

    await expect(adapter.queryReceipt("input-missing")).resolves.toEqual({ outcome: "absent" });
  });
});

function plainInput(text: string) {
  return { schemaVersion: 2 as const, text };
}
