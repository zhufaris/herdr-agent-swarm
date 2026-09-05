import { describe, expect, it } from "vitest";
import { SwarmCommandContextResolver } from "../src/coordinator/swarm-command-context-resolver.js";

const project = { id: "project", displayName: "Project", spaceName: "space", description: "project", workspaceId: "w1", cwd: "/repo", maxInstances: 4 };
const message = { eventId: "event", messageId: "message", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "admin", text: "", mentionsBot: true, isRootMessage: false };
const binding = { id: "binding", creatorOpenId: "admin", projectId: "project", workspaceId: "w1", paneId: "w1:p1", traexSessionId: "terminal", agentSessionSource: "herdr:codex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "native", generation: 3 } as never;

function resolver(current: typeof binding | null = binding) {
  return new SwarmCommandContextResolver({ config: { projects: [project], defaultProjectId: "project", lark: { adminOpenIds: ["admin"] } as never }, store: { findBindingByLarkScope: () => current, getBinding: (id: string) => id === binding.id ? binding : null }, activeTurn: () => ({ promptId: "prompt", paneId: "w1:p1" }) });
}

describe("SwarmCommandContextResolver", () => {
  it("freezes Primary generation and both runtime identity dimensions", () => {
    expect(resolver().resolve(message, { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false })).toEqual({
      outcome: "resolved", laneKey: "binding:binding", context: expect.objectContaining({ projectId: "project", workspaceId: "w1", primary: { bindingId: "binding", bindingGeneration: 3, paneId: "w1:p1", terminalId: "terminal", nativeSession: { source: "herdr:codex", agent: "traex", kind: "id", value: "native" }, activePromptId: null } })
    });
  });

  it("resolves project scope and leaves global queries unbound", () => {
    expect(resolver(null).resolve(message, { kind: "attach", spaceName: "space", paneId: "w1:p1" })).toMatchObject({ outcome: "resolved", laneKey: "project:project", context: { projectId: "project", workspaceId: "w1", primary: null } });
    expect(resolver(null).resolve(message, { kind: "help" })).toMatchObject({ outcome: "resolved", laneKey: "chat:chat", context: { projectId: null, primary: null } });
  });

  it.each([
    [{ kind: "help" }, "global", "chat:chat"],
    [{ kind: "projects" }, "global", "chat:chat"],
    [{ kind: "spaces" }, "project", "project:project"],
    [{ kind: "sessions" }, "global", "chat:chat"],
    [{ kind: "failures" }, "global", "chat:chat"],
    [{ kind: "status" }, "primary-session", "binding:binding"],
    [{ kind: "new", title: null }, "global", "chat:chat"],
    [{ kind: "reset", title: null }, "primary-session", "binding:binding"],
    [{ kind: "attach", spaceName: "space", paneId: "w1:p2" }, "project", "project:project"],
    [{ kind: "rename", title: "name" }, "primary-session", "binding:binding"],
    [{ kind: "close" }, "primary-session", "binding:binding"],
    [{ kind: "pane_close_request" }, "primary-session", "binding:binding"],
    [{ kind: "pane_close_confirm", code: "ABC" }, "primary-session", "binding:binding"],
    [{ kind: "reattach", paneId: "w1:p2" }, "primary-session", "binding:binding"],
    [{ kind: "replace" }, "primary-session", "binding:binding"],
    [{ kind: "resume" }, "primary-session", "binding:binding"],
    [{ kind: "awake" }, "active-turn", "binding:binding"],
    [{ kind: "stop" }, "active-turn", "binding:binding"],
    [{ kind: "steer", text: "focus" }, "active-turn", "binding:binding"],
    [{ kind: "model", name: null }, "primary-session", "binding:binding"],
    [{ kind: "model", name: "gpt" }, "primary-session", "binding:binding"],
    [{ kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false }, "primary-session", "binding:binding"]
  ] as const)("resolves the declared context for %j", (command, scope, expectedLane) => {
    const result = resolver().resolve(message, command);
    expect(result).toMatchObject({ outcome: "resolved", laneKey: expectedLane });
    if (result.outcome !== "resolved") return;
    expect(result.context.primary === null).toBe(scope === "global" || scope === "project");
    expect(result.context.projectId === null).toBe(scope === "global");
  });

  it("enforces administrator and creator policy before dispatch", () => {
    expect(resolver().resolve({ ...message, actorOpenId: "member" }, { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false })).toMatchObject({ outcome: "rejected", code: "administrator_required" });
    expect(resolver({ ...binding, creatorOpenId: "creator" } as never).resolve(message, { kind: "rename", title: "name" })).toMatchObject({ outcome: "rejected", code: "creator_required" });
  });

  it("rejects session-scoped commands outside a bound topic", () => {
    expect(resolver(null).resolve(message, { kind: "status" })).toMatchObject({ outcome: "rejected", code: "binding_required" });
  });

  it("uses the explicit CardKit binding instead of an unrelated scope lookup", () => {
    const unrelated = { ...binding, id: "other", paneId: "w1:other" };
    const explicit = resolver(unrelated as never).resolve(message, { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false }, binding.id);
    expect(explicit).toMatchObject({ outcome: "resolved", laneKey: "binding:binding", context: { primary: { bindingId: "binding", paneId: "w1:p1" } } });
  });

  it("freezes the active prompt only for active-turn commands", () => {
    expect(resolver().resolve(message, { kind: "stop" })).toMatchObject({ outcome: "resolved", context: { primary: { activePromptId: "prompt" } } });
    expect(resolver().resolve(message, { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false })).toMatchObject({ outcome: "resolved", context: { primary: { activePromptId: null } } });
  });
});
