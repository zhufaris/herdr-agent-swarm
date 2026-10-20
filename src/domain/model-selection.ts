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

export type ModelDispatchEvidence =
  | { kind: "claimed"; bindingGeneration: number; promptId: string; revision: number; updatedAt: string }
  | { kind: "prepared"; bindingGeneration: number; promptId: string; revision: number; operationId: string; updatedAt: string }
  | { kind: "prepare_aborted"; bindingGeneration: number; promptId: string; revision: number; operationId: string; updatedAt: string }
  | { kind: "accepted"; bindingGeneration: number; promptId: string; revision: number; operationId: string; turnId: string; updatedAt: string }
  | { kind: "dispatch_failed"; bindingGeneration: number; promptId: string; revision: number; updatedAt: string };

type ExternallyRecordedModelEvidence = Extract<ModelDispatchEvidence, { kind: "prepared" | "prepare_aborted" | "accepted" }>;

export type ModelDispatchEvidenceCommand = ExternallyRecordedModelEvidence extends infer Evidence
  ? Evidence extends ExternallyRecordedModelEvidence ? Omit<Evidence, "updatedAt"> & { bindingId: string } : never
  : never;

export interface ModelPreferenceSnapshot {
  state: ModelPreferenceState | "none";
  effective: { model: string; revision: number } | null;
  desired: { model: string; revision: number } | null;
  promptPinned: boolean;
}

export interface TraexModelSummary {
  id: string;
  name: string;
  displayName: string;
}

export type ModelSelectionAcceptance =
  | { outcome: "accepted"; preference: ModelPreference }
  | { outcome: "busy" | "stale"; preference: ModelPreference | null };

export class RuntimeModelPreference {
  request(
    current: ModelPreference | null,
    input: { bindingId: string; bindingGeneration: number; currentBindingGeneration: number; model: string; updatedAt: string }
  ): ModelSelectionAcceptance {
    return acceptModelSelection(current, input);
  }

  recordEvidence(current: ModelPreference | null, evidence: ModelDispatchEvidence): ModelPreference | null {
    if (!current || current.bindingGeneration !== evidence.bindingGeneration || current.desiredRevision !== evidence.revision) return null;
    if (evidence.kind === "claimed") {
      if (current.state !== "pending") return null;
      return { ...current, state: "applying", dispatchPromptId: evidence.promptId, preparedOperationId: null, updatedAt: evidence.updatedAt };
    }
    if (!matchesApplying(current, evidence)) return null;
    if (evidence.kind === "prepared") {
      if (current.preparedOperationId !== null && current.preparedOperationId !== evidence.operationId) return null;
      return { ...current, preparedOperationId: evidence.operationId, updatedAt: evidence.updatedAt };
    }
    if (evidence.kind === "prepare_aborted") {
      if (current.preparedOperationId !== evidence.operationId) return null;
      return { ...current, state: "pending", dispatchPromptId: null, preparedOperationId: null, updatedAt: evidence.updatedAt };
    }
    if (evidence.kind === "accepted") {
      if (current.preparedOperationId !== evidence.operationId) return null;
      return { ...current, state: "effective", effectiveModel: current.desiredModel, effectiveRevision: current.desiredRevision, dispatchPromptId: null, preparedOperationId: null, updatedAt: evidence.updatedAt };
    }
    return current.preparedOperationId === null
      ? { ...current, state: "pending", dispatchPromptId: null, preparedOperationId: null, updatedAt: evidence.updatedAt }
      : { ...current, state: "uncertain", updatedAt: evidence.updatedAt };
  }

  snapshot(current: ModelPreference | null): ModelPreferenceSnapshot {
    if (!current) return { state: "none", effective: null, desired: null, promptPinned: false };
    const effective = current.effectiveModel !== null && current.effectiveRevision !== null
      ? { model: current.effectiveModel, revision: current.effectiveRevision }
      : null;
    return {
      state: current.state,
      effective,
      desired: current.state === "effective" ? null : { model: current.desiredModel, revision: current.desiredRevision },
      promptPinned: current.state === "applying" || current.state === "uncertain"
    };
  }
}

export const runtimeModelPreference = new RuntimeModelPreference();

function acceptModelSelection(
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
