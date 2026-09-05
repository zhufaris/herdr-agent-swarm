import { describe, expect, it } from "vitest";
import { SwarmCommandContextResolver } from "../src/coordinator/swarm-command-context-resolver.js";

const project = { id: "project", displayName: "Project", spaceName: "space", description: "project", workspaceId: "w1", cwd: "/repo", maxInstances: 4 };
const message = { eventId: "event", messageId: "message", parentMessageId: null, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "admin", text: "", mentionsBot: true, isRootMessage: false };
const binding = { id: "binding", creatorOpenId: "admin", projectId: "project", workspaceId: "w1", paneId: "w1:p1", traexSessionId: "terminal", agentSessionSource: "herdr:codex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "native", generation: 3 } as never;

function resolver(current: typeof binding | null = binding) {
  return new SwarmCommandContextResolver({ config: { projects: [project], defaultProjectId: "project", lark: { adminOpenIds: ["admin"] } as never }, store: { findBindingByLarkScope: () => current }, activeTurn: () => ({ promptId: "prompt", paneId: "w1:p1" }) });
}

describe("SwarmCommandContextResolver", () => {
  it("freezes Primary generation and both runtime identity dimensions", () => {
    expect(resolver().resolve(message, { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false })).toEqual({
      outcome: "resolved", laneKey: "binding:binding", context: expect.objectContaining({ projectId: "project", workspaceId: "w1", primary: { bindingId: "binding", bindingGeneration: 3, paneId: "w1:p1", terminalId: "terminal", nativeSession: { source: "herdr:codex", agent: "traex", kind: "id", value: "native" }, activePromptId: "prompt" } })
    });
  });

  it("resolves project scope and leaves global queries unbound", () => {
    expect(resolver(null).resolve(message, { kind: "attach", spaceName: "space", paneId: "w1:p1" })).toMatchObject({ outcome: "resolved", laneKey: "project:project", context: { projectId: "project", workspaceId: "w1", primary: null } });
    expect(resolver(null).resolve(message, { kind: "help" })).toMatchObject({ outcome: "resolved", laneKey: "chat:chat", context: { projectId: null, primary: null } });
  });

  it("enforces administrator and creator policy before dispatch", () => {
    expect(resolver().resolve({ ...message, actorOpenId: "member" }, { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false })).toMatchObject({ outcome: "rejected", code: "administrator_required" });
    expect(resolver({ ...binding, creatorOpenId: "creator" } as never).resolve(message, { kind: "rename", title: "name" })).toMatchObject({ outcome: "rejected", code: "creator_required" });
  });

  it("rejects session-scoped commands outside a bound topic", () => {
    expect(resolver(null).resolve(message, { kind: "status" })).toMatchObject({ outcome: "rejected", code: "binding_required" });
  });
});
