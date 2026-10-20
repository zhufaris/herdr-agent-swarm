import type { AgentTranscriptReaderPort } from "../domain/ports/external.js";
import type { PromptDispatchStore } from "../domain/ports/prompt-run.js";
import type { PromptJob } from "../domain/types.js";
import { transcriptSourceFor } from "../domain/transcript-observer-identity.js";

export type DetachedPromptReceiptAssessment =
  | { outcome: "owned"; prompt: PromptJob }
  | { outcome: "accepted"; prompt: PromptJob }
  | { outcome: "uncertain" | "rejected"; prompt: PromptJob; reason: string }
  | { outcome: "pending" | "unavailable" | "stale"; reason: string };

/**
 * Classifies a detached Prompt using only its durable submission receipt. A
 * receipt can bound recovery, but never establishes Prompt-to-turn ownership.
 */
export async function assessDetachedPromptReceipt(input: {
  prompt: PromptJob;
  store: Pick<PromptDispatchStore, "getBinding" | "getPrompt">;
  reader?: AgentTranscriptReaderPort;
}): Promise<DetachedPromptReceiptAssessment> {
  const current = input.store.getPrompt(input.prompt.id);
  if (!current || !["running", "recovering"].includes(current.state) || current.observationState !== "detached") return { outcome: "stale", reason: "prompt_not_detached" };
  if (current.transcriptTurnId && current.transcriptTurnStartedAt) return { outcome: "owned", prompt: current };
  if (!current.nativeSubmissionId) return { outcome: "unavailable", reason: "missing_submission_identity" };
  if (current.nativeSubmissionId !== current.id) return { outcome: "unavailable", reason: "submission_identity_mismatch" };
  const binding = input.store.getBinding(current.bindingId);
  if (!binding || binding.state !== "active" || binding.lifecycle !== "active" || binding.generation < 1) return { outcome: "stale", reason: "binding_not_active" };

  if (input.reader?.getNativeSubmissionReceipt) {
    const nativeReceipt = await input.reader.getNativeSubmissionReceipt(transcriptSourceFor(binding), current.nativeSubmissionId);
    if (!nativeReceipt) return { outcome: "pending", reason: "submission_receipt_unavailable" };
    if (nativeReceipt.submissionId !== current.id) return { outcome: "unavailable", reason: "submission_receipt_identity_mismatch" };
    if (nativeReceipt.sessionId !== binding.agentSessionValue || nativeReceipt.agentKind !== binding.agentKind) return { outcome: "unavailable", reason: "submission_receipt_session_mismatch" };
    if (nativeReceipt.state === "accepted") return { outcome: "accepted", prompt: current };
    if (nativeReceipt.state === "uncertain") return { outcome: "uncertain", prompt: current, reason: "submission_outcome_uncertain" };
    if (nativeReceipt.state === "rejected") return { outcome: "rejected", prompt: current, reason: "submission_rejected_before_boundary" };
    return { outcome: "pending", reason: "submission_prepared" };
  }
  if (!input.reader?.getSubmissionReceipt) return { outcome: "unavailable", reason: "submission_recovery_unsupported" };

  const receipt = await input.reader.getSubmissionReceipt(transcriptSourceFor(binding), current.nativeSubmissionId);
  if (!receipt) return { outcome: "pending", reason: "submission_receipt_unavailable" };
  if (receipt.submissionId !== current.id) return { outcome: "unavailable", reason: "submission_receipt_identity_mismatch" };
  if (receipt.sessionId !== binding.agentSessionValue) return { outcome: "unavailable", reason: "submission_receipt_session_mismatch" };
  if (receipt.state === "prepared") return { outcome: "pending", reason: "submission_not_observed" };
  if (receipt.state === "cancelled") return { outcome: "unavailable", reason: "submission_cancelled" };
  if (receipt.state === "legacy_unavailable") return { outcome: "unavailable", reason: "legacy_submission_unavailable" };
  return { outcome: "unavailable", reason: "submission_terminal_without_event" };
}
