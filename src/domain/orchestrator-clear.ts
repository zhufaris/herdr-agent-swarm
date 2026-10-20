import type { HerdrAgentSession } from "./runtime-observation.js";

export type OrchestratorClearState =
  | "accepted"
  | "rotating"
  | "rotation-uncertain"
  | "context-cleared"
  | "withdrawing"
  | "succeeded"
  | "partial"
  | "rejected"
  | "failed";

export interface SessionRotationReceipt {
  operationId: string;
  paneId: string;
  terminalId: string;
  oldSession: HerdrAgentSession;
  newSession: HerdrAgentSession;
}

export interface SessionRotationRequest {
  operationId: string;
  paneId: string;
  expectedTerminalId: string;
  expectedSession: HerdrAgentSession;
  expectedStateChangeSeq: number;
  launch: {
    name: string;
    kind: "traex";
    args?: string[];
    timeoutMs?: number;
  };
}

export type SessionRotationResult =
  | { outcome: "rotated"; receipt: SessionRotationReceipt }
  | { outcome: "already-applied"; receipt: SessionRotationReceipt }
  | { outcome: "fence-lost"; operationId: string; paneId: string; reason: string }
  | { outcome: "unsupported-launch"; operationId: string; paneId: string; reason: string }
  | { outcome: "definitely-not-started"; operationId: string; paneId: string; reason: string }
  | { outcome: "uncertain"; operationId: string; paneId: string; reason: string }
  | { outcome: "malformed-response"; operationId: string; paneId: string; reason: string }
  | { outcome: "rotating"; operationId: string; paneId: string };

export interface OrchestratorClearOperation {
  id: string;
  idempotencyKey: string;
  actorOpenId: string;
  sourceMessageId: string;
  confirmationId: string;
  bindingId: string;
  bindingGeneration: number;
  oldSessionEpoch: number;
  expectedWorkspaceId: string;
  expectedPaneId: string;
  expectedTerminalId: string;
  expectedSession: HerdrAgentSession;
  expectedStateChangeSeq: number;
  state: OrchestratorClearState;
  attemptCount: number;
  receipt: SessionRotationReceipt | null;
  answerTargetSnapshot: readonly string[];
  answerTargetCount: number;
  withdrawnCount: number;
  alreadyAbsentCount: number;
  failedCount: number;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AcceptOrchestratorClearOperationInput = Omit<OrchestratorClearOperation,
  | "state"
  | "attemptCount"
  | "receipt"
  | "answerTargetSnapshot"
  | "answerTargetCount"
  | "withdrawnCount"
  | "alreadyAbsentCount"
  | "failedCount"
  | "detail"
  | "createdAt"
  | "updatedAt"
>;
