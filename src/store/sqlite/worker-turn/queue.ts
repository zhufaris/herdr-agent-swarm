import type { AgentInstance } from "../../../domain/agent-instance.js";
import type {
  InstanceEventKind,
  InstanceTurn,
} from "../../../domain/instance-turn.js";
import { nextWorkerQueuePositions } from "../../../domain/worker-turn-policies.js";
import {
  reduceWorkerTurnCard,
  type WorkerTurnCardView,
} from "../../../domain/worker-turn-card-view.js";
import type { SqliteContext } from "../context.js";
import { mapInstanceTurn, mapWorkerTurnCard } from "./records.js";

export class WorkerTurnQueue {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getAgentInstance(id: string): AgentInstance | null;
      saveWorkerTurnCard(view: WorkerTurnCardView): void;
      invalidateWorkerCardContexts(
        view: WorkerTurnCardView,
        reason: string,
      ): void;
      insertInstanceEvent(
        projectId: string,
        instanceId: string,
        turnId: string | null,
        kind: InstanceEventKind,
        payload: Record<string, unknown>,
      ): number;
    },
  ) {}

  countPending(instanceId: string, expectedGeneration?: number): number {
    const row =
      expectedGeneration === undefined
        ? this.context.database
            .prepare(
              "SELECT COUNT(*) AS count FROM instance_turns WHERE instance_id = ? AND state IN ('queued','claimed','dispatching','running','blocked','dispatch-uncertain')",
            )
            .get(instanceId)
        : this.context.database
            .prepare(
              "SELECT COUNT(*) AS count FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state IN ('queued','claimed','dispatching','running','blocked','dispatch-uncertain')",
            )
            .get(instanceId, expectedGeneration);
    return Number((row as { count: number }).count);
  }

  hasLivePriority(instanceId: string, generation: number): boolean {
    return (
      this.context.database
        .prepare(
          "SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND priority = 'priority' AND state IN ('queued','claimed','dispatching','running','blocked','dispatch-uncertain') LIMIT 1",
        )
        .get(instanceId, generation) !== undefined
    );
  }

  hasActiveRuntime(instanceId: string, generation: number): boolean {
    return (
      this.context.database
        .prepare(
          "SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked','dispatch-uncertain') LIMIT 1",
        )
        .get(instanceId, generation) !== undefined
    );
  }

  nextNormalPosition(instanceId: string, generation: number): number {
    return (
      Number(
        (
          this.context.database
            .prepare(
              "SELECT COUNT(*) AS count FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND priority = 'normal' AND state = 'queued'",
            )
            .get(instanceId, generation) as { count: number }
        ).count,
      ) + 1
    );
  }

  getActive(
    instanceId: string,
    expectedGeneration: number,
  ): InstanceTurn | null {
    const row = this.context.database
      .prepare(
        "SELECT * FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked') ORDER BY created_at, rowid LIMIT 1",
      )
      .get(instanceId, expectedGeneration) as
      | Record<string, unknown>
      | undefined;
    return mapInstanceTurn(row);
  }

  claimNext(
    instanceId: string,
    expectedGeneration: number,
  ): InstanceTurn | null {
    const instance = this.dependencies.getAgentInstance(instanceId);
    if (
      !instance ||
      instance.generation !== expectedGeneration ||
      instance.desiredState !== "running" ||
      !instance.runtimeRef ||
      !["idle", "working", "blocked"].includes(instance.observedState)
    )
      return null;
    if (this.hasActiveRuntime(instanceId, expectedGeneration)) return null;
    const row = this.context.database
      .prepare(
        "SELECT id FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state = 'queued' ORDER BY CASE priority WHEN 'priority' THEN 0 ELSE 1 END, created_at, rowid LIMIT 1",
      )
      .get(instanceId, expectedGeneration) as { id: string } | undefined;
    if (!row) return null;
    this.context.database
      .prepare(
        "UPDATE instance_turns SET state = 'claimed', updated_at = ? WHERE id = ? AND state = 'queued'",
      )
      .run(now(), row.id);
    const turn = mapInstanceTurn(
      this.context.database
        .prepare("SELECT * FROM instance_turns WHERE id = ?")
        .get(row.id) as Record<string, unknown>,
    )!;
    this.dependencies.insertInstanceEvent(
      turn.projectId,
      turn.instanceId,
      turn.id,
      "turn.claimed",
      {},
    );
    return turn;
  }

  repairTerminalPositions(
    instanceId: string,
    generation: number,
    timestamp: string,
  ): void {
    const rows = this.context.database
      .prepare(
        "SELECT c.* FROM worker_turn_cards c JOIN instance_turns t ON t.id = c.turn_id WHERE t.instance_id = ? AND t.instance_generation = ? AND t.state = 'queued' ORDER BY t.created_at, t.rowid",
      )
      .all(instanceId, generation) as Array<Record<string, unknown>>;
    for (const { item: row, queuePosition } of nextWorkerQueuePositions(rows)) {
      const view = mapWorkerTurnCard(row);
      if (!view || view.queuePosition === queuePosition) continue;
      const reordered = reduceWorkerTurnCard(view, {
        type: "queue-position",
        occurredAt: timestamp,
        queuePosition,
      });
      this.dependencies.saveWorkerTurnCard(reordered);
      this.dependencies.invalidateWorkerCardContexts(
        reordered,
        "turn.queue-position",
      );
    }
  }
}

function now(): string {
  return new Date().toISOString();
}
