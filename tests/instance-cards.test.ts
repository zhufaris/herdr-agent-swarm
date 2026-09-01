import { describe, expect, it } from "vitest";
import { renderInstanceDirectoryCard } from "../src/cards/instance-directory-card.js";
import { renderInstanceDetailCard } from "../src/cards/instance-detail-card.js";
import { renderInstanceCreateCard, renderInstanceRemovalPlanCard, renderInstanceSteerCard } from "../src/cards/instance-control-card.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { createQueuedWorkerTurnCard, reduceWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";

const instance = { id: "i1", projectId: "p1", name: "reviewer", role: "worker" as const, agentKind: "claude-code" as const, model: "sonnet", desiredState: "running" as const, observedState: "idle" as const, workspaceLeaseId: "ws1", generation: 2, runtimeRef: { herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "s1", generation: 2 }, pendingRuntimeRef: null, provisioningCheckpoint: "verified" as const, lastError: null };
const workspace = { id: "ws1", projectId: "p1", instanceId: "i1", kind: "git-worktree" as const, cwd: "/repo/.worktree/reviewer", branch: "swarm/reviewer", baseCommit: "abc123", state: "ready" as const, generation: 1 };
const capabilities = { available: true, structuredEvents: true, nativeResume: true, primaryTools: false, steering: "unsupported" as const, interrupt: "terminal-signal" as const, approvals: "terminal" as const, modelSelection: "startup-only" as const, usageReporting: true };
const primary = { bindingId: "binding-1", generation: 3, paneId: "w1:p0", state: "active" as const };

