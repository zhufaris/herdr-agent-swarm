import type {
  InstanceEventKind,
  InstanceTurn,
  InstanceTurnState,
} from "../../../domain/instance-turn.js";
import type {
  TransitionInstanceTurnWithProjectionInput,
  TransitionInstanceTurnWithProjectionResult,
} from "../../../domain/ports.js";
import { matchesExpectedWorkerRuntimeTurn } from "../../../domain/worker-turn-policies.js";
import {
  reduceWorkerTurnCard,
  type WorkerTurnCardView,
} from "../../../domain/worker-turn-card-view.js";
import type { SqliteContext } from "../context.js";
import type { WorkerHumanReview } from "./human-review.js";
import type { WorkerCompletionActionEligibility } from "./completion-action-eligibility.js";
import type { WorkerTurnProjection } from "./projection.js";
import type { WorkerTurnQueue } from "./queue.js";
import { mapInstanceTurn } from "./records.js";
import { normalizeAndPersistCompletionChoice } from "../completion-choice-store.js";

export class WorkerTurnTransition {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      projection: WorkerTurnProjection;
      queue: WorkerTurnQueue;
      humanReview: WorkerHumanReview;
      completionActionEligibility: WorkerCompletionActionEligibility;
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
    },
  ) {}
  applyProjection(input: {
    turnId: string;
    expectedGeneration: number;
    expectedRuntimeTurnId?: string;
    expectedRuntimeTurnStartedAt?: string;
    change: Parameters<typeof reduceWorkerTurnCard>[1];
  }): WorkerTurnCardView | null {
    const turn = this.byId(input.turnId);
    const current = this.dependencies.projection.load(input.turnId);
    if (
      !turn ||
      !current ||
      turn.instanceGeneration !== input.expectedGeneration ||
      !matchesExpectedWorkerRuntimeTurn(turn, input)
    )
      return null;
    const next = reduceWorkerTurnCard(current, input.change);
    if (next !== current) {
      this.dependencies.projection.save(next);
      this.dependencies.invalidateWorkerCardContexts(
        next,
        `turn.${next.phase}`,
      );
    }
    return next;
  }
  transition(
    input: TransitionInstanceTurnWithProjectionInput,
  ): TransitionInstanceTurnWithProjectionResult | null {
    const timestamp = now();
    const current = this.byId(input.turnId);
    const currentView = this.dependencies.projection.load(input.turnId);
    if (
      !current ||
      !currentView ||
      current.instanceGeneration !== input.expectedGeneration ||
      !matchesExpectedWorkerRuntimeTurn(current, input)
    )
      return null;
    let change = input.change;
    let result = input.result;
    if (input.state === "completed" && change.type === "completed") {
      const normalized = normalizeAndPersistCompletionChoice({
        context: this.context,
        ownerKind: "worker-turn",
        ownerId: input.turnId,
        ownerGeneration: currentView.workerSessionGeneration,
        answer: change.answer,
        ...(input.completionChoice ? { completionChoice: input.completionChoice } : {}),
        occurredAt: timestamp
      });
      result = normalized.answer;
      change = { ...change, answer: normalized.answer };
    }
    const changed = this.context.database
      .prepare(
        "UPDATE instance_turns SET state = ?, result = ?, error = ?, updated_at = ? WHERE id = ? AND instance_generation = ? AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.id = instance_turns.instance_id AND i.generation = ?)",
      )
      .run(
        input.state,
        result ?? null,
        input.error ?? null,
        timestamp,
        input.turnId,
        input.expectedGeneration,
        input.expectedGeneration,
      );
    if (changed.changes !== 1) return null;
    const blockedEpisode =
      input.state === "blocked" && current.state !== "blocked";
    const eventId =
      blockedEpisode || input.state !== "blocked"
        ? this.dependencies.insertInstanceEvent(
            current.projectId,
            current.instanceId,
            current.id,
            input.eventKind,
            { state: input.state },
          )
        : null;
    const next = reduceWorkerTurnCard(currentView, change);
    const projectionChanged = next !== currentView;
    if (projectionChanged) {
      this.dependencies.projection.save(next);
      this.dependencies.invalidateWorkerCardContexts(
        next,
        `turn.${next.phase}`,
      );
    }
    if (["completed", "failed", "cancelled"].includes(input.state))
      this.dependencies.queue.repairTerminalPositions(
        current.instanceId,
        input.expectedGeneration,
        timestamp,
      );
    let notification: TransitionInstanceTurnWithProjectionResult["notification"] =
      { outcome: "skipped", reason: "not-blocked-transition" };
    if (input.renderHumanReviewNotification && (input.state === "blocked" || current.state === "blocked"))
      notification = this.dependencies.humanReview.project({
        turn: current,
        view: next,
        state: input.state,
        eventId,
        render: input.renderHumanReviewNotification,
      });
    let completionActionEligibility: TransitionInstanceTurnWithProjectionResult["completionActionEligibility"] =
      { outcome: "skipped", reason: "not-completion" };
    if (input.state === "completed" && current.state !== "completed") {
      completionActionEligibility = this.dependencies.completionActionEligibility.defer({ turn: current, view: next, occurredAt: timestamp });
    }
    const turn = this.byId(input.turnId);
    return turn ? { turn, view: next, projectionChanged, notification, completionActionEligibility } : null;
  }
  update(input: {
    turnId: string;
    expectedGeneration: number;
    expectedRuntimeTurnId?: string;
    expectedRuntimeTurnStartedAt?: string;
    state: InstanceTurnState;
    result?: string | null;
    error?: string | null;
    eventKind: InstanceEventKind;
  }): InstanceTurn | null {
    const current = this.byId(input.turnId);
    if (
      !current ||
      current.instanceGeneration !== input.expectedGeneration ||
      !matchesExpectedWorkerRuntimeTurn(current, input)
    )
      return null;
    if (
      this.context.database
        .prepare(
          "UPDATE instance_turns SET state = ?, result = ?, error = ?, updated_at = ? WHERE id = ? AND instance_generation = ? AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.id = instance_turns.instance_id AND i.generation = ?)",
        )
        .run(
          input.state,
          input.result ?? null,
          input.error ?? null,
          now(),
          input.turnId,
          input.expectedGeneration,
          input.expectedGeneration,
        ).changes !== 1
    )
      return null;
    this.dependencies.insertInstanceEvent(
      current.projectId,
      current.instanceId,
      current.id,
      input.eventKind,
      { state: input.state },
    );
    return this.byId(input.turnId);
  }
  private byId(id: string): InstanceTurn | null {
    return mapInstanceTurn(
      this.context.database
        .prepare("SELECT * FROM instance_turns WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined,
    );
  }
}
function now(): string {
  return new Date().toISOString();
}
