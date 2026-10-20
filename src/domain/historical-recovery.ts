export interface ExactRecoveryRoute {
  ownerKind: "primary" | "worker";
  ownerId: string;
  ownerGeneration: number;
  gatewayId: string;
  rootMessageId: string;
}

export interface HistoricalCoreRecoveryCandidate {
  laneId: string;
  eventId: string;
  laneSequence: number;
  sourceId: string;
  sourceEpoch: string | null;
  agentKind: "traex" | "pi";
  sessionId: string;
  oldestPendingAt: string;
  route: ExactRecoveryRoute;
}

export interface HistoricalCoreRecoveryResult {
  outcome: "projected" | "retry" | "quarantined" | "stale";
  remaining: boolean;
}

export interface HistoricalRecoverySliceResult {
  projected: number;
  retried: number;
  quarantined: number;
  stale: number;
  processed: number;
  cardsReserved: number;
  cardsStale: number;
  cardsRemaining: boolean;
  remaining: boolean;
  oldestEligibleAt: string | null;
  durationMs: number;
  backlog: HistoricalRecoveryBacklogSummary | null;
}

export interface HistoricalRecoveryBacklogSummary {
  eligiblePendingEvents: number;
  eligibleLanes: number;
  ineligiblePendingEvents: number;
  quarantinedEvents: number;
  oldestEligibleAt: string | null;
}

export interface HistoricalMissingPageCandidate {
  segmentId: string;
  pageIndex: number;
  elementId: string;
  startCursor: import("./delivery.js").AnswerTimelineCursor | null;
  viewVersion: number;
  updatedAt: string;
  route: ExactRecoveryRoute;
}
