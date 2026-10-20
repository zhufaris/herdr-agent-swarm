import { randomUUID } from "node:crypto";
import type { AgentInstance } from "../../../domain/agent-instance.js";
import type { ControlActor } from "../../../domain/commands.js";
import type {
  InstanceEventKind,
  InstanceTurn,
} from "../../../domain/instance-turn.js";
import type { AcceptInstanceTurnWithCardInput } from "../../../domain/ports.js";
import type { OutboxStore } from "../../../domain/ports/outbox.js";
import { validateWorkerTurnAdmission } from "../../../domain/worker-turn-policies.js";
import type { WorkerTurnCardView } from "../../../domain/worker-turn-card-view.js";
import type { SqliteContext } from "../context.js";
import { turnActorProvenance } from "../turn-actor-provenance.js";
import type { WorkerTurnProjection } from "./projection.js";
import type { WorkerTurnQueue } from "./queue.js";
import { mapInstanceTurn } from "./records.js";
import { COMPLETION_ACTION_MESSAGES } from "../../../domain/completion-action-set.js";
import type { WorkerCompletionActionAcceptanceInput, WorkerCompletionActionAcceptanceResult } from "../../../domain/ports/instance.js";
import { dismissPendingCompletionNotification } from "../completion-notification-store.js";
import type { ReserveValidatedCardDismissalInput } from "../../../domain/ports/card-dismissal.js";

type BasicInput = {
  id: string;
  idempotencyKey: string;
  actor: ControlActor;
  projectId: string;
  instanceId: string;
  instanceGeneration: number;
  kind: InstanceTurn["kind"];
  priority?: InstanceTurn["priority"];
  text: string;
  maxQueueDepth?: number;
};

