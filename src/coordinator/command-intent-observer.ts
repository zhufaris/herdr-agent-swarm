import type { CreateWorkerResult } from "../domain/agent-instance.js";
import type { CommandIntent } from "../domain/command-intent.js";
import type { InstanceControlPort } from "../domain/ports/instance-workflows.js";
import type { CommandIntentStore } from "../domain/ports/swarm-command.js";

export type CommandIntentObservation =
  | { outcome: "pending"; intent: CommandIntent }
  | { outcome: "succeeded"; intent: CommandIntent; workerResult?: CreateWorkerResult }
  | { outcome: "rejected" | "failed" | "uncertain"; intent: CommandIntent };

export class CommandIntentObserver {
  constructor(private readonly options: { store: Pick<CommandIntentStore, "getCommandIntent">; instances: Pick<InstanceControlPort, "inspect">; pollIntervalMs?: number }) {}

  async observe(intentId: string, timeoutMs = 0): Promise<CommandIntentObservation> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const observation = this.read(intentId);
      if (observation.outcome !== "pending" || Date.now() >= deadline) return observation;
      await delay(Math.min(this.options.pollIntervalMs ?? 25, Math.max(1, deadline - Date.now())));
    }
  }

  private read(intentId: string): CommandIntentObservation {
    const intent = this.options.store.getCommandIntent(intentId);
    if (!intent) throw new Error(`Swarm command intent ${intentId} was not found`);
    if (intent.state === "accepted" || intent.state === "executing") return { outcome: "pending", intent };
    if (intent.state !== "succeeded") return { outcome: intent.state, intent };
    if (intent.command.kind !== "worker_create") return { outcome: "succeeded", intent };
    if (intent.outcome?.operationKind !== "worker" || !intent.outcome.operationId) throw new Error("Completed Worker creation has no durable Worker identity");
    const instance = this.options.instances.inspect(intent.outcome.operationId).instance;
    const workerResult: CreateWorkerResult = intent.outcome.code === "created_start_failed"
      ? { status: "created-start-failed", instance, error: intent.outcome.detail ?? "Worker start failed" }
      : { status: "created", instance };
    return { outcome: "succeeded", intent, workerResult };
  }
}

function delay(timeoutMs: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, timeoutMs)); }
