import { randomUUID } from "node:crypto";
import type { AgentInstance, WorkspaceLease } from "../../domain/agent-instance.js";
import type { CardContextInvalidation, CardContextTarget } from "../../domain/card-context-invalidation.js";
import { selectPrimaryWorkerActivity, selectPrimaryWorkerSummaries, type PrimaryWorkerActivitySummary, type PrimaryWorkerSummary } from "../../domain/card-context-summary.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { updateRunCardWorkerContext } from "../../domain/run-card-view.js";
import type { TopicViewState } from "../../domain/topic-view.js";
import { updateTopicWorkerContext } from "../../domain/topic-view.js";
import { selectWorkerMainView, type WorkerMainProjectionSource } from "../../domain/worker-main-selector.js";
import type { WorkerMainView } from "../../domain/worker-main-view.js";
import { updateWorkerTurnCardTargets, type WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import type { Binding, MainCardReservationOutcome } from "../../domain/types.js";
import type { SqliteContext } from "./context.js";
import { mapWorkerTurnCard } from "./worker-turn-store.js";

export interface SqliteCardContextStoreDependencies {
  getAgentInstance(id: string): AgentInstance | null;
  getWorkspaceLease(id: string): WorkspaceLease | null;
  getBinding(id: string): Binding | null;
  listWorkerInstancesByParent(input: { bindingId: string; paneId: string }): AgentInstance[];
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
  saveWorkerTurnCard(view: WorkerTurnCardView): void;
  loadTopicView(bindingId: string): TopicViewState | null;
  saveTopicView(view: TopicViewState): void;
  loadRunCard(promptId: string): RunCardView | null;
  saveRunCard(view: RunCardView): RunCardView;
  reserveMainCard(view: TopicViewState, rootMessageId: string | null, card: object): MainCardReservationOutcome;
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): unknown;
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
      { targetKind: "worker-turn", targetId: view.turnId, targetGeneration: view.instanceGeneration, reason },
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

  projectCardContext(invalidation: CardContextInvalidation, renderers: { workerMain(view: WorkerMainView): object; workerTask(view: WorkerTurnCardView): object; primaryMain(view: TopicViewState): object; primaryAnswer(view: RunCardView): object }): "reserved" | "current" | "stale" {
    return this.context.transaction(() => {
      const current = this.loadCardContextInvalidation(invalidation);
      if (!current || current.projectedDependencyRevision >= invalidation.requestedDependencyRevision) return "current";
      let reserved = false;
      if (invalidation.targetKind === "worker-session") {
        const source = this.loadWorkerMainProjectionSource(invalidation.targetId, invalidation.targetGeneration);
        if (!source) return this.markStale(invalidation);
        const previous = this.loadWorkerMainView(invalidation.targetId, invalidation.targetGeneration);
        const next = selectWorkerMainView(source, previous, invalidation.requestedDependencyRevision, now());
        const binding = this.dependencies.getBinding(source.parentBindingId);
        if (!binding?.rootMessageId) return this.markStale(invalidation);
        if (next !== previous || next.viewVersion > next.deliveredVersion) { this.reserveWorkerMainCard(next, binding.rootMessageId, renderers.workerMain(next)); reserved = next.viewVersion > next.deliveredVersion; }
      } else if (invalidation.targetKind === "worker-turn") {
        const previous = this.dependencies.loadWorkerTurnCard(invalidation.targetId);
        if (!previous || previous.instanceGeneration !== invalidation.targetGeneration) return this.markStale(invalidation);
        const main = this.loadWorkerMainView(previous.instanceId, previous.workerSessionGeneration);
        const answer = previous.primaryAnswer ? this.dependencies.loadRunCard(previous.primaryAnswer.aggregateId) : null;
        const next = updateWorkerTurnCardTargets(previous, { ...previous.workerMain, messageId: main?.messageId ?? null }, previous.primaryAnswer ? { ...previous.primaryAnswer, messageId: answer?.answerMessageId ?? null } : null, now());
        if (next !== previous) this.dependencies.saveWorkerTurnCard(next);
        if (next.messageId && next.viewVersion > next.deliveredVersion) {
          this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-turn:update:${next.turnId}:${next.viewVersion}`, bindingId: null, workerTurnId: next.turnId, viewVersion: next.viewVersion, rootMessageId: next.messageId, kind: "card_update", payload: JSON.stringify(renderers.workerTask(next)) });
          reserved = true;
        }
      } else if (invalidation.targetKind === "primary-session") {
        const binding = this.dependencies.getBinding(invalidation.targetId);
        const previous = this.dependencies.loadTopicView(invalidation.targetId);
        if (!binding || binding.generation !== invalidation.targetGeneration || !previous || !binding.rootMessageId) return this.markStale(invalidation);
        const selected = selectPrimaryWorkerSummaries(this.loadPrimaryWorkerSummaries(binding.id, binding.generation));
        const next = updateTopicWorkerContext(previous, selected.workers, selected.overflowCount, invalidation.requestedDependencyRevision);
        this.dependencies.saveTopicView(next);
        reserved = this.dependencies.reserveMainCard(next, binding.rootMessageId, renderers.primaryMain(next)) === "reserved";
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
    const active = this.database.prepare(`SELECT ${summaryColumns} FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase IN ('blocked','running','preparing','queued') ORDER BY CASE phase WHEN 'blocked' THEN 0 WHEN 'running' THEN 1 WHEN 'preparing' THEN 2 ELSE 3 END, CASE WHEN phase = 'queued' THEN created_at END ASC, CASE WHEN phase != 'queued' THEN created_at END DESC, CASE WHEN phase = 'queued' THEN turn_id END ASC, CASE WHEN phase != 'queued' THEN turn_id END DESC LIMIT 1`).get(workerId, generation) as unknown as WorkerTaskSummaryRow | undefined;
    const queue = this.database.prepare("SELECT COUNT(*) AS count, MIN(created_at) AS first_created_at FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase = 'queued'").get(workerId, generation) as { count: number; first_created_at: string | null };
    const nextQueued = queue.first_created_at === null ? undefined : this.database.prepare("SELECT request_text FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase = 'queued' ORDER BY created_at, turn_id LIMIT 1").get(workerId, generation) as { request_text: string } | undefined;
    const recent = this.database.prepare(`SELECT ${summaryColumns} FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase IN ('completed','failed','cancelled','dispatch-uncertain') ORDER BY created_at DESC, turn_id DESC LIMIT 5`).all(workerId, generation) as unknown as WorkerTaskSummaryRow[];
    const first = this.database.prepare("SELECT MIN(created_at) AS created_at FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ?").get(workerId, generation) as { created_at: string | null };
    const summary = (row: WorkerTaskSummaryRow) => ({ turnId: row.turn_id, title: summarizeTaskTitle(row.request_text), phase: row.phase as WorkerTurnCardView["phase"], durationSeconds: durationSeconds(row.started_at, row.finished_at), taskCard: { aggregateKind: "worker-turn" as const, aggregateId: row.turn_id, generation: Number(row.instance_generation), messageId: row.message_id }, updatedAt: row.updated_at });
    return {
      workerId, workerSessionGeneration: generation, workerName: instance.name, model: instance.model, runtimeGeneration: instance.generation, runtimeState: instance.observedState, paneId: instance.runtimeRef?.paneId ?? null,
      runtimeAttached: instance.runtimeRef !== null, desiredState: instance.desiredState, parentActive: (() => { const parent = this.dependencies.getBinding(instance.parent.bindingId); return parent?.generation === instance.parent!.bindingGeneration && parent.paneId === instance.parent!.paneId && parent.state === "active" && parent.lifecycle === "active" && parent.attachment === "attached"; })(),
      lifecycle: instance.workerSessionLifecycle ?? "legacy", parentBindingId: instance.parent.bindingId, parentBindingGeneration: instance.parent.bindingGeneration, parentPaneId: instance.parent.paneId, ownerName: this.dependencies.getBinding(instance.parent.bindingId)?.title ?? "Primary",
      workspace: lease.cwd, branch: lease.branch, currentTask: active ? summary(active) : null, queueCount: Number(queue.count), nextTaskTitle: nextQueued ? summarizeTaskTitle(nextQueued.request_text) : null,
      recentTasks: recent.map(summary), createdAt: first.created_at ?? now()
    };
  }

  loadPrimaryWorkerSummaries(bindingId: string, generation: number): PrimaryWorkerSummary[] {
    const binding = this.dependencies.getBinding(bindingId);
    if (!binding || binding.generation !== generation || !binding.paneId) return [];
    return this.dependencies.listWorkerInstancesByParent({ bindingId, paneId: binding.paneId }).filter((worker) => worker.parent?.bindingGeneration === generation).flatMap((worker) => {
      const source = this.loadWorkerMainProjectionSource(worker.id, worker.workerSessionGeneration ?? 1);
      const main = this.loadWorkerMainView(worker.id, worker.workerSessionGeneration ?? 1);
      if (!source) return [];
      const state = source.currentTask?.phase === "blocked" ? "blocked" as const : source.currentTask?.phase === "running" || source.currentTask?.phase === "preparing" ? "working" as const : source.currentTask?.phase === "queued" || (worker.observedState === "idle" && source.queueCount > 0) ? "queued" as const : worker.observedState;
      return [{ workerId: worker.id, workerSessionGeneration: worker.workerSessionGeneration ?? 1, name: worker.name, state, currentTaskTitle: source.currentTask?.title ?? null, queueCount: source.queueCount, workerMain: { aggregateKind: "worker-session" as const, aggregateId: worker.id, generation: worker.workerSessionGeneration ?? 1, messageId: main?.messageId ?? null }, createdAt: source.createdAt }];
    });
  }

  loadPrimaryWorkerActivity(promptId: string, generation: number): PrimaryWorkerActivitySummary[] {
    const run = this.dependencies.loadRunCard(promptId);
    const binding = run ? this.dependencies.getBinding(run.bindingId) : null;
    if (!run || run.bindingGeneration !== generation || !binding || binding.generation !== generation || !binding.paneId) return [];
    const rows = this.database.prepare(`SELECT c.* FROM instance_turns t INDEXED BY instance_turns_primary_source JOIN worker_turn_cards c ON c.turn_id = t.id JOIN agent_instances worker ON worker.id = c.instance_id WHERE t.actor_kind = 'thread-primary' AND t.source_parent_prompt_id = ? AND t.source_binding_id = ? AND t.source_binding_generation = ? AND worker.role = 'worker' AND worker.parent_binding_id = ? AND worker.parent_binding_generation = ? AND worker.parent_pane_id = ? AND worker.worker_session_generation = c.worker_session_generation ORDER BY c.updated_at DESC, c.turn_id`).all(promptId, run.bindingId, generation, run.bindingId, generation, binding.paneId) as Array<Record<string, unknown>>;
    const grouped = new Map<string, WorkerTurnCardView[]>();
    for (const row of rows) { const view = mapWorkerTurnCard(row); if (view) grouped.set(`${view.instanceId}:${view.workerSessionGeneration}`, [...(grouped.get(`${view.instanceId}:${view.workerSessionGeneration}`) ?? []), view]); }
    return [...grouped.values()].map((cards) => { const latest = cards[0]!; return { workerId: latest.instanceId, workerSessionGeneration: latest.workerSessionGeneration, name: latest.workerName, latestPhase: latest.phase, taskCount: cards.length, latestTaskTitle: summarizeTaskTitle(latest.requestText), latestTaskCard: { aggregateKind: "worker-turn", aggregateId: latest.turnId, generation: latest.instanceGeneration, messageId: latest.messageId }, updatedAt: latest.updatedAt }; });
  }

  private markStale(invalidation: CardContextInvalidation): "stale" { this.markCardContextProjected(invalidation, invalidation.requestedDependencyRevision); return "stale"; }
}

function now(): string { return new Date().toISOString(); }
interface WorkerTaskSummaryRow { turn_id: string; request_text: string; phase: string; started_at: string | null; finished_at: string | null; message_id: string | null; instance_generation: number; updated_at: string; }
function summarizeTaskTitle(text: string): string { return text.trim().split(/\r?\n/, 1)[0]!.slice(0, 120) || "Untitled task"; }
function durationSeconds(startedAt: string | null, finishedAt: string | null): number | null { const start = startedAt ? Date.parse(startedAt) : NaN; const finish = Date.parse(finishedAt ?? now()); return Number.isFinite(start) && Number.isFinite(finish) ? Math.max(0, Math.floor((finish - start) / 1_000)) : null; }
function mapCardContextInvalidation(row: Record<string, unknown>): CardContextInvalidation { return { targetKind: String(row.target_kind) as CardContextInvalidation["targetKind"], targetId: String(row.target_id), targetGeneration: Number(row.target_generation), requestedDependencyRevision: Number(row.requested_dependency_revision), projectedDependencyRevision: Number(row.projected_dependency_revision), reason: String(row.reason), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
