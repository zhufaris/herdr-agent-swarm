export type PromptSubmissionOutcome =
  | { kind: "started"; turnId: string; startedAt: string }
  | { kind: "not_started"; composerCleared: true; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "uncertain"; reason: string };

export type PromptSubmissionFailureOutcome = Exclude<PromptSubmissionOutcome, { kind: "started" }>;

export function classifyPromptSubmissionFailure(error: unknown): PromptSubmissionFailureOutcome | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = structuredErrorCode(message);
  if (code === "agent_prompt_not_started") return { kind: "not_started", composerCleared: true, reason: message };
  if (["agent_not_found", "agent_not_ready", "agent_blocked", "agent_prompt_rejected"].includes(code ?? "")) return { kind: "rejected", reason: message };
  if (code === "agent_prompt_stalled" || code === "agent_prompt_uncertain") return { kind: "uncertain", reason: message };
  return null;
}

function structuredErrorCode(message: string): string | null {
  const start = message.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(start)) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}
