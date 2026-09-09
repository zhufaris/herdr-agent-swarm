import type { AgentInstance } from "./agent-instance.js";
import type { InstanceTurn } from "./instance-turn.js";
import type { Binding } from "./types.js";
import { canSubmitWorkerMainTask, type WorkerMainView } from "./worker-main-view.js";
import type { WorkerTurnCardView } from "./worker-turn-card-view.js";

export type WorkerCardOwnershipRejection =
  | "missing"
  | "stale_card"
  | "stale_instance"
  | "stale_worker_session"
  | "wrong_owner"
  | "inactive_parent"
  | "action_unavailable";

export type WorkerCardOwnershipDecision =
  | { allowed: true }
  | { allowed: false; reason: WorkerCardOwnershipRejection };

export interface WorkerTaskCardOwnershipInput {
  chatId: string;
  actionMessageId: string;
  sourceCardMessageId: string;
  expectedInstanceGeneration: number;
  expectedWorkerSessionGeneration: number;
  instance: AgentInstance | null;
  turn: InstanceTurn | null;
  view: WorkerTurnCardView | null;
  binding: Binding | null;
}

export function decideWorkerTaskCardOwnership(input: WorkerTaskCardOwnershipInput): WorkerCardOwnershipDecision {
  const { instance, turn, view, binding } = input;
  if (!instance || !turn || !view || !binding || !instance.parent) return rejected("missing");
  if (instance.role !== "worker" || turn.instanceId !== instance.id || view.instanceId !== instance.id) return rejected("wrong_owner");
  if (input.actionMessageId !== input.sourceCardMessageId || view.messageId !== input.sourceCardMessageId) return rejected("stale_card");
  if (instance.generation !== input.expectedInstanceGeneration || turn.instanceGeneration !== instance.generation || view.instanceGeneration !== instance.generation) return rejected("stale_instance");
  if (instance.workerSessionGeneration !== input.expectedWorkerSessionGeneration || view.workerSessionGeneration !== instance.workerSessionGeneration) return rejected("stale_worker_session");
  if (binding.id !== instance.parent.bindingId || binding.chatId !== input.chatId || binding.paneId !== instance.parent.paneId) return rejected("wrong_owner");
  if (binding.generation !== (instance.parent.bindingGeneration ?? 1) || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") return rejected("inactive_parent");
  return { allowed: true };
}

export interface WorkerMainCardOwnershipInput {
  chatId: string;
  actionMessageId: string;
  sourceCardMessageId: string;
  expectedInstanceGeneration: number;
  expectedWorkerSessionGeneration: number;
  instance: AgentInstance | null;
  view: WorkerMainView | null;
  binding: Binding | null;
  requireTaskSubmission?: boolean;
  expectedTurnId?: string;
}

export function decideWorkerMainCardOwnership(input: WorkerMainCardOwnershipInput): WorkerCardOwnershipDecision {
  const { instance, view, binding } = input;
  if (!instance || !view || !binding || !instance.parent) return rejected("missing");
  if (instance.role !== "worker" || view.workerId !== instance.id || view.parentBindingId !== instance.parent.bindingId || view.parentPaneId !== instance.parent.paneId) return rejected("wrong_owner");
  if (input.actionMessageId !== input.sourceCardMessageId || view.messageId !== input.sourceCardMessageId) return rejected("stale_card");
  if (instance.generation !== input.expectedInstanceGeneration || view.runtimeGeneration !== instance.generation) return rejected("stale_instance");
  if (instance.workerSessionGeneration !== input.expectedWorkerSessionGeneration || view.workerSessionGeneration !== instance.workerSessionGeneration) return rejected("stale_worker_session");
  if (binding.id !== view.parentBindingId || binding.chatId !== input.chatId || binding.paneId !== view.parentPaneId) return rejected("wrong_owner");
  const parentActive = binding.lifecycle === "active" && binding.state === "active" && binding.attachment === "attached"
    && binding.generation === view.parentBindingGeneration;
  if (!parentActive) return rejected("inactive_parent");
  if (input.expectedTurnId !== undefined && view.currentTask?.turnId !== input.expectedTurnId) return rejected("stale_card");
  if (input.requireTaskSubmission !== false && !canSubmitWorkerMainTask({
    ...view, runtimeAttached: instance.runtimeRef !== null, desiredState: instance.desiredState, parentActive
  })) return rejected("action_unavailable");
  return { allowed: true };
}

export function decideWorkerCardBindingOwnership(input: {
  chatId: string;
  conversationKey?: unknown;
  suppliedBindingId?: unknown;
  suppliedBindingGeneration?: unknown;
  bindingId: string;
  bindingGeneration: number;
  parentPaneId: string;
  binding: Binding | null;
}): WorkerCardOwnershipDecision {
  const { binding } = input;
  if (!binding) return rejected("missing");
  if (binding.id !== input.bindingId || binding.chatId !== input.chatId || binding.paneId !== input.parentPaneId) return rejected("wrong_owner");
  if (binding.generation !== input.bindingGeneration) return rejected("inactive_parent");
  if (typeof input.conversationKey === "string" && input.conversationKey !== `binding:${input.bindingId}`) return rejected("wrong_owner");
  if (typeof input.suppliedBindingId === "string" && input.suppliedBindingId !== input.bindingId) return rejected("wrong_owner");
  if (input.suppliedBindingGeneration !== undefined && Number(input.suppliedBindingGeneration) !== input.bindingGeneration) return rejected("inactive_parent");
  return { allowed: true };
}

function rejected(reason: WorkerCardOwnershipRejection): WorkerCardOwnershipDecision {
  return { allowed: false, reason };
}
