import type { Binding } from "../types.js";

export interface ActiveTurnSnapshot {
  promptId: string;
  paneId: string;
  state: Binding["lastAgentState"];
}

export interface PrimaryRuntimeStatePort {
  activeTurn(bindingId: string): ActiveTurnSnapshot | null;
  isBindingBusy(bindingId: string): boolean;
}
