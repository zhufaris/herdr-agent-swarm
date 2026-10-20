import type { Binding } from "../../domain/binding.js";
import type { AcceptOrchestratorIdentityMigrationInput, OrchestratorIdentityMigration } from "../../domain/orchestrator-identity.js";
import type { OrchestratorIdentityMigrationStore } from "../../domain/ports/orchestrator-identity.js";
import type { PaneIdentityReconcileReceipt } from "../../domain/ports/external.js";
import { mapBinding, mapOrchestratorIdentityMigration, type BindingRow, type OrchestratorIdentityMigrationRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteRuntimeIdentityClaimStore } from "./runtime-identity-claim-store.js";

export class SqliteOrchestratorIdentityMigrationStore implements OrchestratorIdentityMigrationStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly runtimeIdentityClaims: Pick<SqliteRuntimeIdentityClaimStore, "applyRuntimeIdentityTransition">
  ) {}

  findOrchestratorBinding(gatewayId: string, chatId: string): Binding | null {
    const row = this.context.database.prepare("SELECT * FROM bindings WHERE gateway_id = ? AND chat_id = ? AND kind = 'orchestrator' AND state <> 'archived' ORDER BY created_at, id LIMIT 1").get(gatewayId, chatId) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  hasActivePrompt(bindingId: string): boolean {
    return Boolean(this.context.database.prepare("SELECT 1 FROM prompt_jobs WHERE binding_id = ? AND state IN ('submitted','running','recovering','uncertain') AND observation_state <> 'completed' LIMIT 1").get(bindingId));
  }

  hasActiveMigration(bindingId: string): boolean {
    return Boolean(this.context.database.prepare("SELECT 1 FROM orchestrator_identity_migrations WHERE binding_id = ? AND state IN ('accepted','applying','uncertain') LIMIT 1").get(bindingId));
  }

  accept(input: AcceptOrchestratorIdentityMigrationInput): { operation: OrchestratorIdentityMigration; inserted: boolean } {
    return this.context.transaction("sqlite.orchestrator-identity-migration-store.write", () => {
      const existing = this.get(input.id);
      if (existing) {
        if (!sameRequest(existing, input)) throw new Error("Orchestrator identity migration operation ID belongs to a different request");
        return { operation: existing, inserted: false };
      }
      const active = this.context.database.prepare("SELECT * FROM orchestrator_identity_migrations WHERE binding_id = ? AND state IN ('accepted','applying','uncertain') ORDER BY created_at, id LIMIT 1").get(input.bindingId) as OrchestratorIdentityMigrationRow | undefined;
      if (active) {
        const operation = mapOrchestratorIdentityMigration(active);
        if (!sameRequest(operation, input)) throw new Error("An incompatible Orchestrator identity migration is already active");
        return { operation, inserted: false };
      }
      if (this.context.database.prepare("SELECT 1 FROM orchestrator_clear_operations WHERE binding_id = ? AND state IN ('accepted','rotating','rotation-uncertain') LIMIT 1").get(input.bindingId)) {
        throw new Error("Orchestrator clear is in progress");
      }
      const timestamp = now();
      const inserted = this.context.database.prepare(`INSERT INTO orchestrator_identity_migrations(
        id, binding_id, binding_generation, expected_workspace_id, expected_pane_id, expected_terminal_id, expected_token,
        target_workspace_id, expected_workspace_label, target_token, state, attempt_count, receipt_json, detail, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 0, NULL, NULL, ?, ?)`)
        .run(input.id, input.bindingId, input.bindingGeneration, input.expected.workspaceId, input.expected.paneId, input.expected.terminalId, input.expected.token,
          input.target.workspaceId, input.target.expectedWorkspaceLabel, input.target.token, timestamp, timestamp);
      return { operation: this.require(input.id), inserted: Number(inserted.changes) === 1 };
    });
  }

  claim(operationId: string): OrchestratorIdentityMigration | null {
    return this.context.transaction("sqlite.orchestrator-identity-migration-store.write", () => {
      const operation = this.get(operationId);
      if (!operation || !["accepted", "uncertain"].includes(operation.state)) return null;
      const binding = this.requireBinding(operation.bindingId);
      if (!matchesBinding(binding, operation) || this.hasActivePrompt(binding.id)) return null;
      if (this.context.database.prepare("SELECT 1 FROM orchestrator_clear_operations WHERE binding_id = ? AND state IN ('accepted','rotating','rotation-uncertain') LIMIT 1").get(binding.id)) return null;
      const changed = this.context.database.prepare("UPDATE orchestrator_identity_migrations SET state = 'applying', attempt_count = attempt_count + 1, detail = NULL, updated_at = ? WHERE id = ? AND state IN ('accepted','uncertain')").run(now(), operation.id);
      return Number(changed.changes) === 1 ? this.require(operation.id) : null;
    });
  }

  markUncertain(operationId: string, detail: string): OrchestratorIdentityMigration | null {
    const changed = this.context.database.prepare("UPDATE orchestrator_identity_migrations SET state = 'uncertain', detail = ?, updated_at = ? WHERE id = ? AND state = 'applying'").run(detail.slice(0, 500), now(), operationId);
    return Number(changed.changes) === 1 ? this.require(operationId) : null;
  }

  finish(operationId: string, state: "rejected" | "failed", detail: string): OrchestratorIdentityMigration | null {
    const changed = this.context.database.prepare("UPDATE orchestrator_identity_migrations SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state IN ('accepted','applying','uncertain')").run(state, detail.slice(0, 500), now(), operationId);
    return Number(changed.changes) === 1 ? this.require(operationId) : this.get(operationId);
  }

  applyReceipt(input: { operationId: string; receipt: PaneIdentityReconcileReceipt }): { operation: OrchestratorIdentityMigration; binding: Binding } | null {
    return this.context.transaction("sqlite.orchestrator-identity-migration-store.write", () => {
      const operation = this.require(input.operationId);
      if (operation.state === "succeeded") {
        if (JSON.stringify(operation.receipt) !== JSON.stringify(input.receipt)) throw new Error("Orchestrator identity receipt changed after settlement");
        return { operation, binding: this.requireBinding(operation.bindingId) };
      }
      if (operation.state !== "applying" && operation.state !== "uncertain") return null;
      if (!receiptMatches(operation, input.receipt)) throw new Error("Orchestrator identity receipt does not match its exact fence");
      const binding = this.requireBinding(operation.bindingId);
      if (!matchesBinding(binding, operation)) return null;
      const owner = { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch };
      const expected = {
        owner,
        workspaceId: binding.workspaceId,
        paneId: binding.paneId,
        terminalId: binding.traexSessionId,
        attachment: binding.attachment,
        nativeIdentity: bindingSession(binding)
      };
      const settled = this.runtimeIdentityClaims.applyRuntimeIdentityTransition({
        expected: [expected],
        release: [expected],
        targetOwner: owner,
        targetBindingId: binding.id,
        claim: "if_complete"
      }, () => {
        const timestamp = now();
        const changed = this.context.database.prepare(`UPDATE bindings SET workspace_id = ?, pane_id = ?, pane_token = ?, traex_session_id = ?, updated_at = ?
          WHERE id = ? AND generation = ? AND workspace_id = ? AND pane_id = ? AND traex_session_id = ? AND pane_token = ?`)
          .run(input.receipt.current.workspaceId, input.receipt.current.paneId, input.receipt.current.token, input.receipt.current.terminalId, timestamp,
            binding.id, operation.bindingGeneration, operation.expected.workspaceId, operation.expected.paneId, operation.expected.terminalId, operation.expected.token);
        if (Number(changed.changes) !== 1) throw new Error("Orchestrator identity Binding fence changed during receipt application");
        this.context.database.prepare(`UPDATE topic_views SET state_json = json_set(
            state_json,
            '$.workspaceId', ?, '$.spaceName', ?, '$.paneId', ?, '$.paneToken', ?,
            '$.viewVersion', COALESCE(json_extract(state_json, '$.viewVersion'), 0) + 1
          ), updated_at = ?
          WHERE binding_id = ? AND COALESCE(json_extract(state_json, '$.bindingGeneration'), 1) = ?`)
          .run(input.receipt.current.workspaceId, operation.target.expectedWorkspaceLabel, input.receipt.current.paneId, input.receipt.current.token,
            timestamp, binding.id, binding.generation);
        this.context.database.prepare(`UPDATE run_cards SET
            workspace_id = ?, space_name = ?, pane_id = ?, pane_token = ?,
            view_version = CASE WHEN phase IN ('queued','submitted','running','recovering','uncertain','blocked') THEN view_version + 1 ELSE view_version END,
            updated_at = ?
          WHERE binding_id = ? AND binding_generation = ? AND workspace_id = ? AND pane_id = ?`)
          .run(input.receipt.current.workspaceId, operation.target.expectedWorkspaceLabel, input.receipt.current.paneId, input.receipt.current.token,
            timestamp, binding.id, binding.generation, operation.expected.workspaceId, operation.expected.paneId);
        const invalidate = this.context.database.prepare(`INSERT INTO card_context_invalidations(
            target_kind, target_id, target_generation, requested_dependency_revision, projected_dependency_revision, reason, created_at, updated_at
          ) VALUES (?, ?, ?, 1, 0, 'orchestrator-identity-migrated', ?, ?)
          ON CONFLICT(target_kind, target_id, target_generation) DO UPDATE SET
            requested_dependency_revision = card_context_invalidations.requested_dependency_revision + 1,
            reason = excluded.reason, updated_at = excluded.updated_at`);
        invalidate.run("primary-session", binding.id, binding.generation, timestamp, timestamp);
        const mutableRuns = this.context.database.prepare(`SELECT prompt_id FROM run_cards
          WHERE binding_id = ? AND binding_generation = ? AND phase IN ('queued','submitted','running','recovering','uncertain','blocked')
          ORDER BY created_at, prompt_id`).all(binding.id, binding.generation) as Array<{ prompt_id: string }>;
        for (const run of mutableRuns) invalidate.run("primary-turn", run.prompt_id, binding.generation, timestamp, timestamp);
        this.context.database.prepare("UPDATE agent_instances SET parent_pane_id = ?, updated_at = ? WHERE role = 'worker' AND parent_binding_id = ? AND parent_binding_generation = ? AND parent_pane_id = ?")
          .run(input.receipt.current.paneId, timestamp, binding.id, binding.generation, operation.expected.paneId);
        this.context.database.prepare("UPDATE worker_session_threads SET parent_pane_id = ?, updated_at = ? WHERE parent_binding_id = ? AND parent_binding_generation = ? AND parent_pane_id = ?")
          .run(input.receipt.current.paneId, timestamp, binding.id, binding.generation, operation.expected.paneId);
        this.context.database.prepare("UPDATE worker_main_views SET parent_pane_id = ?, state_json = json_set(state_json, '$.parentPaneId', ?), updated_at = ? WHERE parent_binding_id = ? AND parent_binding_generation = ? AND parent_pane_id = ?")
          .run(input.receipt.current.paneId, input.receipt.current.paneId, timestamp, binding.id, binding.generation, operation.expected.paneId);
        this.context.database.prepare("UPDATE binding_thread_aliases SET pane_id = ?, updated_at = ? WHERE binding_id = ? AND binding_generation = ? AND pane_id = ?")
          .run(input.receipt.current.paneId, timestamp, binding.id, binding.generation, operation.expected.paneId);
        this.context.database.prepare("UPDATE orchestrator_identity_migrations SET state = 'succeeded', receipt_json = ?, detail = NULL, updated_at = ? WHERE id = ? AND state IN ('applying','uncertain')")
          .run(JSON.stringify(input.receipt), timestamp, operation.id);
        return this.require(operation.id);
      });
      return { operation: settled, binding: this.requireBinding(binding.id) };
    });
  }

  listRecoverable(limit = 100): OrchestratorIdentityMigration[] {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    return (this.context.database.prepare("SELECT * FROM orchestrator_identity_migrations WHERE state IN ('accepted','applying','uncertain') ORDER BY updated_at, id LIMIT ?").all(bounded) as OrchestratorIdentityMigrationRow[]).map(mapOrchestratorIdentityMigration);
  }

  private get(id: string): OrchestratorIdentityMigration | null {
    const row = this.context.database.prepare("SELECT * FROM orchestrator_identity_migrations WHERE id = ?").get(id) as OrchestratorIdentityMigrationRow | undefined;
    return row ? mapOrchestratorIdentityMigration(row) : null;
  }
  private require(id: string): OrchestratorIdentityMigration { const value = this.get(id); if (!value) throw new Error(`Orchestrator identity migration not found: ${id}`); return value; }
  private requireBinding(id: string): Binding { const row = this.context.database.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as BindingRow | undefined; if (!row) throw new Error(`Binding not found: ${id}`); return mapBinding(row); }
}

