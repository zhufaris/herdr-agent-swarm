export type WorkerSessionThreadMode = "canonical-main" | "legacy-entry";
export type WorkerSessionThreadState = "legacy-unpublished" | "reserving" | "active" | "stale";

export interface WorkerSessionThread {
  id: string;
  publicationKey: string;
  workerId: string;
  workerSessionGeneration: number;
  parentBindingId: string;
  parentBindingGeneration: number;
  parentPaneId: string;
  chatId: string;
  mode: WorkerSessionThreadMode;
  sourceMainMessageId: string | null;
  actionMessageId: string | null;
  topicId: string | null;
  rootMessageId: string | null;
  state: WorkerSessionThreadState;
  createdAt: string;
  activatedAt: string | null;
  staleAt: string | null;
  updatedAt: string;
}
