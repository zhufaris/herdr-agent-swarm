import type { AgentState } from "../domain/types.js";
import { TurnSupervisor } from "./turn-supervisor.js";

export class PromptRunRegistry {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly steeringWorkers = new Map<string, Promise<void>>();
  private readonly turns = new TurnSupervisor();

  get activeWorkerCount(): number { return this.workers.size; }
  get activeSteeringWorkerCount(): number { return this.steeringWorkers.size; }
  get pendingWorkers(): Promise<void>[] { return [...this.workers.values(), ...this.steeringWorkers.values()]; }
  get activeTurnCount(): number { return this.turns.size(); }

  hasWorker(bindingId: string): boolean { return this.workers.has(bindingId); }
  hasSteeringWorker(bindingId: string): boolean { return this.steeringWorkers.has(bindingId); }
  hasTurn(bindingId: string): boolean { return this.turns.has(bindingId); }
  isBindingBusy(bindingId: string): boolean { return this.hasTurn(bindingId) || this.hasWorker(bindingId) || this.hasSteeringWorker(bindingId); }
  worker(bindingId: string): Promise<void> | undefined { return this.workers.get(bindingId); }
  steeringWorker(bindingId: string): Promise<void> | undefined { return this.steeringWorkers.get(bindingId); }

  registerWorker(bindingId: string, worker: Promise<void>): void {
    this.workers.set(bindingId, worker);
  }

  releaseWorker(bindingId: string, worker: Promise<void>): void {
    if (this.workers.get(bindingId) === worker) this.workers.delete(bindingId);
  }

  registerSteeringWorker(bindingId: string, worker: Promise<void>): void {
    this.steeringWorkers.set(bindingId, worker);
  }

  releaseSteeringWorker(bindingId: string, worker: Promise<void>): void {
    if (this.steeringWorkers.get(bindingId) === worker) this.steeringWorkers.delete(bindingId);
  }

  attachTurn(bindingId: string, promptId: string, paneId: string, state?: AgentState): AbortController {
    return this.turns.attach(bindingId, promptId, paneId, state);
  }

  activeTurn(bindingId: string): { promptId: string; paneId: string; state: AgentState } | null {
    const turn = this.turns.get(bindingId);
    return turn ? { promptId: turn.promptId, paneId: turn.paneId, state: turn.state } : null;
  }

  updateTurnState(bindingId: string, promptId: string, state: AgentState): void { this.turns.updateState(bindingId, promptId, state); }
  detachTurn(bindingId: string, promptId: string): void { this.turns.detach(bindingId, promptId); }
  abortTurn(bindingId: string): void { this.turns.abort(bindingId); }
  abortAll(onAbort: (run: { promptId: string; paneId: string; state: AgentState }) => void): void { this.turns.abortAll(onAbort); }
}
