import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/domain/types.js";
import { ProjectRouteIndex } from "../src/coordinator/project-route-index.js";

const projects: ProjectConfig[] = [
  { id: "alpha", displayName: "Alpha", spaceName: "alpha-space", description: "Alpha project", workspaceId: "shared", cwd: "/repos/alpha" },
  { id: "beta", displayName: "Beta", description: "Beta project", workspaceId: "shared", cwd: "/repos/beta" },
  { id: "gamma", displayName: "Gamma", description: "Gamma project", workspaceId: "unique", cwd: "/repos/gamma" }
];

describe("ProjectRouteIndex", () => {
  const routes = new ProjectRouteIndex(projects);

  it("looks up configured projects by ID", () => {
    expect(routes.projectById("alpha")).toBe(projects[0]);
    expect(routes.projectById("missing")).toBeUndefined();
  });

  it("gives a valid project ID precedence over the binding workspace", () => {
    expect(routes.projectForBinding({ projectId: "alpha", workspaceId: "unique" })).toBe(projects[0]);
    expect(routes.spaceNameForBinding({ projectId: "alpha", workspaceId: "unique" })).toBe("alpha-space");
  });

  it("falls back to a uniquely configured workspace", () => {
    expect(routes.projectForBinding({ projectId: null, workspaceId: "unique" })).toBe(projects[2]);
    expect(routes.spaceNameForBinding({ projectId: null, workspaceId: "unique" })).toBe("gamma");
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
});
