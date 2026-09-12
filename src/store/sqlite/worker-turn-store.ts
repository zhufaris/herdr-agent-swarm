import { randomUUID } from "node:crypto";
import type { AgentInstance } from "../../domain/agent-instance.js";
import type { ControlActor } from "../../domain/commands.js";
import { InstanceTurnCapacityExceeded } from "../../domain/instance-turn-capacity-error.js";
import type { InstanceEvent, InstanceEventKind, InstanceTurn, InstanceTurnState, InstanceTurnSummary } from "../../domain/instance-turn.js";
import type { AcceptInstanceTurnWithCardInput } from "../../domain/ports.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { AnswerPageDeliveryFacts, AnswerPageReservationOutcome, OutboundReplyState } from "../../domain/types.js";
import { reduceWorkerTurnCard, type WorkerTurnCardChange, type WorkerTurnCardPage, type WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import type { SqliteContext } from "./context.js";
import { turnActorProvenance } from "./turn-actor-provenance.js";

export interface WorkerTurnStoreDependencies {
  getAgentInstance(id: string): AgentInstance | null;
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): unknown;
  invalidateWorkerCardContexts(view: WorkerTurnCardView, reason: string): void;
  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean;
}

export class SqliteWorkerTurnStore {
  constructor(private readonly context: SqliteContext, private readonly dependencies: WorkerTurnStoreDependencies) {}

  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean {
    return this.dependencies.hasPendingOutboundReplyForWorkerTurn(turnId);
  }

  acceptInstanceTurn(input: { id: string; idempotencyKey: string; actor: ControlActor; projectId: string; instanceId: string; instanceGeneration: number; kind: InstanceTurn["kind"]; priority?: InstanceTurn["priority"]; text: string; maxQueueDepth?: number }): { turn: InstanceTurn; inserted: boolean } {
    const timestamp = now();
    return this.context.transaction(() => {
      const current = this.dependencies.getAgentInstance(input.instanceId);
      if (!current || current.projectId !== input.projectId || current.generation !== input.instanceGeneration) throw new Error("Instance generation changed before turn acceptance");
      const existing = this.getInstanceTurnByKey(input.idempotencyKey);
      const priority = input.priority ?? "normal";
      if (existing) {
        if (existing.instanceId !== input.instanceId || existing.text !== input.text || existing.kind !== input.kind || existing.priority !== priority) throw new Error("Idempotency key belongs to a different instance turn");
        return { turn: existing, inserted: false };
      }
      if (input.maxQueueDepth !== undefined && this.countPendingInstanceTurns(input.instanceId, input.instanceGeneration) >= input.maxQueueDepth) throw new InstanceTurnCapacityExceeded();
      if (priority === "priority" && this.context.database.prepare("SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND priority = 'priority' AND state IN ('queued','claimed','dispatching','running','blocked','dispatch-uncertain') LIMIT 1").get(input.instanceId, input.instanceGeneration)) throw new Error("Target instance already has a live priority turn");
      if (priority === "priority" && this.context.database.prepare("SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked','dispatch-uncertain') LIMIT 1").get(input.instanceId, input.instanceGeneration)) throw new Error("Target instance already has an active runtime turn");
      const actor = turnActorProvenance(input.actor);
      const inserted = this.context.database.prepare(`INSERT INTO instance_turns(id, idempotency_key, project_id, instance_id, instance_generation, actor_json, actor_kind, source_binding_id, source_binding_generation, source_parent_prompt_id, kind, priority, text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`)
        .run(input.id, input.idempotencyKey, input.projectId, input.instanceId, input.instanceGeneration, JSON.stringify(input.actor), actor.actorKind, actor.sourceBindingId, actor.sourceBindingGeneration, actor.sourceParentPromptId, input.kind, priority, input.text, timestamp, timestamp).changes === 1;
      const turn = this.getInstanceTurnByKey(input.idempotencyKey);
      if (!turn) throw new Error("Accepted instance turn could not be loaded");
      if (turn.instanceId !== input.instanceId || turn.text !== input.text || turn.kind !== input.kind || turn.priority !== priority) throw new Error("Idempotency key belongs to a different instance turn");
      if (inserted) this.insertInstanceEvent(input.projectId, input.instanceId, turn.id, "turn.accepted", { kind: input.kind });
      return { turn, inserted };
    });
  }

