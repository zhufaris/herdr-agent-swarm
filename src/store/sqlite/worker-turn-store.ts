import type { AgentInstance } from "../../domain/agent-instance.js";
import type { Binding } from "../../domain/binding.js";
import type { ControlActor } from "../../domain/commands.js";
import type {
  InstanceEvent,
  InstanceEventKind,
  InstanceTurn,
  InstanceTurnState,
  InstanceTurnSummary,
} from "../../domain/instance-turn.js";
import type {
  AcceptInstanceTurnWithCardInput,
  TransitionInstanceTurnWithProjectionInput,
  TransitionInstanceTurnWithProjectionResult,
} from "../../domain/ports.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { AnswerTimelineItem } from "../../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../../domain/delivery.js";
import type {
  AnswerPageDeliveryFacts,
  AnswerPageReservationOutcome,
  AnswerTimelinePageCheckpoint,
} from "../../domain/types.js";
import type {
  WorkerTurnCardChange,
  WorkerTurnCardPage,
  WorkerTurnCardView,
} from "../../domain/worker-turn-card-view.js";
import { matchesExpectedWorkerRuntimeTurn } from "../../domain/worker-turn-policies.js";
import type { SqliteContext } from "./context.js";
import { WorkerTurnAcceptance } from "./worker-turn/acceptance.js";
import { WorkerHumanReview } from "./worker-turn/human-review.js";
import { WorkerTurnProjection } from "./worker-turn/projection.js";
import { WorkerTurnQueue } from "./worker-turn/queue.js";
import { WorkerTurnRecovery } from "./worker-turn/recovery.js";
import { mapInstanceTurn, mapWorkerTurnCard } from "./worker-turn/records.js";
import { WorkerTurnTransition } from "./worker-turn/transition.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";

export interface WorkerTurnStoreDependencies {
  getAgentInstance(id: string): AgentInstance | null;
  getBinding(id: string): Binding | null;
  enqueueOutboundReply(input: EnqueueOutboundReplyInput): unknown;
  invalidateWorkerCardContexts(view: WorkerTurnCardView, reason: string): void;
  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean;
}

