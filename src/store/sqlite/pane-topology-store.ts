import type {
  PaneTopologyIntent, PaneTopologyMoveReceipt, PaneTopologyRuntimeIdentity,
  ReservePaneTopologyIntentInput
} from "../../domain/pane-topology-intent.js";
import type { PaneTopologyIntentStore } from "../../domain/ports/pane-topology.js";
import type { SqliteContext } from "./context.js";

type PaneTopologyIntentRow = {
  id: string; idempotency_key: string; owner_kind: "primary" | "worker"; owner_id: string;
  owner_generation: number; owner_session_generation: number;
  parent_binding_id: string | null; parent_binding_generation: number | null;
  parent_session_generation: number | null; parent_pane_id: string | null;
  workspace_id: string; expected_pane_id: string; expected_terminal_id: string;
  expected_agent_session_id: string; expected_tab_id: string; expected_pane_label: string; expected_tab_label: string;
  target_tab_id: string; target_anchor_pane_id: string; desired_pane_label: string; desired_tab_label: string;
  state: PaneTopologyIntent["state"]; attempt_count: number;
  result_previous_pane_id: string | null; result_pane_id: string | null; result_tab_id: string | null;
  detail: string | null; created_at: string; updated_at: string; completed_at: string | null;
};

export class SqlitePaneTopologyStore implements PaneTopologyIntentStore {
  constructor(private readonly context: SqliteContext) {}
  private get database() { return this.context.database; }

  reserve(input: ReservePaneTopologyIntentInput): { intent: PaneTopologyIntent; inserted: boolean } {
    return this.context.transaction("sqlite.pane-topology-store.write", () => {
      const timestamp = new Date().toISOString();
      const parent = input.owner.kind === "worker" ? input.owner.parent : null;
      const inserted = this.database.prepare(`INSERT INTO pane_topology_intents(
        id,idempotency_key,owner_kind,owner_id,owner_generation,owner_session_generation,
        parent_binding_id,parent_binding_generation,parent_session_generation,parent_pane_id,
        workspace_id,expected_pane_id,expected_terminal_id,expected_agent_session_id,expected_tab_id,expected_pane_label,expected_tab_label,
        target_tab_id,target_anchor_pane_id,desired_pane_label,desired_tab_label,
        state,attempt_count,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?) ON CONFLICT(idempotency_key) DO NOTHING`).run(
        input.id, input.idempotencyKey, input.owner.kind, input.owner.id, input.owner.generation, input.owner.sessionGeneration,
        parent?.id ?? null, parent?.generation ?? null, parent?.sessionGeneration ?? null, parent?.paneId ?? null,
        input.expected.workspaceId, input.expected.paneId, input.expected.terminalId, input.expected.agentSessionId, input.expected.tabId, input.expected.paneLabel, input.expected.tabLabel,
        input.desired.tabId, input.desired.anchorPaneId, input.desired.paneLabel, input.desired.tabLabel,
        timestamp, timestamp
      ).changes === 1;
      const intent = this.getByKey(input.idempotencyKey);
      if (!intent) throw new Error(`Pane Topology Intent not found for ${input.idempotencyKey}`);
      if (!sameReservation(intent, input)) throw new Error(`Pane Topology Intent idempotency conflict for ${input.idempotencyKey}`);
      return { intent, inserted };
    });
  }

  get(id: string): PaneTopologyIntent | null {
    const row = this.database.prepare("SELECT * FROM pane_topology_intents WHERE id=?").get(id) as PaneTopologyIntentRow | undefined;
    return row ? mapIntent(row) : null;
  }

  listRecoverable(): PaneTopologyIntent[] {
    return (this.database.prepare(`SELECT * FROM pane_topology_intents
      WHERE state IN ('pending','executing','uncertain') ORDER BY created_at,id`).all() as PaneTopologyIntentRow[]).map(mapIntent);
  }

