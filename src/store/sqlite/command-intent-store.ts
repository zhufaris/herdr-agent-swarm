import type { AcceptCommandIntentInput, AcceptCommandIntentResult, CommandIntent, CommandIntentTerminalState } from "../../domain/command-intent.js";
import { createAcceptedCommandStatusView, transitionCommandStatusView, type CommandStatusView } from "../../domain/command-status-view.js";
import type { SwarmCommandSource } from "../../domain/swarm-command.js";
import type { CommandStatusRenderer } from "../../domain/ports/swarm-command.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import { mapCommandIntent, mapCommandStatusView, type CommandIntentRow, type CommandStatusViewRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

export class SqliteCommandIntentStore {
  constructor(private readonly context: SqliteContext, private readonly dependencies: { enqueue(input: EnqueueOutboundReplyInput): unknown }) {}

  accept(input: AcceptCommandIntentInput, source: SwarmCommandSource = "literal", renderStatus: CommandStatusRenderer = identityStatus): AcceptCommandIntentResult {
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
      const view = createAcceptedCommandStatusView(input, source);
      this.saveStatus(view, renderStatus);
      this.projectStatus(view, input.context.rootMessageId ?? input.context.sourceMessageId, input.context.primary?.bindingId ?? null, renderStatus);
      const intent = this.get(input.id);
      if (!intent) throw new Error(`Command intent insertion was not observable: ${input.id}`);
      return { outcome: "accepted", intent };
    });
  }

  get(id: string): CommandIntent | null {
    const row = this.context.database.prepare("SELECT * FROM swarm_command_intents WHERE id = ?").get(id) as CommandIntentRow | undefined;
    return row ? mapCommandIntent(row) : null;
  }

  getStatus(id: string): CommandStatusView | null {
    const row = this.context.database.prepare("SELECT * FROM command_status_views WHERE intent_id = ?").get(id) as CommandStatusViewRow | undefined;
    return row ? mapCommandStatusView(row) : null;
  }

  claimNext(laneKey?: string, renderStatus: CommandStatusRenderer = identityStatus): CommandIntent | null {
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
      if (changed.changes !== 1) return null;
      const intent = this.get(row.id);
      if (!intent) throw new Error(`Claimed Command intent was not observable: ${row.id}`);
      this.transitionStatus(intent, claimedAt, renderStatus);
      return intent;
    });
  }

  finish(id: string, state: CommandIntentTerminalState, outcome: CommandIntent["outcome"], renderStatus: CommandStatusRenderer = identityStatus): CommandIntent | null {
    return this.context.transaction(() => {
      const occurredAt = now();
      const changed = this.context.database.prepare("UPDATE swarm_command_intents SET state = ?, outcome_json = ?, updated_at = ? WHERE id = ? AND state IN ('executing','uncertain')")
        .run(state, outcome === null ? null : JSON.stringify(outcome), occurredAt, id);
      if (changed.changes !== 1) return null;
      const intent = this.get(id);
      if (!intent) throw new Error(`Finished Command intent was not observable: ${id}`);
      this.transitionStatus(intent, occurredAt, renderStatus);
      return intent;
    });
  }

  listRecoverable(): CommandIntent[] {
    return (this.context.database.prepare("SELECT * FROM swarm_command_intents WHERE state IN ('accepted','uncertain') ORDER BY created_at, rowid").all() as CommandIntentRow[]).map(mapCommandIntent);
  }

  recoverExecuting(recoveredAt: string, renderStatus: CommandStatusRenderer = identityStatus): number {
    const outcome = JSON.stringify({ code: "restart_during_execution", detail: "Command execution outcome is uncertain after restart", operationKind: null, operationId: null });
    return this.context.transaction(() => {
      const ids = (this.context.database.prepare("SELECT id FROM swarm_command_intents WHERE state = 'executing' ORDER BY created_at").all() as Array<{ id: string }>).map(({ id }) => id);
      const changed = Number(this.context.database.prepare("UPDATE swarm_command_intents SET state = 'uncertain', outcome_json = COALESCE(outcome_json, ?), updated_at = ? WHERE state = 'executing'").run(outcome, recoveredAt).changes);
      for (const id of ids) { const intent = this.get(id); if (intent) this.transitionStatus(intent, recoveredAt, renderStatus); }
      return changed;
    });
  }

  private transitionStatus(intent: CommandIntent, occurredAt: string, renderStatus: CommandStatusRenderer): void {
    const current = this.getStatus(intent.id);
    if (!current) return;
    const next = transitionCommandStatusView(current, { state: intent.state, attemptCount: intent.attemptCount, outcome: intent.outcome, occurredAt });
    if (next === current) return;
    this.saveStatus(next, renderStatus);
    this.projectStatus(next, intent.context.rootMessageId ?? intent.context.sourceMessageId, intent.context.primary?.bindingId ?? null, renderStatus);
  }

  private saveStatus(view: CommandStatusView, renderStatus: CommandStatusRenderer): void {
    const cardJson = JSON.stringify(renderStatus(view));
    this.context.database.prepare(`
      INSERT INTO command_status_views(intent_id, command_kind, summary, source, actor_open_id, lane_key, state, attempt_count, outcome_json, message_id, card_id, card_json, revision, delivered_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(intent_id) DO UPDATE SET state = excluded.state, attempt_count = excluded.attempt_count, outcome_json = excluded.outcome_json, card_json = excluded.card_json, revision = excluded.revision, updated_at = excluded.updated_at
      WHERE excluded.revision > command_status_views.revision
    `).run(view.intentId, view.commandKind, view.summary, view.source, view.actorOpenId, view.laneKey, view.state, view.attemptCount, view.outcome === null ? null : JSON.stringify(view.outcome), view.messageId, view.cardId, cardJson, view.revision, view.deliveredRevision, view.createdAt, view.updatedAt);
  }

  private projectStatus(view: CommandStatusView, replyTarget: string, bindingId: string | null, renderStatus: CommandStatusRenderer): void {
    const projectionKey = `command-status:${view.intentId}`;
    const create = this.context.database.prepare("SELECT state, first_claimed_at FROM outbound_replies WHERE idempotency_key = ?").get(`${projectionKey}:create`) as { state: string; first_claimed_at: string | null } | undefined;
    if (!view.messageId && (!create || (create.state === "pending" && create.first_claimed_at === null))) {
      this.dependencies.enqueue({ id: `${projectionKey}:create`, idempotencyKey: `${projectionKey}:create`, bindingId, targetRole: "operation_result", rootMessageId: replyTarget, kind: "card_reply", payload: JSON.stringify(renderStatus(view)), projectionKey, snapshotRevision: view.revision, laneKeyOverride: projectionKey });
      return;
    }
    if (!view.messageId) return;
    this.dependencies.enqueue({ id: `${projectionKey}:update:${view.revision}`, idempotencyKey: `${projectionKey}:update:${view.revision}`, bindingId, targetRole: "operation_result", rootMessageId: view.messageId, kind: "card_update", payload: JSON.stringify(renderStatus(view)), projectionKey, snapshotRevision: view.revision, laneKeyOverride: projectionKey });
  }

  registerWorkerThreadEntry(input: { commandIntentId: string; workerId: string; workerSessionGeneration: number; bindingId: string; bindingGeneration: number; rootMessageId: string }): boolean {
    const timestamp = now();
    return this.context.transaction(() => {
      const existing = this.context.database.prepare(`
        SELECT worker_id, worker_session_generation, binding_id, binding_generation, root_message_id
        FROM worker_thread_entry_requests WHERE command_intent_id = ?
      `).get(input.commandIntentId) as { worker_id: string; worker_session_generation: number; binding_id: string; binding_generation: number; root_message_id: string } | undefined;
      if (existing) {
        const exact = existing.worker_id === input.workerId
          && existing.worker_session_generation === input.workerSessionGeneration
          && existing.binding_id === input.bindingId
          && existing.binding_generation === input.bindingGeneration
          && existing.root_message_id === input.rootMessageId;
        if (exact) return false;
        throw new Error(`Worker thread entry registration conflicts with existing command intent: ${input.commandIntentId}`);
      }
      const inserted = this.context.database.prepare(`
        INSERT INTO worker_thread_entry_requests(command_intent_id, worker_id, worker_session_generation, binding_id, binding_generation, root_message_id, state, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?
        WHERE EXISTS (SELECT 1 FROM swarm_command_intents WHERE id = ? AND state = 'executing')
          AND EXISTS (SELECT 1 FROM agent_instances WHERE id = ? AND role = 'worker' AND worker_session_generation = ? AND parent_binding_id = ? AND parent_binding_generation = ?)
      `).run(input.commandIntentId, input.workerId, input.workerSessionGeneration, input.bindingId, input.bindingGeneration, input.rootMessageId, timestamp, timestamp, input.commandIntentId, input.workerId, input.workerSessionGeneration, input.bindingId, input.bindingGeneration).changes === 1;
      if (!inserted) return false;
      this.context.database.prepare(`
        INSERT INTO card_context_invalidations(target_kind, target_id, target_generation, requested_dependency_revision, projected_dependency_revision, reason, created_at, updated_at)
        VALUES ('worker-session', ?, ?, 1, 0, 'worker-thread-entry.registered', ?, ?)
        ON CONFLICT(target_kind, target_id, target_generation) DO UPDATE SET
          requested_dependency_revision = card_context_invalidations.requested_dependency_revision + 1,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `).run(input.workerId, input.workerSessionGeneration, timestamp, timestamp);
      return true;
    });
  }
}

function now(): string { return new Date().toISOString(); }
function identityStatus(view: CommandStatusView): object { return view; }
