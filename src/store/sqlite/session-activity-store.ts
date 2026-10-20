import { deliveryScopeKey } from "../../domain/delivery-scope.js";
import {
  SESSION_ACTIVITY_MAX_TERMINAL_PER_KIND,
  SESSION_ACTIVITY_VISIBLE_ACTIVE_PER_KIND,
  type SessionActivityBindingFence,
  type SessionActivityDiagnostics,
  type SessionActivityInvalidationFence,
  type SessionActivityItem,
  type SessionActivityItemKind,
  type SessionAgentIdentity,
  type SessionActivitySnapshot,
  type SessionActivityView
} from "../../domain/session-activity.js";
import { turnSessionStatePresentationFingerprint, turnSessionStateView, type TurnSessionIdentityFacts } from "../../domain/turn-session-state.js";
import type { SessionActivityProjectionInput, SessionActivityProjectionResult, SessionActivityStore } from "../../domain/ports/session-activity.js";
import type { RetainedMultiAgentActivityRecoveryResult } from "../../domain/ports/session-activity.js";
import type { CoreEventEnvelope } from "../../domain/core-event-inbox.js";
import type { SqliteContext } from "./context.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import { updateTopicView, type TopicViewState } from "../../domain/topic-view.js";
import { translateMultiAgentToolLifecycle } from "../../runtime/multi-agent-tool-lifecycle.js";

const REDUCER_REVISION = 1;

interface SnapshotRow {
  scope_key: string; workspace_id: string; pane_id: string; producer_kind: "primary" | "worker"; producer_id: string;
  producer_generation: number; producer_session_generation: number; runtime_pane_id: string;
  binding_id: string; binding_generation: number; session_epoch: number; native_session_id: string; agent_kind: "traex" | "pi";
  lane_id: string; source_id: string; source_epoch: string; source_lane_sequence: number; source_event_id: string;
  retained_recovery_lane_id: string | null; retained_recovery_lane_sequence: number;
  reducer_revision: number; revision: number; current_model: string | null; current_goal_json: string | null;
  last_turn_id: string | null; last_turn_state: "active" | "completed" | "aborted" | null;
  compaction_count: number; token_usage: number | null; context_usage: number | null; updated_at: string;
}

interface ItemMutation {
  kind: SessionActivityItemKind; itemId: string; ordinal: number; label: string; state: string; terminal: boolean;
  preserveExistingLabel?: boolean;
  displayName?: string;
  model?: string;
}

interface AgentIdentityRow {
  scope_key: string; producer_kind: "primary" | "worker"; producer_id: string; agent_id: string;
  producer_generation: number; producer_session_generation: number;
  display_name: string | null; display_name_lane_sequence: number | null; display_name_event_id: string | null;
  model: string | null; model_lane_sequence: number | null; model_event_id: string | null;
  source_lane_sequence: number; source_event_id: string; updated_at: string;
}

interface CurrentWorkerSegmentRow {
  worker_id: string; worker_generation: number; worker_session_generation: number; worker_pane_id: string;
  worker_pane_token: string | null; worker_native_session_id: string; worker_agent_kind: "traex" | "pi";
  worker_desired_state: "running" | "stopped"; worker_observed_state: string;
  binding_id: string; binding_generation: number; session_epoch: number; workspace_id: string; parent_pane_id: string;
  parent_native_session_id: string; lease_cwd: string | null; lease_branch: string | null;
  main_worker_session_generation: number | null; main_parent_binding_id: string | null;
  main_parent_binding_generation: number | null; main_parent_pane_id: string | null; main_state_json: string | null;
}

interface RetainedMultiAgentPair {
  bindingId: string;
  bindingGeneration: number;
  sessionEpoch: number;
  producerKind: "primary" | "worker";
  producerId: string;
  producerGeneration: number;
  producerSessionGeneration: number;
  runtimePaneId: string;
  workspaceId: string;
  paneId: string;
  laneId: string;
  laneSequence: number;
  sourceId: string;
  sourceEpoch: string;
  callEvent: CoreEventEnvelope;
  resultEvent: CoreEventEnvelope;
}

interface RetainedMultiAgentCursor {
  bindingId: string;
  producerKind: "primary" | "worker";
  producerId: string;
  laneId: string;
  laneSequence: number;
  eventId: string;
}

/** @internal Shared with migration planner coverage; runtime parameters remain store-owned. */
export const RETAINED_MULTI_AGENT_ACTIVITY_QUERY = `WITH retained_producers AS (
    SELECT binding.id AS binding_id,binding.generation AS binding_generation,binding.session_epoch,
      'primary' AS producer_kind,binding.id AS producer_id,binding.generation AS producer_generation,
      binding.session_epoch AS producer_session_generation,binding.pane_id AS runtime_pane_id,
      binding.workspace_id,binding.pane_id,binding.agent_kind,binding.agent_session_value AS native_session_id
    FROM bindings binding
    WHERE binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
      AND binding.pane_id IS NOT NULL AND binding.agent_session_kind='id' AND binding.agent_session_value IS NOT NULL
    UNION ALL
    SELECT binding.id,binding.generation,binding.session_epoch,
      'worker',worker.id,worker.generation,worker.worker_session_generation,worker.pane_id,
      binding.workspace_id,binding.pane_id,worker.agent_kind,worker.native_session_id
    FROM agent_instances worker
    JOIN bindings binding ON binding.id=worker.parent_binding_id AND binding.generation=worker.parent_binding_generation
    WHERE worker.role='worker' AND worker.worker_session_lifecycle='active'
      AND worker.pane_id IS NOT NULL AND worker.native_session_id IS NOT NULL
      AND worker.parent_pane_id=binding.pane_id AND worker.parent_native_session_id=binding.agent_session_value
      AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
      AND binding.pane_id IS NOT NULL
  )
  SELECT producer.binding_id,producer.binding_generation,producer.session_epoch,
    producer.producer_kind,producer.producer_id,producer.producer_generation,producer.producer_session_generation,producer.runtime_pane_id,
    producer.workspace_id,producer.pane_id,result_lane.lane_id,result_lane.sequence,result_inbox.event_id AS result_event_id,
    result_inbox.event_json AS result_json,call_inbox.event_json AS call_json,checkpoint.source_id,checkpoint.source_epoch
  FROM retained_producers producer
  JOIN core_event_lane_checkpoints checkpoint ON checkpoint.agent_kind=producer.agent_kind AND checkpoint.session_id=producer.native_session_id
  JOIN core_event_lane_items result_lane ON result_lane.lane_id=checkpoint.lane_id
  JOIN core_event_inbox result_inbox ON result_inbox.event_id=result_lane.event_id
  JOIN core_event_lane_items call_lane ON call_lane.lane_id=result_lane.lane_id AND call_lane.sequence<result_lane.sequence
    AND call_lane.state IN ('projected','ignored')
  JOIN core_event_inbox call_inbox INDEXED BY core_event_inbox_multi_agent_call ON call_inbox.event_id=call_lane.event_id
    AND call_inbox.agent_kind=result_inbox.agent_kind AND call_inbox.session_id=result_inbox.session_id
    AND call_inbox.call_id=result_inbox.call_id
  LEFT JOIN session_activity_snapshots snapshot ON snapshot.scope_key=json_array('pane',producer.workspace_id,producer.pane_id)
    AND snapshot.producer_kind=producer.producer_kind AND snapshot.producer_id=producer.producer_id
    AND snapshot.binding_id=producer.binding_id AND snapshot.binding_generation=producer.binding_generation AND snapshot.session_epoch=producer.session_epoch
    AND snapshot.producer_generation=producer.producer_generation AND snapshot.producer_session_generation=producer.producer_session_generation
    AND snapshot.runtime_pane_id=producer.runtime_pane_id AND snapshot.native_session_id=producer.native_session_id
    AND snapshot.agent_kind=producer.agent_kind
  WHERE result_inbox.agent_kind=producer.agent_kind AND result_inbox.session_id=producer.native_session_id
      AND result_lane.state IN ('projected','ignored')
      AND result_inbox.event_type='tool_result' AND result_inbox.call_id IS NOT NULL
      AND result_inbox.payload_compacted_at IS NULL AND call_inbox.payload_compacted_at IS NULL
      AND call_inbox.event_type='tool_call'
      AND json_extract(call_inbox.event_json,'$.payload.name') IN (
        'multi_agent_v1__spawn_agent','multi_agent_v1__wait_agent','multi_agent_v1__close_agent',
        'collaboration__spawn_agent','collaboration__wait_agent','collaboration__interrupt_agent','collaboration__close_agent'
      )
      AND NOT EXISTS (SELECT 1 FROM session_activity_items item
        WHERE item.scope_key=json_array('pane',producer.workspace_id,producer.pane_id)
          AND item.producer_kind=producer.producer_kind AND item.producer_id=producer.producer_id AND item.kind='agent'
          AND item.source_event_id=result_inbox.event_id)
      AND NOT EXISTS (SELECT 1 FROM session_activity_agent_identities identity
        WHERE identity.scope_key=json_array('pane',producer.workspace_id,producer.pane_id)
          AND identity.producer_kind=producer.producer_kind AND identity.producer_id=producer.producer_id
          AND (identity.display_name_event_id=result_inbox.event_id OR identity.model_event_id=result_inbox.event_id))
      AND (snapshot.retained_recovery_lane_id IS NULL OR snapshot.retained_recovery_lane_id<>result_lane.lane_id
        OR result_lane.sequence>snapshot.retained_recovery_lane_sequence)
      AND (SELECT COUNT(*) FROM core_event_inbox prior_inbox INDEXED BY core_event_inbox_call
        JOIN core_event_lane_items prior_lane ON prior_lane.event_id=prior_inbox.event_id
        WHERE prior_inbox.call_id=result_inbox.call_id AND prior_inbox.event_type='tool_call'
          AND prior_inbox.agent_kind=result_inbox.agent_kind AND prior_inbox.session_id=result_inbox.session_id
          AND prior_inbox.payload_compacted_at IS NULL AND prior_lane.lane_id=result_lane.lane_id
          AND prior_lane.sequence<result_lane.sequence AND prior_lane.state IN ('projected','ignored'))=1
    AND (? IS NULL OR (producer.binding_id,producer.producer_kind,producer.producer_id,result_lane.lane_id,result_lane.sequence,result_inbox.event_id)>(?,?,?,?,?,?))
  ORDER BY producer.binding_id,producer.producer_kind,producer.producer_id,result_lane.lane_id,result_lane.sequence,result_inbox.event_id LIMIT ?`;

