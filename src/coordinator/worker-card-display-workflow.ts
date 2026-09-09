import { renderWorkerStatusSnapshot } from "../cards/worker-main-card.js";
import type { WorkerCardDisplayReceipt, WorkerCardDisplayStore } from "../domain/ports/worker-card-display.js";

export class WorkerCardDisplayWorkflow {
  constructor(private readonly store: WorkerCardDisplayStore, private readonly wakeOutbound: () => void) {}

  show(input: { bindingId: string; bindingGeneration: number; parentPromptId: string; projectId: string; workerName: string; rootMessageId: string; idempotencyKey: string }): WorkerCardDisplayReceipt {
    const receipt = this.store.reserveWorkerCardDisplay({
      ...input,
      renderSnapshot: renderWorkerStatusSnapshot
    });
    this.wakeOutbound();
    return receipt;
  }
}
