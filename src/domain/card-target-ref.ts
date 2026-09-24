export type CardAggregateKind = "primary-session" | "primary-turn" | "worker-session" | "worker-turn";

export interface CardTargetRef {
  aggregateKind: CardAggregateKind;
  aggregateId: string;
  generation: number;
  messageId: string | null;
}

export function sameCardTargetRef(left: CardTargetRef | null | undefined, right: CardTargetRef | null | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.aggregateKind === right.aggregateKind && left.aggregateId === right.aggregateId
    && left.generation === right.generation && left.messageId === right.messageId;
}