export class SqliteSessionActivityStore implements SessionActivityStore {
  private projections: SqliteProjectionStore | null = null;
  private renderers: { main(view: TopicViewState, activity: SessionActivityView | null): object; pane(view: TopicViewState, activity: SessionActivityView | null): object } | null = null;
  private recoveryNotifier: ((input: SessionActivityInvalidationFence) => void) | null = null;
  private runtimeDiagnostics: SessionActivityDiagnostics = {
    missingIdentityFallbackCount: 0,
    lastMissingIdentityAt: null,
    lastMissingIdentityOutcome: null
  };
  constructor(private readonly context: SqliteContext) {}
  connectCardProjection(projections: SqliteProjectionStore): void { this.projections = projections; }
  setCardRenderers(renderers: { main(view: TopicViewState, activity: SessionActivityView | null): object; pane(view: TopicViewState, activity: SessionActivityView | null): object }): void { this.renderers = renderers; }
  setRecoveryNotifier(notifier: (input: SessionActivityInvalidationFence) => void): void { this.recoveryNotifier = notifier; }
  diagnostics(): SessionActivityDiagnostics { return { ...this.runtimeDiagnostics }; }

  projectCanonicalEvent(input: SessionActivityProjectionInput): SessionActivityProjectionResult {
    let missingIdentityFallbacks = 0;
    const result = this.context.transaction("sqlite.session-activity-store.write", () => {
      const identity = this.resolveIdentity(input);
      const scopeKey = deliveryScopeKey(input.context.scope);
      const before = identity ? this.storedPresentationFingerprint(scopeKey, identity) : "null";
      const originalOutcome = this.project(input, () => { missingIdentityFallbacks += 1; });
      const after = identity ? this.storedPresentationFingerprint(scopeKey, identity) : "null";
      const visibleChanged = before !== after;
      const outcome = visibleChanged && originalOutcome === "ignored" ? "projected" : originalOutcome;
      if (visibleChanged && identity) this.projectMainCard(identity.bindingId, input.context.scope, input.observedAt);
      return { outcome, visibleChanged };
    });
    this.recordMissingIdentityFallbacks(missingIdentityFallbacks, input.observedAt);
    return result;
  }

  recoverRetainedMultiAgentActivity(input: { limit: number; observedAt: string; afterCursor?: string | null }): RetainedMultiAgentActivityRecoveryResult {
    const limit = Math.max(1, Math.min(128, Math.floor(input.limit)));
    const pairs = this.loadRetainedMultiAgentPairs(limit + 1, input.afterCursor);
    const remaining = pairs.length > limit;
    const page = pairs.slice(0, limit);
    const mutations: Array<{ pair: RetainedMultiAgentPair; mutation: import("../../domain/session-activity.js").SessionActivityAgentLifecycleMutation }> = [];
    for (const pair of page) {
      for (const mutation of translateMultiAgentToolLifecycle(pair.callEvent, pair.resultEvent)) {
        mutations.push({ pair, mutation });
      }
    }
    let missingIdentityFallbacks = 0;
    const result = this.context.transaction("sqlite.session-activity-store.recover-retained-multi-agent", () => {
      const identities = new Map<string, { pair: RetainedMultiAgentPair; before: string }>();
      for (const { pair } of mutations) {
        const key = recoveryIdentityKey(pair);
        if (!identities.has(key)) identities.set(key, { pair, before: this.storedPresentationFingerprintForRecovery(pair) });
      }
      const recoveredAgentKeys = new Set<string>();
      const changedScopeKeys = new Set<string>();
      for (const { pair, mutation } of mutations) {
        if (this.applyRecoveredAgentMutation(pair, mutation, input.observedAt, () => { missingIdentityFallbacks += 1; })) {
          changedScopeKeys.add(deliveryScopeKey({ kind: "pane", workspaceId: pair.workspaceId, paneId: pair.paneId }));
          recoveredAgentKeys.add(`${recoveryIdentityKey(pair)}\u0000${pair.producerKind}\u0000${pair.producerId}\u0000${mutation.agentId}`);
        }
      }
      for (const scopeKey of changedScopeKeys) this.pruneItems(scopeKey);
      this.advanceRetainedRecoveryCheckpoints(page);
      let visibleChanged = false;
      for (const { pair, before } of identities.values()) {
        if (before !== this.storedPresentationFingerprintForRecovery(pair)) {
          visibleChanged = true;
          this.projectMainCard(pair.bindingId, { kind: "pane", workspaceId: pair.workspaceId, paneId: pair.paneId }, input.observedAt);
          this.recoveryNotifier?.({
            bindingId: pair.bindingId, bindingGeneration: pair.bindingGeneration, sessionEpoch: pair.sessionEpoch,
            producer: {
              kind: pair.producerKind, id: pair.producerId, runtimeGeneration: pair.producerGeneration,
              sessionGeneration: pair.producerSessionGeneration, runtimePaneId: pair.runtimePaneId
            },
            occurredAt: input.observedAt
          });
        }
      }
      return { recoveredAgents: recoveredAgentKeys.size, visibleChanged, remaining, nextCursor: remaining ? recoveryCursor(page.at(-1)!) : null };
    });
    this.recordMissingIdentityFallbacks(missingIdentityFallbacks, input.observedAt);
    return result;
  }

  load(scope: SessionActivityProjectionInput["context"]["scope"], fence: SessionActivityBindingFence): SessionActivityView | null {
    const scopeKey = deliveryScopeKey(scope);
    const binding = this.context.database.prepare(`SELECT agent_session_value FROM bindings
      WHERE id=? AND generation=? AND session_epoch=? AND workspace_id=? AND pane_id=?
        AND state='active' AND lifecycle='active' AND attachment='attached'`).get(
      fence.bindingId, fence.bindingGeneration, fence.sessionEpoch, scope.workspaceId, scope.paneId
    ) as { agent_session_value: string | null } | undefined;
    if (!binding) return null;
    const rows = this.context.database.prepare(`SELECT * FROM session_activity_snapshots
      WHERE scope_key=? AND binding_id=? AND binding_generation=? AND session_epoch=?
        AND ((producer_kind='primary' AND producer_id=?) OR (producer_kind='worker' AND EXISTS(
          SELECT 1 FROM agent_instances worker WHERE worker.id=session_activity_snapshots.producer_id
            AND worker.role='worker' AND worker.generation=session_activity_snapshots.producer_generation
            AND worker.worker_session_generation=session_activity_snapshots.producer_session_generation
            AND worker.worker_session_lifecycle='active' AND worker.parent_binding_id=session_activity_snapshots.binding_id
            AND worker.parent_binding_generation=session_activity_snapshots.binding_generation
            AND worker.parent_pane_id=session_activity_snapshots.pane_id
        )))
      ORDER BY CASE producer_kind WHEN 'primary' THEN 0 ELSE 1 END,producer_id`).all(
      scopeKey, fence.bindingId, fence.bindingGeneration, fence.sessionEpoch, fence.bindingId
    ) as unknown as SnapshotRow[];
    if (rows.length === 0) return null;
    const primary = rows.find(({ producer_kind }) => producer_kind === "primary");
    const items = this.context.database.prepare(`SELECT item.* FROM session_activity_items item
      JOIN session_activity_snapshots snapshot ON snapshot.scope_key=item.scope_key
        AND snapshot.producer_kind=item.producer_kind AND snapshot.producer_id=item.producer_id
      WHERE item.scope_key=? AND snapshot.binding_id=? AND snapshot.binding_generation=? AND snapshot.session_epoch=?
        AND ((snapshot.producer_kind='primary' AND snapshot.producer_id=?) OR (snapshot.producer_kind='worker' AND EXISTS(
          SELECT 1 FROM agent_instances worker WHERE worker.id=snapshot.producer_id
            AND worker.role='worker' AND worker.generation=snapshot.producer_generation
            AND worker.worker_session_generation=snapshot.producer_session_generation
            AND worker.worker_session_lifecycle='active' AND worker.parent_binding_id=snapshot.binding_id
            AND worker.parent_binding_generation=snapshot.binding_generation AND worker.parent_pane_id=snapshot.pane_id
        )))
      ORDER BY item.kind,
        CASE WHEN item.kind='task' THEN item.item_ordinal END,
        CASE WHEN item.kind<>'task' THEN item.terminal END,
        item.updated_at DESC,item.source_event_id DESC,item.producer_kind,item.producer_id,item.item_id`).all(
      scopeKey, fence.bindingId, fence.bindingGeneration, fence.sessionEpoch, fence.bindingId
    ) as Array<Record<string, unknown>>;
    return {
      snapshot: {
        scopeKey, workspaceId: scope.workspaceId, paneId: scope.paneId,
        bindingId: fence.bindingId, bindingGeneration: fence.bindingGeneration, sessionEpoch: fence.sessionEpoch,
        nativeSessionId: primary?.native_session_id ?? binding.agent_session_value ?? "",
        revision: rows.reduce((total, row) => total + Number(row.revision), 0),
        currentModel: primary?.current_model ?? null,
        currentGoal: primary?.current_goal_json ? JSON.parse(primary.current_goal_json) : null,
        lastTurnId: primary?.last_turn_id ?? null, lastTurnState: primary?.last_turn_state ?? null,
        compactionCount: rows.reduce((total, row) => total + Number(row.compaction_count), 0),
        tokenUsage: primary?.token_usage ?? null, contextUsage: primary?.context_usage ?? null,
        updatedAt: rows.reduce((latest, row) => row.updated_at > latest ? row.updated_at : latest, rows[0]!.updated_at)
      },
      items: items.map(mapItem)
    };
  }

