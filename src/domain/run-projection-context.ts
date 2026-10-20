import type { AgentKind } from "./agent-instance.js";
import type { Binding } from "./types.js";

export interface RunProjectionContext {
  bindingId: string;
  bindingGeneration: number;
  sessionTitle: string;
  agentKind: AgentKind;
  workspaceId: string;
  spaceName: string;
  paneId: string | null;
  paneToken: string | null;
}

type RunProjectionBinding = Pick<Binding, "id" | "generation" | "title" | "agentKind" | "workspaceId" | "paneId" | "paneToken">;

export function createRunProjectionContext(binding: RunProjectionBinding, spaceName: string): RunProjectionContext {
  const normalizedSpaceName = spaceName.trim();
  if (!normalizedSpaceName) throw new Error("Run projection space name is required");
  return {
    bindingId: binding.id,
    bindingGeneration: binding.generation,
    sessionTitle: binding.title,
    agentKind: binding.agentKind,
    workspaceId: binding.workspaceId,
    spaceName: normalizedSpaceName,
    paneId: binding.paneId,
    paneToken: binding.paneToken
  };
}
