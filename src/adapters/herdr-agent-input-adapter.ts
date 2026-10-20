import { z } from "zod";
import type { AgentInputCorePort, QueryAgentInputReceiptResult, SubmitAgentInputRequest, SubmitAgentInputResult } from "../domain/ports/agent-input.js";
import { CommandError, type CommandRunner } from "../infra/command-runner.js";

const capabilitiesSchema = z.object({ result: z.object({
  type: z.literal("agent_events_capabilities"),
  agent_input_submission_v2: z.boolean().default(false),
  agent_input_submission_v3: z.boolean().default(false),
  agent_input_typed_message_v1: z.boolean().default(false)
}) });
const submissionReceiptSchema = z.object({ result: z.object({
  type: z.union([z.literal("agent_input_submission_v3"), z.literal("agent_input_submission_v4")]),
  submission_id: z.string().min(1).max(256),
  pane_id: z.string().min(1).max(512),
  terminal_id: z.string().min(1).max(512),
  agent_kind: z.enum(["traex", "pi"]),
  session_id: z.string().min(1).max(512),
  state: z.enum(["prepared", "observed", "terminal", "cancelled"]),
  turn_id: z.string().min(1).max(512).optional(),
  started_at: z.string().min(1).max(128).optional(),
  terminal_state: z.string().min(1).max(64).optional(),
  created_at_ms: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative()
}) });
const definitePreEffectCodes = new Set([
  "empty_agent_prompt",
  "invalid_agent_prompt",
  "pane_not_found",
  "agent_not_found",
  "agent_not_ready",
  "agent_blocked",
  "agent_session_changed",
  "terminal_identity_mismatch",
  "agent_kind_mismatch",
  "session_identity_mismatch",
  "agent_prompt_not_submitted",
  "agent_model_resume_timeout",
  "agent_not_running",
  "submission_identity_conflict",
  "invalid_submission_identity",
  "invalid_human_input_message",
  "invalid_choice_selection_ref"
]);

export class HerdrAgentInputAdapter implements AgentInputCorePort {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable: string
  ) {}

  async capabilities(): Promise<{ agentInputSubmissionV2: boolean; agentInputSubmissionV3: boolean; agentInputTypedMessageV1: boolean }> {
    const result = capabilitiesSchema.parse(await this.command(["agent", "events", "capabilities"])).result;
    return {
      agentInputSubmissionV2: result.agent_input_submission_v2,
      agentInputSubmissionV3: result.agent_input_submission_v3,
      agentInputTypedMessageV1: result.agent_input_typed_message_v1
    };
  }

  async submit(input: SubmitAgentInputRequest): Promise<SubmitAgentInputResult> {
    const choice = input.input.choice;
    if (input.input.text !== input.text) {
      return { outcome: "rejected", failure: { code: "input_text_mismatch", detail: "Typed input text does not match its text projection" } };
    }
    if (choice && input.sessionId === null) {
      return { outcome: "rejected", failure: { code: "typed_input_session_required", detail: "Typed Agent Input requires an expected session identity" } };
    }
    const args = choice
      ? [
        "agent", "input-v4", input.paneId, input.input.text,
        "--expected-terminal-id", input.terminalId,
        "--expected-agent-kind", input.agentKind,
        "--expected-session-id", input.sessionId!,
        "--submission-id", input.submissionId,
        "--action-set-id", choice.actionSetId,
        "--option-id", choice.optionId,
        "--source-message-id", choice.sourceMessageId
      ]
      : [
        "agent", "input", input.paneId, input.input.text,
        "--expected-terminal-id", input.terminalId,
        "--expected-agent-kind", input.agentKind,
        "--submission-id", input.submissionId,
        ...(input.sessionId === null ? [] : ["--expected-session-id", input.sessionId])
      ];
    try {
      const receipt = submissionReceiptSchema.parse(await this.command(args)).result;
      return { outcome: "receipt", receipt: normalizeReceipt(receipt) };
    } catch (error) {
      const failure = normalizeCoreFailure(error);
      if (failure !== null && definitePreEffectCodes.has(failure.code)) return { outcome: "rejected", failure };
      return { outcome: "uncertain", failure: failure ?? {
        code: uncertainFailureCode(error),
        detail: null
      } };
    }
  }

  async queryReceipt(submissionId: string): Promise<QueryAgentInputReceiptResult> {
    try {
      const receipt = submissionReceiptSchema.parse(await this.command([
        "agent", "events", "submission", "--submission-id", submissionId
      ])).result;
      return { outcome: "receipt", receipt: normalizeReceipt(receipt) };
    } catch (error) {
      const failure = normalizeCoreFailure(error);
      if (failure?.code === "submission_not_found") return { outcome: "absent" };
      return { outcome: "unavailable", failure: failure ?? {
        code: uncertainFailureCode(error),
        detail: null
      } };
    }
  }

  private async command(args: string[]): Promise<unknown> {
    const { stdout } = await this.runner.run(this.executable, args, 2_000);
    return JSON.parse(stdout) as unknown;
  }
}

function normalizeReceipt(receipt: z.infer<typeof submissionReceiptSchema>["result"]) {
  return {
    submissionId: receipt.submission_id,
    paneId: receipt.pane_id,
    terminalId: receipt.terminal_id,
    agentKind: receipt.agent_kind,
    sessionId: receipt.session_id,
    state: receipt.state,
    turnId: receipt.turn_id ?? null,
    startedAt: receipt.started_at ?? null,
    terminalState: receipt.terminal_state ?? null,
    createdAt: receipt.created_at_ms,
    updatedAt: receipt.updated_at_ms
  };
}

function normalizeCoreFailure(error: unknown): { code: string; detail: string | null } | null {
  const message = String(error);
  const code = /"code"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  if (!code) return null;
  const detailValue = /"message"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(message)?.[1];
  let detail: string | null = null;
  if (detailValue) {
    try { detail = JSON.parse(detailValue) as string; } catch { detail = null; }
  }
  return { code, detail };
}

function uncertainFailureCode(error: unknown): string {
  if (error instanceof CommandError && error.timedOut) return "transport_timeout";
  if (error instanceof SyntaxError) return "malformed_json";
  if (error instanceof z.ZodError) return "invalid_response";
  return "transport_failure";
}
