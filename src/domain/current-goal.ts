export type GoalLifecycleStatus = "active" | "paused" | "blocked" | "completed" | "budget_limited" | "usage_limited";
export type CurrentGoalStatus = "active" | "paused" | "blocked";
export type GoalBlockKind = "explicit" | "budget" | "usage" | null;

export interface GoalChange {
  goalId: string;
  objective: string;
  status: GoalLifecycleStatus;
  sourceUpdatedAt: number;
  occurredAt: string;
  sourceId: string;
  sourceSequence: number;
  sourceEventId: string;
  nativeSessionId: string;
}

export interface CurrentGoal {
  goalId: string;
  objective: string;
  status: CurrentGoalStatus;
  blockKind: GoalBlockKind;
  sourceUpdatedAt: number;
  occurredAt: string;
  sourceId: string;
  sourceSequence: number;
  sourceEventId: string;
  nativeSessionId: string;
}

export function reduceCurrentGoal(current: CurrentGoal | null, change: GoalChange): CurrentGoal | null {
  if (!isNewerGoalChange(current, change)) return current;
  if (change.status === "completed") return current?.goalId === change.goalId ? null : current;
  return {
    goalId: change.goalId,
    objective: change.objective,
    status: visibleStatus(change.status),
    blockKind: blockKind(change.status),
    sourceUpdatedAt: change.sourceUpdatedAt,
    occurredAt: change.occurredAt,
    sourceId: change.sourceId,
    sourceSequence: change.sourceSequence,
    sourceEventId: change.sourceEventId,
    nativeSessionId: change.nativeSessionId
  };
}

export function sameCurrentGoal(left: CurrentGoal | null, right: CurrentGoal | null): boolean {
  return left === right || Boolean(left && right
    && left.goalId === right.goalId
    && left.objective === right.objective
    && left.status === right.status
    && left.blockKind === right.blockKind
    && left.sourceUpdatedAt === right.sourceUpdatedAt
    && left.occurredAt === right.occurredAt
    && left.sourceId === right.sourceId
    && left.sourceSequence === right.sourceSequence
    && left.sourceEventId === right.sourceEventId
    && left.nativeSessionId === right.nativeSessionId);
}

function isNewerGoalChange(current: CurrentGoal | null, change: GoalChange): boolean {
  if (!current) return change.status !== "completed";
  if (change.nativeSessionId !== current.nativeSessionId) return false;
  if (change.sourceId === current.sourceId) return change.sourceSequence > current.sourceSequence;
  if (change.sourceUpdatedAt !== current.sourceUpdatedAt) return change.sourceUpdatedAt > current.sourceUpdatedAt;
  // Equal-time events from different Core sources have no reliable ordering.
  // Fail closed so recovery cannot overwrite a newer session projection.
  return false;
}

function visibleStatus(status: Exclude<GoalLifecycleStatus, "completed">): CurrentGoalStatus {
  return status === "active" || status === "paused" ? status : "blocked";
}

function blockKind(status: Exclude<GoalLifecycleStatus, "completed">): GoalBlockKind {
  if (status === "budget_limited") return "budget";
  if (status === "usage_limited") return "usage";
  return status === "blocked" ? "explicit" : null;
}