export class SqliteWorkerTurnStore {
  private readonly projection: WorkerTurnProjection;
  private readonly queue: WorkerTurnQueue;
  private readonly acceptance: WorkerTurnAcceptance;
  private readonly transition: WorkerTurnTransition;
  private readonly recovery: WorkerTurnRecovery;
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: WorkerTurnStoreDependencies,
  ) {
    this.projection = new WorkerTurnProjection(context, dependencies);
    const event = this.insertInstanceEvent.bind(this);
    this.queue = new WorkerTurnQueue(context, {
      getAgentInstance: dependencies.getAgentInstance,
      saveWorkerTurnCard: (view) => this.projection.save(view),
      invalidateWorkerCardContexts: dependencies.invalidateWorkerCardContexts,
      insertInstanceEvent: event,
    });
    this.acceptance = new WorkerTurnAcceptance(context, {
      ...dependencies,
      queue: this.queue,
      projection: this.projection,
      insertInstanceEvent: event,
    });
    const humanReview = new WorkerHumanReview(dependencies);
    this.transition = new WorkerTurnTransition(context, {
      projection: this.projection,
      queue: this.queue,
      humanReview,
      invalidateWorkerCardContexts: dependencies.invalidateWorkerCardContexts,
      insertInstanceEvent: event,
    });
    this.recovery = new WorkerTurnRecovery(context, {
      projection: this.projection,
      insertInstanceEvent: event,
    });
  }
  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean {
    return this.dependencies.hasPendingOutboundReplyForWorkerTurn(turnId);
  }
  acceptInstanceTurn(input: {
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
  }): { turn: InstanceTurn; inserted: boolean } {
    return this.context.transaction(() => this.acceptance.accept(input));
  }
  acceptInstanceTurnWithCard(
    input: AcceptInstanceTurnWithCardInput & { maxQueueDepth?: number },
  ): { turn: InstanceTurn; view: WorkerTurnCardView; inserted: boolean } {
    return this.context.transaction(() =>
      this.acceptance.acceptWithCard(input),
    );
  }
  getInstanceTurn(id: string): InstanceTurn | null {
    return mapInstanceTurn(
      this.context.database
        .prepare("SELECT * FROM instance_turns WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined,
    );
  }
  claimInstanceTurnTranscript(input: {
    turnId: string;
    expectedGeneration: number;
    runtimeTurnId: string;
    startedAt: string;
  }): InstanceTurn | null {
    if (!input.runtimeTurnId || !Number.isFinite(Date.parse(input.startedAt)))
      return null;
    return this.context.transaction(() => {
      const current = this.getInstanceTurn(input.turnId);
      if (
        !current ||
        current.instanceGeneration !== input.expectedGeneration ||
        !["dispatching", "running", "blocked", "dispatch-uncertain"].includes(
          current.state,
        )
      )
        return null;
      if (
        current.runtimeTurnId !== null ||
        current.runtimeTurnStartedAt !== null
      )
        return current.runtimeTurnId === input.runtimeTurnId &&
          current.runtimeTurnStartedAt === input.startedAt
          ? current
          : null;
      const changed = this.context.database
        .prepare(
          `UPDATE instance_turns SET runtime_turn_id = ?, runtime_turn_started_at = ?, updated_at = ? WHERE id = ? AND instance_generation = ? AND runtime_turn_id IS NULL AND runtime_turn_started_at IS NULL AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.id = instance_turns.instance_id AND i.generation = ? AND i.pane_id IS NOT NULL)`,
        )
        .run(
          input.runtimeTurnId,
          input.startedAt,
          now(),
          input.turnId,
          input.expectedGeneration,
          input.expectedGeneration,
        );
      if (changed.changes === 1)
        this.insertInstanceEvent(
          current.projectId,
          current.instanceId,
          current.id,
          "turn.transcript-owned",
          { runtimeTurnId: input.runtimeTurnId, startedAt: input.startedAt },
        );
      return changed.changes === 1 ? this.getInstanceTurn(input.turnId) : null;
    });
  }
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null {
    return this.projection.load(turnId);
  }
  findWorkerTurnByCardMessage(
    messageId: string,
  ): { turn: InstanceTurn; view: WorkerTurnCardView } | null {
    const id = this.projection.findTurnIdByMessage(messageId);
    if (!id) return null;
    const turn = this.getInstanceTurn(id);
    const view = this.projection.load(id);
    return turn && view ? { turn, view } : null;
  }
  listWorkerTurnCardPages(turnId: string): WorkerTurnCardPage[] {
    return this.projection.listPages(turnId);
  }
  listActionableWorkerTurnCardIds(): string[] {
    return this.projection.listActionableIds();
  }
  getWorkerTurnCardDeliveryFacts(
    turnId: string,
    pageIndex: number,
  ): AnswerPageDeliveryFacts {
    return this.projection.getDeliveryFacts(turnId, pageIndex);
  }
  getWorkerAnswerTimelinePage(
    turnId: string,
    pageIndex: number,
  ): AnswerTimelinePageCheckpoint {
    return this.projection.getTimelinePage(turnId, pageIndex);
  }
  listFrozenWorkerAnswerTimelineItems(turnId: string, beforePageIndex: number) {
    return this.projection.listFrozenTimelineItems(turnId, beforePageIndex);
  }
  reserveWorkerAnswerTimelineCard(input: {
    turnId: string;
    pageIndex: number;
    messageId: string;
    card: object;
    cursor: AnswerTimelineCursor | null;
    items: readonly AnswerTimelineItem[];
  }): AnswerPageReservationOutcome {
    return this.context.transaction(() =>
      this.projection.reserveTimelineCard(input),
    );
  }
  reserveWorkerRichTextUpdate(input: Parameters<WorkerTurnProjection["reserveRichTextUpdate"]>[0]): AnswerPageReservationOutcome {
    return this.context.transaction(() => this.projection.reserveRichTextUpdate(input));
  }
  reserveWorkerRichTextContinuation(input: Parameters<WorkerTurnProjection["reserveRichTextContinuation"]>[0]): AnswerPageReservationOutcome {
    return this.context.transaction(() => this.projection.reserveRichTextContinuation(input));
  }
  reserveWorkerTurnContent(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    elementId: string;
    content: string;
    sourceEnd: number;
    timelineCursor?: AnswerTimelineCursor | null;
    timelineItems?: readonly AnswerTimelineItem[];
  }): AnswerPageReservationOutcome {
    return this.context.transaction(() =>
      this.projection.reserveContent(input),
    );
  }
  reserveWorkerTurnFinish(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    summary: string;
  }): AnswerPageReservationOutcome {
    return this.context.transaction(() => this.projection.reserveFinish(input));
  }
  reserveWorkerTurnCardHydration(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    messageId: string;
    card: object;
  }): AnswerPageReservationOutcome {
    return this.context.transaction(() =>
      this.projection.reserveHydration(input),
    );
  }
  reserveWorkerTurnContinuation(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    summary: string;
    nextPageIndex: number;
    nextPageStart: number;
    nextElementId: string;
    rootMessageId: string;
    viewVersion: number;
    card: object;
    timelineStartCursor?: AnswerTimelineCursor;
    timelineEndCursor?: AnswerTimelineCursor | null;
    timelineItems?: readonly AnswerTimelineItem[];
  }): AnswerPageReservationOutcome {
    return this.context.transaction(() =>
      this.projection.reserveContinuation(input),
    );
  }
  applyInstanceTurnProjection(input: {
    turnId: string;
    expectedGeneration: number;
    expectedRuntimeTurnId?: string;
    expectedRuntimeTurnStartedAt?: string;
    change: WorkerTurnCardChange;
    render(view: WorkerTurnCardView): object;
  }): WorkerTurnCardView | null {
    return this.context.transaction(() =>
      this.transition.applyProjection(input),
    );
  }
  transitionInstanceTurnWithProjection(
    input: TransitionInstanceTurnWithProjectionInput,
  ): TransitionInstanceTurnWithProjectionResult | null {
    return this.context.transaction(() => this.transition.transition(input));
  }
  saveWorkerTurnCard(view: WorkerTurnCardView): void {
    this.context.transaction(() => this.projection.save(view));
  }
  listInstanceTurns(
    instanceId: string,
    options: { limit?: number; after?: { createdAt: string; id: string } } = {},
  ): {
    items: InstanceTurn[];
    nextCursor: { createdAt: string; id: string } | null;
  } {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const rows = (
      options.after
        ? this.context.database
            .prepare(
              "SELECT * FROM instance_turns WHERE instance_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?",
            )
            .all(
              instanceId,
              options.after.createdAt,
              options.after.createdAt,
              options.after.id,
              limit + 1,
            )
        : this.context.database
            .prepare(
              "SELECT * FROM instance_turns WHERE instance_id = ? ORDER BY created_at, id LIMIT ?",
            )
            .all(instanceId, limit + 1)
    ) as Array<Record<string, unknown>>;
    const items = rows.slice(0, limit).map((row) => mapInstanceTurn(row)!);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }
  listRecentInstanceTurnSummaries(
    instanceId: string,
    requestedLimit = 5,
  ): InstanceTurnSummary[] {
    const limit = Math.max(1, Math.min(requestedLimit, 5));
    return (
      this.context.database
        .prepare(
          `SELECT t.*, COALESCE(c.result_capture, CASE WHEN t.result IS NOT NULL THEN 'captured' ELSE 'pending' END) AS result_capture FROM instance_turns t LEFT JOIN worker_turn_cards c ON c.turn_id = t.id WHERE t.instance_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
        )
        .all(instanceId, limit) as Array<Record<string, unknown>>
    ).map((row) => ({
      ...mapInstanceTurn(row)!,
      resultCapture: String(
        row.result_capture,
      ) as InstanceTurnSummary["resultCapture"],
    }));
  }
  getActiveInstanceTurn(
    instanceId: string,
    expectedGeneration: number,
  ): InstanceTurn | null {
    return this.queue.getActive(instanceId, expectedGeneration);
  }
  claimNextInstanceTurn(
    instanceId: string,
    expectedGeneration: number,
  ): InstanceTurn | null {
    return this.context.transaction(() =>
      this.queue.claimNext(instanceId, expectedGeneration),
    );
  }
  recoverInterruptedInstanceTurns(): {
    requeuedTurnIds: string[];
    cancelledLegacyTurnIds: string[];
    observableTurns: InstanceTurn[];
  } {
    return this.context.transaction(() => this.recovery.recover());
  }
  listObservableInstanceTurns(): InstanceTurn[] {
    return this.recovery.listObservable();
  }
  listObservableInstanceTurnsByPaneIds(
    paneIds: readonly string[],
  ): InstanceTurn[] {
    return this.recovery.listObservableByPaneIds(paneIds);
  }
  getInstanceTurnDiagnostics(): {
    queuedTurns: number;
    activeTurns: number;
    uncertainTurns: number;
  } {
    return this.recovery.diagnostics();
  }
  updateInstanceTurn(input: {
    turnId: string;
    expectedGeneration: number;
    expectedRuntimeTurnId?: string;
    expectedRuntimeTurnStartedAt?: string;
    state: InstanceTurnState;
    result?: string | null;
    error?: string | null;
    eventKind: InstanceEventKind;
  }): InstanceTurn | null {
    return this.context.transaction(() => this.transition.update(input));
  }
  completeInstanceTurn(input: {
    turnId: string;
    expectedGeneration: number;
    result: string;
  }): InstanceTurn | null {
    return this.updateInstanceTurn({
      ...input,
      state: "completed",
      eventKind: "turn.completed",
    });
  }
  listInstanceEvents(instanceId: string, afterId = 0): InstanceEvent[] {
    return (
      this.context.database
        .prepare(
          "SELECT * FROM instance_events WHERE instance_id = ? AND id > ? ORDER BY id LIMIT 100",
        )
        .all(instanceId, afterId) as Array<Record<string, unknown>>
    ).map((row) => ({
      id: Number(row.id),
      projectId: String(row.project_id),
      instanceId: String(row.instance_id),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      kind: String(row.kind) as InstanceEventKind,
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    }));
  }
  countPendingInstanceTurns(
    instanceId: string,
    expectedGeneration?: number,
  ): number {
    return this.queue.countPending(instanceId, expectedGeneration);
  }
  private insertInstanceEvent(
    projectId: string,
    instanceId: string,
    turnId: string | null,
    kind: InstanceEventKind,
    payload: Record<string, unknown>,
  ): number {
    const result = this.context.database
      .prepare(
        "INSERT INTO instance_events(project_id, instance_id, turn_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(projectId, instanceId, turnId, kind, JSON.stringify(payload), now());
    return Number(result.lastInsertRowid);
  }
}

export { mapWorkerTurnCard };
function now(): string {
  return new Date().toISOString();
}
