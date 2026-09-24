import type { WorkerCardDisplayInput, WorkerCardDisplayPort, WorkerCardDisplayReceipt, WorkerCardDisplayStore } from "../domain/ports/worker-card-display.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";

export class WorkerCardDisplayWorkflow implements WorkerCardDisplayPort {
  constructor(private readonly store: WorkerCardDisplayStore, private readonly wakeOutbound: () => void, private readonly presentation: Pick<ApplicationPresentation, "workerStatusSnapshot">) {}

  show(input: WorkerCardDisplayInput): WorkerCardDisplayReceipt {
    const receipt = this.store.reserveWorkerCardDisplay({
      ...input,
      renderSnapshot: this.presentation.workerStatusSnapshot
    });
    this.wakeOutbound();
    return receipt;
  }
}
