import type { AcceptOrchestratorClearOperationInput, OrchestratorClearOperation, SessionRotationReceipt } from "../../domain/orchestrator-clear.js";
import type { Binding } from "../../domain/binding.js";
import type { OrchestratorClearStore } from "../../domain/ports/orchestrator-clear.js";
import type { OrchestratorClearOperationRow } from "../sqlite-records.js";
import { mapOrchestratorClearOperation } from "../sqlite-records.js";
import { mapBinding, type BindingRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import type { SqliteRuntimeIdentityClaimStore } from "./runtime-identity-claim-store.js";

export class SqliteOrchestratorClearStore implements OrchestratorClearStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: { enqueueOutboundReply(input: EnqueueOutboundReplyInput): unknown },
    private readonly runtimeIdentityClaims: Pick<SqliteRuntimeIdentityClaimStore, "applyRuntimeIdentityTransition">
  ) {}
  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void { this.preparedDeliveryReservation = reservation; this.preparedDeliveryConsumer = consumer; }

  getBinding(id: string): Binding | null {
    const row = this.context.database.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  hasNonterminalPrompt(bindingId: string): boolean {
    return Boolean(this.context.database.prepare(`SELECT 1 FROM prompt_jobs WHERE binding_id = ?
      AND state IN ('queued','submitted','running','recovering','uncertain') LIMIT 1`).get(bindingId));
  }

  hasActiveIdentityMigration(bindingId: string): boolean {
    return Boolean(this.context.database.prepare("SELECT 1 FROM orchestrator_identity_migrations WHERE binding_id = ? AND state IN ('accepted','applying','uncertain') LIMIT 1").get(bindingId));
  }

  accept(input: AcceptOrchestratorClearOperationInput): { operation: OrchestratorClearOperation; inserted: boolean } {
    return this.context.transaction("sqlite.orchestrator-clear-store.write", () => {
      const existing = this.context.database.prepare("SELECT * FROM orchestrator_clear_operations WHERE idempotency_key = ?").get(input.idempotencyKey) as OrchestratorClearOperationRow | undefined;
      if (existing) {
        const operation = mapOrchestratorClearOperation(existing);
        if (!sameRequest(operation, input)) throw new Error("Idempotency key belongs to a different Orchestrator clear operation");
        return { operation, inserted: false };
      }
      if (this.hasActiveIdentityMigration(input.bindingId)) throw new Error("Orchestrator identity migration is in progress");
      const timestamp = now();
      const inserted = this.context.database.prepare(`
        INSERT INTO orchestrator_clear_operations(
          id, idempotency_key, actor_open_id, source_message_id, confirmation_id,
          binding_id, binding_generation, old_session_epoch,
          expected_workspace_id, expected_pane_id, expected_terminal_id,
          expected_session_source, expected_session_agent, expected_session_kind, expected_session_value,
          expected_state_change_seq, state, attempt_count, receipt_json,
          answer_target_snapshot_json, answer_target_count, withdrawn_count, already_absent_count, failed_count,
          detail, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 0, NULL, '[]', 0, 0, 0, 0, NULL, ?, ?)
      `).run(
        input.id, input.idempotencyKey, input.actorOpenId, input.sourceMessageId, input.confirmationId,
        input.bindingId, input.bindingGeneration, input.oldSessionEpoch,
        input.expectedWorkspaceId, input.expectedPaneId, input.expectedTerminalId,
        input.expectedSession.source, input.expectedSession.agent, input.expectedSession.kind, input.expectedSession.value,
        input.expectedStateChangeSeq, timestamp, timestamp
      );
      return { operation: this.require(input.id), inserted: Number(inserted.changes) === 1 };
    });
  }

  get(id: string): OrchestratorClearOperation | null {
    const row = this.context.database.prepare("SELECT * FROM orchestrator_clear_operations WHERE id = ?").get(id) as OrchestratorClearOperationRow | undefined;
    return row ? mapOrchestratorClearOperation(row) : null;
  }

  claimNext(bindingId: string): OrchestratorClearOperation | null {
    return this.context.transaction("sqlite.orchestrator-clear-store.write", () => {
      const row = this.context.database.prepare(`SELECT operation.id FROM orchestrator_clear_operations operation
        JOIN bindings binding ON binding.id = operation.binding_id
        WHERE operation.binding_id = ? AND operation.state = 'accepted'
          AND binding.kind = 'orchestrator' AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
          AND binding.generation = operation.binding_generation AND binding.session_epoch = operation.old_session_epoch
          AND binding.workspace_id = operation.expected_workspace_id AND binding.pane_id = operation.expected_pane_id
          AND binding.pane_token = 'orch'
          AND binding.traex_session_id = operation.expected_terminal_id
          AND binding.agent_session_source = operation.expected_session_source
          AND binding.agent_session_agent = operation.expected_session_agent
          AND binding.agent_session_kind = operation.expected_session_kind
          AND binding.agent_session_value = operation.expected_session_value
          AND NOT EXISTS (SELECT 1 FROM prompt_jobs prompt WHERE prompt.binding_id = operation.binding_id
            AND prompt.state IN ('queued','submitted','running','recovering','uncertain'))
        ORDER BY operation.created_at, operation.id LIMIT 1`).get(bindingId) as { id: string } | undefined;
      if (!row) return null;
      const changed = this.context.database.prepare("UPDATE orchestrator_clear_operations SET state = 'rotating', attempt_count = attempt_count + 1, detail = NULL, updated_at = ? WHERE id = ? AND state = 'accepted'").run(now(), row.id);
      return Number(changed.changes) === 1 ? this.require(row.id) : null;
    });
  }

  markRotationUncertain(operationId: string, detail: string): OrchestratorClearOperation | null {
    const changed = this.context.database.prepare("UPDATE orchestrator_clear_operations SET state = 'rotation-uncertain', detail = ?, updated_at = ? WHERE id = ? AND state = 'rotating'").run(detail.slice(0, 500), now(), operationId);
    return Number(changed.changes) === 1 ? this.require(operationId) : null;
  }

  applyRotationReceipt(input: { operationId: string; receipt: SessionRotationReceipt }): { operation: OrchestratorClearOperation; binding: Binding } | null {
    return this.context.transaction("sqlite.orchestrator-clear-store.write", () => {
      const operation = this.require(input.operationId);
      if (operation.state === "context-cleared" || operation.state === "withdrawing" || operation.state === "succeeded" || operation.state === "partial") {
        if (JSON.stringify(operation.receipt) !== JSON.stringify(input.receipt)) throw new Error("Orchestrator clear receipt changed after settlement");
        const binding = this.requireBinding(operation.bindingId);
        return { operation, binding };
      }
      if (operation.state !== "rotating" && operation.state !== "rotation-uncertain") return null;
      if (input.receipt.operationId !== operation.id || input.receipt.paneId !== operation.expectedPaneId || input.receipt.terminalId !== operation.expectedTerminalId
        || !sameSession(input.receipt.oldSession, operation.expectedSession)) throw new Error("Orchestrator clear receipt does not match its exact fence");
      if (sameSession(input.receipt.newSession, operation.expectedSession)
        || input.receipt.newSession.source !== operation.expectedSession.source
        || input.receipt.newSession.agent !== operation.expectedSession.agent
        || input.receipt.newSession.kind !== operation.expectedSession.kind) {
        throw new Error("Orchestrator clear receipt does not identify a new compatible Agent session");
      }
      const binding = this.requireBinding(operation.bindingId);
      if (binding.kind !== "orchestrator" || binding.generation !== operation.bindingGeneration || binding.sessionEpoch !== operation.oldSessionEpoch
        || binding.workspaceId !== operation.expectedWorkspaceId || binding.paneId !== operation.expectedPaneId || binding.traexSessionId !== operation.expectedTerminalId
        || binding.paneToken !== "orch" || !sameSession(bindingSession(binding), operation.expectedSession)) return null;
      const expected = {
        owner: { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch },
        workspaceId: binding.workspaceId, paneId: binding.paneId, terminalId: binding.traexSessionId,
        attachment: binding.attachment, nativeIdentity: input.receipt.oldSession
      };
      const settled = this.runtimeIdentityClaims.applyRuntimeIdentityTransition({
        expected: [expected], release: [expected],
        targetOwner: { ...expected.owner, sessionEpoch: expected.owner.sessionEpoch + 1 },
        targetBindingId: binding.id, claim: "if_complete"
      }, () => {
        const timestamp = now();
        const changed = this.context.database.prepare(`UPDATE bindings SET session_epoch = session_epoch + 1,
          agent_session_source = ?, agent_session_agent = ?, agent_session_kind = ?, agent_session_value = ?,
          last_agent_state = 'idle', last_output_fingerprint = NULL, updated_at = ?
          WHERE id = ? AND generation = ? AND session_epoch = ? AND workspace_id = ? AND pane_id = ? AND traex_session_id = ?
            AND pane_token = 'orch' AND agent_session_source = ? AND agent_session_agent = ? AND agent_session_kind = ? AND agent_session_value = ?`).run(
            input.receipt.newSession.source, input.receipt.newSession.agent, input.receipt.newSession.kind, input.receipt.newSession.value,
            timestamp, operation.bindingId, operation.bindingGeneration, operation.oldSessionEpoch, operation.expectedWorkspaceId,
            operation.expectedPaneId, operation.expectedTerminalId, operation.expectedSession.source, operation.expectedSession.agent,
            operation.expectedSession.kind, operation.expectedSession.value
          );
        if (Number(changed.changes) !== 1) throw new Error("Orchestrator clear Binding fence changed during receipt application");
        this.resetCurrentMainView(operation.bindingId, timestamp);
        const targets = this.answerTargets(operation);
        for (const [index, messageId] of targets.entries()) {
          const replyId = `orchestrator-clear-delete:${operation.id}:${index}`;
          this.enqueuePrimary({ id: replyId, idempotencyKey: replyId, bindingId: operation.bindingId, bindingGeneration: operation.bindingGeneration, rootMessageId: messageId, kind: "message_delete", payload: "" });
          this.context.database.prepare(`INSERT OR IGNORE INTO orchestrator_clear_answer_targets(
            operation_id, message_id, outbound_reply_id, outcome, detail, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', NULL, ?, ?)`).run(operation.id, messageId, replyId, timestamp, timestamp);
        }
        const state = targets.length === 0 ? "succeeded" : "withdrawing";
        this.context.database.prepare("UPDATE orchestrator_clear_operations SET state = ?, receipt_json = ?, answer_target_snapshot_json = ?, answer_target_count = ?, detail = NULL, updated_at = ? WHERE id = ? AND state IN ('rotating','rotation-uncertain')")
          .run(state, JSON.stringify(input.receipt), JSON.stringify(targets), targets.length, timestamp, operation.id);
        this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, 'orchestrator.context.clear', ?, 'context-cleared', ?)")
          .run(operation.actorOpenId, `binding:${operation.bindingId}:epoch:${operation.oldSessionEpoch + 1}`, timestamp);
        return this.require(operation.id);
      });
      return { operation: settled, binding: this.requireBinding(operation.bindingId) };
    });
  }

  settleAnswerWithdrawal(input: { outboundReplyId: string; outcome: "deleted" | "already_absent" | "failed"; detail?: string | null }): OrchestratorClearOperation | null {
    return this.context.transaction("sqlite.orchestrator-clear-store.write", () => {
      const target = this.context.database.prepare("SELECT operation_id, outcome FROM orchestrator_clear_answer_targets WHERE outbound_reply_id = ?").get(input.outboundReplyId) as { operation_id: string; outcome: string } | undefined;
      if (!target) return null;
      if (target.outcome === "pending") this.context.database.prepare("UPDATE orchestrator_clear_answer_targets SET outcome = ?, detail = ?, updated_at = ? WHERE outbound_reply_id = ? AND outcome = 'pending'")
        .run(input.outcome, input.detail?.slice(0, 500) ?? null, now(), input.outboundReplyId);
      const counts = this.context.database.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN outcome = 'deleted' THEN 1 ELSE 0 END) AS withdrawn,
        SUM(CASE WHEN outcome = 'already_absent' THEN 1 ELSE 0 END) AS absent,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM orchestrator_clear_answer_targets WHERE operation_id = ?`).get(target.operation_id) as { total: number; pending: number; withdrawn: number; absent: number; failed: number };
      const terminalState = Number(counts.pending) === 0 ? (Number(counts.failed) > 0 ? "partial" : "succeeded") : "withdrawing";
      this.context.database.prepare(`UPDATE orchestrator_clear_operations SET state = ?, answer_target_count = ?, withdrawn_count = ?, already_absent_count = ?, failed_count = ?,
        detail = CASE WHEN ? > 0 THEN 'One or more Answer Card withdrawals failed' ELSE NULL END, updated_at = ? WHERE id = ? AND state IN ('context-cleared','withdrawing','succeeded','partial')`)
        .run(terminalState, Number(counts.total), Number(counts.withdrawn), Number(counts.absent), Number(counts.failed), Number(counts.failed), now(), target.operation_id);
      return this.require(target.operation_id);
    });
  }

  listTerminalWithoutResult(limit = 100): OrchestratorClearOperation[] {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    return (this.context.database.prepare(`SELECT operation.* FROM orchestrator_clear_operations operation
      LEFT JOIN orchestrator_clear_result_publications publication ON publication.operation_id = operation.id
      WHERE operation.state IN ('succeeded','partial','rejected','failed') AND publication.operation_id IS NULL
      ORDER BY operation.updated_at, operation.id LIMIT ?`).all(bounded) as OrchestratorClearOperationRow[]).map(mapOrchestratorClearOperation);
  }

  reserveResult(operationId: string, card: object): boolean {
    return this.context.transaction("sqlite.orchestrator-clear-store.write", () => {
      const operation = this.require(operationId);
      if (!isTerminal(operation.state)) return false;
      if (this.context.database.prepare("SELECT 1 FROM orchestrator_clear_result_publications WHERE operation_id = ?").get(operationId)) return false;
      const replyId = `orchestrator-clear-result:${operation.id}`;
      if (!this.hasExactActiveBinding(operation.bindingId, operation.bindingGeneration)) return false;
      this.enqueuePrimary({ id: replyId, idempotencyKey: replyId, bindingId: operation.bindingId, bindingGeneration: operation.bindingGeneration, rootMessageId: operation.sourceMessageId, kind: "card_reply", targetRole: "operation_result", payload: JSON.stringify(card) });
      this.context.database.prepare("INSERT INTO orchestrator_clear_result_publications(operation_id, outbound_reply_id, created_at) VALUES (?, ?, ?)").run(operation.id, replyId, now());
      return true;
    });
  }

  finish(operationId: string, state: "succeeded" | "partial" | "rejected" | "failed", detail: string | null = null): OrchestratorClearOperation | null {
    const changed = this.context.database.prepare(`UPDATE orchestrator_clear_operations SET state = ?, detail = ?, updated_at = ?
      WHERE id = ? AND state NOT IN ('succeeded','partial','rejected','failed')`).run(state, detail?.slice(0, 500) ?? null, now(), operationId);
    return Number(changed.changes) === 1 ? this.require(operationId) : this.get(operationId);
  }

  listRecoverable(limit = 100): OrchestratorClearOperation[] {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    return (this.context.database.prepare(`SELECT * FROM orchestrator_clear_operations
      WHERE state IN ('accepted','rotating','rotation-uncertain','context-cleared','withdrawing')
      ORDER BY updated_at, id LIMIT ?`).all(bounded) as OrchestratorClearOperationRow[]).map(mapOrchestratorClearOperation);
  }

  private resetCurrentMainView(bindingId: string, timestamp: string): void {
    const row = this.context.database.prepare("SELECT state_json FROM topic_views WHERE binding_id = ?").get(bindingId) as { state_json: string } | undefined;
    if (!row) return;
    const current = JSON.parse(row.state_json) as Record<string, unknown>;
    const next = {
      ...current,
      phase: "ready", agentState: "idle", queueDepth: 0, answer: null, notice: null, activePromptId: null,
      recentProgress: [], progressSummary: { total: 0, stepTotal: 0, stepDone: 0 }, timelineItems: [], currentGoal: null,
      liveStatus: null, currentAnswer: null, context: null, activityAt: timestamp,
      viewVersion: Number(current.viewVersion ?? 0) + 1
    };
    this.context.database.prepare("UPDATE topic_views SET state_json = ?, updated_at = ? WHERE binding_id = ?").run(JSON.stringify(next), timestamp, bindingId);
  }

  private answerTargets(operation: OrchestratorClearOperation): string[] {
    return (this.context.database.prepare(`SELECT DISTINCT page.message_id AS message_id
      FROM prompt_jobs prompt JOIN answer_pages page ON page.prompt_id = prompt.id
      WHERE prompt.binding_id = ? AND prompt.session_epoch <= ? AND page.message_id IS NOT NULL
      ORDER BY page.message_id`).all(operation.bindingId, operation.oldSessionEpoch) as Array<{ message_id: string }>).map(({ message_id }) => message_id);
  }

  private requireBinding(id: string): Binding {
    const row = this.context.database.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as BindingRow | undefined;
    if (!row) throw new Error(`Binding not found: ${id}`);
    return mapBinding(row);
  }

  private require(id: string): OrchestratorClearOperation {
    const operation = this.get(id);
    if (!operation) throw new Error(`Orchestrator clear operation not found: ${id}`);
    return operation;
  }
  private enqueuePrimary(input: EnqueueOutboundReplyInput): void {
    if (!input.bindingId || input.bindingGeneration === null || input.bindingGeneration === undefined
      || !this.hasExactActiveBinding(input.bindingId, input.bindingGeneration)) return;
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Orchestrator Clear prepared delivery is not connected");
    this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply(input));
  }
  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void { queueMicrotask(() => { for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery); }); }
  private hasExactActiveBinding(id: string, generation: number): boolean { return this.context.database.prepare("SELECT 1 FROM bindings WHERE id=? AND generation=? AND state='active' AND lifecycle='active' AND attachment='attached'").get(id, generation) !== undefined; }
}

function now(): string { return new Date().toISOString(); }
function bindingSession(binding: Binding) {
  return binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
    : null;
}
function sameSession(left: { source: string; agent: string; kind: string; value: string } | null, right: { source: string; agent: string; kind: string; value: string }): boolean {
  return left !== null && left.source === right.source && left.agent === right.agent && left.kind === right.kind && left.value === right.value;
}
function sameRequest(operation: OrchestratorClearOperation, input: AcceptOrchestratorClearOperationInput): boolean {
  return operation.id === input.id && operation.idempotencyKey === input.idempotencyKey && operation.actorOpenId === input.actorOpenId
    && operation.sourceMessageId === input.sourceMessageId && operation.confirmationId === input.confirmationId
    && operation.bindingId === input.bindingId && operation.bindingGeneration === input.bindingGeneration
    && operation.oldSessionEpoch === input.oldSessionEpoch && operation.expectedWorkspaceId === input.expectedWorkspaceId
    && operation.expectedPaneId === input.expectedPaneId && operation.expectedTerminalId === input.expectedTerminalId
    && sameSession(operation.expectedSession, input.expectedSession) && operation.expectedStateChangeSeq === input.expectedStateChangeSeq;
}
function isTerminal(state: OrchestratorClearOperation["state"]): boolean { return state === "succeeded" || state === "partial" || state === "rejected" || state === "failed"; }
