export interface WorkerHumanReviewNotificationInput {
  workerId: string;
  workerSessionGeneration: number;
  workerName: string;
  turnId: string;
  taskTitle: string;
  primaryName: string;
  parentPaneId: string;
  workerPaneId: string;
  notice: string;
  creatorOpenId: string | null;
  workerMainMessageId: string | null;
}

export type WorkerHumanReviewReservation =
  | { outcome: "reserved"; mention: "included" | "omitted"; eventId: number }
  | { outcome: "skipped"; reason: "not-blocked-transition" | "stale-routing" };

export function canMentionFeishuOpenId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
