export type WorktreeRemovalReason = "clean" | "dirty" | "conflicted" | "ahead" | "uncertain";

export interface PreparedWorktree { cwd: string; branch: string; baseCommit: string; headCommit: string }

export interface WorktreeInspection {
  registered: boolean;
  cwd: string;
  branch: string | null;
  headCommit: string;
  dirty: boolean;
  conflicted: boolean;
  aheadCount: number;
  fingerprint: string;
}

export interface WorktreeRemovalPlan {
  repositoryRoot: string;
  targetPath: string;
  baseCommit: string;
  leaseGeneration: number;
  safe: boolean;
  reason: WorktreeRemovalReason;
  fingerprint: string | null;
  inspection: WorktreeInspection | null;
}

export interface WorktreePort {
  prepare(input: { repositoryRoot: string; targetPath: string; branch: string; baseRef: string }): Promise<PreparedWorktree>;
  planRemoval(input: { repositoryRoot: string; targetPath: string; baseCommit: string; leaseGeneration: number }): Promise<WorktreeRemovalPlan>;
  release(plan: WorktreeRemovalPlan, currentLeaseGeneration?: number): Promise<void>;
}