export class WorkerTurnAcceptance {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getAgentInstance(id: string): AgentInstance | null;
      queue: WorkerTurnQueue;
      projection: WorkerTurnProjection;
      enqueueOutboundReply(
        input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & {
          laneKeyOverride?: string;
        },
      ): unknown;
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
      reserveCardDismissal(input: ReserveValidatedCardDismissalInput): unknown;
    },
  ) {}
  accept(input: BasicInput): { turn: InstanceTurn; inserted: boolean; completionActionOwnerTurnIds?: string[] } {
    const current = this.dependencies.getAgentInstance(input.instanceId);
    const existing = this.byKey(input.idempotencyKey);
    const priority = input.priority ?? "normal";
    this.validateGeneration(input, current);
    if (existing) {
      this.validateDuplicate(existing, input, priority);
      return { turn: existing, inserted: false };
    }
    this.validate(input, current, priority);
    const actor = turnActorProvenance(input.actor);
    const timestamp = now();
    const inserted =
      this.context.database
        .prepare(
          `INSERT INTO instance_turns(id, idempotency_key, project_id, instance_id, instance_generation, actor_json, actor_kind, source_binding_id, source_binding_generation, source_parent_prompt_id, kind, priority, text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          input.id,
          input.idempotencyKey,
          input.projectId,
          input.instanceId,
          input.instanceGeneration,
          JSON.stringify(input.actor),
          actor.actorKind,
          actor.sourceBindingId,
          actor.sourceBindingGeneration,
          actor.sourceParentPromptId,
          input.kind,
          priority,
          input.text,
          timestamp,
          timestamp,
        ).changes === 1;
    const turn = this.byKey(input.idempotencyKey);
    if (!turn) throw new Error("Accepted instance turn could not be loaded");
    this.validateDuplicate(turn, input, priority);
    if (inserted)
      this.dependencies.insertInstanceEvent(
        input.projectId,
        input.instanceId,
        turn.id,
        "turn.accepted",
        { kind: input.kind },
      );
    return { turn, inserted, ...(inserted ? { completionActionOwnerTurnIds: this.supersedeEarlierCompletionActions(turn) } : {}) };
  }
  acceptWithCard(
    input: AcceptInstanceTurnWithCardInput & { maxQueueDepth?: number },
  ): { turn: InstanceTurn; view: WorkerTurnCardView; inserted: boolean; completionActionOwnerTurnIds?: string[] } {
    const current = this.dependencies.getAgentInstance(input.instanceId);
    const existing = this.byKey(input.idempotencyKey);
    const priority = input.priority ?? "normal";
    this.validateGeneration(input, current);
    if (existing) {
      this.validateDuplicate(existing, input, priority, input.parentTurnId);
      this.validateCanonicalIntent(existing.id, input.unifiedSegment);
      const view = input.unifiedSegment ? input.view : this.dependencies.projection.load(existing.id);
      if (!view)
        throw new Error("Accepted Worker turn card could not be loaded");
      return { turn: existing, view, inserted: false };
    }
    this.validate(input, current, priority, input.parentTurnId);
    if (
      input.view.turnId !== input.id ||
      input.view.instanceId !== input.instanceId ||
      input.view.instanceGeneration !== input.instanceGeneration ||
      input.view.parentTurnId !== input.parentTurnId ||
      input.view.rootMessageId.length === 0
    )
      throw new Error(
        "Worker turn card identity does not match the accepted turn",
      );
    const acceptedView = {
      ...input.view,
      queuePosition:
        priority === "priority"
          ? 0
          : this.dependencies.queue.nextNormalPosition(
              input.instanceId,
              input.instanceGeneration,
            ),
    };
    const actor = turnActorProvenance(input.actor);
    const timestamp = now();
    const canonicalGatewayId = input.unifiedSegment ? this.canonicalGatewayId(current) : null;
    const inserted =
      this.context.database
        .prepare(
          `INSERT INTO instance_turns(id, idempotency_key, project_id, instance_id, instance_generation, actor_json, actor_kind, source_binding_id, source_binding_generation, source_parent_prompt_id, kind, priority, text, state, parent_turn_id, source_message_id,
            canonical_segment_id, canonical_submission_id, canonical_agent_kind, canonical_expected_session_id, canonical_root_message_id, canonical_gateway_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          input.id,
          input.idempotencyKey,
          input.projectId,
          input.instanceId,
          input.instanceGeneration,
          JSON.stringify(input.actor),
          actor.actorKind,
          actor.sourceBindingId,
          actor.sourceBindingGeneration,
          actor.sourceParentPromptId,
          input.kind,
          priority,
          input.text,
          input.parentTurnId,
          input.sourceMessageId,
          input.unifiedSegment?.segmentId ?? null,
          input.unifiedSegment?.submissionId ?? null,
          input.unifiedSegment?.agentKind ?? null,
          input.unifiedSegment?.expectedSessionId ?? null,
          input.unifiedSegment?.rootMessageId ?? null,
          canonicalGatewayId,
          timestamp,
          timestamp,
        ).changes === 1;
    const turn = this.byKey(input.idempotencyKey);
    if (!turn) throw new Error("Accepted instance turn could not be loaded");
    this.validateDuplicate(turn, input, priority, input.parentTurnId);
    this.validateCanonicalIntent(turn.id, input.unifiedSegment);
    if (inserted) {
      if (!input.unifiedSegment) this.dependencies.projection.save(acceptedView);
      this.dependencies.insertInstanceEvent(
        input.projectId,
        input.instanceId,
        turn.id,
        "turn.accepted",
        { kind: input.kind },
      );
      // Unified Worker turns own their Turn Card through conversation_segments;
      // never enqueue the legacy worker_turn_cards stream-create path.
      if (!input.unifiedSegment && current?.workerSessionLifecycle === "active")
        this.dependencies.enqueueOutboundReply({
          id: randomUUID(),
          idempotencyKey: `worker-turn:create:${turn.id}:0`,
          bindingId: null,
          workerTurnId: turn.id,
          viewVersion: acceptedView.viewVersion,
          rootMessageId: acceptedView.rootMessageId,
          kind: "stream_card_create",
          payload: JSON.stringify({
            card: input.render(acceptedView),
            stream: { pageIndex: 0, pageStart: 0, elementId: acceptedView.elementId },
          }),
        });
      this.dependencies.invalidateWorkerCardContexts(
        acceptedView,
        "turn.accepted",
      );
    }
    const view = input.unifiedSegment ? acceptedView : this.dependencies.projection.load(turn.id);
    if (!view) throw new Error("Accepted Worker turn card could not be loaded");
    return { turn, view, inserted, ...(inserted ? { completionActionOwnerTurnIds: this.supersedeEarlierCompletionActions(turn) } : {}) };
  }
  acceptCompletionAction(input: WorkerCompletionActionAcceptanceInput): WorkerCompletionActionAcceptanceResult {
    if ((input.selection === undefined) === (input.optionId === undefined)) throw new Error("Exactly one Worker completion action identity is required");
    const sourceKey = input.optionId ? `completion-choice:v1:${input.actionSetId}:${input.optionId}` : `completion-action:v1:${input.actionSetId}:${input.selection}`;
    const action = this.context.database.prepare(`SELECT action.id, action.owner_id, action.owner_generation, action.binding_id, action.binding_generation, action.page_index, action.card_id, action.card_message_id,
        action.mention_open_id, action.presentation_kind, action.presentation_reply_id, action.presentation_message_id, action.state, action.selected_action, action.selected_choice_option_id, action.choice_specification_id, action.result_source_key,
        reply.delivery_parent_session_generation
      FROM completion_action_sets action
      LEFT JOIN outbound_replies reply ON reply.id=action.presentation_reply_id
      WHERE action.id = ? AND action.owner_kind = 'worker-turn'`).get(input.actionSetId) as {
        id: string; owner_id: string; owner_generation: number; binding_id: string; binding_generation: number; page_index: number;
        card_id: string | null; card_message_id: string | null; mention_open_id: string | null; presentation_kind: "legacy-inline" | "fresh-card"; presentation_reply_id: string | null; presentation_message_id: string | null; state: string; selected_action: string | null; selected_choice_option_id: string | null; choice_specification_id: string | null; result_source_key: string | null; delivery_parent_session_generation: number | null;
      } | undefined;
    const choice = action && input.optionId ? this.context.database.prepare(`SELECT label, message FROM completion_choice_options
      WHERE specification_id = ? AND option_id = ?`).get(action.choice_specification_id, input.optionId) as { label: string; message: string } | undefined : undefined;
    const existing = this.byKey(sourceKey);
    const actionMessageId = action?.presentation_kind === "fresh-card" ? action.presentation_message_id : action?.card_message_id;
    const actionable = action?.presentation_kind === "fresh-card" ? action.state === "active" : action?.state === "available";
    if (action?.state === "consumed" && (input.optionId ? action.selected_choice_option_id === input.optionId : action.selected_action === input.selection) && action.result_source_key === sourceKey
      && action.mention_open_id === input.actorOpenId && existing) {
      const view = this.dependencies.projection.load(existing.id);
      if (!view) throw new Error(`Worker turn card missing for turn: ${existing.id}`);
      return { turn: existing, view, inserted: false, completionActionOwnerTurnIds: [action.owner_id] };
    }
    const owner = action ? this.byId(action.owner_id) : null;
    const ownerView = owner ? this.dependencies.projection.load(owner.id) : null;
    const instance = owner ? this.dependencies.getAgentInstance(owner.instanceId) : null;
    const parent = instance?.parent;
    const binding = parent ? this.context.database.prepare("SELECT id, generation, session_epoch, pane_id, traex_session_id, state, lifecycle, attachment, chat_id, gateway_id FROM bindings WHERE id = ?").get(parent.bindingId) as { id: string; generation: number; session_epoch: number; pane_id: string | null; traex_session_id: string | null; state: string; lifecycle: string; attachment: string; chat_id: string; gateway_id: string } | undefined : undefined;
    const finalPage = owner ? this.context.database.prepare("SELECT page_index, card_id, message_id, state FROM worker_turn_card_pages WHERE turn_id = ? ORDER BY page_index DESC LIMIT 1").get(owner.id) as { page_index: number; card_id: string | null; message_id: string | null; state: string } | undefined : undefined;
    if (!action || !actionable || action.owner_id !== input.ownerTurnId || action.owner_generation !== input.ownerGeneration
      || actionMessageId !== input.cardMessageId || action.mention_open_id !== input.actorOpenId || !owner || !ownerView || !instance || !parent || !binding || !finalPage
      || owner.state !== "completed" || ownerView.phase !== "completed" || instance.id !== owner.instanceId || instance.generation !== owner.instanceGeneration
      || ownerView.instanceGeneration !== instance.generation || instance.workerSessionGeneration !== action.owner_generation || ownerView.workerSessionGeneration !== action.owner_generation
      || parent.bindingId !== action.binding_id || parent.bindingGeneration !== action.binding_generation || parent.paneId !== binding.pane_id || binding.traex_session_id !== null && parent.nativeSessionId !== binding.traex_session_id || binding.generation !== action.binding_generation
      || action.presentation_kind === "fresh-card" && (action.presentation_reply_id === null || binding.session_epoch !== action.delivery_parent_session_generation)
      || binding.chat_id !== input.chatId
      || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached"
      || finalPage.page_index !== action.page_index || action.presentation_kind === "legacy-inline" && (finalPage.card_id !== action.card_id || finalPage.message_id !== action.card_message_id)
      || finalPage.state !== "finished") {
      throw new Error("Worker completion action is no longer available");
    }
    if (input.selection !== undefined && action.choice_specification_id !== null) throw new Error("Worker completion action is no longer available");
    const accepted = input.accepted;
    if (accepted.idempotencyKey !== sourceKey || accepted.actor.kind !== "human" || accepted.actor.channel !== "feishu" || accepted.actor.userId !== input.actorOpenId
      || accepted.projectId !== owner.projectId || accepted.instanceId !== owner.instanceId || accepted.instanceGeneration !== owner.instanceGeneration
      || accepted.kind !== "followup" || accepted.text !== (input.optionId ? choice?.message : COMPLETION_ACTION_MESSAGES[input.selection!]) || accepted.parentTurnId !== owner.id
      || accepted.sourceMessageId !== actionMessageId || accepted.view.turnId !== accepted.id || accepted.view.instanceId !== owner.instanceId
      || accepted.view.instanceGeneration !== owner.instanceGeneration || accepted.view.workerSessionGeneration !== action.owner_generation
      || accepted.view.parentTurnId !== owner.id || accepted.view.rootMessageId !== ownerView.rootMessageId || accepted.view.requestText !== accepted.text) {
      throw new Error("Worker completion action admission identity mismatch");
    }
    if (input.optionId && !choice) throw new Error("Worker completion choice is no longer available");
    const timestamp = now();
    const consumed = this.context.database.prepare(`UPDATE completion_action_sets SET state = 'consumed', selected_action = ?, selected_choice_option_id = ?, result_source_key = ?, decided_at = ?, updated_at = ?
      WHERE id = ? AND ((presentation_kind='legacy-inline' AND state='available') OR (presentation_kind='fresh-card' AND state='active'))`).run(input.selection ?? null, input.optionId ?? null, sourceKey, timestamp, timestamp, input.actionSetId);
    if (Number(consumed.changes) !== 1) throw new Error("Worker completion action lost ownership");
    dismissPendingCompletionNotification(this.context, "worker-turn", owner.id);
    this.bumpCompletionActionOwnerView(owner.id, timestamp);
    const result = this.acceptWithCard(accepted);
    return { ...result, completionActionOwnerTurnIds: [...new Set([owner.id, ...(result.completionActionOwnerTurnIds ?? [])])] };
  }
  ignoreCompletionAction(input: { actionSetId: string; ownerTurnId: string; ownerGeneration: number; cardMessageId: string; chatId: string; actorOpenId: string }): import("../../../domain/completion-action-set.js").CompletionActionIgnoreResult {
    const action = this.context.database.prepare(`SELECT action.id, action.owner_id, action.owner_generation, action.binding_id, action.binding_generation, action.page_index, action.card_id, action.card_message_id,
        action.mention_open_id, action.presentation_kind, action.presentation_reply_id, action.presentation_message_id, action.state, action.reason, action.choice_specification_id,
        reply.delivery_parent_session_generation
      FROM completion_action_sets action
      LEFT JOIN outbound_replies reply ON reply.id=action.presentation_reply_id
      WHERE action.id = ? AND action.owner_kind = 'worker-turn'`).get(input.actionSetId) as {
        id: string; owner_id: string; owner_generation: number; binding_id: string; binding_generation: number; page_index: number;
        card_id: string | null; card_message_id: string | null; mention_open_id: string | null; presentation_kind: "legacy-inline" | "fresh-card"; presentation_reply_id: string | null; presentation_message_id: string | null; state: string; reason: string | null; choice_specification_id: string | null; delivery_parent_session_generation: number | null;
      } | undefined;
    const actionMessageId = action?.presentation_kind === "fresh-card" ? action.presentation_message_id : action?.card_message_id;
    const actionable = action?.presentation_kind === "fresh-card" ? action.state === "active" : action?.state === "available";
    const exactIdentity = action && action.owner_id === input.ownerTurnId && action.owner_generation === input.ownerGeneration
      && actionMessageId === input.cardMessageId && action.mention_open_id === input.actorOpenId;
    if (exactIdentity && action.state === "consumed" && action.reason === "ignored") return { ownerId: action.owner_id, changed: false };
    const owner = action ? this.byId(action.owner_id) : null;
    const ownerView = owner ? this.dependencies.projection.load(owner.id) : null;
    const instance = owner ? this.dependencies.getAgentInstance(owner.instanceId) : null;
    const parent = instance?.parent;
    const binding = parent ? this.context.database.prepare("SELECT id, generation, session_epoch, pane_id, traex_session_id, state, lifecycle, attachment, chat_id, gateway_id FROM bindings WHERE id = ?").get(parent.bindingId) as { id: string; generation: number; session_epoch: number; pane_id: string | null; traex_session_id: string | null; state: string; lifecycle: string; attachment: string; chat_id: string; gateway_id: string } | undefined : undefined;
    const finalPage = owner ? this.context.database.prepare("SELECT page_index, card_id, message_id, state FROM worker_turn_card_pages WHERE turn_id = ? ORDER BY page_index DESC LIMIT 1").get(owner.id) as { page_index: number; card_id: string | null; message_id: string | null; state: string } | undefined : undefined;
    if (!exactIdentity || !actionable || !action.choice_specification_id || !owner || !ownerView || !instance || !parent || !binding || !finalPage
      || owner.state !== "completed" || ownerView.phase !== "completed" || instance.id !== owner.instanceId || instance.generation !== owner.instanceGeneration
      || ownerView.instanceGeneration !== instance.generation || instance.workerSessionGeneration !== action.owner_generation || ownerView.workerSessionGeneration !== action.owner_generation
      || parent.bindingId !== action.binding_id || parent.bindingGeneration !== action.binding_generation || parent.paneId !== binding.pane_id || binding.traex_session_id !== null && parent.nativeSessionId !== binding.traex_session_id || binding.generation !== action.binding_generation
      || action.presentation_kind === "fresh-card" && (action.presentation_reply_id === null || binding.session_epoch !== action.delivery_parent_session_generation)
      || binding.chat_id !== input.chatId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached"
      || finalPage.page_index !== action.page_index || action.presentation_kind === "legacy-inline" && (finalPage.card_id !== action.card_id || finalPage.message_id !== action.card_message_id)
      || finalPage.state !== "finished") {
      throw new Error("Worker completion action is no longer available");
    }
    const timestamp = now();
    const changed = this.context.database.prepare(`UPDATE completion_action_sets SET state = 'consumed', selected_action = NULL,
      selected_choice_option_id = NULL, result_source_key = NULL, reason = 'ignored', decided_at = ?, updated_at = ?
      WHERE id = ? AND ((presentation_kind='legacy-inline' AND state='available') OR (presentation_kind='fresh-card' AND state='active'))`).run(timestamp, timestamp, input.actionSetId);
    if (Number(changed.changes) !== 1) throw new Error("Worker completion action lost ownership");
    dismissPendingCompletionNotification(this.context, "worker-turn", owner.id);
    if (action.presentation_kind === "legacy-inline") this.dependencies.reserveCardDismissal({
      actionKind: "worker_completion_ignore", semanticKey: `completion-action:${action.id}`,
      actorOpenId: input.actorOpenId, chatId: input.chatId, gatewayId: binding.gateway_id,
      messageId: action.card_message_id!
    });
    this.bumpCompletionActionOwnerView(owner.id, timestamp);
    return { ownerId: owner.id, changed: true };
  }
  private validate(
    input: BasicInput,
    current: AgentInstance | null,
    priority: InstanceTurn["priority"],
    parentTurnId?: string | null,
  ): void {
    validateWorkerTurnAdmission({
      current,
      projectId: input.projectId,
      instanceGeneration: input.instanceGeneration,
      priority,
      pendingCount: this.dependencies.queue.countPending(
        input.instanceId,
        input.instanceGeneration,
      ),
      maxQueueDepth: input.maxQueueDepth,
      hasLivePriorityTurn: this.dependencies.queue.hasLivePriority(
        input.instanceId,
        input.instanceGeneration,
      ),
      hasActiveRuntimeTurn: this.dependencies.queue.hasActiveRuntime(
        input.instanceId,
        input.instanceGeneration,
      ),
      kind: parentTurnId === undefined ? undefined : input.kind,
      parentTurnId,
      parent: parentTurnId ? this.byId(parentTurnId) : null,
      instanceId: input.instanceId,
    });
  }
  private validateGeneration(
    input: BasicInput,
    current: AgentInstance | null,
  ): void {
    if (
      !current ||
      current.projectId !== input.projectId ||
      current.generation !== input.instanceGeneration
    )
      throw new Error("Instance generation changed before turn acceptance");
  }
  private validateDuplicate(
    turn: InstanceTurn,
    input: BasicInput,
    priority: InstanceTurn["priority"],
    parentTurnId?: string | null,
  ): void {
    if (
      turn.instanceId !== input.instanceId ||
      turn.text !== input.text ||
      turn.kind !== input.kind ||
      turn.priority !== priority ||
      (parentTurnId !== undefined && turn.parentTurnId !== parentTurnId)
    )
      throw new Error("Idempotency key belongs to a different instance turn");
  }
  private validateCanonicalIntent(turnId: string, intent: AcceptInstanceTurnWithCardInput["unifiedSegment"]): void {
    const row = this.context.database.prepare(`SELECT canonical_segment_id,canonical_submission_id,canonical_agent_kind,
      canonical_expected_session_id,canonical_root_message_id FROM instance_turns WHERE id=?`).get(turnId) as {
        canonical_segment_id: string | null; canonical_submission_id: string | null; canonical_agent_kind: string | null;
        canonical_expected_session_id: string | null; canonical_root_message_id: string | null;
      } | undefined;
    const exact = row && (intent ? row.canonical_segment_id === `worker-turn:${turnId}`
      && row.canonical_submission_id === turnId
      && row.canonical_agent_kind === intent.agentKind
      && row.canonical_expected_session_id === intent.expectedSessionId
      && row.canonical_root_message_id === intent.rootMessageId
      : row.canonical_segment_id === null && row.canonical_submission_id === null);
    if (!exact) throw new Error("Idempotency key belongs to a different Worker canonical intent");
  }
  private canonicalGatewayId(instance: AgentInstance | null): string {
    if (!instance?.parent || instance.parent.bindingGeneration === undefined)
      throw new Error("Worker canonical gateway route is unavailable");
    const row = this.context.database.prepare("SELECT gateway_id FROM bindings WHERE id=? AND generation=?")
      .get(instance.parent.bindingId, instance.parent.bindingGeneration) as { gateway_id: string } | undefined;
    if (!row) throw new Error("Worker canonical gateway route is unavailable");
    return row.gateway_id;
  }
  private byKey(key: string): InstanceTurn | null {
    return mapInstanceTurn(
      this.context.database
        .prepare("SELECT * FROM instance_turns WHERE idempotency_key = ?")
        .get(key) as Record<string, unknown> | undefined,
    );
  }
  private byId(id: string): InstanceTurn | null {
    return mapInstanceTurn(
      this.context.database
        .prepare("SELECT * FROM instance_turns WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined,
    );
  }
  private supersedeEarlierCompletionActions(successor: InstanceTurn): string[] {
    if (successor.actor.kind !== "human") return [];
    const candidates = this.context.database.prepare(`SELECT action.id, action.owner_id
      FROM completion_action_sets action
      JOIN instance_turns owner ON owner.id = action.owner_id
      JOIN instance_turns later ON later.id = ?
      WHERE action.owner_kind = 'worker-turn' AND action.state IN ('available','provisional','presenting','active')
        AND owner.instance_id = later.instance_id
        AND (owner.created_at < later.created_at OR (owner.created_at = later.created_at AND owner.rowid < later.rowid))
      ORDER BY owner.created_at, owner.rowid`).all(successor.id) as Array<{ id: string; owner_id: string }>;
    const timestamp = now();
    const ownerTurnIds: string[] = [];
    for (const candidate of candidates) {
      const updated = this.context.database.prepare(`UPDATE completion_action_sets
        SET state = 'superseded', reason = 'successor-accepted', decided_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('available','provisional','presenting','active')`).run(timestamp, timestamp, candidate.id);
      if (Number(updated.changes) === 1) {
        this.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',
          error='Completion Review became obsolete before first delivery attempt',updated_at=?
          WHERE id=(SELECT presentation_reply_id FROM completion_action_sets WHERE id=? AND presentation_kind='fresh-card')
            AND state='pending' AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
            AND attempt_count=0 AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL`).run(timestamp, candidate.id);
        dismissPendingCompletionNotification(this.context, "worker-turn", candidate.owner_id);
        this.bumpCompletionActionOwnerView(candidate.owner_id, timestamp);
        ownerTurnIds.push(candidate.owner_id);
      }
    }
    return ownerTurnIds;
  }
  private bumpCompletionActionOwnerView(turnId: string, timestamp: string): void {
    this.context.database.prepare("UPDATE worker_turn_cards SET view_version = view_version + 1, updated_at = ? WHERE turn_id = ?").run(timestamp, turnId);
  }
}
function now(): string {
  return new Date().toISOString();
}
