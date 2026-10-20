import type { HerdrPort } from "../domain/ports/external.js";
import type { Binding, HerdrPane, RuntimeIdentityReconciliationDecision } from "../domain/types.js";
import { isNativeTraexSession, sameNativeTraexSession } from "../domain/traex-session-identity.js";
import type { ProjectCatalog } from "./project-catalog.js";
import { matchesAgentKind } from "../domain/agent-instance.js";
import { fingerprintRuntimeIdentityEvidence, sameNativeRuntimeIdentity, type RuntimeIdentityClaim } from "../domain/runtime-identity-claim.js";

export type { RuntimeIdentityReconciliationDecision } from "../domain/types.js";

export function decideRuntimeIdentityReconciliation(input: { binding: Binding; claim: RuntimeIdentityClaim | null; pane: HerdrPane }): RuntimeIdentityReconciliationDecision {
  const { binding, pane } = input;
  const claim = input.claim ?? compatibilityClaimFor(binding);
  const fingerprint = () => fingerprintRuntimeIdentityEvidence({ workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId ?? null, agentKind: pane.agentKind ?? null, agentSession: pane.agentSession ?? null });
  const refuse = (reason: string): RuntimeIdentityReconciliationDecision => {
    const evidenceFingerprint = fingerprint();
    return claim?.lastRejectedEvidenceFingerprint === evidenceFingerprint && claim.lastRejectedReason === reason
      ? { outcome: "unchanged_refusal", reason }
      : { outcome: "refused", reason, evidenceFingerprint };
  };
  if (claim.owner.bindingId !== binding.id || (Number.isInteger(binding.generation) && claim.owner.bindingGeneration !== binding.generation) || (Number.isInteger(binding.sessionEpoch) && claim.owner.sessionEpoch !== binding.sessionEpoch)) return { outcome: "stale" };
  if (pane.workspaceId !== binding.workspaceId || pane.paneId !== binding.paneId) return refuse("attachment_mismatch");
  const agentKind = binding.agentKind ?? "traex";
  const agentMatches = agentKind === "traex"
    ? pane.foregroundExecutables.includes("traex") || pane.agentKind === "traex"
    : matchesAgentKind(agentKind, pane.agentKind);
  if (!agentMatches) return refuse("agent_kind_mismatch");
  if (!pane.terminalId || !pane.agentSession) {
    return claim.state === "unclaimed" && binding.attachment !== "orphaned" && (!binding.traexSessionId || binding.traexSessionId === pane.terminalId)
      ? { outcome: "observe_unclaimed" }
      : refuse("continuity_not_proven");
  }
  if (agentKind === "traex" && !isNativeTraexSession(pane.agentSession)) return refuse("continuity_not_proven");
  if (claim.state === "unclaimed") {
    if (binding.attachment !== "attached" || binding.traexSessionId !== pane.terminalId) return refuse("attachment_mismatch");
    return { outcome: "adopt" };
  }
  if (claim.state !== "current" || !claim.attachment || !claim.nativeIdentity) return refuse("claim_not_current");
  if (claim.attachment.workspaceId !== pane.workspaceId || claim.attachment.paneId !== pane.paneId) return refuse("attachment_mismatch");
  if (!sameNativeRuntimeIdentity(claim.nativeIdentity, pane.agentSession)) return refuse("native_session_mismatch");
  if (claim.attachment.state === "orphaned" || binding.attachment === "orphaned") return { outcome: "orphan_recovery" };
  return claim.attachment.terminalId === pane.terminalId ? { outcome: "observed" } : { outcome: "terminal_refresh" };
}

