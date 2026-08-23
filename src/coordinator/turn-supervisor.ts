import type { AgentState } from "../domain/types.js";

interface ActiveTurn { promptId: string; paneId: string; state: AgentState; abortController: AbortController }

export class TurnSupervisor {
  private readonly active = new Map<string, ActiveTurn>();

  has(bindingId: string): boolean { return this.active.has(bindingId); }
  get(bindingId: string): ActiveTurn | undefined { return this.active.get(bindingId); }
  size(): number { return this.active.size; }

  attach(bindingId: string, promptId: string, paneId: string, state: AgentState = "working"): AbortController {
    if (this.active.has(bindingId)) throw new Error(`Binding ${bindingId} already has an active turn observer`);
    const abortController = new AbortController();
    this.active.set(bindingId, { promptId, paneId, state, abortController });
    return abortController;
  }

  updateState(bindingId: string, promptId: string, state: AgentState): void {
    const turn = this.active.get(bindingId);
    if (turn?.promptId === promptId) turn.state = state;
  }

  detach(bindingId: string, promptId: string): void {
    if (this.active.get(bindingId)?.promptId === promptId) this.active.delete(bindingId);
  }

  abortAll(onDetach: (turn: Readonly<ActiveTurn>) => void): void {
    for (const turn of this.active.values()) {
      onDetach(turn);
      turn.abortController.abort();
    }
  }
}
