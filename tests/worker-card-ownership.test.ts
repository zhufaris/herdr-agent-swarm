import { describe, expect, it } from "vitest";
import type { AgentInstance } from "../src/domain/agent-instance.js";
import type { InstanceTurn } from "../src/domain/instance-turn.js";
import type { Binding } from "../src/domain/types.js";
import { decideWorkerCardBindingOwnership, decideWorkerMainCardOwnership, decideWorkerTaskCardOwnership } from "../src/domain/worker-card-ownership.js";
import type { WorkerMainView } from "../src/domain/worker-main-view.js";
import type { WorkerTurnCardView } from "../src/domain/worker-turn-card-view.js";

describe("Worker card ownership policy", () => {
  it("accepts an exact Worker Task identity", () => {
    expect(decideWorkerTaskCardOwnership(taskInput())).toEqual({ allowed: true });
  });

  it.each([
    ["card message", { sourceCardMessageId: "other" }, "stale_card"],
    ["instance generation", { expectedInstanceGeneration: 2 }, "stale_instance"],
    ["Worker session", { expectedWorkerSessionGeneration: 2 }, "stale_worker_session"],
    ["chat ownership", { chatId: "other" }, "wrong_owner"]
  ] as const)("rejects a stale Worker Task %s", (_label, patch, reason) => {
    expect(decideWorkerTaskCardOwnership({ ...taskInput(), ...patch })).toEqual({ allowed: false, reason });
  });

  it("rejects a Worker Task after its parent generation changes", () => {
    const input = taskInput();
    expect(decideWorkerTaskCardOwnership({ ...input, binding: { ...input.binding!, generation: 2 } })).toEqual({ allowed: false, reason: "inactive_parent" });
  });

  it("accepts an exact actionable Worker Main identity", () => {
    expect(decideWorkerMainCardOwnership(mainInput())).toEqual({ allowed: true });
  });

  it("distinguishes ownership from action availability on Worker Main", () => {
    const input = mainInput();
    const view = { ...input.view!, frozenAt: "2026-09-06T00:00:00.000Z" };
    expect(decideWorkerMainCardOwnership({ ...input, view })).toEqual({ allowed: false, reason: "action_unavailable" });
    expect(decideWorkerMainCardOwnership({ ...input, view, requireTaskSubmission: false })).toEqual({ allowed: true });
  });

  it("rejects a stable-card callback after the current turn changes", () => {
    const input = mainInput();
    const view = { ...input.view!, currentTask: { turnId: "new-turn" } } as WorkerMainView;
    expect(decideWorkerMainCardOwnership({ ...input, view, expectedTurnId: "old-turn", requireTaskSubmission: false })).toEqual({ allowed: false, reason: "stale_card" });
    expect(decideWorkerMainCardOwnership({ ...input, view, expectedTurnId: "new-turn", requireTaskSubmission: false })).toEqual({ allowed: true });
  });

  it("validates optional binding context fences", () => {
    const binding = activeBinding();
    const base = { chatId: "chat", bindingId: binding.id, bindingGeneration: binding.generation, parentPaneId: binding.paneId!, binding };
    expect(decideWorkerCardBindingOwnership({ ...base, conversationKey: "binding:binding", suppliedBindingId: "binding", suppliedBindingGeneration: 1 })).toEqual({ allowed: true });
    expect(decideWorkerCardBindingOwnership({ ...base, suppliedBindingGeneration: 2 })).toEqual({ allowed: false, reason: "inactive_parent" });
  });
});

function taskInput(): Parameters<typeof decideWorkerTaskCardOwnership>[0] {
  const instance = worker();
  const turn = { id: "turn", projectId: "project", instanceId: instance.id, instanceGeneration: 1 } as InstanceTurn;
  const view = { turnId: turn.id, instanceId: instance.id, instanceGeneration: 1, workerSessionGeneration: 1, messageId: "task-card" } as WorkerTurnCardView;
  return { chatId: "chat", actionMessageId: "task-card", sourceCardMessageId: "task-card", expectedInstanceGeneration: 1, expectedWorkerSessionGeneration: 1, instance, turn, view, binding: activeBinding() };
}

function mainInput(): Parameters<typeof decideWorkerMainCardOwnership>[0] {
  const instance = worker();
  const view = {
    workerId: instance.id, workerSessionGeneration: 1, parentBindingId: "binding", parentBindingGeneration: 1, parentPaneId: "primary-pane",
    runtimeGeneration: 1, runtimeState: "idle", runtimeAttached: true, desiredState: "running", parentActive: true, messageId: "main-card", frozenAt: null
  } as WorkerMainView;
  return { chatId: "chat", actionMessageId: "main-card", sourceCardMessageId: "main-card", expectedInstanceGeneration: 1, expectedWorkerSessionGeneration: 1, instance, view, binding: activeBinding() };
}

function worker(): AgentInstance {
  return {
    id: "worker", projectId: "project", name: "worker", role: "worker", agentKind: "traex", model: null, sourcePrimaryPaneLabel: null,
    parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: null }, workerSessionLifecycle: "active",
    workerSessionGeneration: 1, desiredState: "running", observedState: "idle", workspaceLeaseId: "workspace", generation: 1,
    runtimeRef: { herdrWorkspaceId: "herdr", paneId: "worker-pane", nativeSessionId: "session", generation: 1 }, pendingRuntimeRef: null, provisioningCheckpoint: "verified", lastError: null
  };
}

function activeBinding(): Binding {
  return {
    id: "binding", creatorOpenId: "user", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", retiredTopicId: null, retiredRootMessageId: null, replacesBindingId: null, reservedTopicId: null, reservedRootMessageId: null, resetMessageId: null, paneId: "primary-pane", traexSessionId: "terminal", agentSessionSource: null, agentSessionAgent: null, agentSessionKind: null, agentSessionValue: null, title: "Primary", runtime: "traex", state: "active", statusMessageId: "main", statusCardSequence: 1, lastAgentState: "idle", lastOutputFingerprint: null, lifecycle: "active", attachment: "attached", generation: 1, provisioningCheckpoint: "active", degradationCount: 0, hasCompletedTurn: false, lastObservedAt: null, archivedAt: null, lastActivityAt: "2026-09-06T00:00:00.000Z", createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z"
  };
}
