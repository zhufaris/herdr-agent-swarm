export type ReconciliationScope = ReadonlySet<string> | null;

/**
 * Merges a new request into pending work. `null` means all workspaces and
 * absorbs every scoped request; `undefined` means the caller requested all
 * workspaces.
 */
export function mergeReconciliationScope(
  pending: ReconciliationScope | undefined,
  requestedWorkspaceIds?: readonly string[]
): ReconciliationScope {
  if (requestedWorkspaceIds === undefined || pending === null) return null;
  return new Set([...(pending ?? []), ...requestedWorkspaceIds]);
}

/** Whether an in-flight scope already covers a new request. */
export function reconciliationScopeCovers(
  active: ReconciliationScope | undefined,
  requestedWorkspaceIds?: readonly string[]
): boolean {
  if (active === undefined) return false;
  if (active === null) return true;
  if (requestedWorkspaceIds === undefined) return false;
  return requestedWorkspaceIds.every((workspaceId) => active.has(workspaceId));
}

/**
 * Determines whether every requested workspace completed successfully inside
 * the event cooldown. Empty explicit scopes deliberately do not suppress a
 * follow-up request.
 */
export function reconciliationCooldownCovers(input: {
  requestedWorkspaceIds?: readonly string[];
  configuredWorkspaceIds: ReadonlySet<string>;
  lastReconciledAt: ReadonlyMap<string, number>;
  now: number;
  cooldownMs: number;
}): boolean {
  const requested = input.requestedWorkspaceIds ?? [...input.configuredWorkspaceIds];
  const cutoff = input.now - input.cooldownMs;
  return requested.length > 0 && requested.every((workspaceId) => (input.lastReconciledAt.get(workspaceId) ?? -Infinity) >= cutoff);
}
