import type {
  ConfirmNaturalLanguageSwarmCommandInput, ConfirmNaturalLanguageSwarmCommandResult, DecideNaturalLanguageCommandConfirmationResult, NaturalLanguageCommandConfirmation,
  StageNaturalLanguageCommandConfirmationInput, StageNaturalLanguageCommandConfirmationResult
} from "../../domain/natural-language-command-confirmation.js";
import { naturalLanguageCommandEnvelopeSchema } from "../../domain/natural-language-command-confirmation.js";
import { mapNaturalLanguageCommandConfirmation, type NaturalLanguageCommandConfirmationRow } from "../sqlite-records.js";
import type { SqliteOutboxStore } from "./outbox-store.js";
import type { SqliteContext } from "./context.js";
import type { SqliteCommandIntentStore } from "./command-intent-store.js";

export class SqliteNaturalLanguageCommandConfirmationStore {
  constructor(private readonly context: SqliteContext, private readonly outbox: SqliteOutboxStore, private readonly commandIntents: SqliteCommandIntentStore) {}

  stageNaturalLanguageCommandConfirmation(input: StageNaturalLanguageCommandConfirmationInput): StageNaturalLanguageCommandConfirmationResult {
    const commandJson = JSON.stringify(naturalLanguageCommandEnvelopeSchema.parse(input.confirmation.envelope));
    return this.context.transaction(() => {
      const prior = this.getBySourceMessageId(input.confirmation.sourceMessageId);
      if (prior) return { outcome: sameRequest(prior, input.confirmation, commandJson) ? "duplicate" : "conflict", confirmation: prior };
      const value = input.confirmation;
      this.context.database.prepare(`
        INSERT INTO natural_language_command_confirmations(
          id, source_message_id, actor_open_id, chat_id, topic_id, root_message_id, command_json, expected_binding_id, expected_binding_generation, expected_instance_id, expected_instance_generation, state, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(value.id, value.sourceMessageId, value.actorOpenId, value.chatId, value.topicId, value.rootMessageId, commandJson, value.expectedBindingId, value.expectedBindingGeneration, value.expectedInstanceId, value.expectedInstanceGeneration, value.expiresAt, value.createdAt, value.createdAt);
      this.outbox.enqueueOutboundReply({ id: input.outbox.id, idempotencyKey: input.outbox.idempotencyKey, bindingId: value.expectedBindingId, targetRole: "operation_result", rootMessageId: value.rootMessageId, kind: "card_reply", payload: JSON.stringify(input.outbox.card) });
      return { outcome: "staged", confirmation: this.require(value.id) };
    });
  }

  getNaturalLanguageCommandConfirmation(id: string): NaturalLanguageCommandConfirmation | null {
    const row = this.context.database.prepare("SELECT * FROM natural_language_command_confirmations WHERE id = ?").get(id) as NaturalLanguageCommandConfirmationRow | undefined;
    return row ? mapNaturalLanguageCommandConfirmation(row) : null;
  }

  decideNaturalLanguageCommandConfirmation(input: { id: string; decision: "confirm" | "cancel"; actorOpenId: string; chatId: string; decidedAt: string }): DecideNaturalLanguageCommandConfirmationResult {
    return this.context.transaction(() => {
      let current = this.getNaturalLanguageCommandConfirmation(input.id);
      if (!current) return { outcome: "missing", confirmation: null };
      if (current.actorOpenId !== input.actorOpenId || current.chatId !== input.chatId) return { outcome: "unauthorized", confirmation: current };
      if (current.state !== "pending") return { outcome: "already-resolved", confirmation: current };
      if (current.expiresAt <= input.decidedAt) {
        this.resolve(current.id, "expired", "confirmation_expired", input.decidedAt);
        return { outcome: "expired", confirmation: this.require(current.id) };
      }
      if (!naturalLanguageCommandEnvelopeSchema.safeParse(current.envelope).success || !this.fencesMatch(current)) {
        this.resolve(current.id, "cancelled", "stale_context", input.decidedAt);
        return { outcome: "stale", confirmation: this.require(current.id) };
      }
      const state = input.decision === "confirm" ? "consumed" : "cancelled";
      this.resolve(current.id, state, input.decision === "confirm" ? "confirmed" : "cancelled_by_user", input.decidedAt);
      current = this.require(current.id);
      return { outcome: state, confirmation: current };
    });
  }

  confirmNaturalLanguageSwarmCommand(input: ConfirmNaturalLanguageSwarmCommandInput): ConfirmNaturalLanguageSwarmCommandResult {
    return this.context.transaction(() => {
      const checked = this.checkPending(input);
      if (checked.outcome !== "pending") return checked;
      if (checked.confirmation.envelope.family !== "swarm" || JSON.stringify(checked.confirmation.envelope.command) !== JSON.stringify(input.commandIntent.command)) {
        this.resolve(checked.confirmation.id, "cancelled", "command_mismatch", input.decidedAt);
        return { outcome: "stale", confirmation: this.require(checked.confirmation.id) };
      }
      const commandIntent = this.commandIntents.accept(input.commandIntent);
      if (commandIntent.outcome === "conflict") {
        this.resolve(checked.confirmation.id, "cancelled", "command_intent_conflict", input.decidedAt);
        return { outcome: "stale", confirmation: this.require(checked.confirmation.id) };
      }
      this.resolve(checked.confirmation.id, "consumed", "confirmed", input.decidedAt);
      return { outcome: "consumed", confirmation: this.require(checked.confirmation.id), commandIntent };
    });
  }

  private fencesMatch(value: NaturalLanguageCommandConfirmation): boolean {
    if (value.expectedBindingId) {
      const row = this.context.database.prepare("SELECT generation FROM bindings WHERE id = ?").get(value.expectedBindingId) as { generation: number } | undefined;
      if (!row || Number(row.generation) !== value.expectedBindingGeneration) return false;
    }
    if (value.expectedInstanceId) {
      const row = this.context.database.prepare("SELECT generation FROM agent_instances WHERE id = ?").get(value.expectedInstanceId) as { generation: number } | undefined;
      if (!row || Number(row.generation) !== value.expectedInstanceGeneration) return false;
    }
    return true;
  }
  private checkPending(input: { id: string; actorOpenId: string; chatId: string; decidedAt: string }): { outcome: "pending"; confirmation: NaturalLanguageCommandConfirmation } | Exclude<DecideNaturalLanguageCommandConfirmationResult, { outcome: "consumed" | "cancelled" }> {
    const current = this.getNaturalLanguageCommandConfirmation(input.id);
    if (!current) return { outcome: "missing", confirmation: null };
    if (current.actorOpenId !== input.actorOpenId || current.chatId !== input.chatId) return { outcome: "unauthorized", confirmation: current };
    if (current.state !== "pending") return { outcome: "already-resolved", confirmation: current };
    if (current.expiresAt <= input.decidedAt) { this.resolve(current.id, "expired", "confirmation_expired", input.decidedAt); return { outcome: "expired", confirmation: this.require(current.id) }; }
    if (!naturalLanguageCommandEnvelopeSchema.safeParse(current.envelope).success || !this.fencesMatch(current)) { this.resolve(current.id, "cancelled", "stale_context", input.decidedAt); return { outcome: "stale", confirmation: this.require(current.id) }; }
    return { outcome: "pending", confirmation: current };
  }

  private getBySourceMessageId(id: string): NaturalLanguageCommandConfirmation | null {
    const row = this.context.database.prepare("SELECT * FROM natural_language_command_confirmations WHERE source_message_id = ?").get(id) as NaturalLanguageCommandConfirmationRow | undefined;
    return row ? mapNaturalLanguageCommandConfirmation(row) : null;
  }
  private require(id: string): NaturalLanguageCommandConfirmation { const value = this.getNaturalLanguageCommandConfirmation(id); if (!value) throw new Error(`Natural-language confirmation not found: ${id}`); return value; }
  private resolve(id: string, state: "consumed" | "expired" | "cancelled", detail: string, at: string): void { this.context.database.prepare("UPDATE natural_language_command_confirmations SET state = ?, result_detail = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'").run(state, detail, at, at, id); }
}

function sameRequest(existing: NaturalLanguageCommandConfirmation, input: StageNaturalLanguageCommandConfirmationInput["confirmation"], commandJson: string): boolean {
  return existing.id === input.id && existing.actorOpenId === input.actorOpenId && existing.chatId === input.chatId && existing.topicId === input.topicId && existing.rootMessageId === input.rootMessageId
    && JSON.stringify(existing.envelope) === commandJson && existing.expectedBindingId === input.expectedBindingId && existing.expectedBindingGeneration === input.expectedBindingGeneration
    && existing.expectedInstanceId === input.expectedInstanceId && existing.expectedInstanceGeneration === input.expectedInstanceGeneration && existing.expiresAt === input.expiresAt;
}
