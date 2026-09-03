import type { HerdrPort } from "../domain/ports/external.js";
import type { Binding, HerdrPane, ProjectConfig } from "../domain/types.js";

export async function requireMatchingPane(herdr: Pick<HerdrPort, "observeRuntime">, projectsById: ReadonlyMap<string, ProjectConfig>, binding: Binding, paneId: string): Promise<HerdrPane> {
  const pane = (await herdr.observeRuntime(paneId)).pane;
  if (!pane) throw new Error(`Herdr pane ${paneId} not found`);
  if (pane.workspaceId !== binding.workspaceId) throw new Error(`Herdr pane ${paneId} belongs to another workspace`);
  const project = binding.projectId ? projectsById.get(binding.projectId) : undefined;
  if (project && pane.cwd !== project.cwd) throw new Error(`Herdr pane ${paneId} does not match project ${project.displayName}`);
  if (hasNativeAgentSession(binding) && pane.agentSession && !sameNativeAgentSession(binding, pane)) throw new Error(`Herdr Agent session identity changed for ${paneId}`);
  if (binding.traexSessionId && pane.terminalId && binding.traexSessionId !== pane.terminalId && !sameNativeAgentSession(binding, pane)) throw new Error(`Herdr pane identity changed for ${paneId}`);
  if (!pane.foregroundExecutables.includes("traex")) throw new Error(`TraeX is not running in pane ${paneId}`);
  return pane;
}

export function hasNativeAgentSession(binding: Binding): boolean { return Boolean(binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue); }
export function sameNativeAgentSession(binding: Binding, pane: HerdrPane): boolean { return Boolean(pane.agentSession && binding.agentSessionSource === pane.agentSession.source && binding.agentSessionAgent === pane.agentSession.agent && binding.agentSessionKind === pane.agentSession.kind && binding.agentSessionValue === pane.agentSession.value); }
