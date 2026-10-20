export type InputCardState = "pending" | "working";

export interface InputCardView {
  submissionId: string;
  state: InputCardState;
  text: string;
  ownerKind: "primary" | "worker";
}

export interface InputCardReservation {
  rootMessageId: string;
  pendingCard: object;
  workingCard: object;
}

export interface PendingTurnCardReservation {
  segmentId: string;
  rootMessageId: string;
  card: object;
}
