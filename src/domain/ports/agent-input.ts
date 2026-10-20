import type { AdmitSubmissionIntentInput, AdmitSubmissionIntentResult, CoreSubmissionReceipt, LegacyAgentInputMigrationSummary, SubmissionCancellation, SubmissionIntent, SubmissionIntentActor, SubmissionIntentOwner, SubmissionIntentState, SubmissionUncertainty } from "../submission-intent.js";
import type { HumanInputMessageV2 } from "../inbound.js";

export interface AgentInputRequest {
  ingressSource: string;
  sourceMessageKey: string;
  actor: SubmissionIntentActor;
  input?: HumanInputMessageV2;
  text: string;
  owner: SubmissionIntentOwner;
  paneId: string;
  terminalId: string;
  expectedAgentKind: "traex" | "pi";
  expectedSessionId: string | null;
}

export type AgentInputResult =
  | { outcome: "accepted" | "duplicate"; submissionId: string; state: SubmissionIntentState }
  | { outcome: "conflict"; submissionId: string; state: SubmissionIntentState };

export interface AgentInputWorkflowPort {
  submit(input: AgentInputRequest): Promise<AgentInputResult>;
  resume(submissionId: string): Promise<AgentInputResult>;
}

export interface AgentInputCoreCapabilities {
  agentInputSubmissionV2: boolean;
  agentInputSubmissionV3?: boolean;
  agentInputTypedMessageV1?: boolean;
}

export interface SubmitAgentInputRequest {
  submissionId: string;
  paneId: string;
  terminalId: string;
  agentKind: "traex" | "pi";
  sessionId: string | null;
  text: string;
  input: HumanInputMessageV2;
}

export interface AgentInputCoreFailure {
  code: string;
  detail: string | null;
}

export type SubmitAgentInputResult =
  | { outcome: "receipt"; receipt: CoreSubmissionReceipt }
  | { outcome: "rejected"; failure: AgentInputCoreFailure }
  | { outcome: "uncertain"; failure: AgentInputCoreFailure };

export type QueryAgentInputReceiptResult =
  | { outcome: "receipt"; receipt: CoreSubmissionReceipt }
  | { outcome: "absent" }
  | { outcome: "unavailable"; failure: AgentInputCoreFailure };

export type CanonicalInputRecoveryOutcome = "recovered" | "indexing" | "not_found" | "ambiguous" | "unavailable";
export interface CanonicalInputRecoverySummary {
  indexing: number;
  needsHuman: number;
  lastFailureCode: "recovery_not_found" | "recovery_ambiguous" | "recovery_unavailable" | null;
  hasMore?: boolean;
}
export interface CanonicalInputRecoveryCursor { createdAt: string; submissionId: string }
export interface CanonicalInputRecoveryPage {
  items: SubmissionIntent[];
  nextCursor: CanonicalInputRecoveryCursor | null;
  hasMore: boolean;
  scanCutoff: string;
}

export interface AgentInputCorePort {
  capabilities(): Promise<AgentInputCoreCapabilities>;
  submit(input: SubmitAgentInputRequest): Promise<SubmitAgentInputResult>;
  queryReceipt(submissionId: string): Promise<QueryAgentInputReceiptResult>;
}

export interface AgentInputRecoveryCursor { createdAt: string; submissionId: string }
export interface AgentInputRecoveryItem { action: "submit" | "query"; intent: SubmissionIntent }
export interface AgentInputRecoveryPage {
  items: AgentInputRecoveryItem[];
  nextCursor: AgentInputRecoveryCursor | null;
  hasMore: boolean;
  scanCutoff: string;
}
export type AgentInputRecoveryOutcome =
  | { submissionId: string; kind: "receipt"; receipt: CoreSubmissionReceipt }
  | { submissionId: string; kind: "rejected"; cancellation: SubmissionCancellation }
  | { submissionId: string; kind: "uncertain"; uncertainty: SubmissionUncertainty };

export interface AgentInputStore {
  admit(input: AdmitSubmissionIntentInput): AdmitSubmissionIntentResult;
  get(submissionId: string): SubmissionIntent | null;
  claimRecorded(submissionId: string, attemptedAt: string): SubmissionIntent | null;
  recordReceipt(submissionId: string, receipt: CoreSubmissionReceipt): SubmissionIntent | null;
  recordUncertain(submissionId: string, uncertainty: SubmissionUncertainty): SubmissionIntent | null;
  recordDefiniteRejection(submissionId: string, cancellation: SubmissionCancellation): SubmissionIntent | null;
  listRecoveryWork(): { submit: SubmissionIntent[]; query: SubmissionIntent[] };
  listRecoveryWorkPage(input: { limit: number; cursor: AgentInputRecoveryCursor | null; scanCutoff: string }): AgentInputRecoveryPage;
  claimRecoveryWorkPage(input: { limit: number; attemptedAt: string }): AgentInputRecoveryPage;
  completeRecoveryWorkPage(input: { page: AgentInputRecoveryPage; outcomes: readonly AgentInputRecoveryOutcome[]; completedAt: string }): void;
  reconcileCanonicalHumanMessages(limit?: number): number;
  listPendingCanonicalRecoveries(limit?: number, currentTime?: string): SubmissionIntent[];
  listPendingCanonicalRecoveryPage(input: { limit: number; currentTime: string; cursor: CanonicalInputRecoveryCursor | null; scanCutoff: string }): CanonicalInputRecoveryPage;
  claimPendingCanonicalRecoveryPage(input: { limit: number; currentTime: string }): CanonicalInputRecoveryPage;
  recordCanonicalRecoveryOutcome(submissionId: string, outcome: CanonicalInputRecoveryOutcome, occurredAt: string): void;
  recordCanonicalRecoveryOutcomes(outcomes: ReadonlyArray<{ submissionId: string; outcome: CanonicalInputRecoveryOutcome }>, occurredAt: string): void;
  completeCanonicalRecoveryPage(input: { page: CanonicalInputRecoveryPage; outcomes: ReadonlyArray<{ submissionId: string; outcome: CanonicalInputRecoveryOutcome }>; occurredAt: string }): void;
  getCanonicalRecoverySummary(): CanonicalInputRecoverySummary;
  hasPendingInputCards(ownerKind: "primary" | "worker", ownerId: string, ownerGeneration: number): boolean;
  migrateLegacyNeverAttempted(recordedAt: string): LegacyAgentInputMigrationSummary;
}
