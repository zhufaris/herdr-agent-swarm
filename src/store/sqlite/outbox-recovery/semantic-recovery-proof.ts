import type { DeliveryFailureMetadata, OutboundReply } from "../../../domain/types.js";
export { PRIMARY_ANSWER_EXPIRED_TARGET_PLAN_PROOF } from "../delivery-recovery-proof.js";

export const WORKER_EXPIRED_TARGET_PROOFS = Object.freeze({
  workerMainUpdateCard: "feishu:update_card:worker-main:expired_worker_view_target",
  workerMainUpdateCardKit: "feishu:update_cardkit:worker-main:expired_worker_view_target",
  workerTurnUpdateCard: "feishu:update_card:worker-turn:expired_worker_view_target",
  workerTurnUpdateCardKit: "feishu:update_cardkit:worker-turn:expired_worker_view_target",
  legacyWorkerMainSurfaceReplace: "feishu:surface.replace:worker-main:expired_worker_view_target:legacy-card-update-v1",
  legacyWorkerTurnSurfaceReplace: "feishu:surface.replace:worker-turn:expired_worker_view_target:legacy-card-update-v1"
});

export const WORKER_EXPIRED_TARGET_PROOF_LIST = Object.freeze([
  WORKER_EXPIRED_TARGET_PROOFS.workerMainUpdateCard,
  WORKER_EXPIRED_TARGET_PROOFS.workerMainUpdateCardKit,
  WORKER_EXPIRED_TARGET_PROOFS.workerTurnUpdateCard,
  WORKER_EXPIRED_TARGET_PROOFS.workerTurnUpdateCardKit,
  WORKER_EXPIRED_TARGET_PROOFS.legacyWorkerMainSurfaceReplace,
  WORKER_EXPIRED_TARGET_PROOFS.legacyWorkerTurnSurfaceReplace
]);

export function matchesPersistedPrimaryAnswerExpiredTargetPlan(
  value: string | null,
  target: { gatewayId: string; gatewayProfileId: string; messageId: string }
): boolean {
  if (!value || target.gatewayId !== "feishu:primary" || target.gatewayProfileId !== "feishu-cardkit-v1") return false;
  try {
    const plan = JSON.parse(value) as {
      protocolVersion?: unknown;
      gatewayId?: unknown;
      profileId?: unknown;
      operation?: unknown;
      intent?: { kind?: unknown; purpose?: unknown; messageId?: unknown };
    };
    return plan.protocolVersion === 1
      && plan.gatewayId === target.gatewayId
      && plan.profileId === target.gatewayProfileId
      && plan.operation === "surface.replace"
      && plan.intent?.kind === "surface.replace"
      && plan.intent.purpose === "primary-answer"
      && plan.intent.messageId === target.messageId;
  } catch {
    return false;
  }
}

type WorkerExpiredTargetPurpose = "worker-main" | "worker-turn";
type WorkerExpiredTargetOperation = "update_card" | "update_cardkit";

type WorkerExpiredTargetShape = {
  kind: string;
  bindingId?: string | null;
  workerId?: string | null;
  workerSessionGeneration?: number | null;
  workerTurnId?: string | null;
  promptId?: string | null;
  rootMessageId?: string | null;
  streamPageIndex?: number | null;
  cardRole?: string | null;
  targetRole?: string | null;
  selectionId?: string | null;
};

type WorkerExpiredTargetPersistedShape = {
  gateway_id: string;
  kind: string;
  binding_id: string | null;
  worker_id: string | null;
  worker_session_generation: number | null;
  worker_turn_id: string | null;
  prompt_id: string | null;
  root_message_id: string | null;
  stream_page_index: number | null;
  card_role: string | null;
  target_role: string | null;
  selection_id: string | null;
};

export function deriveExactWorkerExpiredTargetProof(reply: OutboundReply, metadata: DeliveryFailureMetadata & { effectCertainty?: string }): string | null {
  if (reply.gatewayId !== "feishu:primary") return null;
  if (metadata.failureClass !== "permanent" || metadata.effectCertainty !== "rejected") return null;
  if (metadata.larkErrorCode !== "230031" || metadata.recoveryKind !== "expired_worker_view_target") return null;
  const operation = metadata.providerOperation === "update_card" || metadata.providerOperation === "update_cardkit"
    ? metadata.providerOperation
    : null;
  if (!operation) return null;
  const purpose = workerExpiredTargetPurpose(reply);
  return purpose ? workerExpiredTargetProof(purpose, operation) : null;
}

export function matchesPersistedWorkerExpiredTargetProof(proof: string | null, row: WorkerExpiredTargetPersistedShape): boolean {
  if (row.gateway_id !== "feishu:primary" || row.kind !== "card_update" || !proof) return false;
  const purpose = workerExpiredTargetPurpose({
    kind: row.kind,
    bindingId: row.binding_id,
    workerId: row.worker_id,
    workerSessionGeneration: row.worker_session_generation,
    workerTurnId: row.worker_turn_id,
    promptId: row.prompt_id,
    rootMessageId: row.root_message_id,
    streamPageIndex: row.stream_page_index,
    cardRole: row.card_role,
    targetRole: row.target_role,
    selectionId: row.selection_id
  });
  if (!purpose) return false;
  return proof === workerExpiredTargetProof(purpose, "update_card")
    || proof === workerExpiredTargetProof(purpose, "update_cardkit")
    || proof === legacyWorkerExpiredTargetProof(purpose);
}

function workerExpiredTargetPurpose(reply: WorkerExpiredTargetShape): WorkerExpiredTargetPurpose | null {
  if (reply.kind !== "card_update") return null;
  if (reply.promptId !== null && reply.promptId !== undefined) return null;
  if (reply.rootMessageId === null || reply.rootMessageId === undefined) return null;
  if (reply.cardRole !== null && reply.cardRole !== undefined) return null;
  if (reply.targetRole !== null && reply.targetRole !== undefined) return null;
  if (reply.selectionId !== null && reply.selectionId !== undefined) return null;
  const workerMain = reply.workerId !== null && reply.workerId !== undefined
    && reply.workerSessionGeneration !== null && reply.workerSessionGeneration !== undefined
    && reply.workerTurnId === null
    && (reply.streamPageIndex === null || reply.streamPageIndex === undefined);
  const workerTurn = (reply.workerId === null || reply.workerId === undefined)
    && (reply.workerSessionGeneration === null || reply.workerSessionGeneration === undefined)
    && reply.workerTurnId !== null && reply.workerTurnId !== undefined
    && reply.streamPageIndex !== null && reply.streamPageIndex !== undefined;
  if (workerMain === workerTurn) return null;
  return workerMain ? "worker-main" : "worker-turn";
}

function legacyWorkerExpiredTargetProof(purpose: WorkerExpiredTargetPurpose): string {
  return purpose === "worker-main"
    ? WORKER_EXPIRED_TARGET_PROOFS.legacyWorkerMainSurfaceReplace
    : WORKER_EXPIRED_TARGET_PROOFS.legacyWorkerTurnSurfaceReplace;
}

function workerExpiredTargetProof(purpose: WorkerExpiredTargetPurpose, operation: WorkerExpiredTargetOperation): string {
  if (purpose === "worker-main") return operation === "update_card"
    ? WORKER_EXPIRED_TARGET_PROOFS.workerMainUpdateCard
    : WORKER_EXPIRED_TARGET_PROOFS.workerMainUpdateCardKit;
  return operation === "update_card"
    ? WORKER_EXPIRED_TARGET_PROOFS.workerTurnUpdateCard
    : WORKER_EXPIRED_TARGET_PROOFS.workerTurnUpdateCardKit;
}
