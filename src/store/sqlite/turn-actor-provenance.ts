import type { ControlActor } from "../../domain/commands.js";

export interface TurnActorProvenance {
  actorKind: ControlActor["kind"] | null;
  sourceBindingId: string | null;
  sourceBindingGeneration: number | null;
  sourceParentPromptId: string | null;
}

export function turnActorProvenance(actor: ControlActor): TurnActorProvenance {
  return actor.kind === "thread-primary"
    ? { actorKind: actor.kind, sourceBindingId: actor.bindingId, sourceBindingGeneration: actor.bindingGeneration, sourceParentPromptId: actor.parentPromptId }
    : { actorKind: actor.kind === "human" ? actor.kind : null, sourceBindingId: null, sourceBindingGeneration: null, sourceParentPromptId: null };
}
