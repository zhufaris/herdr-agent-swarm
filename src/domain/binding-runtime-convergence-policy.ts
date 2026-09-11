import type { HerdrPane } from "./types.js";

export interface ObservedAgentState { terminalId: string | null; sequence: number; state: HerdrPane["agentState"] }

export function applyMonotonicAgentState(pane: HerdrPane, previous: ObservedAgentState | undefined): { pane: HerdrPane; observation: ObservedAgentState | null } {
  const sequence = pane.stateChangeSeq;
  if (sequence === null || sequence === undefined) return { pane, observation: null };
  const observation = { terminalId: pane.terminalId ?? null, sequence, state: pane.agentState };
  if (previous && previous.terminalId === observation.terminalId && sequence <= previous.sequence) return { pane: { ...pane, agentState: previous.state }, observation: null };
  return { pane, observation };
}

export function isConfirmedUnregisteredTraexAgent(pane: HerdrPane): boolean { return pane.agentKind === null && pane.foregroundExecutables.includes("traex"); }
export function isTraexCompatiblePane(pane: HerdrPane): boolean {
  return pane.foregroundExecutables.includes("traex") || pane.agentKind === "traex";
}
