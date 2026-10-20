export interface WorkerHumanReviewNotificationInput {
  state: "waiting" | "resolved";
  workerId: string;
  workerSessionGeneration: number;
  workerName: string;
  turnId: string;
  taskTitle: string;
  primaryName: string;
  parentPaneId: string;
  parentPaneToken?: string | null;
  workerPaneId: string;
  workerPaneToken?: string | null;
  notice: string;
  creatorOpenId: string | null;
  workerMainMessageId: string | null;
}

export type WorkerHumanReviewReservation =
  | { outcome: "reserved"; kind: "requested" | "updated" | "resolved"; mention: "included" | "omitted"; eventId: number | null; episodeId: string }
  | { outcome: "skipped"; reason: "not-blocked-transition" | "stale-routing" };

export { canMentionFeishuOpenId } from "./human-review.js";
