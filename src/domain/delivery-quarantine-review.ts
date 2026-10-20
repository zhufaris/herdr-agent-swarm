import type { DeliveryEffectCertainty, DeliveryFailureClass, OutboundReplyKind } from "./delivery.js";

export interface DeliveryQuarantineReviewInput {
  failedReplyId: string;
  replyKind: OutboundReplyKind;
  failureClass: DeliveryFailureClass;
  effectCertainty: DeliveryEffectCertainty;
  reason: string;
  scopeLabel: string;
  creatorOpenId: string | null;
  retryAllowed: boolean;
}
