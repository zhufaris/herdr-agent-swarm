import { describe, expect, it } from "vitest";
import { requireMatchingPane } from "../src/coordinator/pane-runtime-identity.js";
import { ProjectCatalog } from "../src/coordinator/project-catalog.js";

const project = { id: "project", displayName: "Project", description: "project", workspaceId: "w1", cwd: "/repo" };
const binding = { id: "b1", projectId: "project", workspaceId: "w1", paneId: "w1:p1", traexSessionId: "terminal-1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" } as never;
const pane = (overrides: Record<string, unknown> = {}) => ({ paneId: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", cwd: "/repo", agentState: "idle", foregroundExecutables: ["traex"], ...overrides });
const projects = new ProjectCatalog([project]);

describe("pane runtime identity", () => {
  it("restores a durable native session when a matching runtime observation omits it", async () => {
    const result = await requireMatchingPane({ observeRuntime: async () => ({ pane: pane(), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, binding, "w1:p1");
    expect(result.agentSession).toEqual({ source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" });
  });

  it("fails closed when a reported native session conflicts with the durable identity", async () => {
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: pane({ agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "other" } }), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, binding, "w1:p1"))
      .rejects.toThrow(/session identity changed/);
  });

  it("rejects retired shim sessions", async () => {
    const aliased = { ...binding, agentSessionSource: "herdr:codex" } as never;
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: pane({ agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" } }), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, aliased, "w1:p1"))
      .rejects.toThrow(/session identity changed/);
  });

  it("rejects a native Herdr TraeX source for a legacy binding", async () => {
    const legacy = { ...binding, agentSessionSource: "herdr:codex" } as never;
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: pane({ agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } }), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, legacy, "w1:p1"))
      .rejects.toThrow(/session identity changed/);
  });

  it("does not treat arbitrary reporter sources as aliases", async () => {
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: pane({ agentSession: { source: "other-reporter", agent: "traex", kind: "id", value: "session-1" } }), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, binding, "w1:p1"))
      .rejects.toThrow(/session identity changed/);
  });

  it("does not use durable session restoration to bypass a terminal identity mismatch", async () => {
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: pane({ terminalId: "terminal-2" }), traexProcess: true, composerReady: true, evidenceSource: "structured" }) } as never, projects, binding, "w1:p1"))
      .rejects.toThrow(/pane identity changed/);
  });

  it("accepts only the exact persisted non-TraeX Agent kind and session", async () => {
    const piBinding = { ...binding, agentKind: "pi", agentSessionSource: "herdr:pi", agentSessionAgent: "pi", agentSessionValue: "pi-session" } as never;
    const matching = pane({ foregroundExecutables: ["pi"], agentKind: "pi", agentSession: { source: "herdr:pi", agent: "pi", kind: "id", value: "pi-session" } });

    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: matching, traexProcess: false, composerReady: false, evidenceSource: "structured" }) } as never, projects, piBinding, "w1:p1"))
      .resolves.toMatchObject({ agentKind: "pi" });
    await expect(requireMatchingPane({ observeRuntime: async () => ({ pane: { ...matching, agentKind: "codex" }, traexProcess: false, composerReady: false, evidenceSource: "structured" }) } as never, projects, piBinding, "w1:p1"))
      .rejects.toThrow(/Agent kind changed/);
  });
});
