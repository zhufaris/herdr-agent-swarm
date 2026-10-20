export type CompletionActionEligibilityReservation =
  | { outcome: "deferred" }
  | { outcome: "skipped"; reason: "not-completion" | "successor-present" | "stale-routing" | "historical-recovery" | "no-review-choice" };
