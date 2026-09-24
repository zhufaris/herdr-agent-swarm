import { randomUUID } from "node:crypto";
import type { AgentInstance, WorkspaceLease } from "../../domain/agent-instance.js";
import type { CardContextInvalidation, CardContextTarget } from "../../domain/card-context-invalidation.js";
import { selectPrimaryWorkerActivity, selectPrimaryWorkerSummaries, type PrimaryWorkerActivitySummary, type PrimaryWorkerSummary } from "../../domain/card-context-summary.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { updateRunCardWorkerContext } from "../../domain/run-card-view.js";
import type { TopicViewState } from "../../domain/topic-view.js";
import { updateTopicCurrentAnswer, updateTopicWorkerContext } from "../../domain/topic-view.js";
import { selectWorkerMainView, type WorkerMainProjectionSource } from "../../domain/worker-main-selector.js";
import type { WorkerMainView } from "../../domain/worker-main-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import type { Binding, MainCardReservationOutcome } from "../../domain/types.js";
import type { SqliteContext } from "./context.js";
import { mapWorkerTurnCard } from "./worker-turn-store.js";

export interface SqliteCardContextStoreDependencies {
  getAgentInstance(id: string): AgentInstance | null;
  getWorkspaceLease(id: string): WorkspaceLease | null;
  getBinding(id: string): Binding | null;
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
  saveWorkerTurnCard(view: WorkerTurnCardView): void;
  loadTopicView(bindingId: string): TopicViewState | null;
  saveTopicView(view: TopicViewState): void;
  loadRunCard(promptId: string): RunCardView | null;
  saveRunCard(view: RunCardView): RunCardView;
  reserveMainCard(view: TopicViewState, rootMessageId: string | null, card: object, paneEntryCard: object): MainCardReservationOutcome;
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): unknown;
  reserveWorkerMainPlacement(view: WorkerMainView, card: object): "reserved" | "waiting" | "current" | "stale";
}

export class SqliteCardContextStore {
  constructor(private readonly context: SqliteContext, private readonly dependencies: SqliteCardContextStoreDependencies) {}

  private get database() { return this.context.database; }

  loadWorkerMainView(workerId: string, workerSessionGeneration: number): WorkerMainView | null {
    const row = this.database.prepare("SELECT state_json FROM worker_main_views WHERE worker_id = ? AND worker_session_generation = ?").get(workerId, workerSessionGeneration) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as WorkerMainView : null;
  }

  saveWorkerMainView(view: WorkerMainView): WorkerMainView | null {
    const instance = this.dependencies.getAgentInstance(view.workerId);
    if (!instance || instance.role !== "worker" || instance.workerSessionGeneration !== view.workerSessionGeneration
      || instance.parent?.bindingId !== view.parentBindingId || instance.parent.paneId !== view.parentPaneId) return null;
    const result = this.database.prepare(`
      INSERT INTO worker_main_views(worker_id, worker_session_generation, parent_binding_id, parent_binding_generation, parent_pane_id, state_json, view_version, delivered_version, message_id, card_id, frozen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id, worker_session_generation) DO UPDATE SET
        state_json=excluded.state_json, view_version=excluded.view_version, delivered_version=excluded.delivered_version, message_id=excluded.message_id, card_id=excluded.card_id, frozen_at=excluded.frozen_at, updated_at=excluded.updated_at
      WHERE worker_main_views.frozen_at IS NULL AND excluded.view_version >= worker_main_views.view_version
    `).run(view.workerId, view.workerSessionGeneration, view.parentBindingId, view.parentBindingGeneration, view.parentPaneId, JSON.stringify(view), view.viewVersion, view.deliveredVersion, view.messageId, view.cardId, view.frozenAt, view.createdAt, view.updatedAt);
    return result.changes === 1 ? this.loadWorkerMainView(view.workerId, view.workerSessionGeneration) : null;
  }

