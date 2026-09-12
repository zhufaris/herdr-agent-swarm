import type { TurnOutputObservation } from "../domain/events.js";
import type { TraexTranscriptObservation } from "../domain/ports/external.js";
import { appendTurnOutput, type BoundedTurnOutput } from "../runtime/bounded-turn-output.js";

export interface OwnedTranscriptOutputState {
  emitted: boolean;
  output: BoundedTurnOutput;
  terminalLifecycle?: NonNullable<TraexTranscriptObservation["turnLifecycle"]>;
}

export interface OwnedTranscriptOutputProjection {
  state: OwnedTranscriptOutputState;
  observation?: TurnOutputObservation;
}

/**
 * Reduces safe output from a transcript turn whose ownership was already
 * proven by the caller. It has no cursor, clock, persistence, or publishing
 * dependency and therefore cannot attribute an unowned turn to a prompt.
 */
export function projectOwnedTranscriptOutput(input: {
  state: OwnedTranscriptOutputState;
  observation: TraexTranscriptObservation;
  elapsedSeconds?: number;
}): OwnedTranscriptOutputProjection {
  const lifecycle = input.observation.turnLifecycle;
  const terminalLifecycle = lifecycle?.state === "completed" || lifecycle?.state === "aborted"
    ? lifecycle
    : input.state.terminalLifecycle;
  const output = appendTurnOutput(input.state.output, input.observation.answerDelta);
  const answerChanged = Boolean(input.observation.answerDelta) && !input.state.output.truncated;
  const answerSnapshot = answerChanged ? (output.truncated ? output.text : input.observation.answerDelta) : "";
  const answerUpdate = answerChanged && output.truncated ? "replace-all" as const : "append" as const;
  const emitted = input.state.emitted || Boolean(input.observation.answerDelta);
  const mainStatus = input.observation.mainStatus && input.elapsedSeconds !== undefined
    ? {
      ...(input.observation.mainStatus.statusTitle ? { statusTitle: input.observation.mainStatus.statusTitle } : {}),
      ...(input.observation.mainStatus.planSteps ? { planSteps: input.observation.mainStatus.planSteps.map((step) => ({ ...step, kind: "step" as const })) } : {}),
      elapsedSeconds: Math.max(0, input.elapsedSeconds),
      ...(input.observation.mainStatus.tokenCount !== undefined ? { tokenCount: input.observation.mainStatus.tokenCount } : {})
    }
    : undefined;
  const observation = answerChanged || input.observation.toolActivities?.length || mainStatus
    ? {
      answer: { snapshot: answerSnapshot, update: answerUpdate, toolActivities: input.observation.toolActivities ?? [] },
      main: { ...(mainStatus ? { status: mainStatus } : {}) }
    }
    : undefined;
  return { state: { emitted, output, ...(terminalLifecycle ? { terminalLifecycle } : {}) }, ...(observation ? { observation } : {}) };
}