function now(): string { return new Date().toISOString(); }
function bindingSession(binding: Binding) {
  return binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
    : null;
}
function sameRequest(left: OrchestratorIdentityMigration, right: AcceptOrchestratorIdentityMigrationInput): boolean {
  return left.id === right.id && left.bindingId === right.bindingId && left.bindingGeneration === right.bindingGeneration
    && JSON.stringify(left.expected) === JSON.stringify(right.expected) && JSON.stringify(left.target) === JSON.stringify(right.target);
}
function matchesBinding(binding: Binding, operation: OrchestratorIdentityMigration): boolean {
  return binding.kind === "orchestrator" && binding.state === "active" && binding.lifecycle === "active" && binding.attachment === "attached"
    && binding.generation === operation.bindingGeneration && binding.workspaceId === operation.expected.workspaceId
    && binding.paneId === operation.expected.paneId && binding.traexSessionId === operation.expected.terminalId && binding.paneToken === operation.expected.token;
}
function receiptMatches(operation: OrchestratorIdentityMigration, receipt: PaneIdentityReconcileReceipt): boolean {
  return receipt.operationId === operation.id
    && receipt.previous.workspaceId === operation.expected.workspaceId
    && receipt.previous.paneId === operation.expected.paneId
    && receipt.previous.terminalId === operation.expected.terminalId
    && receipt.previous.token === operation.expected.token
    && receipt.current.workspaceId === operation.target.workspaceId && receipt.current.token === operation.target.token
    && receipt.current.terminalId === operation.expected.terminalId;
}
