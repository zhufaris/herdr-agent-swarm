export type ModelPreferenceState = "pending" | "applying" | "effective" | "uncertain";

export interface ModelPreference {
  bindingId: string;
  bindingGeneration: number;
  desiredModel: string;
  desiredRevision: number;
  effectiveModel: string | null;
  effectiveRevision: number | null;
  state: ModelPreferenceState;
  dispatchPromptId: string | null;
  preparedOperationId: string | null;
  updatedAt: string;
}

export interface ModelDispatch {
  name: string;
  revision: number;
}

export interface TraexModelSummary {
  id: string;
  name: string;
  displayName: string;
}

export type ModelSelectionAcceptance =
  | { outcome: "accepted"; preference: ModelPreference }
  | { outcome: "busy" | "stale"; preference: ModelPreference | null };

export function acceptModelSelection(
  current: ModelPreference | null,
  input: { bindingId: string; bindingGeneration: number; currentBindingGeneration: number; model: string; updatedAt: string }
): ModelSelectionAcceptance {
  if (input.bindingGeneration !== input.currentBindingGeneration) return { outcome: "stale", preference: current };
  if (current?.bindingGeneration === input.bindingGeneration && (current.state === "applying" || current.state === "uncertain")) {
    return { outcome: "busy", preference: current };
  }
  const sameGeneration = current?.bindingGeneration === input.bindingGeneration;
  return {
    outcome: "accepted",
    preference: {
      bindingId: input.bindingId, bindingGeneration: input.bindingGeneration, desiredModel: input.model,
      desiredRevision: sameGeneration ? current.desiredRevision + 1 : 1,
      effectiveModel: sameGeneration ? current.effectiveModel : null, effectiveRevision: sameGeneration ? current.effectiveRevision : null,
      state: "pending", dispatchPromptId: null, preparedOperationId: null, updatedAt: input.updatedAt
    }
  };
}

type ExactTransition = { promptId: string; revision: number; updatedAt: string };

export function markModelEffective(current: ModelPreference, input: ExactTransition): ModelPreference | null {
  if (!matchesApplying(current, input)) return null;
  return { ...current, state: "effective", effectiveModel: current.desiredModel, effectiveRevision: current.desiredRevision, dispatchPromptId: null, preparedOperationId: null, updatedAt: input.updatedAt };
}

export function rollbackModelBeforeDispatch(current: ModelPreference, input: ExactTransition): ModelPreference | null {
  if (!matchesApplying(current, input)) return null;
  return { ...current, state: "pending", dispatchPromptId: null, preparedOperationId: null, updatedAt: input.updatedAt };
}

export function markModelUncertain(current: ModelPreference, input: ExactTransition): ModelPreference | null {
  if (!matchesApplying(current, input)) return null;
  return { ...current, state: "uncertain", updatedAt: input.updatedAt };
}

export type CatalogModelResolution =
  | { outcome: "resolved"; name: string }
  | { outcome: "invalid" | "not_found" | "ambiguous" };

const CANONICAL_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,127}$/;

export function resolveCatalogModel(requested: string, catalog: readonly string[]): CatalogModelResolution {
  if (!CANONICAL_MODEL_NAME.test(requested)) return { outcome: "invalid" };
  const exact = catalog.filter((name) => CANONICAL_MODEL_NAME.test(name) && name === requested);
  if (exact.length === 1) return { outcome: "resolved", name: exact[0]! };
  if (exact.length > 1) return { outcome: "ambiguous" };
  const candidates = catalog.filter((name) => CANONICAL_MODEL_NAME.test(name) && name.localeCompare(requested, undefined, { sensitivity: "accent" }) === 0);
  return candidates.length === 1 ? { outcome: "resolved", name: candidates[0]! } : candidates.length > 1 ? { outcome: "ambiguous" } : { outcome: "not_found" };
}

function matchesApplying(current: ModelPreference, input: ExactTransition): boolean {
  return current.state === "applying" && current.dispatchPromptId === input.promptId && current.desiredRevision === input.revision;
}