  loadForCurrentPrimarySegment(segmentId: string): SessionActivityView | null {
    const row = this.context.database.prepare(`SELECT binding.id AS binding_id,binding.generation AS binding_generation,
        binding.session_epoch,binding.workspace_id,binding.pane_id
      FROM conversation_segments segment
      JOIN bindings binding ON binding.id=segment.owner_id AND binding.generation=segment.owner_generation
      WHERE segment.id=? AND segment.owner_kind='primary' AND segment.session_id=binding.agent_session_value
        AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
        AND binding.pane_id IS NOT NULL
        AND segment.id=(SELECT current.id FROM conversation_segments current
          WHERE current.owner_kind='primary' AND current.owner_id=binding.id
            AND current.owner_generation=binding.generation AND current.session_id=binding.agent_session_value
            AND current.start_lane_sequence IS NOT NULL
          ORDER BY current.start_lane_sequence DESC,current.start_item_ordinal DESC,current.created_at DESC,current.id DESC
          LIMIT 1)`).get(segmentId) as {
            binding_id: string; binding_generation: number; session_epoch: number; workspace_id: string; pane_id: string;
          } | undefined;
    if (!row) return null;
    return this.load(
      { kind: "pane", workspaceId: row.workspace_id, paneId: row.pane_id },
      { bindingId: row.binding_id, bindingGeneration: row.binding_generation, sessionEpoch: row.session_epoch }
    );
  }

  loadTurnSessionStateForCurrentSegment(segmentId: string) {
    const row = this.context.database.prepare(`SELECT binding.id AS binding_id,binding.generation AS binding_generation,
        binding.session_epoch,binding.workspace_id,binding.pane_id
      FROM conversation_segments segment
      JOIN bindings binding ON binding.id=segment.owner_id AND binding.generation=segment.owner_generation
      WHERE segment.id=? AND segment.owner_kind='primary' AND segment.session_id=binding.agent_session_value
        AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
        AND binding.pane_id IS NOT NULL
        AND segment.id=(SELECT current.id FROM conversation_segments current
          WHERE current.owner_kind='primary' AND current.owner_id=binding.id
            AND current.owner_generation=binding.generation AND current.session_id=binding.agent_session_value
            AND current.start_lane_sequence IS NOT NULL
          ORDER BY current.start_lane_sequence DESC,current.start_item_ordinal DESC,current.created_at DESC,current.id DESC
          LIMIT 1)`).get(segmentId) as {
            binding_id: string; binding_generation: number; session_epoch: number; workspace_id: string; pane_id: string;
          } | undefined;
    if (row) {
      return turnSessionStateView(
        this.projections?.loadTopicView(row.binding_id) ?? null,
        this.load(
          { kind: "pane", workspaceId: row.workspace_id, paneId: row.pane_id },
          { bindingId: row.binding_id, bindingGeneration: row.binding_generation, sessionEpoch: row.session_epoch }
        )
      );
    }
    const worker = this.context.database.prepare(`SELECT worker.id AS worker_id,worker.generation AS worker_generation,
        worker.worker_session_generation,worker.pane_id AS worker_pane_id,worker.pane_token AS worker_pane_token,
        worker.native_session_id AS worker_native_session_id,worker.agent_kind AS worker_agent_kind,
        worker.desired_state AS worker_desired_state,worker.observed_state AS worker_observed_state,
        binding.id AS binding_id,binding.generation AS binding_generation,binding.session_epoch,
        binding.workspace_id,binding.pane_id AS parent_pane_id,binding.agent_session_value AS parent_native_session_id,
        lease.cwd AS lease_cwd,lease.branch AS lease_branch,
        main.worker_session_generation AS main_worker_session_generation,main.parent_binding_id AS main_parent_binding_id,
        main.parent_binding_generation AS main_parent_binding_generation,main.parent_pane_id AS main_parent_pane_id,
        main.state_json AS main_state_json
      FROM conversation_segments segment
      JOIN agent_instances worker ON worker.id=segment.owner_id AND worker.generation=segment.owner_generation
      JOIN bindings binding ON binding.id=worker.parent_binding_id AND binding.generation=worker.parent_binding_generation
      LEFT JOIN workspace_leases lease ON lease.id=worker.workspace_lease_id AND lease.instance_id=worker.id
      LEFT JOIN worker_main_views main ON main.worker_id=worker.id
        AND main.worker_session_generation=worker.worker_session_generation
      WHERE segment.id=? AND segment.owner_kind='worker' AND segment.session_id=worker.native_session_id
        AND segment.agent_kind=worker.agent_kind
        AND worker.role='worker' AND worker.worker_session_lifecycle='active'
        AND worker.pane_id IS NOT NULL AND worker.native_session_id IS NOT NULL
        AND worker.parent_pane_id=binding.pane_id AND worker.parent_native_session_id=binding.agent_session_value
        AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
        AND binding.pane_id IS NOT NULL AND binding.agent_session_kind='id' AND binding.agent_session_value IS NOT NULL
        AND segment.id=(SELECT current.id FROM conversation_segments current
          WHERE current.owner_kind='worker' AND current.owner_id=worker.id
            AND current.owner_generation=worker.generation AND current.agent_kind=worker.agent_kind
            AND current.session_id=worker.native_session_id AND current.start_lane_sequence IS NOT NULL
          ORDER BY current.start_lane_sequence DESC,current.start_item_ordinal DESC,current.created_at DESC,current.id DESC
          LIMIT 1)`).get(segmentId) as CurrentWorkerSegmentRow | undefined;
    if (!worker) return null;
    const activity = this.loadExactWorkerActivity(worker);
    if (!activity) return null;
    return turnSessionStateView(this.workerTurnIdentityFacts(worker), activity);
  }

