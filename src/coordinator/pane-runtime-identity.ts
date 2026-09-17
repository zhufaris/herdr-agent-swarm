import type { HerdrPort } from "../domain/ports/external.js";
import type { Binding, HerdrPane } from "../domain/types.js";
import { isNativeTraexSession, sameNativeTraexSession } from "../domain/traex-session-identity.js";
import type { ProjectCatalog } from "./project-catalog.js";
import { matchesAgentKind } from "../domain/agent-instance.js";

export async function requireMatchingPane(herdr: Pick<HerdrPort, "observeRuntime">, projects: ProjectCatalog, binding: Binding, paneId: string): Promise<HerdrPane> {
  let pane = (await herdr.observeRuntime(paneId)).pane;
  if (!pane) throw new Error(`Herdr pane ${paneId} not found`);
  if (pane.workspaceId !== binding.workspaceId) throw new Error(`Herdr pane ${paneId} belongs to another workspace`);
  const project = binding.projectId ? projects.projectById(binding.projectId) : undefined;
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
