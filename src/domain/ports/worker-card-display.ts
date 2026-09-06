import type { WorkerMainView } from "../worker-main-view.js";
import type { WorkerTurnCardView } from "../worker-turn-card-view.js";

export interface WorkerCardDisplayReceipt {
  accepted: true;
  delivery: "queued";
  worker: { id: string; name: string; workerSessionGeneration: number };
  cards: ["worker-main", "worker-task"];
  taskTurnId: string | null;
}

export interface WorkerCardDisplayStore {
  reserveWorkerCardDisplay(input: {
    bindingId: string;
    bindingGeneration: number;
    parentPromptId: string;
    projectId: string;
    workerName: string;
    rootMessageId: string;
    idempotencyKey: string;
    renderMain(view: WorkerMainView): object;
    renderTask(view: WorkerTurnCardView | null, workerName: string): object;
  }): WorkerCardDisplayReceipt;
}