  private loadExactWorkerActivity(worker: CurrentWorkerSegmentRow): SessionActivityView | null {
    const scopeKey = deliveryScopeKey({ kind: "pane", workspaceId: worker.workspace_id, paneId: worker.parent_pane_id });
    const snapshot = this.context.database.prepare(`SELECT * FROM session_activity_snapshots
      WHERE scope_key=? AND workspace_id=? AND pane_id=? AND producer_kind='worker' AND producer_id=?
        AND producer_generation=? AND producer_session_generation=? AND runtime_pane_id=?
        AND binding_id=? AND binding_generation=? AND session_epoch=? AND native_session_id=? AND agent_kind=?`).get(
      scopeKey, worker.workspace_id, worker.parent_pane_id, worker.worker_id,
      worker.worker_generation, worker.worker_session_generation, worker.worker_pane_id,
      worker.binding_id, worker.binding_generation, worker.session_epoch,
      worker.worker_native_session_id, worker.worker_agent_kind
    ) as unknown as SnapshotRow | undefined;
    if (!snapshot) return null;
    const items = this.context.database.prepare(`SELECT item.* FROM session_activity_items item
      JOIN session_activity_snapshots snapshot ON snapshot.scope_key=item.scope_key
        AND snapshot.producer_kind=item.producer_kind AND snapshot.producer_id=item.producer_id
      WHERE item.scope_key=? AND item.producer_kind='worker' AND item.producer_id=?
        AND snapshot.workspace_id=? AND snapshot.pane_id=?
        AND snapshot.producer_generation=? AND snapshot.producer_session_generation=? AND snapshot.runtime_pane_id=?
        AND snapshot.binding_id=? AND snapshot.binding_generation=? AND snapshot.session_epoch=?
        AND snapshot.native_session_id=? AND snapshot.agent_kind=?
      ORDER BY item.kind,
        CASE WHEN item.kind='task' THEN item.item_ordinal END,
        CASE WHEN item.kind<>'task' THEN item.terminal END,
        item.updated_at DESC,item.source_event_id DESC,item.item_id`).all(
      scopeKey, worker.worker_id, worker.workspace_id, worker.parent_pane_id,
      worker.worker_generation, worker.worker_session_generation, worker.worker_pane_id,
      worker.binding_id, worker.binding_generation, worker.session_epoch,
      worker.worker_native_session_id, worker.worker_agent_kind
    ) as Array<Record<string, unknown>>;
    return {
      snapshot: {
        scopeKey, workspaceId: worker.workspace_id, paneId: worker.parent_pane_id,
        bindingId: worker.binding_id, bindingGeneration: worker.binding_generation, sessionEpoch: worker.session_epoch,
        nativeSessionId: snapshot.native_session_id, revision: snapshot.revision,
        currentModel: snapshot.current_model,
        currentGoal: snapshot.current_goal_json ? JSON.parse(snapshot.current_goal_json) : null,
        lastTurnId: snapshot.last_turn_id, lastTurnState: snapshot.last_turn_state,
        compactionCount: snapshot.compaction_count, tokenUsage: snapshot.token_usage,
        contextUsage: snapshot.context_usage, updatedAt: snapshot.updated_at
      },
      items: items.map(mapItem)
    };
  }

  private workerTurnIdentityFacts(worker: CurrentWorkerSegmentRow): TurnSessionIdentityFacts {
    const base: TurnSessionIdentityFacts = {
      paneIdentity: {
        workspace: worker.lease_cwd,
        worktreeName: null,
        branch: worker.lease_branch,
        paneId: worker.worker_pane_id,
        paneToken: worker.worker_pane_token
      },
      model: null,
      modelUsage: null
    };
    if (!worker.main_state_json || worker.main_worker_session_generation !== worker.worker_session_generation
      || worker.main_parent_binding_id !== worker.binding_id || worker.main_parent_binding_generation !== worker.binding_generation
      || worker.main_parent_pane_id !== worker.parent_pane_id || worker.lease_cwd === null) return base;
    let view: Record<string, unknown>;
    try { view = JSON.parse(worker.main_state_json) as Record<string, unknown>; } catch { return base; }
    const identity = record(view.paneIdentity);
    const viewPaneToken = nullableString(view.paneToken);
    if (view.workerId !== worker.worker_id || view.workerSessionGeneration !== worker.worker_session_generation
      || view.parentBindingId !== worker.binding_id || view.parentBindingGeneration !== worker.binding_generation
      || view.parentPaneId !== worker.parent_pane_id || view.runtimeGeneration !== worker.worker_generation
      || view.runtimeAttached !== true || view.parentActive !== true || view.desiredState !== worker.worker_desired_state
      || view.runtimeState !== worker.worker_observed_state || view.paneId !== worker.worker_pane_id
      || !isNullableString(view.paneToken) || (worker.worker_pane_token !== null && viewPaneToken !== worker.worker_pane_token)
      || view.workspace !== worker.lease_cwd
      || !isNullableString(view.branch) || view.branch !== worker.lease_branch
      || (identity && (!isNullableString(identity.workspace) || identity.workspace !== worker.lease_cwd
        || !isNullableString(identity.branch) || identity.branch !== worker.lease_branch
        || !isNullableString(identity.paneId) || identity.paneId !== worker.worker_pane_id
        || !isNullableString(identity.paneToken) || identity.paneToken !== viewPaneToken))) return base;
    const usage = record(view.modelUsage);
    return {
      paneIdentity: {
        workspace: worker.lease_cwd,
        worktreeName: nullableString(identity?.worktreeName ?? view.worktreeName),
        branch: worker.lease_branch,
        paneId: worker.worker_pane_id,
        paneToken: worker.worker_pane_token ?? viewPaneToken
      },
      model: nullableString(view.model),
      modelUsage: usage ? {
        model: nullableString(usage.model),
        contextRemainingPercent: optionalNumber(usage.contextRemainingPercent),
        inputTokens: optionalNumber(usage.inputTokens), outputTokens: optionalNumber(usage.outputTokens),
        waitMs: optionalNumber(usage.waitMs), firstVisibleMs: optionalNumber(usage.firstVisibleMs)
      } : null
    };
  }

  projectTopicViewChange(previous: TopicViewState, next: TopicViewState, occurredAt: string): boolean {
    if (previous.bindingId !== next.bindingId || previous.bindingGeneration !== next.bindingGeneration) return false;
    const binding = this.projections?.getBinding(next.bindingId);
    if (!binding || binding.generation !== next.bindingGeneration || binding.sessionEpoch === undefined || !binding.paneId) return false;
    const activity = this.load(
      { kind: "pane", workspaceId: binding.workspaceId, paneId: binding.paneId },
      { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch }
    );
    if (turnSessionStatePresentationFingerprint(turnSessionStateView(previous, activity)) === turnSessionStatePresentationFingerprint(turnSessionStateView(next, activity))) return false;
    this.recoveryNotifier?.({
      bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch,
      producer: {
        kind: "primary", id: binding.id, runtimeGeneration: binding.generation,
        sessionGeneration: binding.sessionEpoch, runtimePaneId: binding.paneId
      },
      occurredAt
    });
    return true;
  }

  private project(input: SessionActivityProjectionInput, onMissingIdentityFallback: () => void): "projected" | "duplicate" | "stale" | "ignored" {
    if (!Number.isSafeInteger(input.laneSequence) || input.laneSequence < 0 || !input.sourceEpoch) return "stale";
    if (!consistentProjectionContext(input)) return "stale";
    const identity = this.resolveIdentity(input);
    if (!identity) return "stale";
    const scopeKey = deliveryScopeKey(input.context.scope);
    let current = this.context.database.prepare(`SELECT * FROM session_activity_snapshots
      WHERE scope_key=? AND producer_kind=? AND producer_id=?`).get(
      scopeKey, input.context.producer.kind, input.context.producer.id
    ) as unknown as SnapshotRow | undefined;
    if (current && !sameIdentity(current, input, identity)) {
      this.context.database.prepare(`DELETE FROM session_activity_snapshots
        WHERE scope_key=? AND producer_kind=? AND producer_id=?`).run(scopeKey, input.context.producer.kind, input.context.producer.id);
      current = undefined;
    }
    if (current && (current.lane_id !== input.laneId || current.source_id !== input.sourceId || current.source_epoch !== input.sourceEpoch)) {
      const checkpoint = this.context.database.prepare(`SELECT source_id,source_epoch FROM core_event_lane_checkpoints
        WHERE lane_id=?`).get(input.laneId) as { source_id: string; source_epoch: string | null } | undefined;
      if (current.lane_id !== input.laneId || checkpoint?.source_id !== input.sourceId || checkpoint.source_epoch !== input.sourceEpoch) return "stale";
    }
    if (current) {
      if (current.source_lane_sequence > input.laneSequence) return "stale";
      if (current.source_lane_sequence === input.laneSequence) return current.source_event_id === input.event.eventId ? "duplicate" : "stale";
    }
    this.removeStaleProducers(scopeKey, identity);
    const change = projectChange(input, current);
    if (!change.changed) {
      if (current) this.advanceWatermark(scopeKey, input);
      return "ignored";
    }
    const revision = (current?.revision ?? 0) + 1;
    this.context.database.prepare(`INSERT INTO session_activity_snapshots(
      scope_key,workspace_id,pane_id,producer_kind,producer_id,producer_generation,producer_session_generation,runtime_pane_id,
      binding_id,binding_generation,session_epoch,native_session_id,agent_kind,lane_id,source_id,source_epoch,source_lane_sequence,source_event_id,
      reducer_revision,revision,current_model,current_goal_json,last_turn_id,last_turn_state,compaction_count,token_usage,context_usage,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scope_key,producer_kind,producer_id) DO UPDATE SET
      producer_generation=excluded.producer_generation,producer_session_generation=excluded.producer_session_generation,runtime_pane_id=excluded.runtime_pane_id,
      binding_id=excluded.binding_id,binding_generation=excluded.binding_generation,session_epoch=excluded.session_epoch,native_session_id=excluded.native_session_id,agent_kind=excluded.agent_kind,
      lane_id=excluded.lane_id,source_id=excluded.source_id,source_epoch=excluded.source_epoch,source_lane_sequence=excluded.source_lane_sequence,source_event_id=excluded.source_event_id,
      reducer_revision=excluded.reducer_revision,revision=excluded.revision,current_model=excluded.current_model,current_goal_json=excluded.current_goal_json,
      last_turn_id=excluded.last_turn_id,last_turn_state=excluded.last_turn_state,compaction_count=excluded.compaction_count,updated_at=excluded.updated_at`).run(
      scopeKey, input.context.scope.workspaceId, input.context.scope.paneId,
      input.context.producer.kind, input.context.producer.id, input.context.producer.runtimeGeneration, input.context.producer.sessionGeneration, input.context.producer.runtimePaneId,
      identity.bindingId, identity.bindingGeneration, identity.sessionEpoch, input.event.sessionId, input.event.agentKind,
      input.laneId, input.sourceId, input.sourceEpoch, input.laneSequence, input.event.eventId, REDUCER_REVISION, revision,
      change.currentModel, change.currentGoalJson, change.lastTurnId, change.lastTurnState, change.compactionCount, null, null, input.observedAt
    );
    if (input.taskList !== undefined) {
      const retained = new Set(input.taskList.flatMap((task) => task.id ? [task.id] : []));
      const existingTasks = this.context.database.prepare(`SELECT item_id FROM session_activity_items
        WHERE scope_key=? AND producer_kind=? AND producer_id=? AND kind='task'`).all(
        scopeKey, input.context.producer.kind, input.context.producer.id
      ) as Array<{ item_id: string }>;
      for (const task of existingTasks) if (!retained.has(task.item_id)) this.context.database.prepare(`DELETE FROM session_activity_items
        WHERE scope_key=? AND producer_kind=? AND producer_id=? AND kind='task' AND item_id=?`).run(
        scopeKey, input.context.producer.kind, input.context.producer.id, task.item_id
      );
    }
    for (const item of change.items) this.upsertItem(scopeKey, input, item, onMissingIdentityFallback);
    this.pruneItems(scopeKey);
    return "projected";
  }

