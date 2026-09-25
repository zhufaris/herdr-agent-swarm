import type { AnswerPage, Binding } from "../../../domain/types.js";
import type { CardContextTarget } from "../../../domain/card-context-invalidation.js";
import type { RunCardView } from "../../../domain/run-card-view.js";
import type { WorkerMainView } from "../../../domain/worker-main-view.js";
import type { WorkerTurnCardPage, WorkerTurnCardView } from "../../../domain/worker-turn-card-view.js";

export interface OutboxRecoveryDependencies {
  getBinding(id: string): Binding | null;
  loadRunCard(promptId: string): RunCardView | null;
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
  listWorkerTurnCardPages(turnId: string): WorkerTurnCardPage[];
  loadWorkerMainView(workerId: string, workerSessionGeneration: number): WorkerMainView | null;
  saveRunCard(view: RunCardView): RunCardView;
  persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
  invalidateCardContexts(targets: readonly (CardContextTarget & { reason: string })[]): unknown;
}
