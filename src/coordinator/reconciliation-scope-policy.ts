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
