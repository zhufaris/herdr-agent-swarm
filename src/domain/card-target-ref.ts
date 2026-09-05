export type CardAggregateKind = "primary-session" | "primary-turn" | "worker-session" | "worker-turn";

export interface CardTargetRef {
  aggregateKind: CardAggregateKind;
  aggregateId: string;
  generation: number;
  messageId: string | null;
}

export function sameCardTargetRef(left: CardTargetRef, right: CardTargetRef): boolean {
  return left.aggregateKind === right.aggregateKind && left.aggregateId === right.aggregateId
    && left.generation === right.generation && left.messageId === right.messageId;
}
