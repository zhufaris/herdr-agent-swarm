import type { AcceptCommandIntentInput, CommandIntent, CommandIntentOutcome, CommandIntentState } from "./command-intent.js";
import { swarmCommandDefinition, type SwarmCommandSource } from "./swarm-command.js";

export interface CommandStatusView {
  intentId: string;
  commandKind: CommandIntent["command"]["kind"];
  summary: string;
  source: SwarmCommandSource;
  actorOpenId: string;
  laneKey: string;
  state: CommandIntentState;
  attemptCount: number;
  outcome: CommandIntentOutcome | null;
  messageId: string | null;
  cardId: string | null;
  revision: number;
  deliveredRevision: number;
  createdAt: string;
  updatedAt: string;
}

export function createAcceptedCommandStatusView(input: AcceptCommandIntentInput, source: SwarmCommandSource): CommandStatusView {
  return {
    intentId: input.id, commandKind: input.command.kind, summary: swarmCommandDefinition(input.command).summary, source,
    actorOpenId: input.context.actorOpenId, laneKey: input.laneKey, state: "accepted", attemptCount: 0, outcome: null,
    messageId: null, cardId: null, revision: 1, deliveredRevision: 0, createdAt: input.acceptedAt, updatedAt: input.acceptedAt
  };
}

export function transitionCommandStatusView(view: CommandStatusView, input: { state: CommandIntentState; attemptCount: number; outcome: CommandIntentOutcome | null; occurredAt: string }): CommandStatusView {
  if (view.state === input.state && view.attemptCount === input.attemptCount && sameOutcome(view.outcome, input.outcome)) return view;
  return { ...view, state: input.state, attemptCount: input.attemptCount, outcome: input.outcome, revision: view.revision + 1, updatedAt: input.occurredAt };
}

function sameOutcome(left: CommandIntentOutcome | null, right: CommandIntentOutcome | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