  private resolveIdentity(input: SessionActivityProjectionInput): { bindingId: string; bindingGeneration: number; sessionEpoch: number } | null {
    const owner = input.context.ownerFence;
    if (owner.kind === "primary") {
      const row = this.context.database.prepare(`SELECT id,generation,session_epoch FROM bindings
        WHERE id=? AND generation=? AND session_epoch=? AND workspace_id=? AND pane_id=?
          AND state='active' AND lifecycle='active' AND attachment='attached'
          AND agent_kind=? AND agent_session_kind='id' AND agent_session_value=?`).get(
        owner.id, owner.generation, owner.sessionGeneration, input.context.scope.workspaceId, input.context.scope.paneId,
        input.event.agentKind, input.event.sessionId
      ) as { id: string; generation: number; session_epoch: number } | undefined;
      return row ? { bindingId: row.id, bindingGeneration: Number(row.generation), sessionEpoch: Number(row.session_epoch) } : null;
    }
    const parent = owner.parent;
    if (!parent) return null;
    const row = this.context.database.prepare(`SELECT binding.id,binding.generation,binding.session_epoch
      FROM agent_instances worker JOIN bindings binding ON binding.id=worker.parent_binding_id
      WHERE worker.id=? AND worker.role='worker' AND worker.generation=? AND worker.worker_session_generation=?
        AND worker.worker_session_lifecycle='active' AND worker.pane_id=? AND worker.native_session_id=?
        AND worker.parent_binding_id=? AND worker.parent_binding_generation=? AND worker.parent_pane_id=?
        AND binding.generation=? AND binding.session_epoch=? AND binding.workspace_id=? AND binding.pane_id=?
        AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'`).get(
      owner.id, owner.generation, owner.sessionGeneration, input.context.producer.runtimePaneId, input.event.sessionId,
      parent.id, parent.generation, input.context.scope.paneId,
      parent.generation, parent.sessionGeneration, input.context.scope.workspaceId, input.context.scope.paneId
    ) as { id: string; generation: number; session_epoch: number } | undefined;
    return row ? { bindingId: row.id, bindingGeneration: Number(row.generation), sessionEpoch: Number(row.session_epoch) } : null;
  }

  private removeStaleProducers(scopeKey: string, identity: { bindingId: string; bindingGeneration: number; sessionEpoch: number }): boolean {
    const result = this.context.database.prepare(`DELETE FROM session_activity_snapshots
      WHERE scope_key=? AND (
        binding_id<>? OR binding_generation<>? OR session_epoch<>?
        OR (producer_kind='primary' AND producer_id<>?)
        OR (producer_kind='worker' AND NOT EXISTS(
          SELECT 1 FROM agent_instances worker WHERE worker.id=session_activity_snapshots.producer_id
            AND worker.role='worker' AND worker.generation=session_activity_snapshots.producer_generation
            AND worker.worker_session_generation=session_activity_snapshots.producer_session_generation
            AND worker.worker_session_lifecycle='active' AND worker.parent_binding_id=session_activity_snapshots.binding_id
            AND worker.parent_binding_generation=session_activity_snapshots.binding_generation
            AND worker.parent_pane_id=session_activity_snapshots.pane_id
        ))
      )`).run(scopeKey, identity.bindingId, identity.bindingGeneration, identity.sessionEpoch, identity.bindingId);
    return Number(result.changes) > 0;
  }

  private advanceWatermark(scopeKey: string, input: SessionActivityProjectionInput): void {
    this.context.database.prepare(`UPDATE session_activity_snapshots SET
      lane_id=?,source_id=?,source_epoch=?,source_lane_sequence=?,source_event_id=?
      WHERE scope_key=? AND producer_kind=? AND producer_id=?`).run(
      input.laneId, input.sourceId, input.sourceEpoch, input.laneSequence, input.event.eventId,
      scopeKey, input.context.producer.kind, input.context.producer.id
    );
  }

  private upsertItem(scopeKey: string, input: SessionActivityProjectionInput, item: ItemMutation, onMissingIdentityFallback: () => void): boolean {
    const existing = this.context.database.prepare(`SELECT source_lane_sequence,source_event_id,label,state,terminal FROM session_activity_items
      WHERE scope_key=? AND producer_kind=? AND producer_id=? AND kind=? AND item_id=?`).get(
      scopeKey, input.context.producer.kind, input.context.producer.id, item.kind, item.itemId
    ) as { source_lane_sequence: number; source_event_id: string; label: string; state: string; terminal: number } | undefined;
    const identity = item.kind === "agent" ? this.mergeAgentIdentity(scopeKey, input, item) : null;
    const identityLabel = item.kind !== "agent"
      ? item.label
      : identity
        ? agentIdentityLabel(identity, item.itemId)
        : item.preserveExistingLabel && existing?.label
          ? existing.label
          : item.itemId;
    const missingIdentityFallback = item.kind === "agent" && !identity && item.preserveExistingLabel === true
      && (!existing?.label || existing.label === item.itemId);
    if (existing && (existing.source_lane_sequence > input.laneSequence || existing.source_event_id === input.event.eventId)) {
      if (!identity?.changed || existing.label === identityLabel) return false;
      if (missingIdentityFallback) onMissingIdentityFallback();
      this.context.database.prepare(`UPDATE session_activity_items SET label=?,updated_at=?
        WHERE scope_key=? AND producer_kind=? AND producer_id=? AND kind='agent' AND item_id=?`).run(
        bounded(identityLabel, 512), input.observedAt, scopeKey, input.context.producer.kind, input.context.producer.id, item.itemId
      );
      return true;
    }
    if (item.kind === "agent" && existing?.terminal === 1 && !item.terminal) {
      if (!identity?.changed || existing.label === identityLabel) return false;
      if (missingIdentityFallback) onMissingIdentityFallback();
      this.context.database.prepare(`UPDATE session_activity_items SET label=?,updated_at=?
        WHERE scope_key=? AND producer_kind=? AND producer_id=? AND kind='agent' AND item_id=?`).run(
        bounded(identityLabel, 512), input.observedAt, scopeKey, input.context.producer.kind, input.context.producer.id, item.itemId
      );
      return true;
    }
    if (missingIdentityFallback) onMissingIdentityFallback();
    this.context.database.prepare(`INSERT INTO session_activity_items(
      scope_key,producer_kind,producer_id,kind,item_id,producer_generation,producer_session_generation,runtime_pane_id,
      lane_id,source_id,source_epoch,source_lane_sequence,source_event_id,item_ordinal,label,state,terminal,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scope_key,producer_kind,producer_id,kind,item_id) DO UPDATE SET
      producer_generation=excluded.producer_generation,producer_session_generation=excluded.producer_session_generation,runtime_pane_id=excluded.runtime_pane_id,
      lane_id=excluded.lane_id,source_id=excluded.source_id,source_epoch=excluded.source_epoch,source_lane_sequence=excluded.source_lane_sequence,
      source_event_id=excluded.source_event_id,item_ordinal=excluded.item_ordinal,label=excluded.label,state=excluded.state,terminal=excluded.terminal,updated_at=excluded.updated_at`).run(
      scopeKey, input.context.producer.kind, input.context.producer.id, item.kind, item.itemId,
      input.context.producer.runtimeGeneration, input.context.producer.sessionGeneration, input.context.producer.runtimePaneId,
      input.laneId, input.sourceId, input.sourceEpoch, input.laneSequence, input.event.eventId, item.ordinal,
      bounded(item.kind === "agent" ? identityLabel : (item.label === "Tool" || item.preserveExistingLabel) && existing?.label ? existing.label : item.label, 512),
      bounded(item.state, 64), item.terminal ? 1 : 0, input.observedAt
    );
    return true;
  }

