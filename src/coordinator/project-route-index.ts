import { projectSpaceName } from "../config.js";
import type { Binding, ProjectConfig } from "../domain/types.js";

type BindingProjectRoute = Pick<Binding, "projectId" | "workspaceId">;

export class ProjectRouteIndex {
  private readonly projectsById: ReadonlyMap<string, ProjectConfig>;
  private readonly uniqueProjectByWorkspace: ReadonlyMap<string, ProjectConfig | null>;

  constructor(projects: readonly ProjectConfig[]) {
    this.projectsById = new Map(projects.map((project) => [project.id, project]));
    const uniqueProjectByWorkspace = new Map<string, ProjectConfig | null>();
    for (const project of projects) {
      uniqueProjectByWorkspace.set(
        project.workspaceId,
        uniqueProjectByWorkspace.has(project.workspaceId) ? null : project
      );
    }
    this.uniqueProjectByWorkspace = uniqueProjectByWorkspace;
  }

  projectById(projectId: string): ProjectConfig | undefined {
    return this.projectsById.get(projectId);
  }

  projectForBinding(binding: BindingProjectRoute): ProjectConfig | undefined {
    if (binding.projectId) return this.projectById(binding.projectId);
    return this.uniqueProjectByWorkspace.get(binding.workspaceId) ?? undefined;
  }

  spaceNameForBinding(binding: BindingProjectRoute): string {
    const project = this.projectForBinding(binding);
    return project ? projectSpaceName(project) : "legacy/unresolved";
  }
}
