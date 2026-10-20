export type CardDismissalState = "deleting" | "deleted" | "already_absent" | "failed";

export interface CardDismissal {
  id: string;
  actionKind: string;
  semanticKey: string;
  actorOpenId: string;
  chatId: string;
  gatewayId: string;
  messageId: string;
  outboundReplyId: string;
  state: CardDismissalState;
  outcome: "deleted" | "already_absent" | "failed" | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

/**
 * This input is deliberately named for the validated card-action boundary.
 * Callers must not manufacture arbitrary Feishu message identifiers.
 */
export interface ReserveValidatedCardDismissalInput {
  actionKind: string;
  semanticKey: string;
  actorOpenId: string;
  chatId: string;
  gatewayId: string;
  messageId: string;
}

export interface CardDismissalStore {
  reserveValidated(input: ReserveValidatedCardDismissalInput): CardDismissal;
  get(id: string): CardDismissal | null;
  settle(input: { outboundReplyId: string; outcome: "deleted" | "already_absent" | "failed"; detail?: string | null }): CardDismissal | null;
}
