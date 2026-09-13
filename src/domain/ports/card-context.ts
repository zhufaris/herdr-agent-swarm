import type { CardContextInvalidation } from "../card-context-invalidation.js";
import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { WorkerMainView } from "../worker-main-view.js";
import type { WorkerTurnCardView } from "../worker-turn-card-view.js";

export interface CardContextProjectionStore {
  listPendingCardContextInvalidations(limit?: number): CardContextInvalidation[];
  projectCardContext(invalidation: CardContextInvalidation, renderers: { workerMain(view: WorkerMainView): object; workerThreadEntryReady(input: { workerName: string; workerId: string; workerSessionGeneration: number; messageId: string }): object; workerTask(view: WorkerTurnCardView): object; primaryMain(view: TopicViewState): object; primaryPaneEntry(view: TopicViewState): object; primaryAnswer(view: RunCardView): object }): "reserved" | "current" | "stale";
}
