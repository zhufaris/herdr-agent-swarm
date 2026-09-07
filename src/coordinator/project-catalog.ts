import { projectSpaceName } from "../config.js";
import type { Binding, ProjectConfig } from "../domain/types.js";

type BindingProjectRoute = Pick<Binding, "projectId" | "workspaceId">;

export class ProjectCatalog {
  private readonly byId: ReadonlyMap<string, ProjectConfig>;
  private readonly bySpaceName: ReadonlyMap<string, readonly ProjectConfig[]>;
  private readonly byExplicitSpaceName: ReadonlyMap<string, readonly ProjectConfig[]>;
  private readonly byWorkspace: ReadonlyMap<string, readonly ProjectConfig[]>;
  private readonly byWorkspaceAndCwd: ReadonlyMap<string, readonly ProjectConfig[]>;

  constructor(readonly projects: readonly ProjectConfig[]) {
    this.byId = new Map(projects.map((project) => [project.id, project]));
    this.bySpaceName = groupProjects(projects, (project) => projectSpaceName(project));
    this.byExplicitSpaceName = groupProjects(projects.filter((project) => project.spaceName), (project) => project.spaceName!);
    this.byWorkspace = groupProjects(projects, (project) => project.workspaceId);
    this.byWorkspaceAndCwd = groupProjects(projects, (project) => workspaceCwdKey(project.workspaceId, project.cwd));
  }

  projectById(projectId: string): ProjectConfig | undefined {
    return this.byId.get(projectId);
  }

  projectsForSpaceName(spaceName: string): readonly ProjectConfig[] {
    return this.bySpaceName.get(spaceName) ?? [];
  }

  projectsForExplicitSpaceName(spaceName: string): readonly ProjectConfig[] {
    return this.byExplicitSpaceName.get(spaceName) ?? [];
  }

  projectForWorkspaceAndCwd(workspaceId: string, cwd: string | null | undefined): ProjectConfig | undefined {
    return unique(this.byWorkspaceAndCwd.get(workspaceCwdKey(workspaceId, cwd)));
  }

  projectForBinding(binding: BindingProjectRoute): ProjectConfig | undefined {
    if (binding.projectId) return this.projectById(binding.projectId);
    return unique(this.byWorkspace.get(binding.workspaceId));
  }

  spaceNameForBinding(binding: BindingProjectRoute): string {
    const project = this.projectForBinding(binding);
    return project ? projectSpaceName(project) : "legacy/unresolved";
  }
}

function groupProjects(projects: readonly ProjectConfig[], keyFor: (project: ProjectConfig) => string): ReadonlyMap<string, readonly ProjectConfig[]> {
  const grouped = new Map<string, ProjectConfig[]>();
  for (const project of projects) {
    const key = keyFor(project);
    grouped.set(key, [...(grouped.get(key) ?? []), project]);
  }
  return grouped;
}

function unique(projects: readonly ProjectConfig[] | undefined): ProjectConfig | undefined {
  return projects?.length === 1 ? projects[0] : undefined;
}

function workspaceCwdKey(workspaceId: string, cwd: string | null | undefined): string {
  return `${workspaceId}\u0000${cwd ?? ""}`;
}
