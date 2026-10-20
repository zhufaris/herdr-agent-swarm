import { projectSpaceName } from "../config.js";
import type { AgentInstance } from "../domain/agent-instance.js";
import type { PrimaryTopologyPane, PrimaryTopologyPaneOwnership, PrimaryTopologyQueryPort, PrimaryTopologySpace } from "../domain/primary-topology.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { Binding, ProjectConfig } from "../domain/types.js";

interface PrimaryTopologyStore {
  listBindings(): Binding[];
  listAgentInstances(projectId: string): AgentInstance[];
}

interface Options {
  projects: readonly ProjectConfig[];
  store: PrimaryTopologyStore;
  herdr: Pick<HerdrPort, "listPanes">;
}

export class PrimaryTopologyQueryWorkflow implements PrimaryTopologyQueryPort {
  constructor(private readonly options: Options) {}

  listSpaces(projectId: string): PrimaryTopologySpace[] {
    const project = this.project(projectId);
    return [{
      projectId: project.id,
      displayName: project.displayName,
      description: project.description,
      spaceName: projectSpaceName(project),
      workspaceId: project.workspaceId,
      directories: unique([project.cwd, ...(project.orchestrator?.enabled ? [project.orchestrator.cwd] : [])])
    }];
  }

  async listPanes(projectId: string): Promise<PrimaryTopologyPane[]> {
    const project = this.project(projectId);
    const bindings = this.options.store.listBindings().filter((binding) => binding.projectId === project.id && binding.lifecycle !== "archived");
    const instances = this.options.store.listAgentInstances(project.id).filter((instance) => instance.role === "worker");
    const ownership = new Map<string, PrimaryTopologyPaneOwnership>();
    for (const binding of bindings) if (binding.paneId) ownership.set(binding.paneId, { kind: "binding", bindingId: binding.id, bindingKind: binding.kind, generation: binding.generation });
    for (const instance of instances) {
      const paneId = instance.runtimeRef?.paneId ?? instance.pendingRuntimeRef?.paneId;
      if (paneId && !ownership.has(paneId)) ownership.set(paneId, { kind: "worker", instanceId: instance.id, workerName: instance.name, generation: instance.generation });
    }
    const directories = new Set(this.listSpaces(project.id)[0]!.directories);
    return (await this.options.herdr.listPanes(project.workspaceId))
      .filter((pane) => pane.workspaceId === project.workspaceId && (ownership.has(pane.paneId) || (pane.cwd !== null && directories.has(pane.cwd))))
      .map((pane): PrimaryTopologyPane => ({
        paneId: pane.paneId,
        paneToken: pane.paneToken ?? null,
        name: pane.label ?? pane.paneName ?? "",
        workspaceId: pane.workspaceId,
        cwd: pane.cwd,
        agentKind: pane.agentKind ?? null,
        agentState: pane.agentState,
        foregroundExecutables: [...pane.foregroundExecutables],
        ownership: ownership.get(pane.paneId) ?? null
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.paneId.localeCompare(right.paneId));
  }

  private project(projectId: string): ProjectConfig {
    const project = this.options.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Primary topology project ${projectId} is not configured`);
    return project;
  }
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
