import type { WorkerCardDisplayReceipt, WorkerCardDisplayStore } from "../domain/ports/worker-card-display.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";

export class WorkerCardDisplayWorkflow {
  constructor(private readonly store: WorkerCardDisplayStore, private readonly wakeOutbound: () => void, private readonly presentation: Pick<ApplicationPresentation, "workerStatusSnapshot">) {}

  show(input: { bindingId: string; bindingGeneration: number; parentPromptId: string; projectId: string; workerName: string; rootMessageId: string; idempotencyKey: string }): WorkerCardDisplayReceipt {
    const receipt = this.store.reserveWorkerCardDisplay({
      ...input,
      renderSnapshot: this.presentation.workerStatusSnapshot
    });
    this.wakeOutbound();
    return receipt;
  }
}
