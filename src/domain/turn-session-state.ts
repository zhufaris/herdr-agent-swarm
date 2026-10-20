import type { ModelUsageSnapshot, PaneIdentitySnapshot } from "./topic-view.js";
import type { SessionActivityView, SessionActivityTurnState } from "./session-activity.js";

export interface TurnSessionIdentityFacts {
  paneIdentity?: Pick<PaneIdentitySnapshot, "workspace" | "worktreeName" | "branch" | "paneId" | "paneToken"> | null;
  workspace?: string | null;
  worktreeName?: string | null;
  branch?: string | null;
  paneId?: string | null;
  paneToken?: string | null;
  modelUsage?: Pick<ModelUsageSnapshot, "model" | "contextRemainingPercent" | "inputTokens" | "outputTokens" | "waitMs" | "firstVisibleMs"> | null;
  model?: string | null;
}

/**
 * The bounded, provider-neutral state shown only on a mutable current Turn
 * Card. It deliberately excludes segment-owned Goal and Task List facts.
 */
export interface TurnSessionStateView {
  paneIdentity: Pick<PaneIdentitySnapshot, "workspace" | "worktreeName" | "branch" | "paneId" | "paneToken"> | null;
  modelUsage: Pick<ModelUsageSnapshot, "model" | "contextRemainingPercent" | "inputTokens" | "outputTokens" | "waitMs" | "firstVisibleMs">;
  lastTurnState: SessionActivityTurnState | null;
  tokenUsage: number | null;
  contextUsage: number | null;
  activeSubagents: readonly { label: string; state: string }[];
  compactionCount: number | null;
}

const ACTIVE_SUBAGENT_LIMIT = 8;

/** Compose only persisted Topic View and Session Activity facts; never infer missing values. */
export function turnSessionStateView(topic: TurnSessionIdentityFacts | null, activity: SessionActivityView | null): TurnSessionStateView | null {
  const paneIdentity = topic ? compactPaneIdentity(topic.paneIdentity ?? {
    workspace: topic.workspace ?? null,
    worktreeName: topic.worktreeName ?? null,
    branch: topic.branch ?? null,
    paneId: topic.paneId ?? null,
    paneToken: topic.paneToken ?? null
  }) : null;
  const modelUsage = compactModelUsage(topic?.modelUsage, topic?.model ?? activity?.snapshot.currentModel ?? null);
  const activeSubagents = (activity?.items ?? [])
    .filter((item) => item.kind === "agent" && !item.terminal)
    .slice(0, ACTIVE_SUBAGENT_LIMIT)
    .map((item) => ({ label: compactText(item.label, 160), state: compactText(item.state, 48) }))
    .filter(({ label, state }) => Boolean(label && state));
  const state: TurnSessionStateView = {
    paneIdentity,
    modelUsage,
    lastTurnState: activity?.snapshot.lastTurnState ?? null,
    tokenUsage: nonNegativeInteger(activity?.snapshot.tokenUsage),
    contextUsage: nonNegativeInteger(activity?.snapshot.contextUsage),
    activeSubagents,
    compactionCount: positiveInteger(activity?.snapshot.compactionCount)
  };
  return hasDisplayableSessionState(state) ? state : null;
}

/** The fingerprint contains exactly the normalized fields rendered by the Turn Card. */
export function turnSessionStatePresentationFingerprint(view: TurnSessionStateView | null): string {
  return JSON.stringify(view);
}

function compactPaneIdentity(identity: Pick<PaneIdentitySnapshot, "workspace" | "worktreeName" | "branch" | "paneId" | "paneToken">): TurnSessionStateView["paneIdentity"] {
  const value = {
    workspace: nullableText(identity.workspace, 320),
    worktreeName: nullableText(identity.worktreeName, 160),
    branch: nullableText(identity.branch, 160),
    paneId: nullableText(identity.paneId, 160),
    paneToken: nullableText(identity.paneToken, 80)
  };
  return Object.values(value).some(Boolean) ? value : null;
}

function compactModelUsage(usage: TurnSessionIdentityFacts["modelUsage"], fallbackModel: string | null): TurnSessionStateView["modelUsage"] {
  return {
    model: nullableText(usage?.model ?? fallbackModel, 96),
    contextRemainingPercent: boundedPercent(usage?.contextRemainingPercent),
    inputTokens: nonNegativeInteger(usage?.inputTokens),
    outputTokens: nonNegativeInteger(usage?.outputTokens),
    waitMs: nonNegativeInteger(usage?.waitMs),
    firstVisibleMs: nonNegativeInteger(usage?.firstVisibleMs)
  };
}

function hasDisplayableSessionState(view: TurnSessionStateView): boolean {
  return view.paneIdentity !== null || Object.values(view.modelUsage).some((value) => value !== null)
    || view.lastTurnState !== null || view.tokenUsage !== null || view.contextUsage !== null
    || view.activeSubagents.length > 0 || view.compactionCount !== null;
}

function nullableText(value: string | null | undefined, limit: number): string | null {
  const compact = compactText(value ?? "", limit);
  return compact || null;
}

function compactText(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function nonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function boundedPercent(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value * 100) / 100 : null;
}
