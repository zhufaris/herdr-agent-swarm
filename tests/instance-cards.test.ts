import { describe, expect, it } from "vitest";
import { renderInstanceDirectoryCard } from "../src/cards/instance-directory-card.js";
import { renderInstanceDetailCard } from "../src/cards/instance-detail-card.js";
import { renderInstanceCreateCard, renderInstanceRemovalPlanCard, renderInstanceSteerCard } from "../src/cards/instance-control-card.js";

const instance = { id: "i1", projectId: "p1", name: "reviewer", role: "worker" as const, agentKind: "claude-code" as const, model: "sonnet", desiredState: "running" as const, observedState: "idle" as const, workspaceLeaseId: "ws1", generation: 2, runtimeRef: { herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "s1", generation: 2 }, pendingRuntimeRef: null, provisioningCheckpoint: "verified" as const, lastError: null };
const workspace = { id: "ws1", projectId: "p1", instanceId: "i1", kind: "git-worktree" as const, cwd: "/repo/.worktree/reviewer", branch: "swarm/reviewer", baseCommit: "abc123", state: "ready" as const, generation: 1 };
const capabilities = { available: true, structuredEvents: true, nativeResume: true, primaryTools: false, steering: "unsupported" as const, interrupt: "terminal-signal" as const, approvals: "terminal" as const, modelSelection: "startup-only" as const, usageReporting: true };

describe("instance cards", () => {
  it("renders project primary, selected target, queue and worktree evidence", () => {
    const primary = { ...instance, id: "primary", name: "lead", role: "primary" as const };
    const card = renderInstanceDirectoryCard({ project: { id: "p1", displayName: "Product", description: "x", workspaceId: "w1", cwd: "/repo" }, entries: [{ instance: primary, workspace: { ...workspace, instanceId: "primary", kind: "main-checkout", cwd: "/repo", branch: null }, capabilities, queueDepth: 1 }, { instance, workspace, capabilities, queueDepth: 3 }], target: { kind: "instance", instanceId: "i1" } });
    const text = JSON.stringify(card);
    expect(text).toContain("PRIMARY"); expect(text).toContain("lead"); expect(text).toContain("TARGET"); expect(text).toContain("reviewer"); expect(text).toContain("queue 3"); expect(text).toContain("swarm/reviewer");
  });
  it("bounds a large instance directory and summarizes omitted rows", () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({ instance: { ...instance, id: `i${index}`, name: `worker-${index}-${"x".repeat(100)}` }, workspace: { ...workspace, id: `ws${index}`, instanceId: `i${index}` }, capabilities, queueDepth: index }));
    const card = renderInstanceDirectoryCard({ project: { id: "p1", displayName: "Product", description: "x", workspaceId: "w1", cwd: "/repo" }, entries, target: { kind: "primary" } });
    const serialized = JSON.stringify(card);
    expect(serialized.length).toBeLessThanOrEqual(12_000);
    expect(serialized).toMatch(/另有 \d+ 个实例未在本卡展示/);
    expect(serialized).not.toContain("worker\-199");
    expect(entries).toHaveLength(200);
  });
  it("shows runtime and Git evidence but hides unsupported steering controls", () => {
    const text = JSON.stringify(renderInstanceDetailCard({ instance, workspace, capabilities, turns: [], queueDepth: 0 }));
    expect(text).toContain("w1:p1"); expect(text).toContain("abc123"); expect(text).toContain("claude-code"); expect(text).not.toContain("instance_steer_form");
  });

  it("renders actor-bound create and steer forms with CardKit submit behaviors", () => {
    const create = JSON.stringify(renderInstanceCreateCard({ projectId: "p1", requestedBy: "u1" }));
    const steer = JSON.stringify(renderInstanceSteerCard({ instance, requestedBy: "u1" }));
    expect(create).toContain('\"action\":\"instance_create_submit\"');
    expect(create).toContain('\"projectId\":\"p1\"');
    expect(create).toContain('\"requestedBy\":\"u1\"');
    expect(create).toContain('\"form_action_type\":\"submit\"');
    expect(steer).toContain('\"action\":\"instance_steer_submit\"');
    expect(steer).toContain('\"generation\":2');
  });

  it("shows destructive confirmation only for a safe fresh removal plan", () => {
    const safe = JSON.stringify(renderInstanceRemovalPlanCard({ instance, workspace, plan: { id: "plan-1", instanceId: "i1", instanceGeneration: 2, workspaceGeneration: 1, worktreeFingerprint: "clean-fp", safe: true, reason: "clean", state: "pending", createdAt: "now" }, requestedBy: "u1" }));
    const dirty = JSON.stringify(renderInstanceRemovalPlanCard({ instance, workspace: { ...workspace, state: "dirty" }, plan: { id: "plan-2", instanceId: "i1", instanceGeneration: 2, workspaceGeneration: 1, worktreeFingerprint: "dirty-fp", safe: false, reason: "dirty", state: "pending", createdAt: "now" }, requestedBy: "u1" }));
    expect(safe).toContain("instance_confirm_removal");
    expect(safe).toContain("clean-fp");
    expect(dirty).toContain("dirty-fp");
    expect(dirty).toContain("已保留");
    expect(dirty).not.toContain("instance_confirm_removal");
  });
});
