import type { AcceptCommandIntentInput, AcceptCommandIntentResult, CommandIntent, CommandIntentTerminalState } from "../../domain/command-intent.js";
import { mapCommandIntent, type CommandIntentRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

export class SqliteCommandIntentStore {
  constructor(private readonly context: SqliteContext) {}

  accept(input: AcceptCommandIntentInput): AcceptCommandIntentResult {
    const commandJson = JSON.stringify(input.command);
    const contextJson = JSON.stringify(input.context);
    return this.context.transaction(() => {
      const existing = this.context.database.prepare("SELECT * FROM swarm_command_intents WHERE idempotency_key = ?").get(input.idempotencyKey) as CommandIntentRow | undefined;
      if (existing) {
        const intent = mapCommandIntent(existing);
        const exact = existing.lane_key === input.laneKey && existing.command_json === commandJson
          && existing.context_json === contextJson && existing.replay_policy === input.replayPolicy;
        return { outcome: exact ? "duplicate" : "conflict", intent };
      }
      this.context.database.prepare(`
        INSERT INTO swarm_command_intents(
          id, idempotency_key, lane_key, command_json, context_json, replay_policy, state, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 0, ?, ?)
      `).run(input.id, input.idempotencyKey, input.laneKey, commandJson, contextJson, input.replayPolicy, input.acceptedAt, input.acceptedAt);
      const intent = this.get(input.id);
      if (!intent) throw new Error(`Command intent insertion was not observable: ${input.id}`);
      return { outcome: "accepted", intent };
    });
  }

  get(id: string): CommandIntent | null {
    const row = this.context.database.prepare("SELECT * FROM swarm_command_intents WHERE id = ?").get(id) as CommandIntentRow | undefined;
    return row ? mapCommandIntent(row) : null;
  }

  claimNext(laneKey?: string): CommandIntent | null {
    return this.context.transaction(() => {
      const row = this.context.database.prepare(`
        SELECT candidate.* FROM swarm_command_intents candidate
        WHERE candidate.state = 'accepted' ${laneKey ? "AND candidate.lane_key = ?" : ""}
          AND NOT EXISTS (
            SELECT 1 FROM swarm_command_intents active
            WHERE active.lane_key = candidate.lane_key AND active.state = 'executing'
          )
        ORDER BY candidate.created_at, candidate.rowid LIMIT 1
      `).get(...(laneKey ? [laneKey] : [])) as CommandIntentRow | undefined;
      if (!row) return null;
      const claimedAt = now();
      const changed = this.context.database.prepare("UPDATE swarm_command_intents SET state = 'executing', attempt_count = attempt_count + 1, claimed_at = ?, updated_at = ? WHERE id = ? AND state = 'accepted'")
        .run(claimedAt, claimedAt, row.id);
      return changed.changes === 1 ? this.get(row.id) : null;
    });
  }

  finish(id: string, state: CommandIntentTerminalState, outcome: CommandIntent["outcome"]): CommandIntent | null {
    const changed = this.context.database.prepare("UPDATE swarm_command_intents SET state = ?, outcome_json = ?, updated_at = ? WHERE id = ? AND state IN ('executing','uncertain')")
      .run(state, outcome === null ? null : JSON.stringify(outcome), now(), id);
    return changed.changes === 1 ? this.get(id) : null;
  }

  listRecoverable(): CommandIntent[] {
    return (this.context.database.prepare("SELECT * FROM swarm_command_intents WHERE state IN ('accepted','uncertain') ORDER BY created_at, rowid").all() as CommandIntentRow[]).map(mapCommandIntent);
  }

  recoverExecuting(recoveredAt: string): number {
    const outcome = JSON.stringify({ code: "restart_during_execution", detail: "Command execution outcome is uncertain after restart", operationKind: null, operationId: null });
    return Number(this.context.database.prepare("UPDATE swarm_command_intents SET state = 'uncertain', outcome_json = COALESCE(outcome_json, ?), updated_at = ? WHERE state = 'executing'")
      .run(outcome, recoveredAt).changes);
  }

  registerWorkerThreadEntry(input: { commandIntentId: string; workerId: string; workerSessionGeneration: number; bindingId: string; bindingGeneration: number; rootMessageId: string }): boolean {
    const timestamp = now();
    return this.context.database.prepare(`
      INSERT INTO worker_thread_entry_requests(command_intent_id, worker_id, worker_session_generation, binding_id, binding_generation, root_message_id, state, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?
      WHERE EXISTS (SELECT 1 FROM swarm_command_intents WHERE id = ? AND state = 'executing')
        AND EXISTS (SELECT 1 FROM agent_instances WHERE id = ? AND role = 'worker' AND worker_session_generation = ? AND parent_binding_id = ? AND parent_binding_generation = ?)
    `).run(input.commandIntentId, input.workerId, input.workerSessionGeneration, input.bindingId, input.bindingGeneration, input.rootMessageId, timestamp, timestamp, input.commandIntentId, input.workerId, input.workerSessionGeneration, input.bindingId, input.bindingGeneration).changes === 1;
  }
}

function now(): string { return new Date().toISOString(); }