  private mergeAgentIdentity(
    scopeKey: string,
    input: SessionActivityProjectionInput,
    item: ItemMutation
  ): (SessionAgentIdentity & { changed: boolean }) | null {
    const existing = this.context.database.prepare(`SELECT * FROM session_activity_agent_identities
      WHERE scope_key=? AND producer_kind=? AND producer_id=? AND agent_id=?`).get(
      scopeKey, input.context.producer.kind, input.context.producer.id, item.itemId
    ) as unknown as AgentIdentityRow | undefined;
    const displayName = bounded(item.displayName ?? "", 256) || null;
    const model = bounded(item.model ?? "", 256) || null;
    if (!existing && !displayName && !model) return null;
    const replaceName = Boolean(displayName) && (!existing?.display_name || newerEvidence(
      input.laneSequence, input.event.eventId, existing.display_name_lane_sequence, existing.display_name_event_id
    ));
    const replaceModel = Boolean(model) && (!existing?.model || newerEvidence(
      input.laneSequence, input.event.eventId, existing.model_lane_sequence, existing.model_event_id
    ));
    const nextDisplayName = replaceName ? displayName : existing?.display_name ?? null;
    const nextModel = replaceModel ? model : existing?.model ?? null;
    const changed = !existing || replaceName || replaceModel;
    if (changed) {
      const sourceIsNewer = !existing || newerEvidence(input.laneSequence, input.event.eventId, existing.source_lane_sequence, existing.source_event_id);
      this.context.database.prepare(`INSERT INTO session_activity_agent_identities(
        scope_key,producer_kind,producer_id,producer_generation,producer_session_generation,agent_id,display_name,display_name_lane_sequence,display_name_event_id,
        model,model_lane_sequence,model_event_id,source_lane_sequence,source_event_id,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(scope_key,producer_kind,producer_id,agent_id) DO UPDATE SET
        producer_generation=excluded.producer_generation,producer_session_generation=excluded.producer_session_generation,
        display_name=excluded.display_name,display_name_lane_sequence=excluded.display_name_lane_sequence,display_name_event_id=excluded.display_name_event_id,
        model=excluded.model,model_lane_sequence=excluded.model_lane_sequence,model_event_id=excluded.model_event_id,
        source_lane_sequence=excluded.source_lane_sequence,source_event_id=excluded.source_event_id,updated_at=excluded.updated_at`).run(
        scopeKey, input.context.producer.kind, input.context.producer.id,
        input.context.producer.runtimeGeneration, input.context.producer.sessionGeneration, item.itemId,
        nextDisplayName,
        replaceName ? input.laneSequence : existing?.display_name_lane_sequence ?? null,
        replaceName ? input.event.eventId : existing?.display_name_event_id ?? null,
        nextModel,
        replaceModel ? input.laneSequence : existing?.model_lane_sequence ?? null,
        replaceModel ? input.event.eventId : existing?.model_event_id ?? null,
        sourceIsNewer ? input.laneSequence : existing!.source_lane_sequence,
        sourceIsNewer ? input.event.eventId : existing!.source_event_id,
        input.observedAt
      );
    }
    return {
      scopeKey,
      producerKind: input.context.producer.kind,
      producerId: input.context.producer.id,
      producerGeneration: input.context.producer.runtimeGeneration,
      producerSessionGeneration: input.context.producer.sessionGeneration,
      agentId: item.itemId,
      displayName: nextDisplayName,
      model: nextModel,
      sourceLaneSequence: existing && !newerEvidence(input.laneSequence, input.event.eventId, existing.source_lane_sequence, existing.source_event_id)
        ? existing.source_lane_sequence : input.laneSequence,
      sourceEventId: existing && !newerEvidence(input.laneSequence, input.event.eventId, existing.source_lane_sequence, existing.source_event_id)
        ? existing.source_event_id : input.event.eventId,
      changed
    };
  }

