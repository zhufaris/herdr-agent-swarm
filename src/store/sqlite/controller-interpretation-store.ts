import type { ControllerInterpretationJob, ControllerInterpretationJobState, ControllerRuntimeRecord } from "../../domain/controller-interpretation.js";
import { controllerInterpretationResultSchema } from "../../domain/controller-interpretation.js";
import type { ControllerInterpretationStore } from "../../domain/ports/controller-interpretation.js";
import type { IncomingLarkMessage } from "../../domain/types.js";
import type { SqliteContext } from "./context.js";

type Row = { id: string; source_message_id: string; message_json: string; controller_generation: number; capability_hash: string; state: string; result_json: string | null; runtime_turn_id: string | null; dispatched_at: string | null; error: string | null; created_at: string; updated_at: string };
type RuntimeRow = { generation: number; pane_id: string; terminal_id: string; native_session_id: string; state: "active" | "stale"; created_at: string; updated_at: string };

export class SqliteControllerInterpretationStore implements ControllerInterpretationStore {
  constructor(private readonly context: SqliteContext) {}
  acceptControllerInterpretation(input: Parameters<ControllerInterpretationStore["acceptControllerInterpretation"]>[0]) {
    return this.context.transaction(() => {
      const existing = this.bySource(input.message.messageId);
      if (existing) return { job: existing, inserted: false };
      this.context.database.prepare("INSERT INTO controller_interpretation_jobs(id, source_message_id, message_json, controller_generation, capability_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)").run(input.id, input.message.messageId, JSON.stringify(input.message), input.controllerGeneration, input.capabilityHash, input.acceptedAt, input.acceptedAt);
      return { job: this.require(input.id), inserted: true };
    });
  }
  claimNextControllerInterpretation(controllerGeneration: number, capabilityHash: string, claimedAt: string): ControllerInterpretationJob | null {
    return this.context.transaction(() => {
      const row = this.context.database.prepare("SELECT id FROM controller_interpretation_jobs WHERE state = 'accepted' ORDER BY created_at, rowid LIMIT 1").get() as { id: string } | undefined;
      if (!row) return null;
      const changed = this.context.database.prepare("UPDATE controller_interpretation_jobs SET state = 'dispatching', controller_generation = ?, capability_hash = ?, updated_at = ? WHERE id = ? AND state = 'accepted'").run(controllerGeneration, capabilityHash, claimedAt, row.id);
      return changed.changes === 1 ? this.require(row.id) : null;
    });
  }
  markControllerInterpretationDispatched(id: string, controllerGeneration: number, runtimeTurnId: string | null, dispatchedAt: string): ControllerInterpretationJob | null { return this.update(id, controllerGeneration, "state = 'observing', runtime_turn_id = ?, dispatched_at = ?, updated_at = ?", [runtimeTurnId, dispatchedAt, dispatchedAt], "dispatching"); }
  finishControllerInterpretation(id: string, controllerGeneration: number, result: Parameters<ControllerInterpretationStore["finishControllerInterpretation"]>[2], finishedAt: string): ControllerInterpretationJob | null {
    const parsed = controllerInterpretationResultSchema.parse(result);
    const state = parsed.outcome === "command" ? "succeeded" : parsed.outcome;
    return this.update(id, controllerGeneration, "state = ?, result_json = ?, error = NULL, updated_at = ?", [state, JSON.stringify(parsed), finishedAt], "dispatching','observing','uncertain");
  }
  failControllerInterpretation(id: string, controllerGeneration: number, state: "failed" | "uncertain", error: string, finishedAt: string): ControllerInterpretationJob | null { return this.update(id, controllerGeneration, "state = ?, error = ?, updated_at = ?", [state, error.slice(0, 1000), finishedAt], "dispatching','observing"); }
  getControllerInterpretation(id: string): ControllerInterpretationJob | null { const row = this.context.database.prepare("SELECT * FROM controller_interpretation_jobs WHERE id = ?").get(id) as Row | undefined; return row ? map(row) : null; }
  recoverControllerInterpretations(recoveredAt: string): number { return Number(this.context.database.prepare("UPDATE controller_interpretation_jobs SET state = 'uncertain', error = COALESCE(error, 'restart_after_possible_controller_dispatch'), updated_at = ? WHERE state IN ('dispatching','observing')").run(recoveredAt).changes); }
  getControllerRuntime(): ControllerRuntimeRecord | null { const row = this.context.database.prepare("SELECT generation, pane_id, terminal_id, native_session_id, state, created_at, updated_at FROM controller_runtime WHERE singleton = 1").get() as RuntimeRow | undefined; return row ? mapRuntime(row) : null; }
  saveControllerRuntime(input: Omit<ControllerRuntimeRecord, "createdAt" | "updatedAt">, savedAt: string): ControllerRuntimeRecord {
    this.context.database.prepare("INSERT INTO controller_runtime(singleton, generation, pane_id, terminal_id, native_session_id, state, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation, pane_id = excluded.pane_id, terminal_id = excluded.terminal_id, native_session_id = excluded.native_session_id, state = excluded.state, updated_at = excluded.updated_at").run(input.generation, input.paneId, input.terminalId, input.nativeSessionId, input.state, savedAt, savedAt);
    return this.getControllerRuntime()!;
  }
  markControllerRuntimeStale(generation: number, updatedAt: string): boolean { return this.context.database.prepare("UPDATE controller_runtime SET state = 'stale', updated_at = ? WHERE singleton = 1 AND generation = ? AND state = 'active'").run(updatedAt, generation).changes === 1; }
  private bySource(id: string): ControllerInterpretationJob | null { const row = this.context.database.prepare("SELECT * FROM controller_interpretation_jobs WHERE source_message_id = ?").get(id) as Row | undefined; return row ? map(row) : null; }
  private require(id: string): ControllerInterpretationJob { const job = this.getControllerInterpretation(id); if (!job) throw new Error(`Controller interpretation job not found: ${id}`); return job; }
  private update(id: string, generation: number, set: string, values: unknown[], states: string): ControllerInterpretationJob | null { const changed = this.context.database.prepare(`UPDATE controller_interpretation_jobs SET ${set} WHERE id = ? AND controller_generation = ? AND state IN ('${states}')`).run(...values as [], id, generation); return changed.changes === 1 ? this.require(id) : null; }
}
function map(row: Row): ControllerInterpretationJob { return { id: row.id, sourceMessageId: row.source_message_id, message: JSON.parse(row.message_json) as IncomingLarkMessage, controllerGeneration: Number(row.controller_generation), capabilityHash: row.capability_hash, state: row.state as ControllerInterpretationJobState, result: row.result_json ? controllerInterpretationResultSchema.parse(JSON.parse(row.result_json)) : null, runtimeTurnId: row.runtime_turn_id, dispatchedAt: row.dispatched_at, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapRuntime(row: RuntimeRow): ControllerRuntimeRecord { return { generation: Number(row.generation), paneId: row.pane_id, terminalId: row.terminal_id, nativeSessionId: row.native_session_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }; }