  claimNext(at: string): PaneTopologyIntent | null {
    return this.context.transaction("sqlite.pane-topology-store.write", () => {
      const row = this.database.prepare("SELECT id FROM pane_topology_intents WHERE state='pending' ORDER BY created_at,id LIMIT 1").get() as { id: string } | undefined;
      if (!row) return null;
      const changed = this.database.prepare(`UPDATE pane_topology_intents SET
        state='executing',attempt_count=attempt_count+1,detail=NULL,updated_at=? WHERE id=? AND state='pending'`).run(at, row.id);
      return changed.changes === 1 ? this.get(row.id) : null;
    });
  }

  claim(id: string, at: string): PaneTopologyIntent | null {
    return this.context.transaction("sqlite.pane-topology-store.write", () => {
      const changed = this.database.prepare(`UPDATE pane_topology_intents SET
        state='executing',attempt_count=attempt_count+1,detail=NULL,updated_at=? WHERE id=? AND state='pending'`).run(at, id);
      return changed.changes === 1 ? this.get(id) : null;
    });
  }

  markUncertain(input: { id: string; expectedAttemptCount: number; detail: string; at: string }): PaneTopologyIntent | null {
    return this.context.transaction("sqlite.pane-topology-store.write", () => {
      const changed = this.database.prepare(`UPDATE pane_topology_intents SET state='uncertain',detail=?,updated_at=?
        WHERE id=? AND state='executing' AND attempt_count=?`).run(input.detail.slice(0, 500), input.at, input.id, input.expectedAttemptCount);
      return changed.changes === 1 ? this.get(input.id) : null;
    });
  }

  rearmIfStillExpected(input: { id: string; expectedAttemptCount: number; observed: PaneTopologyRuntimeIdentity; at: string }): PaneTopologyIntent | null {
    return this.context.transaction("sqlite.pane-topology-store.write", () => {
      const intent = this.get(input.id);
      if (!intent || intent.state !== "uncertain" || intent.attemptCount !== input.expectedAttemptCount || !sameRuntime(intent.expected, input.observed)) return null;
      const changed = this.database.prepare(`UPDATE pane_topology_intents SET state='pending',detail=NULL,updated_at=?
        WHERE id=? AND state='uncertain' AND attempt_count=?`).run(input.at, input.id, input.expectedAttemptCount);
      return changed.changes === 1 ? this.get(input.id) : null;
    });
  }

  finishSucceeded(input: { id: string; expectedAttemptCount: number; receipt: PaneTopologyMoveReceipt; at: string }): PaneTopologyIntent | null {
    return this.context.transaction("sqlite.pane-topology-store.write", () => {
      const changed = this.database.prepare(`UPDATE pane_topology_intents SET
          state='succeeded',result_previous_pane_id=?,result_pane_id=?,result_tab_id=?,detail=NULL,completed_at=?,updated_at=?
        WHERE id=? AND state IN ('executing','uncertain') AND attempt_count=?
          AND workspace_id=? AND expected_pane_id=? AND target_tab_id=?`).run(
        input.receipt.previousPaneId, input.receipt.paneId, input.receipt.tabId, input.at, input.at,
        input.id, input.expectedAttemptCount, input.receipt.workspaceId, input.receipt.previousPaneId, input.receipt.tabId
      );
      return changed.changes === 1 ? this.get(input.id) : null;
    });
  }

