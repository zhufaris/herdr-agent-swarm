import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/domain/types.js";
import { ProjectCatalog } from "../src/coordinator/project-catalog.js";

const projects: ProjectConfig[] = [
  { id: "alpha", displayName: "Alpha", spaceName: "alpha-space", description: "Alpha project", workspaceId: "shared", cwd: "/repos/alpha", orchestrator: { enabled: true, cwd: "/repos" } },
  { id: "beta", displayName: "Beta", description: "Beta project", workspaceId: "shared", cwd: "/repos/beta" },
  { id: "gamma", displayName: "Gamma", description: "Gamma project", workspaceId: "unique", cwd: "/repos/gamma" }
];

describe("ProjectCatalog", () => {
  const routes = new ProjectCatalog(projects);

  it("derives one complete Run Projection Context from a binding", () => {
    expect(routes.runProjectionContextForBinding({
      id: "binding", projectId: "alpha", workspaceId: "shared", paneId: "shared:p1", paneToken: "yx0c",
      title: "Primary", agentKind: "traex", generation: 3
    } as never)).toEqual({
      bindingId: "binding", bindingGeneration: 3, sessionTitle: "Primary", agentKind: "traex",
      workspaceId: "shared", spaceName: "alpha-space", paneId: "shared:p1", paneToken: "yx0c"
    });
  });

  it("looks up configured projects by ID", () => {
    expect(routes.projectById("alpha")).toBe(projects[0]);
    expect(routes.projectById("missing")).toBeUndefined();
  });

  it("gives a valid project ID precedence over the binding workspace", () => {
    expect(routes.projectForBinding({ projectId: "alpha", workspaceId: "unique" })).toBe(projects[0]);
    expect(routes.spaceNameForBinding({ projectId: "alpha", workspaceId: "unique" })).toBe("alpha-space");
  });

  it("uses the configured Orchestrator directory only for Orchestrator bindings", () => {
    expect(routes.projectForBinding({ kind: "orchestrator", projectId: "alpha", workspaceId: "shared" })).toMatchObject({ id: "alpha", cwd: "/repos" });
    expect(routes.projectForBinding({ kind: "task", projectId: "alpha", workspaceId: "shared" })).toBe(projects[0]);
  });

  it("falls back to a uniquely configured workspace", () => {
    expect(routes.projectForBinding({ projectId: null, workspaceId: "unique" })).toBe(projects[2]);
    expect(routes.spaceNameForBinding({ projectId: null, workspaceId: "unique" })).toBe("herdr");
  });

  it("does not retarget a stale project ID through the workspace", () => {
    expect(routes.projectForBinding({ projectId: "retired", workspaceId: "unique" })).toBeUndefined();
    expect(routes.spaceNameForBinding({ projectId: "retired", workspaceId: "unique" })).toBe("legacy/unresolved");
  });

  it("does not guess when a workspace is ambiguous", () => {
    expect(routes.projectForBinding({ projectId: null, workspaceId: "shared" })).toBeUndefined();
    expect(routes.spaceNameForBinding({ projectId: null, workspaceId: "shared" })).toBe("legacy/unresolved");
  });

  it("does not resolve an unknown workspace", () => {
    expect(routes.projectForBinding({ projectId: null, workspaceId: "missing" })).toBeUndefined();
    expect(routes.spaceNameForBinding({ projectId: null, workspaceId: "missing" })).toBe("legacy/unresolved");
  });

  it("resolves only unique space names", () => {
    expect(routes.projectsForSpaceName("alpha-space")).toEqual([projects[0]]);
    expect(routes.projectsForSpaceName("herdr")).toEqual([projects[1], projects[2]]);
    expect(routes.projectsForSpaceName("missing")).toEqual([]);
  });

  it("keeps explicit attachment names separate from display-name fallbacks", () => {
    expect(routes.projectsForExplicitSpaceName("alpha-space")).toEqual([projects[0]]);
    expect(routes.projectsForExplicitSpaceName("herdr")).toEqual([projects[1], projects[2]]);
    expect(routes.projectsForExplicitSpaceName("gamma")).toEqual([]);
  });

  it("resolves only unique workspace and cwd routes", () => {
    expect(routes.projectForWorkspaceAndCwd("shared", "/repos/beta")).toBe(projects[1]);
    expect(routes.projectForWorkspaceAndCwd("shared", "/repos/missing")).toBeUndefined();
  });

  it("returns the indexed route bucket for diagnostics without rescanning projects", () => {
    const duplicate = { ...projects[1]!, id: "beta-copy" };
    const indexed = new ProjectCatalog([...projects, duplicate]);

    expect(indexed.projectsForWorkspaceAndCwd("shared", "/repos/beta")).toEqual([projects[1], duplicate]);
    expect(indexed.projectsForWorkspaceAndCwd("missing", "/repos/beta")).toEqual([]);
  });
});
