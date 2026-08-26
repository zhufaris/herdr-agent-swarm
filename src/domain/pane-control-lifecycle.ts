import type { PaneControlOperationState } from "./types.js";

export type PaneControlOutcome = Extract<PaneControlOperationState, "applied" | "confirmed" | "rejected" | "failed" | "uncertain">;

export function paneControlOutcomeSources(outcome: PaneControlOutcome): readonly PaneControlOperationState[] {
  return outcome === "applied" ? ["running"] : ["running", "applied"];
}

export function isTerminalPaneControlState(state: PaneControlOperationState): boolean {
  return state === "confirmed" || state === "rejected" || state === "failed" || state === "uncertain";
}
