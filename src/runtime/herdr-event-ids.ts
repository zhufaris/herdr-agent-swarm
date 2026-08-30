export function extractHerdrEventIds(value: unknown): { workspaceIds: string[]; paneIds: string[] } {
  const workspaceIds = new Set<string>();
  const paneIds = new Set<string>();
  visit(value, workspaceIds, paneIds, 0);
  return { workspaceIds: [...workspaceIds].slice(0, 64), paneIds: [...paneIds].slice(0, 128) };
}

function visit(value: unknown, workspaces: Set<string>, panes: Set<string>, depth: number): void {
  if (depth > 5 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) visit(item, workspaces, panes, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((key === "workspace_id" || key === "workspaceId") && typeof item === "string" && item.length <= 256) workspaces.add(item);
    else if ((key === "pane_id" || key === "paneId") && typeof item === "string" && item.length <= 256) panes.add(item);
    else visit(item, workspaces, panes, depth + 1);
  }
}
