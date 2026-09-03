import type { Binding, HerdrPane } from "./types.js";

export const CONSERVATIVE_IDLE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
export const CONSERVATIVE_GRACE_MS = 48 * 60 * 60 * 1_000;

export type RetentionDecision =
  | { status: "disabled" | "active" | "blocked"; reason: string }
  | { status: "warning" | "eligible"; idleSince: string; warningAt: string; closeAt: string };

export interface RetentionInput {
  binding: Binding;
  now: string;
  enabled: boolean;
  pendingWork: boolean;
  unresolvedTurn: boolean;
  runtimeState: HerdrPane["agentState"] | null;
  idleAfterMs?: number;
  graceMs?: number;
}

export function evaluatePaneRetention(input: RetentionInput): RetentionDecision {
  if (!input.enabled) return { status: "disabled", reason: "retention is not enabled for this binding" };
  if (input.binding.lifecycle !== "active" || input.binding.state !== "active" || input.binding.attachment !== "attached") return { status: "blocked", reason: "binding is not active and attached" };
  if (input.pendingWork || input.unresolvedTurn) return { status: "blocked", reason: "binding still has durable work" };
  if (input.runtimeState !== "idle" && input.runtimeState !== "done") return { status: "blocked", reason: "runtime is not idle or done" };
  const now = Date.parse(input.now);
  const idleSince = Date.parse(input.binding.lastActivityAt);
  if (!Number.isFinite(now) || !Number.isFinite(idleSince)) return { status: "blocked", reason: "activity timestamp is invalid" };
  const idleAfterMs = input.idleAfterMs ?? CONSERVATIVE_IDLE_AFTER_MS;
  const graceMs = input.graceMs ?? CONSERVATIVE_GRACE_MS;
  const warningAt = new Date(idleSince + idleAfterMs).toISOString();
  const closeAt = new Date(idleSince + idleAfterMs + graceMs).toISOString();
  return now >= idleSince + idleAfterMs + graceMs
    ? { status: "eligible", idleSince: input.binding.lastActivityAt, warningAt, closeAt }
    : now >= idleSince + idleAfterMs
      ? { status: "warning", idleSince: input.binding.lastActivityAt, warningAt, closeAt }
      : { status: "active", reason: "idle threshold has not elapsed" };
}

export interface PaneClosureSafetyInput { binding: Binding; pane: HerdrPane; pendingWork: boolean; busy: boolean; expectedPaneId?: string }
export type PaneClosureSafetyDecision = { allowed: true } | { allowed: false; reason: string };

export function evaluatePaneClosureSafety(input: PaneClosureSafetyInput): PaneClosureSafetyDecision {
  const { binding, pane } = input;
  if (!binding.paneId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") return { allowed: false, reason: "binding is not active and attached" };
  if (input.expectedPaneId !== undefined && binding.paneId !== input.expectedPaneId) return { allowed: false, reason: "pane identity changed" };
  if (input.busy || input.pendingWork) return { allowed: false, reason: "pane has active or queued work" };
  if (pane.workspaceId !== binding.workspaceId || binding.traexSessionId === null || pane.terminalId !== binding.traexSessionId) return { allowed: false, reason: "pane runtime identity changed" };
  if (pane.agentState !== "idle" && pane.agentState !== "done") return { allowed: false, reason: `pane runtime state is ${pane.agentState}` };
  return { allowed: true };
}
