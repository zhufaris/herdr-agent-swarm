import { renderWorkerMainCard } from "../cards/worker-main-card.js";
import { renderWorkerNoTaskCard, renderWorkerTurnCard } from "../cards/worker-turn-card.js";
import type { WorkerCardDisplayReceipt, WorkerCardDisplayStore } from "../domain/ports/worker-card-display.js";

export class WorkerCardDisplayWorkflow {
  constructor(private readonly store: WorkerCardDisplayStore, private readonly wakeOutbound: () => void) {}

  show(input: { bindingId: string; bindingGeneration: number; parentPromptId: string; projectId: string; workerName: string; rootMessageId: string; idempotencyKey: string }): WorkerCardDisplayReceipt {
    const receipt = this.store.reserveWorkerCardDisplay({
      ...input,
      renderMain: (view) => renderWorkerMainCard(view, { snapshot: true }),
      renderTask: (view, workerName) => view ? renderWorkerTurnCard(view, undefined, { snapshot: true }) : renderWorkerNoTaskCard(workerName)
    });
    this.wakeOutbound();
    return receipt;
  }
}
