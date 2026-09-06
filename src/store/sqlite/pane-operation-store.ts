import { randomUUID } from "node:crypto";
import { paneControlOutcomeSources, type PaneControlOutcome } from "../../domain/pane-control-lifecycle.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { OutboundTargetRole, PaneCloseOperation, PaneControlOperation, PaneControlOperationKind } from "../../domain/types.js";
import { mapPaneControlOperation, type PaneControlOperationRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

export interface SqlitePaneOperationStoreDependencies {
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): unknown;
}

export class SqlitePaneOperationStore {
  constructor(private readonly context: SqliteContext, private readonly dependencies: SqlitePaneOperationStoreDependencies) {}
  private get database() { return this.context.database; }

  createPaneCloseRequest(input: { id: string; bindingId: string; paneId: string; actorOpenId: string; codeHash: string; expiresAt: string }): void {
    this.context.transaction(() => {
      const timestamp = now();
      this.database.prepare("UPDATE pane_close_requests SET state = 'cancelled', updated_at = ? WHERE binding_id = ? AND state = 'pending'").run(timestamp, input.bindingId);
      this.database.prepare(`INSERT INTO pane_close_requests(id, binding_id, pane_id, actor_open_id, code_hash, state, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(input.id, input.bindingId, input.paneId, input.actorOpenId, input.codeHash, input.expiresAt, timestamp, timestamp);
    });
  }

  createAutomaticPaneCloseOperation(input: { id: string; bindingId: string; paneId: string; now: string }): void {
    this.database.prepare(`INSERT INTO pane_close_requests(id, binding_id, pane_id, actor_open_id, code_hash, state, expires_at, consumed_at, created_at, updated_at, detail) VALUES (?, ?, ?, 'system:auto-close', '', 'executing', ?, ?, ?, ?, 'automatic retention policy')`).run(input.id, input.bindingId, input.paneId, input.now, input.now, input.now, input.now);
  }

  consumePaneCloseRequest(input: { bindingId: string; paneId: string; actorOpenId: string; codeHash: string; now: string }): { outcome: "consumed"; operationId: string; paneId: string } | { outcome: "invalid" | "unauthorized" | "expired" | "stale" } {
    return this.context.transaction(() => {
      const row = this.database.prepare("SELECT id, pane_id, actor_open_id, code_hash, expires_at FROM pane_close_requests WHERE binding_id = ? AND state = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1").get(input.bindingId) as { id: string; pane_id: string; actor_open_id: string; code_hash: string; expires_at: string } | undefined;
      if (!row) return { outcome: "stale" };
      if (row.actor_open_id !== input.actorOpenId) return { outcome: "unauthorized" };
      if (row.pane_id !== input.paneId || row.code_hash !== input.codeHash) return { outcome: "invalid" };
      if (row.expires_at <= input.now) { this.database.prepare("UPDATE pane_close_requests SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'pending'").run(input.now, row.id); return { outcome: "expired" }; }
      const result = this.database.prepare("UPDATE pane_close_requests SET state = 'executing', consumed_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'").run(input.now, input.now, row.id);
      return result.changes === 1 ? { outcome: "consumed", operationId: row.id, paneId: row.pane_id } : { outcome: "stale" };
    });
  }

  finishPaneCloseRequest(operationId: string, state: "succeeded" | "rejected" | "uncertain", detail?: string): void { this.database.prepare("UPDATE pane_close_requests SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state IN ('executing','uncertain')").run(state, detail ?? null, now(), operationId); }

  beginWorkerPaneCloseCascade(input: { operationId: string; bindingId: string; paneId: string; reason: string }): Array<{ workerId: string; paneId: string }> {
    return this.context.transaction(() => {
      const workers = this.database.prepare("SELECT id, generation, pane_id FROM agent_instances WHERE role = 'worker' AND parent_binding_id = ? AND parent_pane_id = ? AND worker_session_lifecycle = 'active' ORDER BY created_at, id").all(input.bindingId, input.paneId) as Array<{ id: string; generation: number; pane_id: string | null }>;
      const timestamp = now();
      for (const worker of workers) {
        this.database.prepare("UPDATE instance_turns SET state = 'cancelled', error = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state = 'queued'").run(input.reason, timestamp, worker.id, worker.generation);
        this.database.prepare("UPDATE instance_turns SET state = 'dispatch-uncertain', error = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked')").run(input.reason, timestamp, worker.id, worker.generation);
        this.database.prepare("UPDATE agent_instances SET desired_state = 'stopped', observed_state = 'stopped', worker_session_lifecycle = 'terminated', generation = generation + 1, herdr_workspace_id = NULL, pane_id = NULL, native_session_id = NULL, pending_herdr_workspace_id = NULL, pending_pane_id = NULL, last_error = ?, updated_at = ? WHERE id = ? AND generation = ?").run(input.reason, timestamp, worker.id, worker.generation);
        if (worker.pane_id) this.database.prepare("INSERT OR IGNORE INTO worker_pane_close_steps(operation_id, binding_id, parent_pane_id, worker_id, pane_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'executing', ?, ?)").run(input.operationId, input.bindingId, input.paneId, worker.id, worker.pane_id, timestamp, timestamp);
      }
      return workers.filter((worker): worker is { id: string; generation: number; pane_id: string } => worker.pane_id !== null).map((worker) => ({ workerId: worker.id, paneId: worker.pane_id }));
    });
  }

  listUnresolvedWorkerPaneCloseSteps(): Array<{ operationId: string; bindingId: string; parentPaneId: string; workerId: string; paneId: string; state: "executing" | "uncertain" }> {
    return (this.database.prepare("SELECT operation_id, binding_id, parent_pane_id, worker_id, pane_id, state FROM worker_pane_close_steps WHERE state IN ('executing','uncertain') ORDER BY created_at, worker_id").all() as Array<{ operation_id: string; binding_id: string; parent_pane_id: string; worker_id: string; pane_id: string; state: "executing" | "uncertain" }>).map((row) => ({ operationId: row.operation_id, bindingId: row.binding_id, parentPaneId: row.parent_pane_id, workerId: row.worker_id, paneId: row.pane_id, state: row.state }));
  }
  finishWorkerPaneCloseStep(input: { operationId: string; workerId: string; paneId: string; state: "succeeded" | "uncertain"; detail?: string }): void { this.database.prepare("UPDATE worker_pane_close_steps SET state = ?, detail = ?, updated_at = ? WHERE operation_id = ? AND worker_id = ? AND pane_id = ? AND state IN ('executing','uncertain')").run(input.state, input.detail ?? null, now(), input.operationId, input.workerId, input.paneId); }
  listUnresolvedPaneCloseOperations(): PaneCloseOperation[] { return (this.database.prepare("SELECT id, binding_id, pane_id, state FROM pane_close_requests WHERE state IN ('executing','uncertain') ORDER BY created_at, id").all() as Array<{ id: string; binding_id: string; pane_id: string; state: PaneCloseOperation["state"] }>).map((row) => ({ id: row.id, bindingId: row.binding_id, paneId: row.pane_id, state: row.state })); }

  acceptPaneControlOperation(input: { id: string; idempotencyKey: string; bindingId: string; paneId: string; terminalId: string | null; bindingGeneration: number; kind: PaneControlOperationKind; payload?: string | null; parentPromptId?: string | null; actorOpenId: string; sourceMessageId: string }): { operation: PaneControlOperation; inserted: boolean } {
    return this.context.transaction(() => {
      const timestamp = now();
      const result = this.database.prepare(`INSERT INTO pane_control_operations(id, idempotency_key, binding_id, pane_id, terminal_id, binding_generation, kind, payload, parent_prompt_id, state, attempt_count, actor_open_id, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 0, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`).run(input.id, input.idempotencyKey, input.bindingId, input.paneId, input.terminalId, input.bindingGeneration, input.kind, input.payload ?? null, input.parentPromptId ?? null, input.actorOpenId, input.sourceMessageId, timestamp, timestamp);
      const operation = this.getPaneControlOperationByKey(input.idempotencyKey);
      if (!operation) throw new Error(`Pane control operation not found: ${input.idempotencyKey}`);
      return { operation, inserted: result.changes === 1 };
    });
  }

  claimNextPaneControlOperation(bindingId?: string): PaneControlOperation | null {
    return this.context.transaction(() => {
      const scope = bindingId ? "AND operation.binding_id = ?" : "";
      const row = this.database.prepare(`SELECT operation.* FROM pane_control_operations AS operation JOIN bindings AS binding ON binding.id = operation.binding_id WHERE operation.state = 'accepted' ${scope} AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached' AND binding.pane_id = operation.pane_id AND binding.generation = operation.binding_generation AND (operation.kind != 'model' OR NOT EXISTS (SELECT 1 FROM prompt_jobs active_prompt WHERE active_prompt.binding_id = operation.binding_id AND active_prompt.state = 'running')) AND (operation.kind = 'stop' OR NOT EXISTS (SELECT 1 FROM pane_control_operations active WHERE active.binding_id = operation.binding_id AND active.kind != 'stop' AND active.state = 'running')) ORDER BY CASE operation.kind WHEN 'stop' THEN 0 WHEN 'steer' THEN 1 ELSE 2 END, operation.created_at, operation.rowid LIMIT 1`).get(...(bindingId ? [bindingId] : [])) as PaneControlOperationRow | undefined;
      if (!row) return null;
      const result = this.database.prepare("UPDATE pane_control_operations SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'accepted'").run(now(), row.id);
      if (result.changes !== 1) throw new Error(`Pane control operation ${row.id} was not atomically claimed`);
      return this.getPaneControlOperation(row.id);
    });
  }

  claimPaneControlOperation(id: string): PaneControlOperation | null { return this.claimState(id, "accepted"); }
  claimAppliedPaneControlOperation(id: string): PaneControlOperation | null { return this.claimState(id, "applied"); }
  rejectAppliedPaneControlOperation(id: string, detail: string): PaneControlOperation | null { const result = this.database.prepare("UPDATE pane_control_operations SET state = 'rejected', detail = ?, updated_at = ? WHERE id = ? AND state = 'applied'").run(detail, now(), id); return result.changes === 1 ? this.getPaneControlOperation(id) : null; }
  getPaneControlOperation(id: string): PaneControlOperation | null { const row = this.database.prepare("SELECT * FROM pane_control_operations WHERE id = ?").get(id) as PaneControlOperationRow | undefined; return row ? mapPaneControlOperation(row) : null; }
  listRecoverablePaneControlOperations(): PaneControlOperation[] { return (this.database.prepare("SELECT * FROM pane_control_operations WHERE state IN ('running', 'applied') ORDER BY updated_at, id").all() as PaneControlOperationRow[]).map(mapPaneControlOperation); }

  finishPaneControlOperation(id: string, state: PaneControlOutcome, detail: string | null = null): boolean {
    const sources = paneControlOutcomeSources(state);
    const placeholders = sources.map(() => "?").join(", ");
    return Number(this.database.prepare(`UPDATE pane_control_operations SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state IN (${placeholders})`).run(state, detail, now(), id, ...sources).changes) === 1;
  }

  finishPaneControlWithResult(input: { operationId: string; state: PaneControlOutcome; detail?: string | null; result: { kind: "card_reply" | "card_update"; targetMessageId: string; idempotencyKey: string; targetRole?: OutboundTargetRole | null; card: object } }): boolean {
    return this.context.transaction(() => {
      const operation = this.getPaneControlOperation(input.operationId);
      if (!operation) throw new Error(`Pane control operation not found: ${input.operationId}`);
      if (operation.state !== input.state && !this.finishPaneControlOperation(input.operationId, input.state, input.detail ?? null)) return false;
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: input.result.idempotencyKey, bindingId: operation.bindingId, targetRole: input.result.targetRole ?? null, rootMessageId: input.result.targetMessageId, kind: input.result.kind, payload: JSON.stringify(input.result.card) });
      return true;
    });
  }

  private claimState(id: string, state: "accepted" | "applied"): PaneControlOperation | null {
    return this.context.transaction(() => {
      const row = this.database.prepare("SELECT id FROM pane_control_operations WHERE id = ? AND state = ?").get(id, state) as { id: string } | undefined;
      if (!row) return null;
      const result = this.database.prepare("UPDATE pane_control_operations SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = ?").run(now(), id, state);
      return result.changes === 1 ? this.getPaneControlOperation(id) : null;
    });
  }
  private getPaneControlOperationByKey(key: string): PaneControlOperation | null { const row = this.database.prepare("SELECT * FROM pane_control_operations WHERE idempotency_key = ?").get(key) as PaneControlOperationRow | undefined; return row ? mapPaneControlOperation(row) : null; }
}

function now(): string { return new Date().toISOString(); }
