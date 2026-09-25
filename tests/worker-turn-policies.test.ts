import { describe, expect, it } from "vitest";
import {
  decideWorkerHumanReviewRoute,
  matchesExpectedWorkerRuntimeTurn,
  nextWorkerQueuePositions,
  validateWorkerTurnAdmission,
} from "../src/domain/worker-turn-policies.js";

const instance = {
  id: "worker-1",
  projectId: "project-1",
  role: "worker",
  generation: 2,
  workerSessionLifecycle: "active",
  workerSessionGeneration: 3,
  parent: {
    bindingId: "binding-1",
    bindingGeneration: 4,
    paneId: "w:p1",
    nativeSessionId: null,
  },
  runtimeRef: {
    herdrWorkspaceId: "w",
    paneId: "w:p2",
    nativeSessionId: "s",
    generation: 2,
  },
} as const;
const binding = {
  id: "binding-1",
  generation: 4,
  paneId: "w:p1",
  state: "active",
  lifecycle: "active",
  attachment: "attached",
  rootMessageId: "root",
} as const;
const turn = {
  id: "turn-1",
  projectId: "project-1",
  instanceId: "worker-1",
  instanceGeneration: 2,
  runtimeTurnId: "runtime-1",
  runtimeTurnStartedAt: "2026-09-25T00:00:00.000Z",
} as const;
const view = { workerSessionGeneration: 3 };

describe("Worker turn policies", () => {
  it("preserves admission capacity, priority, and parent errors", () => {
    const base = {
      current: instance,
      projectId: "project-1",
      instanceGeneration: 2,
      priority: "normal" as const,
      pendingCount: 0,
      hasLivePriorityTurn: false,
      hasActiveRuntimeTurn: false,
    };
    expect(() =>
      validateWorkerTurnAdmission({ ...base, maxQueueDepth: 0 }),
    ).toThrow("Target instance queue is full");
    expect(() =>
      validateWorkerTurnAdmission({
        ...base,
        current: { ...instance, projectId: "other" },
      }),
    ).toThrow("Instance generation changed before turn acceptance");
    expect(() =>
      validateWorkerTurnAdmission({
        ...base,
        current: { ...instance, generation: 3 },
      }),
    ).toThrow("Instance generation changed before turn acceptance");
    expect(() =>
      validateWorkerTurnAdmission({
        ...base,
        priority: "priority",
        hasLivePriorityTurn: true,
      }),
    ).toThrow("Target instance already has a live priority turn");
    expect(() =>
      validateWorkerTurnAdmission({
        ...base,
        kind: "turn",
        parentTurnId: "parent",
      }),
    ).toThrow("Ordinary Worker turn cannot have a parent");
    expect(() =>
      validateWorkerTurnAdmission({
        ...base,
        kind: "followup",
        parentTurnId: "parent",
        parent: null,
        instanceId: "worker-1",
      }),
    ).toThrow(
      "Worker follow-up parent must be a settled turn on the same instance",
    );
  });
  it("matches only supplied exact runtime-turn fences", () => {
    expect(matchesExpectedWorkerRuntimeTurn(turn, {})).toBe(true);
    expect(
      matchesExpectedWorkerRuntimeTurn(turn, {
        expectedRuntimeTurnId: "runtime-1",
        expectedRuntimeTurnStartedAt: "2026-09-25T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      matchesExpectedWorkerRuntimeTurn(turn, {
        expectedRuntimeTurnId: "runtime-2",
      }),
    ).toBe(false);
    expect(
      matchesExpectedWorkerRuntimeTurn(turn, {
        expectedRuntimeTurnStartedAt: "2026-09-25T00:00:01.000Z",
      }),
    ).toBe(false);
  });
  it("requires every generation, pane, session, and attachment route fence", () => {
    expect(
      decideWorkerHumanReviewRoute({ instance, binding, turn, view }),
    ).toBe("current");
    expect(
      decideWorkerHumanReviewRoute({
        instance: { ...instance, workerSessionGeneration: 4 },
        binding,
        turn,
        view,
      }),
    ).toBe("stale");
    expect(
      decideWorkerHumanReviewRoute({
        instance: { ...instance, generation: 3 },
        binding,
        turn,
        view,
      }),
    ).toBe("stale");
    expect(
      decideWorkerHumanReviewRoute({
        instance: { ...instance, parent: null },
        binding,
        turn,
        view,
      }),
    ).toBe("stale");
    expect(
      decideWorkerHumanReviewRoute({
        instance,
        binding: { ...binding, paneId: "w:other" },
        turn,
        view,
      }),
    ).toBe("stale");
    expect(
      decideWorkerHumanReviewRoute({
        instance: { ...instance, runtimeRef: null },
        binding,
        turn,
        view,
      }),
    ).toBe("stale");
    expect(
      decideWorkerHumanReviewRoute({
        instance: {
          ...instance,
          parent: { ...instance.parent, bindingGeneration: 5 },
        },
        binding,
        turn,
        view,
      }),
    ).toBe("stale");
    for (const patch of [
      { state: "archived" },
      { lifecycle: "terminated" },
      { attachment: "detached" },
      { rootMessageId: null },
    ]) {
      expect(
        decideWorkerHumanReviewRoute({
          instance,
          binding: { ...binding, ...patch },
          turn,
          view,
        }),
      ).toBe("stale");
    }
    expect(
      decideWorkerHumanReviewRoute({
        instance,
        binding: { ...binding, attachment: "detached" },
        turn,
        view,
      }),
    ).toBe("stale");
  });
  it("assigns deterministic one-based queue positions", () => {
    expect(nextWorkerQueuePositions(["a", "b"])).toEqual([
      { item: "a", queuePosition: 1 },
      { item: "b", queuePosition: 2 },
    ]);
  });
});
