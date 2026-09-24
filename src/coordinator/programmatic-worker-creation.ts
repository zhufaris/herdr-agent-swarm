import type { CreateWorkerResult } from "../domain/agent-instance.js";
import type { IncomingLarkCardAction } from "../domain/types.js";
import type { PrimaryIdentity, PrimaryWorkerCreationPort } from "../runtime/primary-tool-broker.js";
import type { WorkerCreationGateway } from "./instance-interactions/worker-lifecycle-actions.js";
import type { SwarmCommandRequest, SwarmCommandRuntime } from "./swarm-command-gateway.js";

type WorkerCreateCommand = Extract<SwarmCommandRequest, { source: "card" }>["command"];

export class ProgrammaticWorkerCreation implements WorkerCreationGateway, PrimaryWorkerCreationPort {
  constructor(private readonly runtime: Pick<SwarmCommandRuntime, "submit" | "observe">, private readonly timeoutMs: number) {}

  createWorkerFromCard(action: IncomingLarkCardAction, bindingId: string, command: WorkerCreateCommand): Promise<CreateWorkerResult> {
    return this.submitAndObserve({ source: "card", action, bindingId, command });
  }

  createWorkerFromPrimaryTool(input: PrimaryIdentity & { idempotencyKey: string; command: WorkerCreateCommand }): Promise<CreateWorkerResult> {
    return this.submitAndObserve({ source: "primary-tool", ...input });
  }

  private async submitAndObserve(request: Extract<SwarmCommandRequest, { source: "card" | "primary-tool" }>): Promise<CreateWorkerResult> {
    const receipt = await this.runtime.submit(request);
    if (receipt.outcome !== "accepted") {
      if (receipt.outcome === "rejected") throw new Error(receipt.message);
      throw new Error("Idempotency key was already used for a different Worker creation request");
    }
    const observation = await this.runtime.observe(receipt.intent.id, this.timeoutMs);
    if (observation.outcome === "succeeded" && observation.workerResult) return observation.workerResult;
    if (observation.outcome === "pending") throw new Error(`Worker creation is still ${observation.intent.state}; observe intent ${receipt.intent.id} again`);
    throw new Error(observation.intent.outcome?.detail ?? `Worker creation ended ${observation.outcome}`);
  }
}
