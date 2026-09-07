import type { ShutdownContext } from "./shutdown-context.js";

export type LifecycleCleanupKind = "writer" | "non-writer";

export type LifecycleCleanupStage =
  | "ingress"
  | "observers"
  | "workers"
  | "projections"
  | "health";

export interface LifecycleCleanupEntry {
  readonly name: string;
  readonly kind: LifecycleCleanupKind;
  readonly stage: LifecycleCleanupStage;
  readonly stop: (context: ShutdownContext) => Promise<void>;
}

const shutdownStages: readonly LifecycleCleanupStage[] = [
  "ingress",
  "observers",
  "workers",
  "projections",
  "health"
];

/** Records only resources that may have started and emits one safe shutdown plan. */
export class RuntimeLifecycleLedger {
  private readonly entries: LifecycleCleanupEntry[] = [];
  private readonly names = new Set<string>();

  register(entry: LifecycleCleanupEntry): void {
    if (this.names.has(entry.name)) throw new Error(`Lifecycle cleanup already registered: ${entry.name}`);
    this.names.add(entry.name);
    this.entries.push(entry);
  }

  shutdownPlan(): readonly LifecycleCleanupEntry[] {
    const registrationOrder = new Map(this.entries.map((entry, index) => [entry.name, index]));
    return shutdownStages.flatMap((stage) => this.entries
      .filter((entry) => entry.stage === stage)
      .sort((left, right) => registrationOrder.get(right.name)! - registrationOrder.get(left.name)!));
  }
}