describe("instance cards", () => {
  it.each(["queued", "preparing", "running", "blocked", "completed", "failed", "cancelled", "dispatch-uncertain"] as const)("renders a bounded and actionable %s Worker task card", (phase) => {
    const queued = createQueuedWorkerTurnCard({ turnId: "turn:unsafe/id", instanceId: "i1", instanceGeneration: 2, workerName: "reviewer", parentTurnId: "parent-turn", rootMessageId: "root-1", requestText: `review ${"x".repeat(4_000)}`, queuePosition: 3, occurredAt: "2026-09-01T00:00:00.000Z" });
    const view = { ...queued, phase, answer: phase === "completed" ? "final finding" : "", notice: ["blocked", "failed", "cancelled", "dispatch-uncertain"].includes(phase) ? "Bearer live-secret" : null, resultCapture: phase === "completed" ? "captured" as const : "pending" as const };
    const card = renderWorkerTurnCard(view);
    const text = JSON.stringify(card);

    expect(card).toMatchObject({ schema: "2.0", config: { update_multi: true }, body: { elements: expect.any(Array) } });
    expect(text).toContain("reviewer · Task turn:uns");
    expect(text).toContain("parent-turn");
    expect(text).toContain("View Worker");
    expect(text).toContain('\"instanceId\":\"i1\"');
    expect(text).toContain('\"instanceGeneration\":2');
    expect(text).not.toContain("live-secret");
    expect(text.length).toBeLessThan(12_000);
    expect(queued.elementId).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  });

  it("states explicitly when a completed Worker result could not be captured", () => {
    const queued = createQueuedWorkerTurnCard({ turnId: "turn-a", instanceId: "i1", instanceGeneration: 2, workerName: "reviewer", parentTurnId: null, rootMessageId: "root-1", requestText: "review", queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
    const completed = reduceWorkerTurnCard(queued, { type: "completed-without-output", occurredAt: "2026-09-01T00:01:00.000Z", notice: "Structured output is unavailable" });

    expect(JSON.stringify(renderWorkerTurnCard(completed))).toContain("无法获取可信的结构化输出");
  });
  it("renders the current thread as Primary and counts only Workers", () => {
    const card = renderInstanceDirectoryCard({ project: { id: "p1", displayName: "Product", description: "x", workspaceId: "w1", cwd: "/repo" }, entries: [{ instance, workspace, capabilities, queueDepth: 3 }], target: { kind: "instance", instanceId: "i1" }, primary });
    const text = JSON.stringify(card);
    expect(text).toContain("PRIMARY"); expect(text).toContain("当前 Thread"); expect(text).toContain("TARGET"); expect(text).toContain("reviewer"); expect(text).toContain("WORKERS"); expect(text).toContain("queue 3"); expect(text).toContain("swarm/reviewer");
  });
  it("renders an empty Worker directory without Primary creation controls", () => {
    const text = JSON.stringify(renderInstanceDirectoryCard({ project: { id: "p1", displayName: "Product", description: "x", workspaceId: "w1", cwd: "/repo" }, entries: [], target: { kind: "primary" }, primary }));
    expect(text).toContain("Primary (当前 Thread)"); expect(text).toContain("WORKERS"); expect(text).toContain("暂无 Worker"); expect(text).toContain("创建 Worker");
    expect(text).not.toContain("未设置"); expect(text).not.toContain("选择角色"); expect(text).not.toContain("设为 Primary");
  });
  it("bounds a large instance directory and summarizes omitted rows", () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({ instance: { ...instance, id: `i${index}`, name: `worker-${index}-${"x".repeat(100)}` }, workspace: { ...workspace, id: `ws${index}`, instanceId: `i${index}` }, capabilities, queueDepth: index }));
    const card = renderInstanceDirectoryCard({ project: { id: "p1", displayName: "Product", description: "x", workspaceId: "w1", cwd: "/repo" }, entries, target: { kind: "primary" }, primary });
    const serialized = JSON.stringify(card);
    expect(serialized.length).toBeLessThanOrEqual(12_000);
    expect(serialized).toMatch(/另有 \d+ 个实例未在本卡展示/);
    expect(serialized).not.toContain("worker\-199");
    expect(entries).toHaveLength(200);
  });
  it("shows runtime and Git evidence but hides unsupported steering controls", () => {
    const card = renderInstanceDetailCard({ instance, workspace, capabilities, turns: [], queueDepth: 0 });
    const text = JSON.stringify(card);
    expect(text).toContain("w1:p1"); expect(text).toContain("abc123"); expect(text).toContain("claude-code"); expect(text).not.toContain("instance_steer_form");
    expect(text).not.toContain('\"tag\":\"action\"');
    expect(text).toContain('\"tag\":\"column_set\"');
  });

  it("renders at most five newest Worker turns with bounded summaries and navigation", () => {
    const turns = Array.from({ length: 8 }, (_, index) => ({
      id: `turn-${index}-abcdefgh`, idempotencyKey: `key-${index}`, projectId: "p1", instanceId: "i1", instanceGeneration: 2,
      actor: { kind: "human" as const, userId: "u1" }, kind: "turn" as const, text: `request-${index}-${"x".repeat(2_000)}`,
      state: index === 7 ? "completed" as const : "failed" as const, result: index === 7 ? `result-${index}-${"y".repeat(3_000)}` : null,
      resultCapture: index === 7 ? "captured" as const : "unavailable" as const,
      error: index === 7 ? null : "failed", parentTurnId: null, sourceMessageId: `message-${index}`, runtimeTurnId: null, runtimeTurnStartedAt: null,
      createdAt: `2026-09-01T00:0${index}:00.000Z`, updatedAt: `2026-09-01T00:0${index}:30.000Z`
    }));
    const text = JSON.stringify(renderInstanceDetailCard({ instance, workspace, capabilities, turns, queueDepth: 0, conversationKey: "binding:binding-1", bindingId: "binding-1", bindingGeneration: 3 }));

    expect(text).toContain("RECENT TASKS");
    expect(text).not.toContain("RECENT RESULT");
    expect(text.indexOf("turn-7-a")).toBeLessThan(text.indexOf("turn-6-a"));
    expect(text).toContain("request-7");
    expect(text).toContain("result-7");
    expect(text).toContain("captured");
    expect(text).not.toContain("turn-2-a");
    expect(text).toContain('\"action\":\"instance_turn_open\"');
    expect(text).toContain('\"turnId\":\"turn-7-abcdefgh\"');
    expect(text).toContain('\"bindingGeneration\":3');
    expect(text.length).toBeLessThan(12_000);
  });

  it("shows durable provisioning diagnostics for a failed Worker", () => {
    const failed = { ...instance, observedState: "failed" as const, provisioningCheckpoint: "pane-allocated" as const, lastError: "launch failed Bearer live-secret" };
    const text = JSON.stringify(renderInstanceDetailCard({ instance: failed, workspace, capabilities, turns: [], queueDepth: 0 }));
    expect(text).toContain("PROVISIONING");
    expect(text).toContain("pane-allocated");
    expect(text).toContain("LAST ERROR");
    expect(text).toContain("Bearer [REDACTED]");
    expect(text).not.toContain("live-secret");
  });

  it("does not claim a current Thread Primary without a binding", () => {
    const text = JSON.stringify(renderInstanceDirectoryCard({ project: { id: "p1", displayName: "Product", description: "x", workspaceId: "w1", cwd: "/repo" }, entries: [], target: { kind: "primary" }, primary: null }));
    expect(text).toContain("PRIMARY");
    expect(text).toContain("未绑定 Thread");
    expect(text).not.toContain("当前 Thread");
    expect(text).not.toContain("generation 0");
  });

  it("renders actor-bound create and steer forms with CardKit submit behaviors", () => {
    const createCard = renderInstanceCreateCard({ projectId: "p1", requestedBy: "u1" }) as { body: { elements: Array<{ elements?: Array<Record<string, unknown>> }> } };
    const steerCard = renderInstanceSteerCard({ instance, requestedBy: "u1" }) as { body: { elements: Array<{ elements?: Array<Record<string, unknown>> }> } };
    const create = JSON.stringify(createCard);
    const steer = JSON.stringify(steerCard);
    expect(create).toContain('\"action\":\"instance_create_submit\"');
    expect(create).toContain('\"projectId\":\"p1\"');
    expect(create).toContain('\"requestedBy\":\"u1\"');
    expect(create).toContain('\"form_action_type\":\"submit\"');
    expect(create).toContain("创建 Worker");
    expect(create).not.toContain("选择角色");
    expect(create).not.toContain("\"name\":\"role\"");
    const inputs = createCard.body.elements[0]!.elements!.filter(({ tag }) => tag === "input");
    expect(inputs).toHaveLength(2);
    expect(inputs).toEqual(inputs.map((input) => expect.objectContaining({ input_type: "text" })));
    expect(steer).toContain('\"action\":\"instance_steer_submit\"');
    expect(steer).toContain('\"generation\":2');
    expect(steer).toContain('\"form_action_type\":\"submit\"');
    for (const renderedCard of [createCard, steerCard]) {
      const form = renderedCard.body.elements.find(({ elements }) => elements !== undefined);
      const submit = form!.elements!.find(({ tag }) => tag === "button");
      expect(submit).toMatchObject({ form_action_type: "submit" });
      expect(submit).not.toHaveProperty("action_type");
    }
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
