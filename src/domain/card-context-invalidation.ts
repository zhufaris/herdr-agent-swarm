import type { CardAggregateKind } from "./card-target-ref.js";

export interface CardContextInvalidation {
  targetKind: CardAggregateKind;
  targetId: string;
  targetGeneration: number;
  requestedDependencyRevision: number;
  projectedDependencyRevision: number;
  reason: string;
  createdAt: string;
  updatedAt: string;
}

export interface CardContextTarget {
  targetKind: CardAggregateKind;
  targetId: string;
  targetGeneration: number;
}
