import type { AgentTranscriptCursorPort, AgentTranscriptObservation, AgentTranscriptReaderPort, AgentTranscriptSource, AgentTranscriptUnavailableReason } from "../domain/ports/external.js";
import type { HerdrAgentSession } from "../domain/types.js";

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
  | { kind: "accepted"; observation: AgentTranscriptObservation }
  | { kind: "empty" | "duplicate" }
  | { kind: "foreign"; observedTurnId: string | null; observedStartedAt: string | null };

export interface ExactTurnCursor {
  read(): Promise<ExactTurnReadResult>;
  drain(input: { limit: number; onObservation(observation: AgentTranscriptObservation): "continue" | "stop" | Promise<"continue" | "stop"> }): Promise<{ accepted: number; stopped: boolean }>;
}

export type ExactTurnOpenResult =
  | { mode: "typed"; cursor: ExactTurnCursor }
  | { mode: "unavailable"; reason: AgentTranscriptUnavailableReason | "recovery_cursor_unavailable" };

export class ExactTurnObserver {
  constructor(private readonly reader: AgentTranscriptReaderPort) {}

  async open(input: ({ source: AgentTranscriptSource } | { session: HerdrAgentSession | null }) & { boundary: TranscriptBoundary; expected?: ExactTurnIdentity }): Promise<ExactTurnOpenResult> {
    const source = "source" in input ? input.source : input.session;
    const opened = await this.openBoundary(source, input.boundary);
    if (opened.mode === "unavailable") return opened;
    return { mode: "typed", cursor: new FilteringExactTurnCursor(opened.cursor, input.expected) };
  }

  private openBoundary(source: AgentTranscriptSource | HerdrAgentSession | null, boundary: TranscriptBoundary) {
    const reader = this.reader as LegacyCompatibleTranscriptReader;
    if (boundary.kind === "latest") return reader.open(source);
    if (boundary.kind === "active") return reader.openActiveTurn?.(source) ?? reader.open(source);
    if (boundary.kind === "first") {
      if (!reader.openFirstTurn) return Promise.resolve({ mode: "unavailable" as const, reason: "recovery_cursor_unavailable" as const });
      return reader.openFirstTurn(source);
    }
    if (boundary.kind === "at") {
      if (!reader.openAtTurn) return Promise.resolve({ mode: "unavailable" as const, reason: "recovery_cursor_unavailable" as const });
      return reader.openAtTurn(source, boundary.turnId, boundary.startedAt);
    }
    if (!reader.openAfterTurn) return Promise.resolve({ mode: "unavailable" as const, reason: "recovery_cursor_unavailable" as const });
    return reader.openAfterTurn(source, boundary.turnId, boundary.startedAt);
  }
}

type LegacyCompatibleTranscriptReader = {
  open(source: AgentTranscriptSource | HerdrAgentSession | null): Promise<import("../domain/ports/external.js").AgentTranscriptOpenResult>;
  openActiveTurn?(source: AgentTranscriptSource | HerdrAgentSession | null): Promise<import("../domain/ports/external.js").AgentTranscriptOpenResult>;
  openFirstTurn?(source: AgentTranscriptSource | HerdrAgentSession | null): Promise<import("../domain/ports/external.js").AgentTranscriptOpenResult>;
  openAtTurn?(source: AgentTranscriptSource | HerdrAgentSession | null, turnId: string, startedAt: string): Promise<import("../domain/ports/external.js").AgentTranscriptOpenResult>;
  openAfterTurn?(source: AgentTranscriptSource | HerdrAgentSession | null, turnId: string, startedAt: string): Promise<import("../domain/ports/external.js").AgentTranscriptOpenResult>;
};

class FilteringExactTurnCursor implements ExactTurnCursor {
  private lastAcceptedSignature = "";

  constructor(private readonly cursor: AgentTranscriptCursorPort, private readonly expected?: ExactTurnIdentity) {}

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

  async drain(input: { limit: number; onObservation(observation: AgentTranscriptObservation): "continue" | "stop" | Promise<"continue" | "stop"> }): Promise<{ accepted: number; stopped: boolean }> {
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

function matchesExactTurn(observation: AgentTranscriptObservation, expected: ExactTurnIdentity): boolean {
  const turnId = observation.turnId ?? observation.turnLifecycle?.turnId;
  if (turnId !== expected.turnId) return false;
  return !observation.turnLifecycle || observation.turnLifecycle.startedAt === expected.startedAt;
}

function hasObservation(observation: AgentTranscriptObservation): boolean {
  return Boolean(observation.turnId || observation.freshTurnStart || observation.requestText !== undefined || observation.answerDelta || observation.timelineDeltas?.length || observation.toolActivities?.length || observation.mainStatus || observation.turnLifecycle);
}
