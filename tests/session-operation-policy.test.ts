import { describe, expect, it } from "vitest";
import { sessionOperationRejection, UNSUPPORTED_RUNTIME_MODEL_MESSAGE } from "../src/domain/session-operation-policy.js";
import type { Binding, SessionOperationKind } from "../src/domain/types.js";

const active = {
  id: "b1", creatorOpenId: "creator", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root",
  retiredTopicId: null, retiredRootMessageId: null, replacesBindingId: null, reservedTopicId: null, reservedRootMessageId: null, resetMessageId: null,
  paneId: "w1:p1", traexSessionId: "terminal-1", title: "Task", runtime: "traex", state: "active", statusMessageId: "root", statusCardSequence: 0,
  lastAgentState: "idle", lastOutputFingerprint: null, lifecycle: "active", attachment: "attached", generation: 1, provisioningCheckpoint: "activated",
  degradationCount: 0, hasCompletedTurn: false, lastObservedAt: null, archivedAt: null, lastActivityAt: "now", createdAt: "now", updatedAt: "now"
} satisfies Binding;

describe("Session operation policy", () => {
  it.each(["stop", "reset", "rename", "pane_close", "archive"] satisfies SessionOperationKind[])("allows %s for an active attached Session", (kind) => {
    expect(sessionOperationRejection(active, kind)).toBeNull();
  });

  it("allows only recovery operations for an orphaned Session", () => {
    const orphaned = { ...active, state: "orphaned", attachment: "orphaned" } satisfies Binding;
    expect(sessionOperationRejection(orphaned, "reattach")).toBeNull();
    expect(sessionOperationRejection(orphaned, "replace")).toBeNull();
    expect(sessionOperationRejection(orphaned, "stop")).toMatch(/active Session with a Pane/);
  });

  it("keeps degraded stop, reset, and rename eligible but requires attachment for Pane closure", () => {
    const degraded = { ...active, attachment: "degraded" } satisfies Binding;
    expect(sessionOperationRejection(degraded, "stop")).toBeNull();
    expect(sessionOperationRejection(degraded, "reset")).toBeNull();
    expect(sessionOperationRejection(degraded, "rename")).toBeNull();
    expect(sessionOperationRejection(degraded, "pane_close")).toMatch(/active Session with a Pane/);
  });

  it("allows resume only for an archived Session retaining its Pane", () => {
    expect(sessionOperationRejection({ ...active, state: "archived", lifecycle: "archived" }, "resume")).toBeNull();
    expect(sessionOperationRejection(active, "resume")).toMatch(/archived Session/);
    expect(sessionOperationRejection({ ...active, state: "archived", lifecycle: "archived", paneId: null }, "resume")).toMatch(/retained Pane/);
  });

  it("always rejects runtime model selection", () => {
    expect(sessionOperationRejection(active, "model")).toBe(UNSUPPORTED_RUNTIME_MODEL_MESSAGE);
  });
});
