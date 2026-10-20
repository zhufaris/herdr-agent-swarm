import type { DeliveryFailureClass } from "./delivery.js";

export type ProjectionGapStage = "core_projection" | "answer_delivery" | "main_delivery" | "worker_delivery" | "turn_recovery";
export type ProjectionGapOwnerKind = "binding" | "prompt" | "answer_page" | "worker_turn" | "turn_card";

export interface ProjectionGapSummary {
  openProjection: number;
  openDelivery: number;
  compensated: number;
  oldestOpenAt: string | null;
}

export interface ProjectionGapOperationalSummary {
  open: number;
  current?: number;
  historical?: number;
  compensated: number;
  affectedOwners: number;
  oldestOpenAt: string | null;
  byStage: Record<ProjectionGapStage, number>;
}

export interface OpenProjectionGapInput {
  stage: ProjectionGapStage;
  ownerKind: ProjectionGapOwnerKind;
  ownerId: string;
  sourceItemId: string;
  failureClass: DeliveryFailureClass | "projection";
  failureCode: string;
  requiredVersion?: number | null;
  occurredAt: string;
}

export interface ProjectionGapQuery {
  bindingId?: string;
  promptId?: string;
  answerPage?: { promptId: string; pageIndex: number };
  workerTurnId?: string;
}

export interface ProjectionGapStore {
  open(input: OpenProjectionGapInput): void;
  openDeliveryForReply(replyId: string, failureClass: DeliveryFailureClass, failureCode: string, occurredAt: string): void;
  compensateDeliveryForReply(replyId: string, deliveredVersion: number, occurredAt: string): number;
  compensateProjectionEvent(eventId: string, reducerRevision: number, occurredAt: string): number;
  summarize(query: ProjectionGapQuery): ProjectionGapSummary;
}

/** Domain policy shared by every mutable CardKit projection. */
export function projectionGapWarning(summary: ProjectionGapSummary | null | undefined): string | null {
  if (!summary) return null;
  const total = summary.openProjection + summary.openDelivery;
  if (total === 0) return null;
  return summary.openProjection > 0
    ? `⚠ 有 ${total} 条过程更新未能展示；后续消息仍在同步。`
    : `⚠ 有 ${total} 条更新未能实时展示，当前内容已同步到最新状态。`;
}