  reserveWorkerMainCard(view: WorkerMainView, rootMessageId: string, card: object): WorkerMainView | null {
    return this.context.transaction(() => {
      const saved = this.saveWorkerMainView(view);
      if (!saved) return null;
      const creating = saved.messageId === null;
      if (creating && this.database.prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key = ? AND (first_claimed_at IS NOT NULL OR attempt_count > 0 OR card_id_checkpoint IS NOT NULL)").get(`worker-main:create:${saved.workerId}:${saved.workerSessionGeneration}`)) return saved;
      this.dependencies.enqueueOutboundReply({
        id: randomUUID(), idempotencyKey: creating ? `worker-main:create:${saved.workerId}:${saved.workerSessionGeneration}` : `worker-main:update:${saved.workerId}:${saved.workerSessionGeneration}:${saved.viewVersion}`,
        bindingId: saved.parentBindingId, workerId: saved.workerId, workerSessionGeneration: saved.workerSessionGeneration, viewVersion: saved.viewVersion,
        rootMessageId: creating ? rootMessageId : saved.messageId!, kind: creating ? "card_reply" : "card_update", payload: JSON.stringify(card)
      });
      return saved;
    });
  }

  invalidateCardContexts(targets: readonly (CardContextTarget & { reason: string })[]): CardContextInvalidation[] {
    if (targets.length === 0) return [];
    const timestamp = now();
    return this.context.transaction(() => {
      const statement = this.database.prepare(`
        INSERT INTO card_context_invalidations(target_kind, target_id, target_generation, requested_dependency_revision, projected_dependency_revision, reason, created_at, updated_at)
        VALUES (?, ?, ?, 1, 0, ?, ?, ?)
        ON CONFLICT(target_kind, target_id, target_generation) DO UPDATE SET
          requested_dependency_revision = card_context_invalidations.requested_dependency_revision + 1, reason = excluded.reason, updated_at = excluded.updated_at
      `);
      for (const target of targets) statement.run(target.targetKind, target.targetId, target.targetGeneration, target.reason, timestamp, timestamp);
      return targets.map((target) => this.loadCardContextInvalidation(target)!).filter(Boolean);
    });
  }

  invalidateWorkerCardContexts(view: WorkerTurnCardView, reason: string): void {
    const instance = this.dependencies.getAgentInstance(view.instanceId);
    const targets: Array<CardContextTarget & { reason: string }> = [
      { targetKind: "worker-session", targetId: view.instanceId, targetGeneration: view.workerSessionGeneration, reason }
    ];
    if (instance?.parent?.bindingGeneration) targets.push({ targetKind: "primary-session", targetId: instance.parent.bindingId, targetGeneration: instance.parent.bindingGeneration, reason });
    if (view.primaryAnswer) targets.push({ targetKind: "primary-turn", targetId: view.primaryAnswer.aggregateId, targetGeneration: view.primaryAnswer.generation, reason });
    this.invalidateCardContexts(targets);
  }

  invalidateWorkerInstanceContexts(instance: AgentInstance, reason: string): void {
    if (instance.role !== "worker" || !instance.parent?.bindingGeneration) return;
    this.invalidateCardContexts([
      { targetKind: "worker-session", targetId: instance.id, targetGeneration: instance.workerSessionGeneration, reason },
      { targetKind: "primary-session", targetId: instance.parent.bindingId, targetGeneration: instance.parent.bindingGeneration, reason }
    ]);
  }

  invalidateBindingWorkerContexts(bindingId: string, reason: string): void {
    const workers = this.database.prepare("SELECT id, worker_session_generation FROM agent_instances WHERE role = 'worker' AND worker_session_lifecycle = 'active' AND parent_binding_id = ? ORDER BY created_at, id").all(bindingId) as Array<{ id: string; worker_session_generation: number }>;
    this.invalidateCardContexts(workers.map((worker) => ({ targetKind: "worker-session" as const, targetId: worker.id, targetGeneration: Number(worker.worker_session_generation), reason })));
  }

  listPendingCardContextInvalidations(limit = 100): CardContextInvalidation[] {
    const bounded = Math.max(1, Math.min(limit, 500));
    return (this.database.prepare(`SELECT * FROM card_context_invalidations WHERE projected_dependency_revision < requested_dependency_revision ORDER BY updated_at, target_kind, target_id, target_generation LIMIT ?`).all(bounded) as Array<Record<string, unknown>>).map(mapCardContextInvalidation);
  }

  markCardContextProjected(target: CardContextTarget, dependencyRevision: number): boolean {
    if (!Number.isInteger(dependencyRevision) || dependencyRevision < 1) return false;
    return this.database.prepare(`UPDATE card_context_invalidations SET projected_dependency_revision = MAX(projected_dependency_revision, MIN(requested_dependency_revision, ?)), updated_at = ? WHERE target_kind = ? AND target_id = ? AND target_generation = ?`).run(dependencyRevision, now(), target.targetKind, target.targetId, target.targetGeneration).changes === 1;
  }

  projectCardContext(invalidation: CardContextInvalidation, renderers: { workerMain(view: WorkerMainView): object; workerThreadEntryReady(input: { workerName: string; workerId: string; workerSessionGeneration: number; messageId: string }): object; workerTask(view: WorkerTurnCardView): object; primaryMain(view: TopicViewState): object; primaryPaneEntry(view: TopicViewState): object; primaryAnswer(view: RunCardView): object }): "reserved" | "current" | "stale" {
    return this.context.transaction(() => {
      const current = this.loadCardContextInvalidation(invalidation);
      if (!current || current.projectedDependencyRevision >= invalidation.requestedDependencyRevision) return "current";
      let reserved = false;
      if (invalidation.targetKind === "worker-session") {
        return this.projectSessionMain(invalidation, () => {
          const source = this.loadWorkerMainProjectionSource(invalidation.targetId, invalidation.targetGeneration);
          if (!source) return "stale";
          const previous = this.loadWorkerMainView(invalidation.targetId, invalidation.targetGeneration);
          const selected = selectWorkerMainView(source, previous, invalidation.requestedDependencyRevision, now());
          const next = invalidation.reason === "worker-main.delivered" && previous?.messageId && selected.viewVersion <= selected.deliveredVersion
            ? { ...selected, viewVersion: selected.viewVersion + 1, updatedAt: now() }
            : selected;
          const placement = this.dependencies.reserveWorkerMainPlacement(next, renderers.workerMain(next));
          if (placement === "stale") return "stale";
          const threadEntryReserved = next.messageId
            ? this.reserveWorkerThreadEntries(next, renderers.workerThreadEntryReady)
            : false;
          return placement === "reserved" || threadEntryReserved ? "reserved" : "current";
        });
      } else if (invalidation.targetKind === "worker-turn") {
        // Legacy Task Cards are immutable historical artifacts. Mark old
        // invalidations converged without creating or patching visible cards.
        return this.markStale(invalidation);
      } else if (invalidation.targetKind === "primary-session") {
        return this.projectSessionMain(invalidation, () => {
          const binding = this.dependencies.getBinding(invalidation.targetId);
          const previous = this.dependencies.loadTopicView(invalidation.targetId);
          if (!binding || binding.generation !== invalidation.targetGeneration || !previous || !binding.rootMessageId) return "stale";
          const selected = selectPrimaryWorkerSummaries(this.loadPrimaryWorkerSummaries(binding.id, binding.generation));
          const withWorkers = updateTopicWorkerContext(previous, selected.workers, selected.overflowCount, invalidation.requestedDependencyRevision);
          const latestRun = this.database.prepare("SELECT prompt_id FROM run_cards_view WHERE binding_id = ? AND binding_generation = ? AND answer_message_id IS NOT NULL ORDER BY created_at DESC, prompt_id DESC LIMIT 1").get(binding.id, binding.generation) as { prompt_id: string } | undefined;
          const run = latestRun ? this.dependencies.loadRunCard(latestRun.prompt_id) : null;
          const next = updateTopicCurrentAnswer(withWorkers, run ? { aggregateKind: "primary-turn", aggregateId: run.promptId, generation: run.bindingGeneration, messageId: run.answerMessageId } : null);
          this.dependencies.saveTopicView(next);
          return this.dependencies.reserveMainCard(next, binding.rootMessageId, renderers.primaryMain(next), renderers.primaryPaneEntry(next)) === "reserved" ? "reserved" : "current";
        });
      } else {
        const previous = this.dependencies.loadRunCard(invalidation.targetId);
        const page = previous ? this.database.prepare("SELECT state FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(previous.promptId, previous.answerPageIndex) as { state: string } | undefined : undefined;
        if (!previous || previous.bindingGeneration !== invalidation.targetGeneration || previous.workerContextFrozenAt !== null || page?.state === "frozen" || page?.state === "finished") return this.markStale(invalidation);
        const activity = selectPrimaryWorkerActivity(this.loadPrimaryWorkerActivity(previous.promptId, invalidation.targetGeneration));
        const next = updateRunCardWorkerContext(previous, activity, invalidation.requestedDependencyRevision, now());
        if (next !== previous) this.dependencies.saveRunCard(next);
        if (next.answerMessageId && next.viewVersion > next.answerDeliveredVersion) {
          this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:update:${next.promptId}:answer:${next.viewVersion}`, bindingId: next.bindingId, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: next.answerMessageId, kind: "card_update", payload: JSON.stringify(renderers.primaryAnswer(next)) });
          reserved = true;
        }
      }
      this.markCardContextProjected(invalidation, invalidation.requestedDependencyRevision);
      return reserved ? "reserved" : "current";
    });
  }

  /** Shared durable lifecycle for a Primary or Worker pane-session main card. */
  private projectSessionMain(invalidation: CardContextInvalidation, project: () => "reserved" | "current" | "stale"): "reserved" | "current" | "stale" {
    const outcome = project();
    if (outcome === "stale") return this.markStale(invalidation);
    this.markCardContextProjected(invalidation, invalidation.requestedDependencyRevision);
    return outcome;
  }

  private reserveWorkerThreadEntries(view: WorkerMainView, render: (input: { workerName: string; workerId: string; workerSessionGeneration: number; messageId: string }) => object): boolean {
    if (!view.messageId) return false;
    const requests = this.database.prepare(`
      SELECT request.command_intent_id, request.binding_id, request.root_message_id
      FROM worker_thread_entry_requests request
      JOIN worker_session_threads thread ON thread.worker_id = request.worker_id AND thread.worker_session_generation = request.worker_session_generation
      JOIN bindings binding ON binding.id = request.binding_id
      WHERE request.worker_id = ? AND request.worker_session_generation = ? AND request.state = 'pending'
        AND request.binding_id = ? AND request.binding_generation = ?
        AND thread.state = 'active' AND thread.root_message_id = ?
        AND binding.generation = request.binding_generation AND binding.root_message_id = request.root_message_id
        AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
    `).all(view.workerId, view.workerSessionGeneration, view.parentBindingId, view.parentBindingGeneration, view.messageId) as Array<{ command_intent_id: string; binding_id: string; root_message_id: string }>;
    let reserved = false;
    for (const request of requests) {
      const changed = this.database.prepare("UPDATE worker_thread_entry_requests SET state = 'reserved', updated_at = ? WHERE command_intent_id = ? AND state = 'pending'").run(now(), request.command_intent_id).changes;
      if (changed !== 1) continue;
      this.dependencies.enqueueOutboundReply({
        id: randomUUID(), idempotencyKey: `worker-thread-entry:${request.command_intent_id}`, bindingId: request.binding_id, rootMessageId: request.root_message_id, kind: "card_reply",
        payload: JSON.stringify(render({ workerName: view.workerName, workerId: view.workerId, workerSessionGeneration: view.workerSessionGeneration, messageId: view.messageId })),
        laneKeyOverride: `worker-thread-entry:${request.command_intent_id}`
      });
      reserved = true;
    }
    return reserved;
  }

  loadCardContextInvalidation(target: CardContextTarget): CardContextInvalidation | null {
    const row = this.database.prepare("SELECT * FROM card_context_invalidations WHERE target_kind = ? AND target_id = ? AND target_generation = ?").get(target.targetKind, target.targetId, target.targetGeneration) as Record<string, unknown> | undefined;
    return row ? mapCardContextInvalidation(row) : null;
  }

  loadWorkerMainProjectionSource(workerId: string, generation: number): WorkerMainProjectionSource | null {
    const instance = this.dependencies.getAgentInstance(workerId);
    if (!instance || instance.role !== "worker" || instance.workerSessionGeneration !== generation || !instance.parent?.bindingGeneration) return null;
    const lease = this.dependencies.getWorkspaceLease(instance.workspaceLeaseId);
    if (!lease) return null;
    const summaryColumns = "turn_id, request_text, phase, started_at, finished_at, message_id, instance_generation, updated_at";
    const active = this.database.prepare(`SELECT * FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase IN ('blocked','running','preparing') ORDER BY CASE phase WHEN 'blocked' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, created_at DESC, turn_id DESC LIMIT 1`).get(workerId, generation) as Record<string, unknown> | undefined;
    const queue = this.database.prepare("SELECT COUNT(*) AS count, MIN(created_at) AS first_created_at FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase = 'queued'").get(workerId, generation) as { count: number; first_created_at: string | null };
    const nextQueued = queue.first_created_at === null ? undefined : this.database.prepare("SELECT request_text FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase = 'queued' ORDER BY created_at, turn_id LIMIT 1").get(workerId, generation) as { request_text: string } | undefined;
    const recent = this.database.prepare(`SELECT ${summaryColumns} FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase IN ('completed','failed','cancelled','dispatch-uncertain') ORDER BY created_at DESC, turn_id DESC LIMIT 5`).all(workerId, generation) as unknown as WorkerTaskSummaryRow[];
    const first = this.database.prepare("SELECT MIN(created_at) AS created_at FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ?").get(workerId, generation) as { created_at: string | null };
    const queued = this.database.prepare(`SELECT * FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase = 'queued' ORDER BY created_at, turn_id LIMIT 1`).get(workerId, generation) as Record<string, unknown> | undefined;
    const terminal = this.database.prepare(`SELECT * FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase IN ('completed','failed','cancelled','dispatch-uncertain') ORDER BY updated_at DESC, turn_id DESC LIMIT 1`).get(workerId, generation) as Record<string, unknown> | undefined;
    const summary = (row: WorkerTaskSummaryRow) => ({ turnId: row.turn_id, title: summarizeTaskTitle(row.request_text), phase: row.phase as WorkerTurnCardView["phase"], durationSeconds: durationSeconds(row.started_at, row.finished_at), taskCard: { aggregateKind: "worker-turn" as const, aggregateId: row.turn_id, generation: Number(row.instance_generation), messageId: row.message_id }, updatedAt: row.updated_at });
    const currentRow = active ?? terminal ?? queued;
    const currentTask = currentRow ? (() => {
      const card = mapWorkerTurnCard(currentRow);
      return card ? { ...summary(currentRow as unknown as WorkerTaskSummaryRow), requestText: card.requestText, answer: card.answer, statusTitle: card.statusTitle, tokenCount: card.tokenCount, progressEvents: card.progressEvents, notice: card.notice, resultCapture: card.resultCapture } : null;
    })() : null;
    return {
      workerId, workerSessionGeneration: generation, workerName: instance.name, model: instance.model, runtimeGeneration: instance.generation, runtimeState: instance.observedState, paneId: instance.runtimeRef?.paneId ?? null,
      runtimeAttached: instance.runtimeRef !== null, desiredState: instance.desiredState, parentActive: (() => { const parent = this.dependencies.getBinding(instance.parent.bindingId); return parent?.generation === instance.parent!.bindingGeneration && parent.paneId === instance.parent!.paneId && parent.state === "active" && parent.lifecycle === "active" && parent.attachment === "attached"; })(),
      lifecycle: instance.workerSessionLifecycle ?? "legacy", parentBindingId: instance.parent.bindingId, parentBindingGeneration: instance.parent.bindingGeneration, parentPaneId: instance.parent.paneId, primaryPaneName: instance.sourcePrimaryPaneLabel ?? instance.parent.paneId, projectId: instance.projectId, ownerName: this.dependencies.getBinding(instance.parent.bindingId)?.title ?? "Primary",
      workspace: lease.cwd, branch: lease.branch, currentTask, queueCount: Number(queue.count), nextTaskTitle: nextQueued ? summarizeTaskTitle(nextQueued.request_text) : null,
      recentTasks: recent.map(summary), createdAt: first.created_at ?? now()
    };
  }

  loadPrimaryWorkerSummaries(bindingId: string, generation: number): PrimaryWorkerSummary[] {
    const binding = this.database.prepare("SELECT pane_id FROM bindings WHERE id = ? AND generation = ?").get(bindingId, generation) as { pane_id: string | null } | undefined;
    if (!binding?.pane_id) return [];
    const rows = this.database.prepare(`
      WITH candidate_workers AS MATERIALIZED (
        SELECT * FROM agent_instances INDEXED BY agent_instances_worker_parent_name
        WHERE role = 'worker' AND worker_session_lifecycle = 'active'
          AND parent_binding_id = ? AND parent_binding_generation = ? AND parent_pane_id = ?
      ), ranked_cards AS (
        SELECT cards.instance_id, cards.worker_session_generation, cards.request_text, cards.phase, cards.created_at, cards.updated_at, cards.turn_id,
          SUM(CASE WHEN cards.phase = 'queued' THEN 1 ELSE 0 END) OVER (PARTITION BY cards.instance_id, cards.worker_session_generation) AS queue_count,
          MIN(cards.created_at) OVER (PARTITION BY cards.instance_id, cards.worker_session_generation) AS first_created_at,
          ROW_NUMBER() OVER (PARTITION BY cards.instance_id, cards.worker_session_generation ORDER BY
            CASE cards.phase WHEN 'blocked' THEN 0 WHEN 'running' THEN 1 WHEN 'preparing' THEN 2 WHEN 'completed' THEN 3 WHEN 'failed' THEN 3 WHEN 'cancelled' THEN 3 WHEN 'dispatch-uncertain' THEN 3 WHEN 'queued' THEN 4 ELSE 5 END,
            CASE WHEN cards.phase IN ('blocked','running','preparing') THEN cards.created_at END DESC,
            CASE WHEN cards.phase IN ('completed','failed','cancelled','dispatch-uncertain') THEN cards.updated_at END DESC,
            CASE WHEN cards.phase = 'queued' THEN cards.created_at END ASC,
            CASE WHEN cards.phase = 'queued' THEN cards.turn_id END ASC, cards.turn_id DESC) AS task_rank
        FROM worker_turn_cards cards
        JOIN candidate_workers worker ON worker.id = cards.instance_id AND worker.worker_session_generation = cards.worker_session_generation
      )
      SELECT worker.id AS worker_id, worker.worker_session_generation, worker.name, worker.observed_state,
        card.request_text, card.phase, COALESCE(card.queue_count, 0) AS queue_count, card.first_created_at, main.message_id
      FROM candidate_workers worker
      LEFT JOIN ranked_cards card ON card.instance_id = worker.id AND card.worker_session_generation = worker.worker_session_generation AND card.task_rank = 1
      LEFT JOIN worker_main_views main ON main.worker_id = worker.id AND main.worker_session_generation = worker.worker_session_generation
        AND main.parent_binding_id = worker.parent_binding_id AND main.parent_binding_generation = worker.parent_binding_generation AND main.parent_pane_id = worker.parent_pane_id
      ORDER BY worker.created_at, worker.id
    `).all(bindingId, generation, binding.pane_id) as unknown as PrimaryWorkerSummaryRow[];
    return rows.map((row) => {
      const queueCount = Number(row.queue_count);
      const state = row.phase === "blocked" ? "blocked" as const
        : row.phase === "running" || row.phase === "preparing" ? "working" as const
        : row.phase === "queued" || (row.observed_state === "idle" && queueCount > 0) ? "queued" as const
        : row.observed_state as PrimaryWorkerSummary["state"];
      return {
        workerId: row.worker_id, workerSessionGeneration: Number(row.worker_session_generation), name: row.name, state,
        currentTaskTitle: row.request_text === null ? null : summarizeTaskTitle(row.request_text), queueCount,
        workerMain: { aggregateKind: "worker-session" as const, aggregateId: row.worker_id, generation: Number(row.worker_session_generation), messageId: row.message_id },
        createdAt: row.first_created_at ?? now()
      };
    });
  }

  loadPrimaryWorkerActivity(promptId: string, generation: number): PrimaryWorkerActivitySummary[] {
    const run = this.dependencies.loadRunCard(promptId);
    const binding = run ? this.dependencies.getBinding(run.bindingId) : null;
    if (!run || run.bindingGeneration !== generation || !binding || binding.generation !== generation || !binding.paneId) return [];
    const rows = this.database.prepare(`
      WITH ranked_activity AS (
        SELECT c.instance_id, c.worker_session_generation, c.worker_name, c.phase, c.request_text, c.turn_id, c.instance_generation, c.message_id, c.updated_at,
          COUNT(*) OVER (PARTITION BY c.instance_id, c.worker_session_generation) AS task_count,
          ROW_NUMBER() OVER (PARTITION BY c.instance_id, c.worker_session_generation ORDER BY c.updated_at DESC, c.turn_id) AS activity_rank
        FROM instance_turns t INDEXED BY instance_turns_primary_source
        JOIN worker_turn_cards c ON c.turn_id = t.id
        JOIN agent_instances worker ON worker.id = c.instance_id
        WHERE t.actor_kind = 'thread-primary' AND t.source_parent_prompt_id = ? AND t.source_binding_id = ? AND t.source_binding_generation = ?
          AND worker.role = 'worker' AND worker.parent_binding_id = ? AND worker.parent_binding_generation = ? AND worker.parent_pane_id = ?
          AND worker.worker_session_generation = c.worker_session_generation
      )
      SELECT * FROM ranked_activity WHERE activity_rank = 1 ORDER BY updated_at DESC, turn_id
    `).all(promptId, run.bindingId, generation, run.bindingId, generation, binding.paneId) as unknown as PrimaryWorkerActivityRow[];
    return rows.map((row) => ({
      workerId: row.instance_id, workerSessionGeneration: Number(row.worker_session_generation), name: row.worker_name,
      latestPhase: row.phase as WorkerTurnCardView["phase"], taskCount: Number(row.task_count), latestTaskTitle: summarizeTaskTitle(row.request_text),
      latestTaskCard: { aggregateKind: "worker-turn", aggregateId: row.turn_id, generation: Number(row.instance_generation), messageId: row.message_id }, updatedAt: row.updated_at
    }));
  }

  private markStale(invalidation: CardContextInvalidation): "stale" { this.markCardContextProjected(invalidation, invalidation.requestedDependencyRevision); return "stale"; }
}

function now(): string { return new Date().toISOString(); }
interface WorkerTaskSummaryRow { turn_id: string; request_text: string; phase: string; started_at: string | null; finished_at: string | null; message_id: string | null; instance_generation: number; updated_at: string; }
interface PrimaryWorkerSummaryRow { worker_id: string; worker_session_generation: number; name: string; observed_state: string; request_text: string | null; phase: string | null; queue_count: number; first_created_at: string | null; message_id: string | null }
interface PrimaryWorkerActivityRow { instance_id: string; worker_session_generation: number; worker_name: string; phase: string; request_text: string; turn_id: string; instance_generation: number; message_id: string | null; updated_at: string; task_count: number }
function summarizeTaskTitle(text: string): string { return text.trim().split(/\r?\n/, 1)[0]!.slice(0, 120) || "Untitled task"; }
function durationSeconds(startedAt: string | null, finishedAt: string | null): number | null { const start = startedAt ? Date.parse(startedAt) : NaN; const finish = Date.parse(finishedAt ?? now()); return Number.isFinite(start) && Number.isFinite(finish) ? Math.max(0, Math.floor((finish - start) / 1_000)) : null; }
function mapCardContextInvalidation(row: Record<string, unknown>): CardContextInvalidation { return { targetKind: String(row.target_kind) as CardContextInvalidation["targetKind"], targetId: String(row.target_id), targetGeneration: Number(row.target_generation), requestedDependencyRevision: Number(row.requested_dependency_revision), projectedDependencyRevision: Number(row.projected_dependency_revision), reason: String(row.reason), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