  finishWorkerMoveSucceeded(input: {
    id: string; expectedAttemptCount: number; receipt: PaneTopologyMoveReceipt; at: string;
    worker: { id: string; generation: number; sessionGeneration: number; expectedNativeSessionId: string | null };
  }): PaneTopologyIntent | null {
    return this.context.transaction("sqlite.pane-topology-store.write", () => {
      const intent = this.get(input.id);
      if (!intent || intent.owner.kind !== "worker" || intent.owner.id !== input.worker.id
        || intent.owner.generation !== input.worker.generation || intent.owner.sessionGeneration !== input.worker.sessionGeneration) return null;
      const settled = this.database.prepare(`UPDATE pane_topology_intents SET
          state='succeeded',result_previous_pane_id=?,result_pane_id=?,result_tab_id=?,detail=NULL,completed_at=?,updated_at=?
        WHERE id=? AND state IN ('executing','uncertain') AND attempt_count=?
          AND workspace_id=? AND expected_pane_id=? AND target_tab_id=?`).run(
        input.receipt.previousPaneId, input.receipt.paneId, input.receipt.tabId, input.at, input.at,
        input.id, input.expectedAttemptCount, input.receipt.workspaceId, input.receipt.previousPaneId, input.receipt.tabId
      );
      if (settled.changes !== 1) return null;
      const adopted = this.database.prepare(`UPDATE agent_instances SET pane_id=?,pane_token=?,updated_at=?
        WHERE id=? AND generation=? AND worker_session_generation=? AND role='worker'
          AND worker_session_lifecycle='active' AND desired_state='running'
          AND herdr_workspace_id=? AND pane_id=? AND native_session_id IS ?`).run(
        input.receipt.paneId, input.receipt.paneToken ?? null, input.at,
        input.worker.id, input.worker.generation, input.worker.sessionGeneration,
        intent.expected.workspaceId, intent.expected.paneId, input.worker.expectedNativeSessionId
      );
      if (adopted.changes !== 1) throw new Error(`Worker runtime fence changed while settling Pane Topology Intent ${input.id}`);
      return this.get(input.id);
    });
  }

  private getByKey(key: string): PaneTopologyIntent | null {
    const row = this.database.prepare("SELECT * FROM pane_topology_intents WHERE idempotency_key=?").get(key) as PaneTopologyIntentRow | undefined;
    return row ? mapIntent(row) : null;
  }
}

function mapIntent(row: PaneTopologyIntentRow): PaneTopologyIntent {
  const owner = row.owner_kind === "primary"
    ? { kind: "primary" as const, id: row.owner_id, generation: Number(row.owner_generation), sessionGeneration: Number(row.owner_session_generation) }
    : {
        kind: "worker" as const, id: row.owner_id, generation: Number(row.owner_generation), sessionGeneration: Number(row.owner_session_generation),
        parent: { id: row.parent_binding_id!, generation: Number(row.parent_binding_generation), sessionGeneration: Number(row.parent_session_generation), paneId: row.parent_pane_id! }
      };
  return Object.freeze({
    id: row.id, idempotencyKey: row.idempotency_key, owner,
    expected: Object.freeze({ workspaceId: row.workspace_id, paneId: row.expected_pane_id, terminalId: row.expected_terminal_id, agentSessionId: row.expected_agent_session_id, tabId: row.expected_tab_id, paneLabel: row.expected_pane_label, tabLabel: row.expected_tab_label }),
    desired: Object.freeze({ tabId: row.target_tab_id, anchorPaneId: row.target_anchor_pane_id, paneLabel: row.desired_pane_label, tabLabel: row.desired_tab_label }),
    state: row.state, attemptCount: Number(row.attempt_count), resultPreviousPaneId: row.result_previous_pane_id,
    resultPaneId: row.result_pane_id, resultTabId: row.result_tab_id, detail: row.detail,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at
  });
}

function sameReservation(intent: PaneTopologyIntent, input: ReservePaneTopologyIntentInput): boolean {
  return JSON.stringify(intent.owner) === JSON.stringify(input.owner)
    && sameRuntime(intent.expected, input.expected)
    && JSON.stringify(intent.desired) === JSON.stringify(input.desired);
}

function sameRuntime(left: PaneTopologyRuntimeIdentity, right: PaneTopologyRuntimeIdentity): boolean {
  return left.workspaceId === right.workspaceId && left.paneId === right.paneId
    && left.terminalId === right.terminalId && left.agentSessionId === right.agentSessionId && left.tabId === right.tabId
    && left.paneLabel === right.paneLabel && left.tabLabel === right.tabLabel;
}