  acceptInstanceTurnWithCard(input: AcceptInstanceTurnWithCardInput & { maxQueueDepth?: number }): { turn: InstanceTurn; view: WorkerTurnCardView; inserted: boolean } {
    const timestamp = now();
    return this.context.transaction(() => {
      const current = this.dependencies.getAgentInstance(input.instanceId);
      if (!current || current.projectId !== input.projectId || current.generation !== input.instanceGeneration) throw new Error("Instance generation changed before turn acceptance");
      const existing = this.getInstanceTurnByKey(input.idempotencyKey);
      const priority = input.priority ?? "normal";
      if (existing) {
        if (existing.instanceId !== input.instanceId || existing.text !== input.text || existing.kind !== input.kind || existing.priority !== priority || existing.parentTurnId !== input.parentTurnId) throw new Error("Idempotency key belongs to a different instance turn");
        const view = this.loadWorkerTurnCard(existing.id);
        if (!view) throw new Error("Accepted Worker turn card could not be loaded");
        return { turn: existing, view, inserted: false };
      }
      if (input.maxQueueDepth !== undefined && this.countPendingInstanceTurns(input.instanceId, input.instanceGeneration) >= input.maxQueueDepth) throw new InstanceTurnCapacityExceeded();
      if (priority === "priority" && this.context.database.prepare("SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND priority = 'priority' AND state IN ('queued','claimed','dispatching','running','blocked','dispatch-uncertain') LIMIT 1").get(input.instanceId, input.instanceGeneration)) throw new Error("Target instance already has a live priority turn");
      if (priority === "priority" && this.context.database.prepare("SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked','dispatch-uncertain') LIMIT 1").get(input.instanceId, input.instanceGeneration)) throw new Error("Target instance already has an active runtime turn");
      if (input.kind === "turn" && input.parentTurnId !== null) throw new Error("Ordinary Worker turn cannot have a parent");
      if (input.kind === "followup") {
        const parent = input.parentTurnId ? this.getInstanceTurn(input.parentTurnId) : null;
        if (!parent || parent.projectId !== input.projectId || parent.instanceId !== input.instanceId || !["completed", "failed", "cancelled"].includes(parent.state)) throw new Error("Worker follow-up parent must be a settled turn on the same instance");
      }
      if (input.view.turnId !== input.id || input.view.instanceId !== input.instanceId || input.view.instanceGeneration !== input.instanceGeneration || input.view.parentTurnId !== input.parentTurnId || input.view.rootMessageId.length === 0) throw new Error("Worker turn card identity does not match the accepted turn");
      const queuePosition = priority === "priority" ? 0 : Number((this.context.database.prepare("SELECT COUNT(*) AS count FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND priority = 'normal' AND state = 'queued'").get(input.instanceId, input.instanceGeneration) as { count: number }).count) + 1;
      const acceptedView = { ...input.view, queuePosition };
      const actor = turnActorProvenance(input.actor);
      const inserted = this.context.database.prepare(`INSERT INTO instance_turns(id, idempotency_key, project_id, instance_id, instance_generation, actor_json, actor_kind, source_binding_id, source_binding_generation, source_parent_prompt_id, kind, priority, text, state, parent_turn_id, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`)
        .run(input.id, input.idempotencyKey, input.projectId, input.instanceId, input.instanceGeneration, JSON.stringify(input.actor), actor.actorKind, actor.sourceBindingId, actor.sourceBindingGeneration, actor.sourceParentPromptId, input.kind, priority, input.text, input.parentTurnId, input.sourceMessageId, timestamp, timestamp).changes === 1;
      const turn = this.getInstanceTurnByKey(input.idempotencyKey);
      if (!turn) throw new Error("Accepted instance turn could not be loaded");
      if (turn.instanceId !== input.instanceId || turn.text !== input.text || turn.kind !== input.kind || turn.priority !== priority || turn.parentTurnId !== input.parentTurnId) throw new Error("Idempotency key belongs to a different instance turn");
      if (inserted) {
        this.saveWorkerTurnCard(acceptedView);
        this.insertInstanceEvent(input.projectId, input.instanceId, turn.id, "turn.accepted", { kind: input.kind });
        this.dependencies.invalidateWorkerCardContexts(acceptedView, "turn.accepted");
      }
      const view = this.loadWorkerTurnCard(turn.id);
      if (!view) throw new Error("Accepted Worker turn card could not be loaded");
      return { turn, view, inserted };
    });
  }

