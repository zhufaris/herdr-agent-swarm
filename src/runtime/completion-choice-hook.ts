import { z } from "zod";
import { normalizeFinalTraceEnvelope } from "../domain/final-trace-envelope.js";
import type { CompletionChoiceEligibilityRequest } from "../domain/ports/completion-choice-eligibility.js";

const MAX_ASSISTANT_MESSAGE_BYTES = 128 * 1024;
const stopInputSchema = z.object({
  last_assistant_message: z.string(),
  stop_hook_active: z.boolean()
}).passthrough();
const userPromptSubmitInputSchema = z.object({
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string()
}).passthrough();

export type CompletionChoiceHookEnvironment = Partial<Record<
  "HERDR_ENV" | "HERDR_PANE_ID" | "HERDR_BRIDGE_BINDING_ID" | "HERDR_BRIDGE_GENERATION" | "HERDR_PROJECT_ID",
  string | undefined
>>;

export type CompletionChoiceHookResponse = Record<string, never> | {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
} | {
  decision: "block";
  reason: string;
};
export type CompletionChoiceEligibilityCheck = (request: CompletionChoiceEligibilityRequest) => Promise<boolean>;

export const COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT = "Use $herdr-choice-list:herdr-choice-list in inline mode. Keep Final Trace Envelope order: answer -> requester syntax -> invocation -> choice -> optional terminal memory citation. Emit exactly one terminal herdr-choice-list fence with one compact version-3 JSON.stringify line: {\"version\":3} or {\"version\":3,\"choice\":{\"question\":...,\"defaultOption\":{\"id\":...,\"label\":...,\"submitText\":...},\"alternatives\":[...]}}. ordinary JSON examples are explanatory text only, not protocol. Every option needs real submitText; do not emit intent, default, message, or a \"default\" sentinel.";
export const COMPLETION_CHOICE_REPAIR_REASON = "Continue with one compact version 3 herdr-choice-list JSON.stringify block only: {\"version\":3} or embedded choice with defaultOption/submitText. Emit exactly one terminal fence; ordinary JSON examples are not protocol. Keep envelope order answer -> requester syntax -> invocation -> choice -> optional terminal memory citation. Use real submitText; do not emit intent, default, message, or a \"default\" sentinel. Protocol only; do not repeat the Answer.";

export async function handleCompletionChoiceUserPromptSubmit(
  rawInput: unknown,
  environment: CompletionChoiceHookEnvironment,
  checkEligibility: CompletionChoiceEligibilityCheck
): Promise<CompletionChoiceHookResponse> {
  try {
    const parsed = userPromptSubmitInputSchema.safeParse(rawInput);
    if (!parsed.success || Buffer.byteLength(parsed.data.prompt, "utf8") > MAX_ASSISTANT_MESSAGE_BYTES) return {};
    const identity = identityFromEnvironment(environment);
    if (!identity || !await checkEligibility(identity)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: COMPLETION_CHOICE_INLINE_ADDITIONAL_CONTEXT
      }
    };
  } catch {
    return {};
  }
}

export async function handleCompletionChoiceStop(
  rawInput: unknown,
  environment: CompletionChoiceHookEnvironment,
  checkEligibility: CompletionChoiceEligibilityCheck
): Promise<CompletionChoiceHookResponse> {
  try {
    if (isRepeatedStop(rawInput)) return {};
    const parsed = stopInputSchema.safeParse(rawInput);
    if (!parsed.success) return {};
    const identity = identityFromEnvironment(environment);
    if (!identity || !await checkEligibility(identity)) return {};
    if (Buffer.byteLength(parsed.data.last_assistant_message, "utf8") > MAX_ASSISTANT_MESSAGE_BYTES) {
      return { decision: "block", reason: COMPLETION_CHOICE_REPAIR_REASON };
    }

    const inspection = normalizeFinalTraceEnvelope({ finalMarkdown: parsed.data.last_assistant_message }).compatibilityChoice;
    if (inspection.kind !== "valid" || inspection.decision.protocolVersion !== 3) {
      return { decision: "block", reason: COMPLETION_CHOICE_REPAIR_REASON };
    }
    return {};
  } catch {
    return {};
  }
}

function isRepeatedStop(rawInput: unknown): boolean {
  return typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
    && (rawInput as Record<string, unknown>).stop_hook_active === true;
}

function identityFromEnvironment(environment: CompletionChoiceHookEnvironment): CompletionChoiceEligibilityRequest | null {
  if (environment.HERDR_ENV !== "1") return null;
  const paneId = boundedIdentity(environment.HERDR_PANE_ID, 256);
  return paneId ? { paneId } : null;
}

function boundedIdentity(value: string | undefined, maximum: number): string | null {
  return value && value.length <= maximum && value.trim() === value ? value : null;
}
