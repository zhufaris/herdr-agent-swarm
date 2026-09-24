import type { WorkerMainView } from "../worker-main-view.js";

export interface WorkerCardDisplayReceipt {
  accepted: true;
  delivery: "queued";
  worker: { id: string; name: string; workerSessionGeneration: number };
  cards: ["worker-snapshot"] | ["worker-main", "worker-task"];
  taskTurnId: string | null;
}

export interface WorkerCardDisplayInput {
  bindingId: string;
  bindingGeneration: number;
  parentPromptId: string;
  projectId: string;
  workerName: string;
  rootMessageId: string;
  idempotencyKey: string;
}

export interface WorkerCardDisplayPort {
  show(input: WorkerCardDisplayInput): WorkerCardDisplayReceipt;
}

export interface WorkerCardDisplayStore {
  reserveWorkerCardDisplay(input: WorkerCardDisplayInput & {
    renderSnapshot(view: WorkerMainView, generatedAt: string): object;
  }): WorkerCardDisplayReceipt;
}
