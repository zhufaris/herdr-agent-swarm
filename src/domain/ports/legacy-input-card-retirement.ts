export type LegacyInputCardRetirementState = "eligible" | "deleting" | "retired" | "failed";

export interface LegacyInputCardRetirement {
  submissionId: string;
  gatewayId: string;
  messageId: string;
  outboundReplyId: string;
  state: LegacyInputCardRetirementState;
  outcome: "deleted" | "already_absent" | "failed" | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}

export interface LegacyInputCardRetirementStore {
  scan(limit?: number): number;
  get(submissionId: string): LegacyInputCardRetirement | null;
  settle(input: { outboundReplyId: string; outcome: "deleted" | "already_absent" | "failed"; detail?: string | null }): LegacyInputCardRetirement | null;
  reconcileExpiredMessageDelete(outboundReplyId: string): boolean;
}
