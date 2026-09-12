import type { TraexTranscriptObservation } from "../domain/ports/external.js";
import type { PromptJob } from "../domain/types.js";
import { classifyPromptSubmissionFailure } from "../domain/prompt-submission.js";

export type PromptExecutionFailureDisposition =
  | { kind: "detach"; notice: string }
  | { kind: "retry"; reason: string }
  | { kind: "fail"; error: string }
  | { kind: "ignore" };

export type DetachedTurnTerminalOutcome =
  | { kind: "completed"; finalAnswer?: string }
  | { kind: "aborted"; reason?: string }
  | { kind: "pending" };

/**
 * Determines a prompt's durable failure outcome without authorizing a resend.
 * Once dispatch may have reached TraeX, the only safe transition is detached
 * observation; a later worker may observe it but must never replay its body.
 */
export function decidePromptExecutionFailure(input: {
  dispatched: boolean;
  stopping: boolean;
  observerAborted: boolean;
  error: string;
}): PromptExecutionFailureDisposition {
  if (input.dispatched) {
    return {
      kind: "detach",
      notice: input.stopping
        ? "Bridge 已停止观察，但 TraeX 任务可能仍在运行；重启后会继续观察，不会重复发送请求。"
        : `TraeX 请求已尝试投递，但 Bridge 无法确认最终结果：${input.error}；不会自动重发。`
    };
  }
  const submission = classifyPromptSubmissionFailure(input.error);
  if (submission?.kind === "rejected") return { kind: "retry", reason: submission.reason };
  if (input.observerAborted && input.stopping) return { kind: "ignore" };
  return { kind: "fail", error: input.error };
}

/** Returns a terminal outcome only for the transcript turn durably owned by the prompt. */
export function decideDetachedTurnTerminalOutcome(
  prompt: PromptJob,
  observation: TraexTranscriptObservation,
  traexProcessPresent: boolean
): DetachedTurnTerminalOutcome {
  const lifecycle = observation.turnLifecycle;
  if (!traexProcessPresent || !lifecycle) return { kind: "pending" };
  if (lifecycle.turnId !== prompt.transcriptTurnId || lifecycle.startedAt !== prompt.transcriptTurnStartedAt) return { kind: "pending" };
  if (lifecycle.state === "completed") {
    return lifecycle.finalAnswer === undefined
      ? { kind: "completed" }
      : { kind: "completed", finalAnswer: lifecycle.finalAnswer };
  }
  if (lifecycle.state === "aborted") {
    return lifecycle.reason === undefined
      ? { kind: "aborted" }
      : { kind: "aborted", reason: lifecycle.reason };
  }
  return { kind: "pending" };
}

/** A distinct later transcript turn cannot be attributed to this detached prompt. */
export function isLaterConflictingTranscriptTurn(prompt: PromptJob, observation: TraexTranscriptObservation): boolean {
  if (!prompt.transcriptTurnId || !prompt.transcriptTurnStartedAt || !observation.turnId || observation.turnId === prompt.transcriptTurnId) return false;
  const observedStartedAt = observation.turnLifecycle?.startedAt;
  if (!observedStartedAt) return false;
  const observedMs = Date.parse(observedStartedAt);
  const ownedMs = Date.parse(prompt.transcriptTurnStartedAt);
  return Number.isFinite(observedMs) && Number.isFinite(ownedMs) && observedMs > ownedMs;
}

export function abortedPromptNotice(reason?: string): string {
  return reason === "interrupted"
    ? "TraeX turn was interrupted by a human operator"
    : `TraeX turn was aborted${reason ? `: ${reason}` : ""}`;
}
