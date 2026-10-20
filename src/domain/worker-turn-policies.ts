import { InstanceTurnCapacityExceeded } from "./instance-turn-capacity-error.js";
import type { InstanceTurn } from "./instance-turn.js";
import type { WorkerTurnCardView } from "./worker-turn-card-view.js";

export interface WorkerTurnAdmissionFacts {
  current: { projectId: string; generation: number } | null;
  projectId: string;
  instanceGeneration: number;
  priority: InstanceTurn["priority"];
  pendingCount: number;
  maxQueueDepth?: number | undefined;
  hasLivePriorityTurn: boolean;
  hasActiveRuntimeTurn: boolean;
  kind?: InstanceTurn["kind"] | undefined;
  parentTurnId?: string | null | undefined;
  parent?: InstanceTurn | null | undefined;
  instanceId?: string | undefined;
}

export function validateWorkerTurnAdmission(
  facts: WorkerTurnAdmissionFacts,
): void {
  if (
    !facts.current ||
    facts.current.projectId !== facts.projectId ||
    facts.current.generation !== facts.instanceGeneration
  ) {
    throw new Error("Instance generation changed before turn acceptance");
  }
  if (
    facts.maxQueueDepth !== undefined &&
    facts.pendingCount >= facts.maxQueueDepth
  )
    throw new InstanceTurnCapacityExceeded();
  if (facts.priority === "priority" && facts.hasLivePriorityTurn)
    throw new Error("Target instance already has a live priority turn");
  if (facts.priority === "priority" && facts.hasActiveRuntimeTurn)
    throw new Error("Target instance already has an active runtime turn");
  if (
    facts.kind === "turn" &&
    facts.parentTurnId !== null &&
    facts.parentTurnId !== undefined
  )
    throw new Error("Ordinary Worker turn cannot have a parent");
  if (facts.kind === "followup") {
    const parent = facts.parent;
    if (
      !parent ||
      parent.projectId !== facts.projectId ||
      parent.instanceId !== facts.instanceId ||
      !["completed", "failed", "cancelled"].includes(parent.state)
    ) {
      throw new Error(
        "Worker follow-up parent must be a settled turn on the same instance",
      );
    }
  }
}

export function matchesExpectedWorkerRuntimeTurn(
  turn: Pick<InstanceTurn, "runtimeTurnId" | "runtimeTurnStartedAt">,
  expected: {
    expectedRuntimeTurnId?: string;
    expectedRuntimeTurnStartedAt?: string;
  },
): boolean {
  return (
    (expected.expectedRuntimeTurnId === undefined ||
      turn.runtimeTurnId === expected.expectedRuntimeTurnId) &&
    (expected.expectedRuntimeTurnStartedAt === undefined ||
      turn.runtimeTurnStartedAt === expected.expectedRuntimeTurnStartedAt)
  );
}

export function decideWorkerHumanReviewRoute(input: {
  instance: {
    role: string;
    generation: number;
    workerSessionLifecycle: string | null;
    workerSessionGeneration: number;
    parent: { bindingGeneration?: number; paneId: string } | null;
    runtimeRef: { paneId: string } | null;
  } | null;
  binding: {
    generation: number;
    paneId: string | null;
    state: string;
    lifecycle: string;
    attachment: string;
    rootMessageId: string | null;
  } | null;
  turn: Pick<InstanceTurn, "instanceGeneration">;
  view: Pick<WorkerTurnCardView, "workerSessionGeneration">;
}): "current" | "stale" {
  const { instance, binding, turn, view } = input;
  const parent = instance?.parent;
  return instance?.role === "worker" &&
    instance.generation === turn.instanceGeneration &&
    instance.workerSessionLifecycle === "active" &&
    instance.workerSessionGeneration === view.workerSessionGeneration &&
    parent?.bindingGeneration === binding?.generation &&
    parent?.paneId === binding?.paneId &&
    binding?.state === "active" &&
    binding.lifecycle === "active" &&
    binding.attachment === "attached" &&
    typeof binding.rootMessageId === "string" &&
    binding.rootMessageId.length > 0 &&
    typeof instance.runtimeRef?.paneId === "string"
    ? "current"
    : "stale";
}

export function nextWorkerQueuePositions<T>(
  items: readonly T[],
): Array<{ item: T; queuePosition: number }> {
  return items.map((item, index) => ({ item, queuePosition: index + 1 }));
}
