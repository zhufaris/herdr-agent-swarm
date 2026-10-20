import type { AgentState } from "./types.js";

export function canMentionFeishuOpenId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export interface PrimaryHumanReviewNotificationInput {
  state: "waiting" | "resolved";
  bindingId: string;
  bindingGeneration: number;
  primaryName: string;
  promptId: string;
  requestText: string;
  paneId: string;
  paneToken?: string | null;
  notice: string;
  creatorOpenId: string | null;
}

export type PrimaryHumanReviewReservation =
  | { outcome: "reserved"; kind: "requested" | "updated" | "resolved"; mention: "included" | "omitted"; episodeId: string }
  | { outcome: "skipped"; reason: "not-transition" | "stale-routing" };

export interface PrimaryPromptStateObservationInput {
  bindingId: string;
  promptId: string;
  expectedGeneration: number;
  expectedPaneId: string;
  state: AgentState;
  notice: string | null;
  occurredAt: string;
  renderHumanReviewNotification(input: PrimaryHumanReviewNotificationInput): object;
}

export type PrimaryPromptStateObservationResult =
  | { outcome: "stale"; binding: import("./binding.js").Binding | null; notification: PrimaryHumanReviewReservation }
  | { outcome: "applied" | "unchanged"; binding: import("./binding.js").Binding; notification: PrimaryHumanReviewReservation };
