import { describe, expect, it } from "vitest";
import { resolveInstanceTarget, validatePrimaryAssignment } from "../src/domain/agent-instance.js";
import type { AgentInstance } from "../src/domain/agent-instance.js";

function instance(input: Partial<AgentInstance> & Pick<AgentInstance, "id" | "name" | "role">): AgentInstance {
  return {
    projectId: "project-a",
    agentKind: "traex",
    model: null,
    sourcePrimaryPaneLabel: null,
    parent: null,
    workerSessionLifecycle: input.role === "worker" ? "legacy" : null,
    desiredState: "running",
    observedState: "idle",
    workspaceLeaseId: `${input.id}-workspace`,
    generation: 1,
    runtimeRef: null,
    pendingRuntimeRef: null,
    provisioningCheckpoint: "verified",
    lastError: null,
    ...input
  };
}

describe("agent instance domain", () => {
  it("allows at most one primary in a project", () => {
    const primary = instance({ id: "a", name: "architect", role: "primary" });
    const worker = instance({ id: "b", name: "reviewer", role: "worker" });

    expect(validatePrimaryAssignment([primary, worker])).toEqual({ ok: true, primaryInstanceId: "a" });
    expect(validatePrimaryAssignment([primary, { ...worker, role: "primary" }])).toEqual({
      ok: false, reason: "project_has_multiple_primaries"
    });
  });

  it("resolves symbolic primary and fixed instance targets without retargeting", () => {
    const primary = instance({ id: "a", name: "architect", role: "primary" });
    const worker = instance({ id: "b", name: "reviewer", role: "worker" });

    expect(resolveInstanceTarget({ kind: "primary" }, [primary, worker])).toEqual({ ok: true, instance: primary });
    expect(resolveInstanceTarget({ kind: "instance", instanceId: "b" }, [primary, worker])).toEqual({ ok: true, instance: worker });
    expect(resolveInstanceTarget({ kind: "instance", instanceId: "missing" }, [primary, worker])).toEqual({
      ok: false, reason: "instance_not_found"
    });
  });

  it("rejects writes from a stale runtime generation", () => {
    const worker = instance({ id: "b", name: "reviewer", role: "worker", generation: 3 });
    expect(resolveInstanceTarget({ kind: "instance", instanceId: "b", expectedGeneration: 2 }, [worker])).toEqual({
      ok: false, reason: "stale_instance_generation"
    });
  });
});
