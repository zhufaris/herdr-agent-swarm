import type { Binding } from "../../domain/binding.js";
import type { CompletionActionEligibilityReservation } from "../../domain/completion-action-eligibility.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { loadCompletionChoice } from "./completion-choice-store.js";
import type { SqliteContext } from "./context.js";

export class PrimaryCompletionActionEligibility {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getBinding(id: string): Binding | null;
      loadRunCard(promptId: string): RunCardView | null;
    }
  ) {}

  defer(input: { bindingId: string; promptId: string; occurredAt: string }): CompletionActionEligibilityReservation {
    const binding = this.dependencies.getBinding(input.bindingId);
    const view = this.dependencies.loadRunCard(input.promptId);
    if (!binding || !view || view.bindingId !== binding.id || view.bindingGeneration !== binding.generation) {
      return { outcome: "skipped", reason: "stale-routing" };
    }
    if (!loadCompletionChoice(this.context, "primary-prompt", input.promptId, view.bindingGeneration)) {
      return { outcome: "skipped", reason: "no-review-choice" };
    }
    this.context.database.prepare(`INSERT OR IGNORE INTO completion_notification_obligations(
      owner_kind, owner_id, owner_generation, binding_id, binding_generation, required_view_version,
      state, notification_reply_id, created_at, updated_at, released_at
    ) VALUES ('primary-prompt', ?, ?, ?, ?, ?, 'waiting_for_answer', NULL, ?, ?, NULL)`).run(
      input.promptId, view.bindingGeneration, binding.id, binding.generation, view.viewVersion,
      input.occurredAt, input.occurredAt
    );
    return { outcome: "deferred" };
  }
}
