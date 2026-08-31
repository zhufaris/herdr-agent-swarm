export type HerdrEventKind =
  | "agent-status"
  | "pane-created"
  | "pane-updated"
  | "pane-closed"
  | "pane-moved"
  | "pane-exited"
  | "agent-detected"
  | "socket-recovered"
  | "invalid"
  | "unknown";

export type HerdrEventScope = "panes" | "workspaces" | "all";

export interface HerdrRuntimeHint {
  kind: HerdrEventKind;
  scope: HerdrEventScope;
  workspaceIds: string[];
  paneIds: string[];
}

const eventKinds = new Map<string, HerdrEventKind>([
  ["pane.agent_status_changed", "agent-status"],
  ["pane_agent_status_changed", "agent-status"],
  ["pane.created", "pane-created"],
  ["pane_created", "pane-created"],
  ["pane.updated", "pane-updated"],
  ["pane_updated", "pane-updated"],
  ["pane.closed", "pane-closed"],
  ["pane_closed", "pane-closed"],
  ["pane.moved", "pane-moved"],
  ["pane_moved", "pane-moved"],
  ["pane.exited", "pane-exited"],
  ["pane_exited", "pane-exited"],
  ["pane.agent_detected", "agent-detected"],
  ["pane_agent_detected", "agent-detected"]
]);

const scopeRank: Record<HerdrEventScope, number> = { panes: 0, workspaces: 1, all: 2 };

export function normalizeHerdrEvent(
  event: string,
  ids: { workspaceIds: readonly string[]; paneIds: readonly string[] }
): HerdrRuntimeHint {
  const kind = eventKinds.get(event) ?? "unknown";
  const workspaceIds = boundedUnique(ids.workspaceIds, 64);
  const paneIds = boundedUnique(ids.paneIds, 128);
  let scope: HerdrEventScope = "all";
  if (kind === "agent-status" && paneIds.length > 0) scope = "panes";
  else if (kind !== "unknown" && workspaceIds.length > 0) scope = "workspaces";
  return { kind, scope, workspaceIds, paneIds };
}

export function mergeHerdrRuntimeHints(current: HerdrRuntimeHint | null, next: HerdrRuntimeHint): HerdrRuntimeHint {
  if (!current) return next;
  return {
    kind: current.kind === next.kind ? current.kind : "unknown",
    scope: scopeRank[current.scope] >= scopeRank[next.scope] ? current.scope : next.scope,
    workspaceIds: boundedUnique([...current.workspaceIds, ...next.workspaceIds], 64),
    paneIds: boundedUnique([...current.paneIds, ...next.paneIds], 128)
  };
}

function boundedUnique(values: readonly string[], limit: number): string[] {
  return [...new Set(values)].slice(0, limit);
}
