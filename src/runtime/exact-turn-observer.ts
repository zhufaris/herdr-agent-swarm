import type { HerdrAgentSession } from "../domain/types.js";
import type { TraexTranscriptCursorPort, TraexTranscriptObservation, TraexTranscriptReaderPort, TraexTranscriptUnavailableReason } from "../domain/ports/external.js";

export interface ExactTurnIdentity {
  turnId: string;
  startedAt: string;
}

export type TranscriptBoundary =
  | { kind: "latest" }
  | { kind: "active" }
  | { kind: "first" }
  | ({ kind: "at" | "after" } & ExactTurnIdentity);

export type ExactTurnReadResult =
  | { kind: "accepted"; observation: TraexTranscriptObservation }
  | { kind: "empty" | "duplicate" }
  | { kind: "foreign"; observedTurnId: string | null; observedStartedAt: string | null };

export interface ExactTurnCursor {
  read(): Promise<ExactTurnReadResult>;
  drain(input: { limit: number; onObservation(observation: TraexTranscriptObservation): "continue" | "stop" | Promise<"continue" | "stop"> }): Promise<{ accepted: number; stopped: boolean }>;
}

export type ExactTurnOpenResult =
  | { mode: "typed"; cursor: ExactTurnCursor }
  | { mode: "unavailable"; reason: TraexTranscriptUnavailableReason | "recovery_cursor_unavailable" };

export class ExactTurnObserver {
  constructor(private readonly reader: TraexTranscriptReaderPort) {}

  async open(input: { session: HerdrAgentSession | null; boundary: TranscriptBoundary; expected?: ExactTurnIdentity }): Promise<ExactTurnOpenResult> {
    const opened = await this.openBoundary(input.session, input.boundary);
    if (opened.mode === "unavailable") return opened;
    return { mode: "typed", cursor: new FilteringExactTurnCursor(opened.cursor, input.expected) };
  }

  private openBoundary(session: HerdrAgentSession | null, boundary: TranscriptBoundary) {
    if (boundary.kind === "latest") return this.reader.open(session);
    if (boundary.kind === "active") return this.reader.openActiveTurn?.(session) ?? this.reader.open(session);
    if (boundary.kind === "first") {
      if (!this.reader.openFirstTurn) return Promise.resolve({ mode: "unavailable" as const, reason: "recovery_cursor_unavailable" as const });
      return this.reader.openFirstTurn(session);
    }
    if (boundary.kind === "at") {
      if (!this.reader.openAtTurn) return Promise.resolve({ mode: "unavailable" as const, reason: "recovery_cursor_unavailable" as const });
      return this.reader.openAtTurn(session, boundary.turnId, boundary.startedAt);
    }
    if (!this.reader.openAfterTurn) return Promise.resolve({ mode: "unavailable" as const, reason: "recovery_cursor_unavailable" as const });
    return this.reader.openAfterTurn(session, boundary.turnId, boundary.startedAt);
  }
}

class FilteringExactTurnCursor implements ExactTurnCursor {
  private lastAcceptedSignature = "";

  constructor(private readonly cursor: TraexTranscriptCursorPort, private readonly expected?: ExactTurnIdentity) {}

  async read(): Promise<ExactTurnReadResult> {
    const observation = this.cursor.readObservation
      ? await this.cursor.readObservation()
      : { answerDelta: await this.cursor.readDelta() };
    if (!hasObservation(observation)) return { kind: "empty" };
    if (this.expected && !matchesExactTurn(observation, this.expected)) {
      return {
        kind: "foreign",
        observedTurnId: observation.turnId ?? observation.turnLifecycle?.turnId ?? null,
        observedStartedAt: observation.turnLifecycle?.startedAt ?? null
      };
    }
    const signature = JSON.stringify(observation);
    if (signature === this.lastAcceptedSignature) return { kind: "duplicate" };
    this.lastAcceptedSignature = signature;
    return { kind: "accepted", observation };
  }

  async drain(input: { limit: number; onObservation(observation: TraexTranscriptObservation): "continue" | "stop" | Promise<"continue" | "stop"> }): Promise<{ accepted: number; stopped: boolean }> {
    let accepted = 0;
    for (let count = 0; count < input.limit; count += 1) {
      const result = await this.read();
      if (result.kind === "empty" || result.kind === "duplicate") return { accepted, stopped: false };
      if (result.kind !== "accepted") continue;
      accepted += 1;
      if (await input.onObservation(result.observation) === "stop") return { accepted, stopped: true };
    }
    return { accepted, stopped: false };
  }
}

function matchesExactTurn(observation: TraexTranscriptObservation, expected: ExactTurnIdentity): boolean {
  const turnId = observation.turnId ?? observation.turnLifecycle?.turnId;
  if (turnId !== expected.turnId) return false;
  return !observation.turnLifecycle || observation.turnLifecycle.startedAt === expected.startedAt;
}

function hasObservation(observation: TraexTranscriptObservation): boolean {
  return Boolean(observation.turnId || observation.freshTurnStart || observation.requestText !== undefined || observation.answerDelta || observation.timelineDeltas?.length || observation.toolActivities?.length || observation.mainStatus || observation.turnLifecycle);
}
