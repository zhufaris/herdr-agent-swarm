import { z } from "zod";
import { isFinalMessageCompletionChoice, type FinalMessageCompletionChoice } from "./completion-choice.js";
import type { ChoiceSelectionRef } from "./inbound.js";

export const MAX_FREEFORM_EVENT_TEXT_BYTES = 1024 * 1024;
export const MAX_NON_ASSISTANT_MESSAGE_TEXT_BYTES = 64 * 1024;

const MAX_EVENT_IDENTIFIER_LENGTH = 512;
const MAX_EVENT_REASON_LENGTH = 1_024;
const MAX_EVENT_CODE_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_CHANNEL_LENGTH = 64;
const MAX_AGENT_ACTIVITY_CONTENT_BYTES = 16 * 1024;

function boundedUtf8String(maxBytes: number) {
  return z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, {
    message: `must not exceed ${maxBytes} UTF-8 bytes`
  });
}

const identifierSchema = z.string().max(MAX_EVENT_IDENTIFIER_LENGTH);
const requiredIdentifierSchema = identifierSchema.min(1);
const messageRoleSchema = z.enum(["assistant", "developer", "system"]);
const completionChoiceSchema = z.custom<FinalMessageCompletionChoice>(isFinalMessageCompletionChoice, "invalid completion_choice");
const safeNonNegativeIntegerSchema = z.number().int().nonnegative().refine(Number.isSafeInteger, {
  message: "must be a safe non-negative integer"
});
const safePositiveIntegerSchema = z.number().int().positive().refine(Number.isSafeInteger, {
  message: "must be a positive safe integer"
});
const tokenUsageGroupSchema = z.object({
  input_tokens: safeNonNegativeIntegerSchema,
  cached_input_tokens: safeNonNegativeIntegerSchema,
  cache_creation_input_tokens: safeNonNegativeIntegerSchema,
  output_tokens: safeNonNegativeIntegerSchema,
  reasoning_output_tokens: safeNonNegativeIntegerSchema,
  total_tokens: safeNonNegativeIntegerSchema
}).strict();
const choiceSelectionRefSchema = z.object({
  actionSetId: requiredIdentifierSchema,
  optionId: requiredIdentifierSchema,
  sourceMessageId: requiredIdentifierSchema
}) satisfies z.ZodType<ChoiceSelectionRef>;

export const snakeCaseAgentEventPayloadSchema = z.union([
  z.object({ type: z.literal("turn_started") }),
  z.object({ type: z.literal("turn_completed") }),
  z.object({ type: z.literal("turn_aborted"), reason: z.string().max(MAX_EVENT_REASON_LENGTH) }),
  z.object({ type: z.literal("human_message"), message_id: identifierSchema, text: boundedUtf8String(MAX_FREEFORM_EVENT_TEXT_BYTES), truncated: z.boolean(), submission_id: identifierSchema.optional(), choice: choiceSelectionRefSchema.optional() }),
  z.object({ type: z.literal("message"), message_id: identifierSchema, role: messageRoleSchema.optional(), channel: z.string().max(MAX_CHANNEL_LENGTH), text: boundedUtf8String(MAX_FREEFORM_EVENT_TEXT_BYTES), truncated: z.boolean(), completion_choice: completionChoiceSchema.optional() }).superRefine((value, context) => {
    if (value.completion_choice && value.channel !== "final") context.addIssue({ code: z.ZodIssueCode.custom, message: "completion_choice is final-only" });
    if (value.role && value.role !== "assistant" && Buffer.byteLength(value.text, "utf8") > MAX_NON_ASSISTANT_MESSAGE_TEXT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `non-assistant message text must not exceed ${MAX_NON_ASSISTANT_MESSAGE_TEXT_BYTES} UTF-8 bytes`
      });
    }
    if (value.completion_choice && value.role && value.role !== "assistant") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "completion_choice is assistant-only" });
    }
  }),
  z.object({
    type: z.literal("agent_activity"),
    agent_id: z.string().min(1).max(256),
    display_name: z.string().min(1).max(80).optional(),
    model: z.string().min(1).max(256).optional(),
    content: z.string().min(1).pipe(boundedUtf8String(MAX_AGENT_ACTIVITY_CONTENT_BYTES)).optional(),
    content_truncated: z.boolean().optional(),
    result_handoff: z.literal("delivered_to_parent").optional(),
    state: z.enum(["started", "running", "completed", "failed", "interrupted", "blocked"])
  }).superRefine((value, context) => {
    if (value.content_truncated !== undefined && value.content === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "content_truncated requires content" });
    if (value.result_handoff && value.state !== "completed") context.addIssue({ code: z.ZodIssueCode.custom, message: "result_handoff requires completed state" });
  }),
  z.object({ type: z.literal("model_changed"), model: z.string().min(1).max(256) }),
  z.object({ type: z.literal("context_compacted") }),
  z.object({
    type: z.literal("token_usage"),
    response_id: requiredIdentifierSchema,
    response: tokenUsageGroupSchema,
    turn: tokenUsageGroupSchema.optional(),
    thread: tokenUsageGroupSchema.optional(),
    model_context_window: safePositiveIntegerSchema.optional(),
    auto_compact_limit: safePositiveIntegerSchema.optional()
  }).strict(),
  z.object({ type: z.literal("tool_call"), call_id: identifierSchema, name: z.string().max(MAX_TOOL_NAME_LENGTH), arguments: boundedUtf8String(MAX_FREEFORM_EVENT_TEXT_BYTES), truncated: z.boolean() }),
  z.object({ type: z.literal("tool_result"), call_id: identifierSchema, text: boundedUtf8String(MAX_FREEFORM_EVENT_TEXT_BYTES), is_error: z.boolean(), truncated: z.boolean() }),
  z.object({
    type: z.literal("goal_changed"),
    goal_id: z.string().min(1).max(256),
    objective: z.string().min(1).max(16_400),
    status: z.enum(["active", "paused", "blocked", "completed", "budget_limited", "usage_limited"]),
    source_updated_at: z.number().int().nonnegative(),
    truncated: z.boolean()
  }),
  z.object({ type: z.literal("branch_changed"), parent_id: identifierSchema.nullable() }),
  z.object({ type: z.literal("submission_receipt"), submission_id: z.string().min(1).max(256), state: z.enum(["prepared", "accepted", "rejected", "uncertain"]) }),
  z.object({ type: z.literal("runtime_status_changed"), pane_id: requiredIdentifierSchema, status: z.string().min(1).max(64) }),
  z.object({ type: z.literal("runtime_agent_changed"), pane_id: requiredIdentifierSchema, released: z.boolean(), final_status: z.string().min(1).max(64).optional() }),
  z.object({ type: z.literal("runtime_ended"), pane_id: requiredIdentifierSchema, reason: z.string().min(1).max(256) }),
  z.object({ type: z.literal("source_error"), code: z.string().max(MAX_EVENT_CODE_LENGTH) }),
  z.object({ type: z.literal("record_skipped"), code: z.string().max(MAX_EVENT_CODE_LENGTH) })
]);

export type SnakeCaseAgentEventPayload = z.infer<typeof snakeCaseAgentEventPayloadSchema>;
