import type { InstanceStore } from "../domain/ports.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";

export class InstanceWorkScheduler {
  private readonly active = new Set<string>();
  private readonly drains = new Set<Promise<void>>();
  private stopping = false;
  constructor(private readonly options: { store: InstanceStore; drivers: AgentDriverRegistry }) {}

  wake(instanceId: string): void {
    if (this.stopping) return;
    queueMicrotask(() => {
      if (this.stopping) return;
      const drain = this.drain(instanceId);
      this.drains.add(drain);
      void drain.finally(() => this.drains.delete(drain));
    });
  }
  async drain(instanceId: string): Promise<void> {
    if (this.stopping) return;
    if (this.active.has(instanceId)) return;
    this.active.add(instanceId);
    try {
      while (!this.stopping) {
        const instance = this.options.store.getAgentInstance(instanceId);
        if (!instance?.runtimeRef) return;
        const turn = this.options.store.claimNextInstanceTurn(instance.id, instance.generation);
        if (!turn) return;
        const driver = this.options.drivers.get(instance.agentKind);
        if (!driver) { this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "failed", error: "Agent adapter unavailable", eventKind: "turn.failed" }); continue; }
        this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "dispatching", eventKind: "turn.dispatching" });
        const receipt = await driver.submit(instance.runtimeRef, turn.text);
        if (receipt.status === "confirmed-delivered") {
          this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "running", eventKind: "turn.running" });
          this.options.store.updateAgentInstanceLifecycle({ instanceId: instance.id, expectedGeneration: instance.generation, desiredState: "running", observedState: "working" });
        }
        else if (receipt.status === "delivery-uncertain") this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "dispatch-uncertain", error: receipt.reason, eventKind: "turn.dispatch-uncertain" });
        else this.options.store.updateInstanceTurn({ turnId: turn.id, expectedGeneration: turn.instanceGeneration, state: "failed", error: receipt.reason, eventKind: "turn.failed" });
        return;
      }
    } finally { this.active.delete(instanceId); }
  }
  async stop(): Promise<void> { this.stopping = true; await Promise.allSettled([...this.drains]); }
}
