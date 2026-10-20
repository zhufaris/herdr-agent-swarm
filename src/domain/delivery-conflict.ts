import type { DeliveryEffectCertainty, DeliveryFailureClass, OutboundReplyKind, OutboundTargetRole } from "./delivery.js";

export interface DeliveryConflictIdentityInput {
  gatewayId: string;
  laneKey: string;
  projectionKey: string | null;
  bindingId: string | null;
  bindingGeneration: number | null;
  promptId: string | null;
  workerTurnId: string | null;
  workerId: string | null;
  workerSessionGeneration: number | null;
  streamPageIndex: number | null;
  targetRole: OutboundTargetRole | null;
  kind: OutboundReplyKind;
  rootMessageId: string | null;
}

export function deliveryConflictKey(input: DeliveryConflictIdentityInput): string {
  const gateway = requiredPart(input.gatewayId);
  const prefix = `gateway:${gateway}`;
  const pageIndex = input.streamPageIndex;

  if (input.workerTurnId && pageIndex !== null) {
    return `${prefix}:worker-task:${input.workerTurnId}:${pageIndex}`;
  }
  if (input.promptId && pageIndex !== null) {
    return `${prefix}:answer-page:${input.promptId}:${pageIndex}`;
  }
  if (input.workerId && input.workerSessionGeneration !== null
    && (input.kind === "card_update" || input.kind === "group_card_create")) {
    return `${prefix}:worker-main:${input.workerId}:${input.workerSessionGeneration}`;
  }
  if (input.bindingId && input.bindingGeneration !== null && input.targetRole === "session_status") {
    return `${prefix}:primary-main:${input.bindingId}:${input.bindingGeneration}`;
  }
  if (input.rootMessageId && (input.kind === "card_update" || input.kind === "message_delete")) {
    return `${prefix}:surface:${input.rootMessageId}`;
  }

  const laneKey = input.laneKey.trim();
  if (laneKey) return laneKey.startsWith("gateway:") ? laneKey : `${prefix}:${laneKey}`;
  throw new Error("delivery_conflict_identity_required");
}

export function deliveryDegradationBudget(input: {
  failureClass: DeliveryFailureClass;
  effectCertainty: DeliveryEffectCertainty;
  firstFailedAt: string;
}): { attemptLimit: number; durationMs: number; deadlineAt: string } {
  const firstFailedAtMs = Date.parse(input.firstFailedAt);
  if (!Number.isFinite(firstFailedAtMs)) throw new Error("delivery_first_failure_timestamp_invalid");
  const uncertain = input.effectCertainty === "uncertain";
  const durationMs = uncertain ? 60_000 : 120_000;
  return Object.freeze({
    attemptLimit: !uncertain && input.failureClass === "transient" ? 5 : 0,
    durationMs,
    deadlineAt: new Date(firstFailedAtMs + durationMs).toISOString()
  });
}

function requiredPart(value: string): string {
  const result = value.trim();
  if (!result) throw new Error("delivery_conflict_identity_required");
  return result;
}