function compatibilityClaimFor(binding: Binding): RuntimeIdentityClaim {
  const owner = { bindingId: binding.id, bindingGeneration: Number.isInteger(binding.generation) ? binding.generation : 1, sessionEpoch: Number.isInteger(binding.sessionEpoch) ? binding.sessionEpoch : 1 };
  if (!binding.agentSessionSource || !binding.agentSessionAgent || !binding.agentSessionKind || !binding.agentSessionValue || !binding.paneId || !binding.traexSessionId || (binding.attachment !== "attached" && binding.attachment !== "orphaned")) return { owner, state: "unclaimed", nativeIdentity: null, attachment: null, lastRejectedEvidenceFingerprint: null, lastRejectedReason: null, createdAt: binding.updatedAt, updatedAt: binding.updatedAt };
  return { owner, state: "current", nativeIdentity: { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }, attachment: { state: binding.attachment, workspaceId: binding.workspaceId, paneId: binding.paneId, terminalId: binding.traexSessionId }, lastRejectedEvidenceFingerprint: null, lastRejectedReason: null, createdAt: binding.updatedAt, updatedAt: binding.updatedAt };
}

export async function requireMatchingPane(herdr: Pick<HerdrPort, "observeRuntime">, projects: ProjectCatalog, binding: Binding, paneId: string): Promise<HerdrPane> {
  let pane = (await herdr.observeRuntime(paneId)).pane;
  if (!pane) throw new Error(`Herdr pane ${paneId} not found`);
  if (pane.workspaceId !== binding.workspaceId) throw new Error(`Herdr pane ${paneId} belongs to another workspace`);
  const project = projects.projectForBinding(binding);
  if (project && pane.cwd !== project.cwd) throw new Error(`Herdr pane ${paneId} does not match project ${project.displayName}`);
  requireMatchingRuntimeIdentity(binding, pane);
  if (hasNativeAgentSession(binding) && !pane.agentSession) pane = { ...pane, agentSession: persistedAgentSession(binding) };
  if (binding.agentKind === "traex" ? !pane.foregroundExecutables.includes("traex") && pane.agentKind !== "traex" : !matchesAgentKind(binding.agentKind, pane.agentKind)) throw new Error(`${binding.agentKind} is not running in pane ${paneId}`);
  return pane;
}

export function hasNativeAgentSession(binding: Binding): boolean { return isNativeTraexSession(persistedAgentSession(binding)); }
export function sameNativeAgentSession(binding: Binding, pane: HerdrPane): boolean {
  const persisted = persistedAgentSession(binding);
  return Boolean(persisted && pane.agentSession && sameNativeTraexSession(persisted, pane.agentSession));
}

export function requireMatchingRuntimeIdentity(binding: Binding, pane: HerdrPane): void {
  if (binding.paneId && binding.paneId !== pane.paneId) throw new Error(`Herdr pane identity changed for ${pane.paneId}`);
  if (binding.traexSessionId && binding.traexSessionId !== pane.terminalId) throw new Error(`Herdr pane identity changed for ${pane.paneId}`);
  const persisted = persistedAgentSession(binding);
  if (binding.agentKind === "traex") {
    if ((persisted && !isNativeTraexSession(persisted)) || (pane.agentSession && !isNativeTraexSession(pane.agentSession))) throw new Error(`Herdr Agent session identity changed for ${pane.paneId}`);
    if (persisted && pane.agentSession && !sameNativeAgentSession(binding, pane)) throw new Error(`Herdr Agent session identity changed for ${pane.paneId}`);
  } else {
    if (!matchesAgentKind(binding.agentKind, pane.agentKind)) throw new Error(`Herdr Agent kind changed for ${pane.paneId}`);
    if (persisted && pane.agentSession && (persisted.source !== pane.agentSession.source || persisted.agent !== pane.agentSession.agent || persisted.kind !== pane.agentSession.kind || persisted.value !== pane.agentSession.value)) throw new Error(`Herdr Agent session identity changed for ${pane.paneId}`);
  }
}

export function preferredRuntimeSessionId(binding: Binding, pane: HerdrPane): string | null {
  requireMatchingRuntimeIdentity(binding, pane);
  return pane.agentSession?.value ?? (hasNativeAgentSession(binding) ? binding.agentSessionValue! : pane.terminalId ?? null);
}

function persistedAgentSession(binding: Binding): NonNullable<HerdrPane["agentSession"]> | null {
  return binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
    : null;
}
