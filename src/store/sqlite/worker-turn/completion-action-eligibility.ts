import type { AgentInstance } from "../../../domain/agent-instance.js";
import type { Binding } from "../../../domain/binding.js";
import type { CompletionActionEligibilityReservation } from "../../../domain/completion-action-eligibility.js";
import type { InstanceTurn } from "../../../domain/instance-turn.js";
import { decideWorkerHumanReviewRoute } from "../../../domain/worker-turn-policies.js";
import type { WorkerTurnCardView } from "../../../domain/worker-turn-card-view.js";
import { loadCompletionChoice } from "../completion-choice-store.js";
import type { SqliteContext } from "../context.js";

export class WorkerCompletionActionEligibility {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getAgentInstance(id: string): AgentInstance | null;
      getBinding(id: string): Binding | null;
    },
  ) {}

  defer(input: { turn: InstanceTurn; view: WorkerTurnCardView; occurredAt: string }): CompletionActionEligibilityReservation {
    const instance = this.dependencies.getAgentInstance(input.turn.instanceId);
    const parent = instance?.parent;
    const binding = parent ? this.dependencies.getBinding(parent.bindingId) : null;
    if (
      decideWorkerHumanReviewRoute({ instance, binding, turn: input.turn, view: input.view }) === "stale" ||
      !instance ||
      !parent ||
      !binding?.rootMessageId || !instance.runtimeRef
    ) return { outcome: "skipped", reason: "stale-routing" };
    if (!loadCompletionChoice(this.context, "worker-turn", input.turn.id, input.view.workerSessionGeneration)) {
      return { outcome: "skipped", reason: "no-review-choice" };
    }
    this.context.database.prepare(`INSERT OR IGNORE INTO completion_notification_obligations(
      owner_kind, owner_id, owner_generation, binding_id, binding_generation, required_view_version,
      state, notification_reply_id, created_at, updated_at, released_at
    ) VALUES ('worker-turn', ?, ?, ?, ?, ?, 'waiting_for_answer', NULL, ?, ?, NULL)`).run(
      input.turn.id, input.view.workerSessionGeneration, binding.id, binding.generation,
      input.view.viewVersion, input.occurredAt, input.occurredAt
    );
    return { outcome: "deferred" };
  }
}
