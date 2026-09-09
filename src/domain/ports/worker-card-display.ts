import type { WorkerMainView } from "../worker-main-view.js";

export interface WorkerCardDisplayReceipt {
  accepted: true;
  delivery: "queued";
  worker: { id: string; name: string; workerSessionGeneration: number };
  cards: ["worker-snapshot"] | ["worker-main", "worker-task"];
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
    renderSnapshot(view: WorkerMainView, generatedAt: string): object;
  }): WorkerCardDisplayReceipt;
}