  private applyRecoveredAgentMutation(
    pair: RetainedMultiAgentPair,
    mutation: import("../../domain/session-activity.js").SessionActivityAgentLifecycleMutation,
    observedAt: string,
    onMissingIdentityFallback: () => void
  ): boolean {
    const scopeKey = deliveryScopeKey({ kind: "pane", workspaceId: pair.workspaceId, paneId: pair.paneId });
    const context: SessionActivityProjectionInput["context"] = {
      scope: { kind: "pane", workspaceId: pair.workspaceId, paneId: pair.paneId },
      ownerFence: pair.producerKind === "primary"
        ? { kind: "primary", id: pair.bindingId, generation: pair.bindingGeneration, sessionGeneration: pair.sessionEpoch }
        : {
            kind: "worker", id: pair.producerId, generation: pair.producerGeneration, sessionGeneration: pair.producerSessionGeneration,
            parent: { id: pair.bindingId, generation: pair.bindingGeneration, sessionGeneration: pair.sessionEpoch }
          },
      producer: {
        kind: pair.producerKind, id: pair.producerId, runtimeGeneration: pair.producerGeneration,
        sessionGeneration: pair.producerSessionGeneration, runtimePaneId: pair.runtimePaneId
      }
    };
    let snapshot = this.context.database.prepare(`SELECT * FROM session_activity_snapshots
      WHERE scope_key=? AND producer_kind=? AND producer_id=?`).get(scopeKey, pair.producerKind, pair.producerId) as unknown as SnapshotRow | undefined;
    if (snapshot && (snapshot.binding_generation !== pair.bindingGeneration || snapshot.session_epoch !== pair.sessionEpoch
      || snapshot.producer_generation !== pair.producerGeneration || snapshot.producer_session_generation !== pair.producerSessionGeneration
      || snapshot.runtime_pane_id !== pair.runtimePaneId || snapshot.native_session_id !== pair.resultEvent.sessionId
      || snapshot.agent_kind !== pair.resultEvent.agentKind)) {
      this.context.database.prepare(`DELETE FROM session_activity_snapshots
        WHERE scope_key=? AND producer_kind=? AND producer_id=?`).run(scopeKey, pair.producerKind, pair.producerId);
      snapshot = undefined;
    }
    const createdSnapshot = !snapshot;
    if (createdSnapshot) {
      this.context.database.prepare(`INSERT INTO session_activity_snapshots(
        scope_key,workspace_id,pane_id,producer_kind,producer_id,producer_generation,producer_session_generation,runtime_pane_id,
        binding_id,binding_generation,session_epoch,native_session_id,agent_kind,lane_id,source_id,source_epoch,source_lane_sequence,source_event_id,
        reducer_revision,revision,current_model,current_goal_json,last_turn_id,last_turn_state,compaction_count,token_usage,context_usage,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        scopeKey, pair.workspaceId, pair.paneId, pair.producerKind, pair.producerId,
        pair.producerGeneration, pair.producerSessionGeneration, pair.runtimePaneId,
        pair.bindingId, pair.bindingGeneration, pair.sessionEpoch, pair.resultEvent.sessionId, pair.resultEvent.agentKind,
        pair.laneId, pair.sourceId, pair.sourceEpoch, pair.laneSequence, pair.resultEvent.eventId,
        REDUCER_REVISION, 1, null, null, null, null, 0, null, null, observedAt
      );
    }
    const applied = this.upsertItem(scopeKey, {
      context, laneId: pair.laneId, laneSequence: pair.laneSequence, sourceId: pair.sourceId, sourceEpoch: pair.sourceEpoch,
      event: pair.resultEvent, observedAt
    }, {
      kind: "agent", itemId: mutation.agentId, ordinal: 0,
      label: mutation.model ? `${mutation.displayName ?? mutation.agentId} · ${mutation.model}` : mutation.displayName ?? mutation.agentId,
      state: mutation.state, terminal: mutation.terminal, preserveExistingLabel: !mutation.displayName || !mutation.model,
      ...(mutation.displayName ? { displayName: mutation.displayName } : {}),
      ...(mutation.model ? { model: mutation.model } : {})
    }, onMissingIdentityFallback);
    if (!applied) return false;
    if (!createdSnapshot) this.context.database.prepare(`UPDATE session_activity_snapshots SET revision=revision+1,updated_at=?
      WHERE scope_key=? AND producer_kind=? AND producer_id=?`).run(observedAt, scopeKey, pair.producerKind, pair.producerId);
    return true;
  }

  private advanceRetainedRecoveryCheckpoints(page: readonly RetainedMultiAgentPair[]): void {
    const checkpoints = new Map<string, RetainedMultiAgentPair>();
    for (const pair of page) {
      const key = `${recoveryIdentityKey(pair)}\u0000${pair.producerKind}\u0000${pair.producerId}\u0000${pair.producerGeneration}\u0000${pair.producerSessionGeneration}\u0000${pair.runtimePaneId}\u0000${pair.resultEvent.sessionId}\u0000${pair.resultEvent.agentKind}\u0000${pair.laneId}`;
      const current = checkpoints.get(key);
      if (!current || pair.laneSequence > current.laneSequence) checkpoints.set(key, pair);
    }
    const update = this.context.database.prepare(`UPDATE session_activity_snapshots SET
      retained_recovery_lane_id=?,
      retained_recovery_lane_sequence=CASE WHEN retained_recovery_lane_id=?
        THEN CASE WHEN retained_recovery_lane_sequence>? THEN retained_recovery_lane_sequence ELSE ? END
        ELSE ? END
      WHERE scope_key=? AND producer_kind=? AND producer_id=?
        AND binding_id=? AND binding_generation=? AND session_epoch=?
        AND producer_generation=? AND producer_session_generation=? AND runtime_pane_id=?
        AND native_session_id=? AND agent_kind=?`);
    for (const pair of checkpoints.values()) {
      update.run(
        pair.laneId, pair.laneId, pair.laneSequence, pair.laneSequence, pair.laneSequence,
        deliveryScopeKey({ kind: "pane", workspaceId: pair.workspaceId, paneId: pair.paneId }), pair.producerKind, pair.producerId,
        pair.bindingId, pair.bindingGeneration, pair.sessionEpoch,
        pair.producerGeneration, pair.producerSessionGeneration, pair.runtimePaneId,
        pair.resultEvent.sessionId, pair.resultEvent.agentKind
      );
    }
  }

  private loadRetainedMultiAgentPairs(limit: number, afterCursor?: string | null): RetainedMultiAgentPair[] {
    const cursor = parseRecoveryCursor(afterCursor);
    const rows = this.context.database.prepare(RETAINED_MULTI_AGENT_ACTIVITY_QUERY).all(
      cursor?.bindingId ?? null, cursor?.bindingId ?? "", cursor?.producerKind ?? "primary", cursor?.producerId ?? "",
      cursor?.laneId ?? "", cursor?.laneSequence ?? -1, cursor?.eventId ?? "", limit
    ) as Array<{ binding_id: string; binding_generation: number; session_epoch: number;
      producer_kind: "primary" | "worker"; producer_id: string; producer_generation: number; producer_session_generation: number; runtime_pane_id: string;
      workspace_id: string; pane_id: string;
      lane_id: string; sequence: number; result_event_id: string; result_json: string; call_json: string; source_id: string; source_epoch: string | null }>;
    return rows.flatMap((row) => {
      try {
        return [{
          bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation), sessionEpoch: Number(row.session_epoch),
          producerKind: row.producer_kind, producerId: row.producer_id, producerGeneration: Number(row.producer_generation),
          producerSessionGeneration: Number(row.producer_session_generation), runtimePaneId: row.runtime_pane_id,
          workspaceId: row.workspace_id, paneId: row.pane_id, laneId: row.lane_id, laneSequence: Number(row.sequence),
          sourceId: row.source_id, sourceEpoch: row.source_epoch ?? row.source_id,
          callEvent: JSON.parse(row.call_json) as CoreEventEnvelope, resultEvent: JSON.parse(row.result_json) as CoreEventEnvelope
        }];
      } catch { return []; }
    });
  }

  private storedPresentationFingerprintForRecovery(pair: RetainedMultiAgentPair): string {
    return this.storedPresentationFingerprint(
      deliveryScopeKey({ kind: "pane", workspaceId: pair.workspaceId, paneId: pair.paneId }),
      { bindingId: pair.bindingId, bindingGeneration: pair.bindingGeneration, sessionEpoch: pair.sessionEpoch }
    );
  }

  private pruneItems(scopeKey: string): void {
    for (const kind of ["task", "agent", "tool"] as const) {
      this.context.database.prepare(`DELETE FROM session_activity_items WHERE rowid IN (
        SELECT rowid FROM session_activity_items
        WHERE scope_key=? AND kind=? AND terminal=1
        ORDER BY CASE WHEN kind='task' THEN item_ordinal END,
          CASE WHEN kind<>'task' THEN updated_at END DESC,source_event_id DESC,producer_kind,producer_id,item_id LIMIT -1 OFFSET ?
      )`).run(scopeKey, kind, SESSION_ACTIVITY_MAX_TERMINAL_PER_KIND);
      this.context.database.prepare(`DELETE FROM session_activity_items WHERE rowid IN (
        SELECT rowid FROM session_activity_items
        WHERE scope_key=? AND kind=? AND terminal=0
        ORDER BY CASE WHEN kind='task' THEN item_ordinal END,
          CASE WHEN kind<>'task' THEN updated_at END DESC,source_event_id DESC,producer_kind,producer_id,item_id LIMIT -1 OFFSET ?
      )`).run(scopeKey, kind, SESSION_ACTIVITY_VISIBLE_ACTIVE_PER_KIND);
    }
  }

  private projectMainCard(bindingId: string, scope: SessionActivityProjectionInput["context"]["scope"], observedAt: string): void {
    if (!this.projections || !this.renderers) return;
    const binding = this.projections.getBinding(bindingId);
    const current = this.projections.loadTopicView(bindingId);
    if (!binding || !binding.rootMessageId || !current) return;
    const activity = this.load(scope, { bindingId, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch });
    const next = updateTopicView(current, { sessionActivityRevision: current.sessionActivityRevision + 1, activityAt: activity?.snapshot.updatedAt ?? observedAt });
    this.projections.saveTopicView(next);
    this.projections.reserveMainCardIntent(
      next,
      binding.rootMessageId,
      this.renderers.main(next, activity),
      undefined,
      this.renderers.pane(next, activity)
    );
  }

  private storedPresentationFingerprint(
    scopeKey: string,
    identity: { bindingId: string; bindingGeneration: number; sessionEpoch: number }
  ): string {
    const snapshots = this.context.database.prepare(`SELECT * FROM session_activity_snapshots
      WHERE scope_key=? AND binding_id=? AND binding_generation=? AND session_epoch=?
      ORDER BY CASE producer_kind WHEN 'primary' THEN 0 ELSE 1 END,producer_id`).all(
      scopeKey, identity.bindingId, identity.bindingGeneration, identity.sessionEpoch
    ) as unknown as SnapshotRow[];
    if (!snapshots.length) {
      return turnSessionStatePresentationFingerprint(
        turnSessionStateView(this.projections?.loadTopicView(identity.bindingId) ?? null, null)
      );
    }
    const primary = snapshots.find(({ producer_kind }) => producer_kind === "primary");
    const items = this.context.database.prepare(`SELECT item.* FROM session_activity_items item
      JOIN session_activity_snapshots snapshot ON snapshot.scope_key=item.scope_key
        AND snapshot.producer_kind=item.producer_kind AND snapshot.producer_id=item.producer_id
      WHERE item.scope_key=? AND snapshot.binding_id=? AND snapshot.binding_generation=? AND snapshot.session_epoch=?
      ORDER BY item.kind,
        CASE WHEN item.kind='task' THEN item.item_ordinal END,
        CASE WHEN item.kind<>'task' THEN item.terminal END,
        item.updated_at DESC,item.source_event_id DESC,item.producer_kind,item.producer_id,item.item_id`).all(
      scopeKey, identity.bindingId, identity.bindingGeneration, identity.sessionEpoch
    ) as Array<Record<string, unknown>>;
    return turnSessionStatePresentationFingerprint(turnSessionStateView(this.projections?.loadTopicView(identity.bindingId) ?? null, {
      snapshot: {
        scopeKey, workspaceId: snapshots[0]!.workspace_id, paneId: snapshots[0]!.pane_id,
        bindingId: identity.bindingId, bindingGeneration: identity.bindingGeneration, sessionEpoch: identity.sessionEpoch,
        nativeSessionId: primary?.native_session_id ?? "",
        revision: snapshots.reduce((total, row) => total + Number(row.revision), 0),
        currentModel: primary?.current_model ?? null,
        currentGoal: primary?.current_goal_json ? JSON.parse(primary.current_goal_json) : null,
        lastTurnId: primary?.last_turn_id ?? null, lastTurnState: primary?.last_turn_state ?? null,
        compactionCount: snapshots.reduce((total, row) => total + Number(row.compaction_count), 0),
        tokenUsage: primary?.token_usage ?? null, contextUsage: primary?.context_usage ?? null,
        updatedAt: snapshots.reduce((latest, row) => row.updated_at > latest ? row.updated_at : latest, snapshots[0]!.updated_at)
      },
      items: items.map(mapItem)
    }));
  }

  private recordMissingIdentityFallbacks(count: number, observedAt: string): void {
    if (count === 0) return;
    this.runtimeDiagnostics = {
      missingIdentityFallbackCount: Math.min(Number.MAX_SAFE_INTEGER, this.runtimeDiagnostics.missingIdentityFallbackCount + count),
      lastMissingIdentityAt: observedAt,
      lastMissingIdentityOutcome: "uuid_fallback"
    };
  }
}

function consistentProjectionContext(input: SessionActivityProjectionInput): boolean {
  const { ownerFence: owner, producer, scope } = input.context;
  if (owner.kind !== producer.kind || owner.id !== producer.id
    || owner.generation !== producer.runtimeGeneration
    || owner.sessionGeneration !== producer.sessionGeneration) return false;
  if (owner.kind === "primary") return producer.runtimePaneId === scope.paneId;
  return Boolean(owner.parent);
}

function projectChange(input: SessionActivityProjectionInput, current?: SnapshotRow): {
  changed: boolean; currentModel: string | null; currentGoalJson: string | null; lastTurnId: string | null;
  lastTurnState: "active" | "completed" | "aborted" | null; compactionCount: number; items: ItemMutation[];
} {
  const payload = input.event.payload as Record<string, unknown>;
  const type = payload.type;
  let currentModel = current?.current_model ?? null;
  let currentGoalJson = current?.current_goal_json ?? null;
  let lastTurnId = current?.last_turn_id ?? null;
  let lastTurnState = current?.last_turn_state ?? null;
  let compactionCount = current?.compaction_count ?? 0;
  const items: ItemMutation[] = [];
  let changed = false;
  if (type === "turn_started") { lastTurnId = input.event.turnId; lastTurnState = "active"; changed = true; }
  else if ((type === "turn_completed" || type === "turn_aborted") && input.event.turnId && (!lastTurnId || lastTurnId === input.event.turnId)) {
    lastTurnId = input.event.turnId; lastTurnState = type === "turn_completed" ? "completed" : "aborted"; changed = true;
  } else if (type === "model_changed") {
    const model = bounded(text(payload, "model"), 256); if (model && model !== currentModel) { currentModel = model; changed = true; }
  } else if (type === "context_compacted") { compactionCount += 1; changed = true; }
  else if (type === "goal_changed") {
    const goal = { goalId: text(payload, "goal_id", "goalId"), objective: bounded(text(payload, "objective"), 2_000), status: text(payload, "status"), sourceUpdatedAt: number(payload, "source_updated_at", "sourceUpdatedAt") };
    const next = JSON.stringify(goal); if (goal.goalId && goal.objective && currentGoalJson !== next) { currentGoalJson = next; changed = true; }
  } else if (type === "agent_activity") {
    const itemId = text(payload, "agent_id", "agentId"); const state = text(payload, "state");
    const displayState = text(payload, "result_handoff", "resultHandoff") === "delivered_to_parent" ? "returned to main" : state;
    const suppliedDisplayName = text(payload, "display_name", "displayName");
    const displayName = suppliedDisplayName || itemId;
    const model = bounded(text(payload, "model"), 256);
    const label = model ? `${displayName} · ${model}` : displayName;
    if (itemId && state) {
      items.push({
        kind: "agent", itemId, ordinal: 0, label, state: displayState,
        terminal: terminalAgent(state), preserveExistingLabel: !suppliedDisplayName || !model,
        ...(suppliedDisplayName ? { displayName: suppliedDisplayName } : {}),
        ...(model ? { model } : {})
      });
      changed = true;
    }
  } else if (type === "tool_call") {
    const itemId = text(payload, "call_id", "callId"); const label = text(payload, "name") || "Tool";
    if (itemId) { items.push({ kind: "tool", itemId, ordinal: 0, label, state: "running", terminal: false }); changed = true; }
  } else if (type === "tool_result") {
    const itemId = text(payload, "call_id", "callId");
    if (itemId) { items.push({ kind: "tool", itemId, ordinal: 0, label: "Tool", state: truthy(payload, "is_error", "isError") ? "failed" : "completed", terminal: true }); changed = true; }
  }
  if (input.agentLifecycleMutations?.length) {
    for (const mutation of input.agentLifecycleMutations) {
      const displayName = mutation.displayName || mutation.agentId;
      const model = bounded(mutation.model ?? "", 256);
      items.push({
        kind: "agent", itemId: mutation.agentId, ordinal: 0, label: model ? `${displayName} · ${model}` : displayName,
        state: mutation.state, terminal: mutation.terminal, preserveExistingLabel: !mutation.displayName || !model,
        ...(mutation.displayName ? { displayName: mutation.displayName } : {}),
        ...(model ? { model } : {})
      });
    }
    changed = true;
  }
  if (input.taskList !== undefined) {
    input.taskList.forEach((task, ordinal) => { if (task.id) items.push({ kind: "task", itemId: task.id, ordinal, label: task.label, state: task.state ?? "pending", terminal: task.state === "completed" || task.state === "done" }); });
    changed = true;
  }
  return { changed, currentModel, currentGoalJson, lastTurnId, lastTurnState, compactionCount, items };
}

function sameIdentity(row: SnapshotRow, input: SessionActivityProjectionInput, identity: { bindingId: string; bindingGeneration: number; sessionEpoch: number }): boolean {
  return row.workspace_id === input.context.scope.workspaceId && row.pane_id === input.context.scope.paneId
    && row.producer_generation === input.context.producer.runtimeGeneration
    && row.producer_session_generation === input.context.producer.sessionGeneration
    && row.runtime_pane_id === input.context.producer.runtimePaneId
    && row.binding_id === identity.bindingId && row.binding_generation === identity.bindingGeneration && row.session_epoch === identity.sessionEpoch
    && row.native_session_id === input.event.sessionId && row.agent_kind === input.event.agentKind;
}

function recoveryIdentityKey(pair: RetainedMultiAgentPair): string {
  return `${pair.bindingId}\u0000${pair.bindingGeneration}\u0000${pair.sessionEpoch}\u0000${pair.workspaceId}\u0000${pair.paneId}`;
}

function recoveryCursor(pair: RetainedMultiAgentPair): string {
  return Buffer.from(JSON.stringify({
    bindingId: pair.bindingId, producerKind: pair.producerKind, producerId: pair.producerId,
    laneId: pair.laneId, laneSequence: pair.laneSequence, eventId: pair.resultEvent.eventId
  }), "utf8").toString("base64url");
}

function parseRecoveryCursor(value: string | null | undefined): RetainedMultiAgentCursor | null {
  if (!value || Buffer.byteLength(value, "utf8") > 1_024) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof parsed.bindingId === "string" && (parsed.producerKind === "primary" || parsed.producerKind === "worker")
      && typeof parsed.producerId === "string" && typeof parsed.laneId === "string"
      && typeof parsed.laneSequence === "number" && Number.isSafeInteger(parsed.laneSequence) && typeof parsed.eventId === "string"
      ? {
          bindingId: parsed.bindingId, producerKind: parsed.producerKind, producerId: parsed.producerId,
          laneId: parsed.laneId, laneSequence: parsed.laneSequence, eventId: parsed.eventId
        }
      : null;
  } catch { return null; }
}

function mapItem(row: Record<string, unknown>): SessionActivityItem {
  return {
    scopeKey: String(row.scope_key), producerKind: row.producer_kind as "primary" | "worker", producerId: String(row.producer_id),
    kind: row.kind as SessionActivityItemKind, itemId: String(row.item_id), ordinal: Number(row.item_ordinal), label: String(row.label), state: String(row.state),
    terminal: Number(row.terminal) === 1, sourceEventId: String(row.source_event_id), sourceLaneSequence: Number(row.source_lane_sequence), updatedAt: String(row.updated_at)
  };
}
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isNullableString(value: unknown): value is string | null { return value === null || typeof value === "string"; }
function nullableString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function optionalNumber(value: unknown): number | null { return typeof value === "number" ? value : null; }
function text(payload: Record<string, unknown>, ...keys: string[]): string { for (const key of keys) if (typeof payload[key] === "string") return payload[key] as string; return ""; }
function number(payload: Record<string, unknown>, ...keys: string[]): number { for (const key of keys) if (typeof payload[key] === "number") return payload[key] as number; return 0; }
function truthy(payload: Record<string, unknown>, ...keys: string[]): boolean { return keys.some((key) => payload[key] === true); }
function terminalAgent(state: string): boolean { return ["completed", "failed", "interrupted"].includes(state); }
function bounded(value: string, max: number): string { return value.replace(/\s+/g, " ").trim().slice(0, max); }
function newerEvidence(sequence: number, eventId: string, currentSequence: number | null, currentEventId: string | null): boolean {
  return currentSequence === null || sequence > currentSequence || (sequence === currentSequence && eventId > (currentEventId ?? ""));
}
function agentIdentityLabel(identity: SessionAgentIdentity | null, fallback: string): string {
  const displayName = identity?.displayName ?? fallback;
  return identity?.model ? `${displayName} · ${identity.model}` : displayName;
}
