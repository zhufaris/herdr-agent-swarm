import type {
  InstanceEventKind,
  InstanceTurn,
} from "../../../domain/instance-turn.js";
import { reduceWorkerTurnCard } from "../../../domain/worker-turn-card-view.js";
import type { SqliteContext } from "../context.js";
import type { WorkerTurnProjection } from "./projection.js";
import { mapInstanceTurn } from "./records.js";

export class WorkerTurnRecovery {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      projection: WorkerTurnProjection;
      insertInstanceEvent(
        projectId: string,
        instanceId: string,
        turnId: string | null,
        kind: InstanceEventKind,
        payload: Record<string, unknown>,
      ): number;
    },
  ) {}
  recover(): {
    requeuedTurnIds: string[];
    cancelledLegacyTurnIds: string[];
    observableTurns: InstanceTurn[];
  } {
    const timestamp = now();
    const notice = "Legacy Worker session is detached and cannot be resumed";
    const legacy = this.context.database
      .prepare(
        `SELECT t.* FROM instance_turns t JOIN agent_instances i ON i.id = t.instance_id AND i.generation = t.instance_generation WHERE t.state = 'queued' AND i.role = 'worker' AND i.worker_session_lifecycle = 'legacy' AND i.observed_state = 'detached' AND i.pane_id IS NULL AND i.pending_pane_id IS NULL ORDER BY t.created_at, t.rowid`,
      )
      .all() as Array<Record<string, unknown>>;
    const cancelledLegacyTurnIds: string[] = [];
    for (const row of legacy) {
      const turn = mapInstanceTurn(row)!;
      const changed = this.context.database
        .prepare(
          `UPDATE instance_turns SET state = 'cancelled', error = ?, updated_at = ? WHERE id = ? AND instance_generation = ? AND state = 'queued' AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.id = instance_turns.instance_id AND i.generation = instance_turns.instance_generation AND i.role = 'worker' AND i.worker_session_lifecycle = 'legacy' AND i.observed_state = 'detached' AND i.pane_id IS NULL AND i.pending_pane_id IS NULL)`,
        )
        .run(notice, timestamp, turn.id, turn.instanceGeneration);
      if (changed.changes !== 1) continue;
      const view = this.dependencies.projection.load(turn.id);
      if (view)
        this.dependencies.projection.save({
          ...reduceWorkerTurnCard(view, {
            type: "cancelled",
            occurredAt: timestamp,
            notice,
          }),
          resultCapture: "unavailable",
        });
      this.dependencies.insertInstanceEvent(
        turn.projectId,
        turn.instanceId,
        turn.id,
        "turn.cancelled",
        { state: "cancelled", reason: "legacy_worker_unrecoverable" },
      );
      cancelledLegacyTurnIds.push(turn.id);
    }
    const claimed = this.context.database
      .prepare(
        `SELECT t.id, t.project_id, t.instance_id FROM instance_turns t JOIN agent_instances i ON i.id = t.instance_id AND i.generation = t.instance_generation WHERE t.state = 'claimed' ORDER BY t.created_at, t.rowid`,
      )
      .all() as Array<{ id: string; project_id: string; instance_id: string }>;
    for (const turn of claimed) {
      this.context.database
        .prepare(
          "UPDATE instance_turns SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'claimed'",
        )
        .run(timestamp, turn.id);
      this.dependencies.insertInstanceEvent(
        turn.project_id,
        turn.instance_id,
        turn.id,
        "turn.requeued-after-restart",
        {},
      );
    }
    return {
      requeuedTurnIds: claimed.map(({ id }) => id),
      cancelledLegacyTurnIds,
      observableTurns: this.listObservable(),
    };
  }
  listObservable(): InstanceTurn[] {
    return this.rows(
      `SELECT t.* FROM instance_turns t JOIN agent_instances i ON i.id = t.instance_id AND i.generation = t.instance_generation WHERE t.state IN ('dispatching','running','blocked','dispatch-uncertain') ORDER BY t.created_at, t.rowid`,
    );
  }
  listObservableByPaneIds(paneIds: readonly string[]): InstanceTurn[] {
    const unique = [...new Set(paneIds)];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => "?").join(",");
    return this.rows(
      `SELECT t.* FROM instance_turns t JOIN agent_instances i ON i.id = t.instance_id AND i.generation = t.instance_generation WHERE t.state IN ('dispatching','running','blocked','dispatch-uncertain') AND i.pane_id IN (${placeholders}) ORDER BY t.created_at, t.rowid`,
      unique,
    );
  }
  diagnostics(): {
    queuedTurns: number;
    activeTurns: number;
    uncertainTurns: number;
  } {
    const row = this.context.database
      .prepare(
        `SELECT SUM(CASE WHEN t.state = 'queued' THEN 1 ELSE 0 END) AS queued_turns, SUM(CASE WHEN t.state IN ('claimed','dispatching','running','blocked') THEN 1 ELSE 0 END) AS active_turns, SUM(CASE WHEN t.state = 'dispatch-uncertain' THEN 1 ELSE 0 END) AS uncertain_turns FROM instance_turns t JOIN agent_instances i ON i.id = t.instance_id AND i.generation = t.instance_generation`,
      )
      .get() as {
      queued_turns: number | null;
      active_turns: number | null;
      uncertain_turns: number | null;
    };
    return {
      queuedTurns: row.queued_turns ?? 0,
      activeTurns: row.active_turns ?? 0,
      uncertainTurns: row.uncertain_turns ?? 0,
    };
  }
  private rows(
    sql: string,
    parameters: readonly string[] = [],
  ): InstanceTurn[] {
    return (
      this.context.database.prepare(sql).all(...parameters) as Array<
        Record<string, unknown>
      >
    ).map((row) => mapInstanceTurn(row)!);
  }
}
function now(): string {
  return new Date().toISOString();
}
