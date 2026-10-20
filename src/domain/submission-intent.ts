import type { HumanInputMessageV2 } from "./inbound.js";

export type SubmissionIntentState = "recorded" | "attempting" | "prepared" | "observed" | "terminal" | "cancelled" | "uncertain";
export type SubmissionIntentOwnerKind = "primary" | "worker";
export type SubmissionIntentAgentKind = "traex" | "pi";

export interface SubmissionIntentActor {
  kind: "human" | "system";
  id: string;
  gatewayId: string;
  chatId: string;
  topicId: string | null;
  rootMessageId: string | null;
}

export interface SubmissionIntentOwner {
  kind: SubmissionIntentOwnerKind;
  id: string;
  generation: number;
}

export type CoreSubmissionReceiptState = "prepared" | "observed" | "terminal" | "cancelled";

export interface CoreSubmissionReceipt {
  submissionId: string;
  paneId: string;
  terminalId: string;
  agentKind: SubmissionIntentAgentKind;
  sessionId: string | null;
  state: CoreSubmissionReceiptState;
  turnId: string | null;
  startedAt: string | null;
  terminalState: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SubmissionUncertainty {
  code: string;
  detail: string | null;
  recordedAt: string;
}

export interface SubmissionCancellation {
  code: string;
  detail: string | null;
  recordedAt: string;
}

export interface SubmissionIntent {
  submissionId: string;
  ingressSource: string;
  sourceMessageKey: string;
  actor: SubmissionIntentActor;
  input: HumanInputMessageV2;
  text: string;
  owner: SubmissionIntentOwner;
  paneId: string;
  terminalId: string;
  expectedAgentKind: SubmissionIntentAgentKind;
  expectedSessionId: string | null;
  state: SubmissionIntentState;
  receipt: CoreSubmissionReceipt | null;
  uncertainty: SubmissionUncertainty | null;
  cancellation: SubmissionCancellation | null;
  attemptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdmitSubmissionIntentInput {
  submissionId: string;
  ingressSource: string;
  sourceMessageKey: string;
  actor: SubmissionIntentActor;
  /** Legacy callers may omit this; admission canonically upgrades their text. */
  input?: HumanInputMessageV2;
  text: string;
  owner: SubmissionIntentOwner;
  paneId: string;
  terminalId: string;
  expectedAgentKind: SubmissionIntentAgentKind;
  expectedSessionId: string | null;
  recordedAt: string;
}

export type AdmitSubmissionIntentResult =
  | { outcome: "accepted"; intent: SubmissionIntent }
  | { outcome: "duplicate"; intent: SubmissionIntent }
  | { outcome: "conflict"; intent: SubmissionIntent };

export type SubmissionIntentRecoveryAction = "submit" | "query" | "none";

export interface LegacyAgentInputMigrationSummary {
  migratedInputs: number;
  cancelledPromptJobs: number;
  cancelledBatches: number;
  remainingEligible: number;
  preservedPossibleEffect: number;
}

export function submissionIntentRecoveryAction(state: SubmissionIntentState): SubmissionIntentRecoveryAction {
  if (state === "recorded") return "submit";
  if (state === "attempting" || state === "prepared" || state === "uncertain") return "query";
  return "none";
}

export function coreReceiptMatchesIntent(intent: SubmissionIntent, receipt: CoreSubmissionReceipt): boolean {
  return receipt.submissionId === intent.submissionId
    && receipt.paneId === intent.paneId
    && receipt.terminalId === intent.terminalId
    && receipt.agentKind === intent.expectedAgentKind
    && (intent.expectedSessionId === null || receipt.sessionId === intent.expectedSessionId);
}

export function canAdoptCoreReceipt(current: SubmissionIntent, receipt: CoreSubmissionReceipt): boolean {
  if (!coreReceiptMatchesIntent(current, receipt)) return false;
  if (current.state === "recorded") return false;
  if (current.state === "terminal" || current.state === "cancelled") {
    return current.state === receipt.state && current.receipt !== null
      && JSON.stringify(current.receipt) === JSON.stringify(receipt);
  }
  if (current.state === "attempting" || current.state === "uncertain") return true;
  const rank: Record<CoreSubmissionReceiptState, number> = { prepared: 1, observed: 2, terminal: 3, cancelled: 3 };
  return rank[receipt.state] >= rank[current.state];
}
