import type { DeliveryEffectCertainty, OutboundReplyKind } from "./delivery.js";

export interface ReplaySafeSupersessionFacts {
  effectCertainty: DeliveryEffectCertainty | null;
  autoRecoveryCount: number;
  kind: OutboundReplyKind;
  idempotencyKey: string | null;
  projectionKey: string | null;
  reconstructible: boolean;
  targetFrozen: boolean;
  providerOperationSafe: boolean;
  ownerCurrent: boolean;
  hasExternalEffectEvidence: boolean;
}

export interface DirectDeliveryRetryFacts {
  effectCertainty: DeliveryEffectCertainty | null;
  autoRecoveryCount: number;
  kind: OutboundReplyKind;
  deliveredMessageId: string | null;
  cardIdCheckpoint: string | null;
  gatewayCheckpointJson: string | null;
}

export function isReplaySafeSupersession(facts: ReplaySafeSupersessionFacts): boolean {
  const confirmedNonApplication = facts.effectCertainty === "not-started" || facts.effectCertainty === "rejected";
  const stableIdentity = nonempty(facts.idempotencyKey) || nonempty(facts.projectionKey);
  return confirmedNonApplication
    && facts.autoRecoveryCount === 0
    && facts.kind !== "message_delete"
    && stableIdentity
    && facts.reconstructible
    && !facts.targetFrozen
    && facts.providerOperationSafe
    && facts.ownerCurrent
    && !facts.hasExternalEffectEvidence;
}

export function isDirectDeliveryRetryAllowed(facts: DirectDeliveryRetryFacts): boolean {
  return (facts.effectCertainty === "not-started" || facts.effectCertainty === "rejected")
    && facts.autoRecoveryCount === 0
    && (facts.kind === "text" || facts.kind === "card_reply" || facts.kind === "group_card_create" || facts.kind === "stream_card_create")
    && facts.deliveredMessageId === null
    && facts.cardIdCheckpoint === null
    && facts.gatewayCheckpointJson === null;
}

function nonempty(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}