  getInstanceTurn(id: string): InstanceTurn | null { return mapInstanceTurn(this.context.database.prepare("SELECT * FROM instance_turns WHERE id = ?").get(id) as Record<string, unknown> | undefined); }
  claimInstanceTurnTranscript(input: { turnId: string; expectedGeneration: number; runtimeTurnId: string; startedAt: string }): InstanceTurn | null {
    if (!input.runtimeTurnId || !Number.isFinite(Date.parse(input.startedAt))) return null;
    return this.context.transaction(() => {
      const current = this.getInstanceTurn(input.turnId);
      if (!current || current.instanceGeneration !== input.expectedGeneration || !["dispatching", "running", "blocked", "dispatch-uncertain"].includes(current.state)) return null;
      if (current.runtimeTurnId !== null || current.runtimeTurnStartedAt !== null) {
        return current.runtimeTurnId === input.runtimeTurnId && current.runtimeTurnStartedAt === input.startedAt ? current : null;
      }
      const changed = this.context.database.prepare(`UPDATE instance_turns SET runtime_turn_id = ?, runtime_turn_started_at = ?, updated_at = ?
        WHERE id = ? AND instance_generation = ? AND runtime_turn_id IS NULL AND runtime_turn_started_at IS NULL
          AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.id = instance_turns.instance_id AND i.generation = ? AND i.pane_id IS NOT NULL)`)
        .run(input.runtimeTurnId, input.startedAt, now(), input.turnId, input.expectedGeneration, input.expectedGeneration);
      if (changed.changes === 1) this.insertInstanceEvent(current.projectId, current.instanceId, current.id, "turn.transcript-owned", { runtimeTurnId: input.runtimeTurnId, startedAt: input.startedAt });
      const claimed = changed.changes === 1 ? this.getInstanceTurn(input.turnId) : null;
      return claimed;
    });
  }
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null {
    return mapWorkerTurnCard(this.context.database.prepare("SELECT * FROM worker_turn_cards WHERE turn_id = ?").get(turnId) as Record<string, unknown> | undefined);
  }
  findWorkerTurnByCardMessage(messageId: string): { turn: InstanceTurn; view: WorkerTurnCardView } | null {
    const rows = this.context.database.prepare("SELECT turn_id FROM worker_turn_card_pages WHERE message_id = ? UNION SELECT turn_id FROM worker_turn_cards WHERE message_id = ?").all(messageId, messageId) as Array<{ turn_id: string }>;
    if (rows.length !== 1) return null;
    const turn = this.getInstanceTurn(rows[0]!.turn_id); const view = this.loadWorkerTurnCard(rows[0]!.turn_id);
    return turn && view ? { turn, view } : null;
  }
  listWorkerTurnCardPages(turnId: string): WorkerTurnCardPage[] {
    return (this.context.database.prepare("SELECT * FROM worker_turn_card_pages WHERE turn_id = ? ORDER BY page_index").all(turnId) as Array<Record<string, unknown>>).map(mapWorkerTurnCardPage);
  }
  getWorkerTurnCardDeliveryFacts(turnId: string, pageIndex: number): AnswerPageDeliveryFacts {
    const page = this.context.database.prepare("SELECT element_id FROM worker_turn_card_pages WHERE turn_id = ? AND page_index = ?").get(turnId, pageIndex) as { element_id: string } | undefined;
    if (!page) return { latestContent: null, finishPending: false, continuationPending: false, finalUpdateState: null };
    const contentRow = this.context.database.prepare("SELECT payload, state, view_version FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_content' AND stream_page_index = ? AND selection_id IS NULL AND state IN ('pending','delivered','dead_letter') ORDER BY delivery_order DESC LIMIT 1").get(turnId, pageIndex) as { payload: string; state: OutboundReplyState; view_version: number | null } | undefined;
    const contentPayload = contentRow ? parseJsonRecord(contentRow.payload) : null;
    const latestContent = contentRow && contentPayload ? { content: typeof contentPayload.content === "string" ? contentPayload.content : "", sequence: Number(contentPayload.sequence ?? contentRow.view_version ?? 0), state: contentRow.state, sourceEnd: Number.isInteger(contentPayload.sourceEnd) ? Number(contentPayload.sourceEnd) : null } : null;
    const finishPending = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_finish' AND stream_page_index = ? AND state = 'pending' LIMIT 1").get(turnId, pageIndex) !== undefined;
    const continuationPending = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_card_create' AND stream_page_index = ? AND state = 'pending' LIMIT 1").get(turnId, pageIndex + 1) !== undefined;
    return { latestContent, finishPending, continuationPending, finalUpdateState: null };
  }
  reserveWorkerTurnContent(input: { turnId: string; pageIndex: number; cardId: string; elementId: string; content: string; sourceEnd: number }): AnswerPageReservationOutcome {
    return this.reserveWorkerTurnPageIntent(input.turnId, input.pageIndex, (page) => {
      if (page.cardId !== input.cardId || page.elementId !== input.elementId) return "stale";
      const facts = this.getWorkerTurnCardDeliveryFacts(input.turnId, input.pageIndex);
      if (facts.latestContent?.state === "pending" || facts.latestContent?.content === input.content) return "waiting";
      const sequence = page.sequence + 1;
      this.context.database.prepare("UPDATE worker_turn_card_pages SET sequence = ?, updated_at = ? WHERE turn_id = ? AND page_index = ? AND state = 'active' AND sequence = ?").run(sequence, now(), input.turnId, input.pageIndex, page.sequence);
      this.context.database.prepare("UPDATE worker_turn_cards SET sequence = ?, updated_at = ? WHERE turn_id = ? AND page_index = ?").run(sequence, now(), input.turnId, input.pageIndex);
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-turn:stream:${input.turnId}:${input.pageIndex}:${sequence}`, bindingId: null, workerTurnId: input.turnId, viewVersion: sequence, rootMessageId: input.cardId, kind: "stream_content", payload: JSON.stringify({ pageIndex: input.pageIndex, elementId: input.elementId, content: input.content, sourceEnd: input.sourceEnd, sequence }) });
      return "reserved";
    });
  }
  reserveWorkerTurnProgress(input: { turnId: string; pageIndex: number; cardId: string; elementId: string; content: string }): AnswerPageReservationOutcome {
    return this.reserveWorkerTurnPageIntent(input.turnId, input.pageIndex, (page) => {
      if (page.cardId !== input.cardId) return "stale";
      const view = this.loadWorkerTurnCard(input.turnId);
      if (!view) return "stale";
      const row = this.context.database.prepare("SELECT payload, state FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_content' AND stream_page_index = ? AND selection_id = 'worker-progress' AND state IN ('pending','delivered','dead_letter') ORDER BY delivery_order DESC LIMIT 1").get(input.turnId, input.pageIndex) as { payload: string; state: OutboundReplyState } | undefined;
      const latest = row ? { ...row, payload: parseJsonRecord(row.payload) } : undefined;
      if (latest?.state === "pending" || latest?.state === "dead_letter" || latest?.payload.content === input.content) return "waiting";
      const sequence = view.progressSequence + 1;
      const changed = this.context.database.prepare("UPDATE worker_turn_cards SET progress_sequence = ?, updated_at = ? WHERE turn_id = ? AND progress_sequence = ?").run(sequence, now(), input.turnId, view.progressSequence);
      if (changed.changes !== 1) return "stale";
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-turn:progress:${input.turnId}:${input.pageIndex}:${sequence}`, bindingId: null, workerTurnId: input.turnId, selectionId: "worker-progress", viewVersion: sequence, rootMessageId: input.cardId, kind: "stream_content", payload: JSON.stringify({ workerElement: "progress", pageIndex: input.pageIndex, elementId: input.elementId, content: input.content, sequence }) });
      return "reserved";
    });
  }
  reserveWorkerTurnFinish(input: { turnId: string; pageIndex: number; cardId: string; summary: string }): AnswerPageReservationOutcome {
    return this.reserveWorkerTurnPageIntent(input.turnId, input.pageIndex, (page) => {
      if (page.cardId !== input.cardId) return "stale";
      const facts = this.getWorkerTurnCardDeliveryFacts(input.turnId, input.pageIndex);
      if (facts.finishPending) return "waiting";
      const sequence = page.sequence + 1;
      this.context.database.prepare("UPDATE worker_turn_card_pages SET sequence = ?, updated_at = ? WHERE turn_id = ? AND page_index = ? AND state = 'active' AND sequence = ?").run(sequence, now(), input.turnId, input.pageIndex, page.sequence);
      this.context.database.prepare("UPDATE worker_turn_cards SET sequence = ?, updated_at = ? WHERE turn_id = ? AND page_index = ?").run(sequence, now(), input.turnId, input.pageIndex);
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-turn:finish:${input.turnId}:${input.pageIndex}:${sequence}`, bindingId: null, workerTurnId: input.turnId, viewVersion: sequence, rootMessageId: input.cardId, kind: "stream_finish", payload: JSON.stringify({ pageIndex: input.pageIndex, summary: input.summary, sequence }) });
      return "reserved";
    });
  }
  reserveWorkerTurnCardHydration(input: { turnId: string; pageIndex: number; cardId: string; messageId: string; card: object }): AnswerPageReservationOutcome {
    return this.context.transaction(() => {
      const pageRow = this.context.database.prepare("SELECT * FROM worker_turn_card_pages WHERE turn_id = ? AND page_index = ?").get(input.turnId, input.pageIndex) as Record<string, unknown> | undefined;
      const view = this.loadWorkerTurnCard(input.turnId);
      if (!pageRow || !view) return "stale";
      const page = mapWorkerTurnCardPage(pageRow);
      const liveContinuation = page.pageIndex > 0 && page.state === "active" && (view.phase === "running" || view.phase === "blocked");
      const completedPage = ["active", "finished"].includes(page.state) && view.phase === "completed";
      if ((!liveContinuation && !completedPage) || page.cardId !== input.cardId || page.messageId !== input.messageId) return "stale";
      const key = `worker-turn:hydrate:${input.turnId}:${input.pageIndex}:${input.cardId}:${view.phase}`;
      if (this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key = ?").get(key)) return "waiting";
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: key, bindingId: null, workerTurnId: input.turnId, viewVersion: view.viewVersion, rootMessageId: input.messageId, kind: "card_update", payload: JSON.stringify(input.card), laneKeyOverride: `worker-turn:${input.turnId}` });
      return "reserved";
    });
  }
  reserveWorkerTurnContinuation(input: { turnId: string; pageIndex: number; cardId: string; summary: string; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.reserveWorkerTurnPageIntent(input.turnId, input.pageIndex, (page) => {
      if (page.cardId !== input.cardId || input.nextPageIndex !== input.pageIndex + 1 || input.nextPageStart <= page.pageStart) return "stale";
      const facts = this.getWorkerTurnCardDeliveryFacts(input.turnId, input.pageIndex);
      if ((facts.latestContent && facts.latestContent.state !== "delivered") || facts.finishPending || facts.continuationPending) return "waiting";
      const sequence = page.sequence + 1;
      this.context.database.prepare("UPDATE worker_turn_card_pages SET sequence = ?, updated_at = ? WHERE turn_id = ? AND page_index = ? AND state = 'active' AND sequence = ?").run(sequence, now(), input.turnId, input.pageIndex, page.sequence);
      this.context.database.prepare("UPDATE worker_turn_cards SET sequence = ?, updated_at = ? WHERE turn_id = ? AND page_index = ?").run(sequence, now(), input.turnId, input.pageIndex);
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-turn:finish:${input.turnId}:${input.pageIndex}:${sequence}`, bindingId: null, workerTurnId: input.turnId, viewVersion: sequence, rootMessageId: input.cardId, kind: "stream_finish", payload: JSON.stringify({ pageIndex: input.pageIndex, summary: input.summary, sequence }) });
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-turn:create:${input.turnId}:${input.nextPageIndex}`, bindingId: null, workerTurnId: input.turnId, viewVersion: input.viewVersion, rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.nextPageStart, elementId: input.nextElementId } }) });
      return "reserved";
    });
  }
  private reserveWorkerTurnPageIntent(turnId: string, pageIndex: number, reserve: (page: WorkerTurnCardPage, view: WorkerTurnCardView) => AnswerPageReservationOutcome): AnswerPageReservationOutcome {
    return this.context.transaction(() => {
      const pageRow = this.context.database.prepare("SELECT * FROM worker_turn_card_pages WHERE turn_id = ? AND page_index = ? AND state = 'active'").get(turnId, pageIndex) as Record<string, unknown> | undefined;
      const view = this.loadWorkerTurnCard(turnId);
      return pageRow && view ? reserve(mapWorkerTurnCardPage(pageRow), view) : "stale";
    });
  }
  applyInstanceTurnProjection(input: { turnId: string; expectedGeneration: number; expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string; change: WorkerTurnCardChange; render(view: WorkerTurnCardView): object }): WorkerTurnCardView | null {
    return this.context.transaction(() => {
      const turn = this.getInstanceTurn(input.turnId); const current = this.loadWorkerTurnCard(input.turnId);
      if (!turn || !current || turn.instanceGeneration !== input.expectedGeneration || !matchesExpectedRuntimeTurn(turn, input)) return null;
      const next = reduceWorkerTurnCard(current, input.change);
      if (next !== current) {
        this.saveWorkerTurnCard(next);
        this.dependencies.invalidateWorkerCardContexts(next, `turn.${next.phase}`);
      }
      return next;
    });
  }
  transitionInstanceTurnWithProjection(input: { turnId: string; expectedGeneration: number; expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string; state: InstanceTurnState; result?: string | null; error?: string | null; eventKind: InstanceEventKind; change: WorkerTurnCardChange; render(view: WorkerTurnCardView): object }): { turn: InstanceTurn; view: WorkerTurnCardView } | null {
    const timestamp = now();
    return this.context.transaction(() => {
      const current = this.getInstanceTurn(input.turnId);
      const currentView = this.loadWorkerTurnCard(input.turnId);
      if (!current || !currentView || current.instanceGeneration !== input.expectedGeneration || !matchesExpectedRuntimeTurn(current, input)) return null;
      const changed = this.context.database.prepare("UPDATE instance_turns SET state = ?, result = ?, error = ?, updated_at = ? WHERE id = ? AND instance_generation = ? AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.id = instance_turns.instance_id AND i.generation = ?)")
        .run(input.state, input.result ?? null, input.error ?? null, timestamp, input.turnId, input.expectedGeneration, input.expectedGeneration);
      if (changed.changes !== 1) return null;
      this.insertInstanceEvent(current.projectId, current.instanceId, current.id, input.eventKind, { state: input.state });
      const next = reduceWorkerTurnCard(currentView, input.change);
      if (next !== currentView) {
        this.saveWorkerTurnCard(next);
        this.dependencies.invalidateWorkerCardContexts(next, `turn.${next.phase}`);
      }
      if (["completed", "failed", "cancelled"].includes(input.state)) {
        const queued = this.context.database.prepare("SELECT c.* FROM worker_turn_cards c JOIN instance_turns t ON t.id = c.turn_id WHERE t.instance_id = ? AND t.instance_generation = ? AND t.state = 'queued' ORDER BY t.created_at, t.rowid").all(current.instanceId, input.expectedGeneration) as Array<Record<string, unknown>>;
        for (const [index, row] of queued.entries()) {
          const queuedView = mapWorkerTurnCard(row);
          if (!queuedView || queuedView.queuePosition === index + 1) continue;
          const reordered = reduceWorkerTurnCard(queuedView, { type: "queue-position", occurredAt: timestamp, queuePosition: index + 1 });
          this.saveWorkerTurnCard(reordered);
          this.dependencies.invalidateWorkerCardContexts(reordered, "turn.queue-position");
        }
      }
      const turn = this.getInstanceTurn(input.turnId);
      return turn ? { turn, view: next } : null;
    });
  }
  saveWorkerTurnCard(view: WorkerTurnCardView): void {
    this.context.database.prepare(`INSERT INTO worker_turn_cards(turn_id, instance_id, instance_generation, worker_session_generation, worker_name, parent_turn_id, root_message_id, message_id, card_id, element_id, progress_sequence, phase, request_text, answer, status_title, progress_json, queue_position, started_at, finished_at, notice, result_capture, worker_main_ref_json, primary_answer_ref_json, page_index, page_start, sequence, view_version, delivered_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET message_id=excluded.message_id, card_id=excluded.card_id, phase=excluded.phase, answer=excluded.answer, status_title=excluded.status_title, progress_json=excluded.progress_json, queue_position=excluded.queue_position, started_at=excluded.started_at, finished_at=excluded.finished_at, notice=excluded.notice, result_capture=excluded.result_capture, worker_main_ref_json=excluded.worker_main_ref_json, primary_answer_ref_json=excluded.primary_answer_ref_json, page_index=excluded.page_index, page_start=excluded.page_start, sequence=excluded.sequence, view_version=excluded.view_version, delivered_version=excluded.delivered_version, updated_at=excluded.updated_at`)
      .run(view.turnId, view.instanceId, view.instanceGeneration, view.workerSessionGeneration, view.workerName, view.parentTurnId, view.rootMessageId, view.messageId, view.cardId, view.elementId, view.progressSequence, view.phase, view.requestText, view.answer, view.statusTitle, JSON.stringify(view.progressEvents), view.queuePosition, view.startedAt, view.finishedAt, view.notice, view.resultCapture, JSON.stringify(view.workerMain), view.primaryAnswer ? JSON.stringify(view.primaryAnswer) : null, view.pageIndex, view.pageStart, view.sequence, view.viewVersion, view.deliveredVersion, view.createdAt, view.updatedAt);
  }
  private getInstanceTurnByKey(key: string): InstanceTurn | null { return mapInstanceTurn(this.context.database.prepare("SELECT * FROM instance_turns WHERE idempotency_key = ?").get(key) as Record<string, unknown> | undefined); }
  private insertInstanceEvent(projectId: string, instanceId: string, turnId: string | null, kind: InstanceEventKind, payload: Record<string, unknown>): void {
    this.context.database.prepare("INSERT INTO instance_events(project_id, instance_id, turn_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, instanceId, turnId, kind, JSON.stringify(payload), now());
  }
  listInstanceTurns(instanceId: string, options: { limit?: number; after?: { createdAt: string; id: string } } = {}): { items: InstanceTurn[]; nextCursor: { createdAt: string; id: string } | null } {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const rows = (options.after
      ? this.context.database.prepare("SELECT * FROM instance_turns WHERE instance_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?").all(instanceId, options.after.createdAt, options.after.createdAt, options.after.id, limit + 1)
      : this.context.database.prepare("SELECT * FROM instance_turns WHERE instance_id = ? ORDER BY created_at, id LIMIT ?").all(instanceId, limit + 1)) as Array<Record<string, unknown>>;
    const items = rows.slice(0, limit).map((row) => mapInstanceTurn(row)!);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
  }
  listRecentInstanceTurnSummaries(instanceId: string, requestedLimit = 5): InstanceTurnSummary[] {
    const limit = Math.max(1, Math.min(requestedLimit, 5));
    const rows = this.context.database.prepare(`
      SELECT t.*, COALESCE(c.result_capture, CASE WHEN t.result IS NOT NULL THEN 'captured' ELSE 'pending' END) AS result_capture
      FROM instance_turns t LEFT JOIN worker_turn_cards c ON c.turn_id = t.id
      WHERE t.instance_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ?
    `).all(instanceId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...mapInstanceTurn(row)!, resultCapture: String(row.result_capture) as InstanceTurnSummary["resultCapture"] }));
  }
  getActiveInstanceTurn(instanceId: string, expectedGeneration: number): InstanceTurn | null {
    const row = this.context.database.prepare("SELECT * FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked') ORDER BY created_at, rowid LIMIT 1").get(instanceId, expectedGeneration) as Record<string, unknown> | undefined;
    return mapInstanceTurn(row);
  }
  claimNextInstanceTurn(instanceId: string, expectedGeneration: number): InstanceTurn | null {
    return this.context.transaction(() => {
      const instance = this.dependencies.getAgentInstance(instanceId);
      if (!instance || instance.generation !== expectedGeneration || instance.desiredState !== "running" || !instance.runtimeRef || !["idle", "working", "blocked"].includes(instance.observedState)) return null;
      const active = this.context.database.prepare("SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked','dispatch-uncertain')").get(instanceId, expectedGeneration);
      if (active) return null;
      const row = this.context.database.prepare("SELECT id FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state = 'queued' ORDER BY CASE priority WHEN 'priority' THEN 0 ELSE 1 END, created_at, rowid LIMIT 1").get(instanceId, expectedGeneration) as { id: string } | undefined;
      if (!row) return null;
      this.context.database.prepare("UPDATE instance_turns SET state = 'claimed', updated_at = ? WHERE id = ? AND state = 'queued'").run(now(), row.id);
      const turn = this.getInstanceTurn(row.id)!; this.insertInstanceEvent(turn.projectId, turn.instanceId, turn.id, "turn.claimed", {});
      return turn;
    });
  }

  recoverInterruptedInstanceTurns(): { requeuedTurnIds: string[]; observableTurns: InstanceTurn[] } {
    const timestamp = now();
    return this.context.transaction(() => {
      const claimed = this.context.database.prepare(`SELECT t.id, t.project_id, t.instance_id FROM instance_turns t JOIN agent_instances i ON i.id = t.instance_id AND i.generation = t.instance_generation WHERE t.state = 'claimed' ORDER BY t.created_at, t.rowid`).all() as Array<{ id: string; project_id: string; instance_id: string }>;
      for (const turn of claimed) {
        this.context.database.prepare("UPDATE instance_turns SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'claimed'").run(timestamp, turn.id);
        this.insertInstanceEvent(turn.project_id, turn.instance_id, turn.id, "turn.requeued-after-restart", {});
      }
      const rows = this.context.database.prepare(`SELECT t.* FROM instance_turns t JOIN agent_instances i ON i.id = t.instance_id AND i.generation = t.instance_generation WHERE t.state IN ('dispatching','running','blocked','dispatch-uncertain') ORDER BY t.created_at, t.rowid`).all() as Array<Record<string, unknown>>;
      return { requeuedTurnIds: claimed.map(({ id }) => id), observableTurns: rows.map((row) => mapInstanceTurn(row)!) };
    });
  }

  listObservableInstanceTurns(): InstanceTurn[] {
    return (this.context.database.prepare(`SELECT t.* FROM instance_turns t JOIN agent_instances i ON i.id = t.instance_id AND i.generation = t.instance_generation WHERE t.state IN ('dispatching','running','blocked','dispatch-uncertain') ORDER BY t.created_at, t.rowid`).all() as Array<Record<string, unknown>>).map((row) => mapInstanceTurn(row)!);
  }

  listObservableInstanceTurnsByPaneIds(paneIds: readonly string[]): InstanceTurn[] {
    const uniquePaneIds = [...new Set(paneIds)];
    if (uniquePaneIds.length === 0) return [];
    const placeholders = uniquePaneIds.map(() => "?").join(",");
    return (this.context.database.prepare(`SELECT t.* FROM instance_turns t JOIN agent_instances i ON i.id = t.instance_id AND i.generation = t.instance_generation WHERE t.state IN ('dispatching','running','blocked','dispatch-uncertain') AND i.pane_id IN (${placeholders}) ORDER BY t.created_at, t.rowid`).all(...uniquePaneIds) as Array<Record<string, unknown>>).map((row) => mapInstanceTurn(row)!);
  }

  getInstanceTurnDiagnostics(): { queuedTurns: number; activeTurns: number; uncertainTurns: number } {
    const row = this.context.database.prepare(`SELECT
      SUM(CASE WHEN t.state = 'queued' THEN 1 ELSE 0 END) AS queued_turns,
      SUM(CASE WHEN t.state IN ('claimed','dispatching','running','blocked') THEN 1 ELSE 0 END) AS active_turns,
      SUM(CASE WHEN t.state = 'dispatch-uncertain' THEN 1 ELSE 0 END) AS uncertain_turns
      FROM instance_turns t JOIN agent_instances i ON i.id = t.instance_id AND i.generation = t.instance_generation`).get() as { queued_turns: number | null; active_turns: number | null; uncertain_turns: number | null };
    return { queuedTurns: row.queued_turns ?? 0, activeTurns: row.active_turns ?? 0, uncertainTurns: row.uncertain_turns ?? 0 };
  }

  updateInstanceTurn(input: { turnId: string; expectedGeneration: number; expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string; state: InstanceTurnState; result?: string | null; error?: string | null; eventKind: InstanceEventKind }): InstanceTurn | null {
    const timestamp = now();
    return this.context.transaction(() => {
      const current = this.getInstanceTurn(input.turnId);
      if (!current || current.instanceGeneration !== input.expectedGeneration || !matchesExpectedRuntimeTurn(current, input)) return null;
      const changed = this.context.database.prepare("UPDATE instance_turns SET state = ?, result = ?, error = ?, updated_at = ? WHERE id = ? AND instance_generation = ? AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.id = instance_turns.instance_id AND i.generation = ?)").run(input.state, input.result ?? null, input.error ?? null, timestamp, input.turnId, input.expectedGeneration, input.expectedGeneration);
      if (changed.changes !== 1) return null;
      this.insertInstanceEvent(current.projectId, current.instanceId, current.id, input.eventKind, { state: input.state });
      return this.getInstanceTurn(input.turnId);
    });
  }
  completeInstanceTurn(input: { turnId: string; expectedGeneration: number; result: string }): InstanceTurn | null { return this.updateInstanceTurn({ ...input, state: "completed", eventKind: "turn.completed" }); }
  listInstanceEvents(instanceId: string, afterId = 0): InstanceEvent[] {
    return (this.context.database.prepare("SELECT * FROM instance_events WHERE instance_id = ? AND id > ? ORDER BY id LIMIT 100").all(instanceId, afterId) as Array<Record<string, unknown>>).map((row) => ({ id: Number(row.id), projectId: String(row.project_id), instanceId: String(row.instance_id), turnId: row.turn_id === null ? null : String(row.turn_id), kind: String(row.kind) as InstanceEventKind, payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at) }));
  }
  countPendingInstanceTurns(instanceId: string, expectedGeneration?: number): number {
    const row = expectedGeneration === undefined
      ? this.context.database.prepare("SELECT COUNT(*) AS count FROM instance_turns WHERE instance_id = ? AND state IN ('queued','claimed','dispatching','running','blocked','dispatch-uncertain')").get(instanceId)
      : this.context.database.prepare("SELECT COUNT(*) AS count FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state IN ('queued','claimed','dispatching','running','blocked','dispatch-uncertain')").get(instanceId, expectedGeneration);
    return Number((row as { count: number }).count);
  }
}

function now(): string { return new Date().toISOString(); }
function parseJsonRecord(payload: string): Record<string, unknown> { try { const value = JSON.parse(payload) as unknown; return isRecord(value) ? value : {}; } catch { return {}; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function mapWorkerTurnCard(row: Record<string, unknown> | undefined): WorkerTurnCardView | null {
  if (!row) return null;
  const progressEvents = parseWorkerProgress(row.progress_json);
  return { turnId: String(row.turn_id), instanceId: String(row.instance_id), instanceGeneration: Number(row.instance_generation), workerSessionGeneration: Number(row.worker_session_generation ?? 1), workerName: String(row.worker_name), parentTurnId: row.parent_turn_id === null ? null : String(row.parent_turn_id), rootMessageId: String(row.root_message_id), messageId: row.message_id === null ? null : String(row.message_id), cardId: row.card_id === null ? null : String(row.card_id), elementId: String(row.element_id), progressSequence: Number(row.progress_sequence ?? 0), phase: String(row.phase) as WorkerTurnCardView["phase"], requestText: String(row.request_text), answer: String(row.answer), statusTitle: row.status_title === null ? null : String(row.status_title), progressEvents, progressSummary: summarizeWorkerProgress(progressEvents), queuePosition: Number(row.queue_position), startedAt: row.started_at === null ? null : String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at), notice: row.notice === null ? null : String(row.notice), resultCapture: String(row.result_capture) as WorkerTurnCardView["resultCapture"], workerMain: JSON.parse(String(row.worker_main_ref_json ?? '{}')) as WorkerTurnCardView["workerMain"], primaryAnswer: row.primary_answer_ref_json === null || row.primary_answer_ref_json === undefined ? null : JSON.parse(String(row.primary_answer_ref_json)) as WorkerTurnCardView["primaryAnswer"], pageIndex: Number(row.page_index), pageStart: Number(row.page_start), sequence: Number(row.sequence), viewVersion: Number(row.view_version), deliveredVersion: Number(row.delivered_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function parseWorkerProgress(value: unknown): import("../../domain/run-card-view.js").RunProgressEvent[] { try { const parsed = JSON.parse(String(value ?? "[]")) as unknown; return Array.isArray(parsed) ? parsed as import("../../domain/run-card-view.js").RunProgressEvent[] : []; } catch { return []; } }
function summarizeWorkerProgress(events: readonly import("../../domain/run-card-view.js").RunProgressEvent[]): import("../../domain/run-card-view.js").RunProgressSummary { let stepTotal = 0; let stepDone = 0; for (const event of events) if (event.kind === "step") { stepTotal += 1; if (event.state === "done") stepDone += 1; } return { total: events.length, stepTotal, stepDone }; }
function mapWorkerTurnCardPage(row: Record<string, unknown>): WorkerTurnCardPage { return { id: String(row.id), turnId: String(row.turn_id), pageIndex: Number(row.page_index), pageStart: Number(row.page_start), elementId: String(row.element_id), messageId: row.message_id === null ? null : String(row.message_id), cardId: row.card_id === null ? null : String(row.card_id), state: String(row.state) as WorkerTurnCardPage["state"], sequence: Number(row.sequence), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function matchesExpectedRuntimeTurn(turn: InstanceTurn, input: { expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string }): boolean { return (input.expectedRuntimeTurnId === undefined || turn.runtimeTurnId === input.expectedRuntimeTurnId) && (input.expectedRuntimeTurnStartedAt === undefined || turn.runtimeTurnStartedAt === input.expectedRuntimeTurnStartedAt); }
function mapInstanceTurn(row: Record<string, unknown> | undefined): InstanceTurn | null { return row ? { id: String(row.id), idempotencyKey: String(row.idempotency_key), projectId: String(row.project_id), instanceId: String(row.instance_id), instanceGeneration: Number(row.instance_generation), actor: JSON.parse(String(row.actor_json)) as ControlActor, kind: String(row.kind) as InstanceTurn["kind"], priority: String(row.priority ?? "normal") as InstanceTurn["priority"], text: String(row.text), state: String(row.state) as InstanceTurnState, result: row.result === null ? null : String(row.result), error: row.error === null ? null : String(row.error), parentTurnId: row.parent_turn_id === null || row.parent_turn_id === undefined ? null : String(row.parent_turn_id), sourceMessageId: row.source_message_id === null || row.source_message_id === undefined ? null : String(row.source_message_id), runtimeTurnId: row.runtime_turn_id === null || row.runtime_turn_id === undefined ? null : String(row.runtime_turn_id), runtimeTurnStartedAt: row.runtime_turn_started_at === null || row.runtime_turn_started_at === undefined ? null : String(row.runtime_turn_started_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at) } : null; }
