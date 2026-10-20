import type {
  ConfirmNaturalLanguageSwarmCommandInput, ConfirmNaturalLanguageSwarmCommandResult, DecideNaturalLanguageCommandConfirmationResult, NaturalLanguageCommandConfirmation,
  ResolvedCommandTarget,
  StageNaturalLanguageCommandConfirmationInput, StageNaturalLanguageCommandConfirmationResult
} from "../../domain/natural-language-command-confirmation.js";
import { commandTargetsEqual, frozenCommandTargetSchema, naturalLanguageCommandEnvelopeSchema } from "../../domain/natural-language-command-confirmation.js";
import { mapNaturalLanguageCommandConfirmation, type NaturalLanguageCommandConfirmationRow } from "../sqlite-records.js";
import type { SqliteOutboxStore } from "./outbox-store.js";
import type { SqliteContext } from "./context.js";
import type { SqliteCommandIntentStore } from "./command-intent-store.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";

export class SqliteNaturalLanguageCommandConfirmationStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(private readonly context: SqliteContext, private readonly outbox: SqliteOutboxStore, private readonly commandIntents: SqliteCommandIntentStore) {}
  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void { this.preparedDeliveryReservation = reservation; this.preparedDeliveryConsumer = consumer; }

  stageNaturalLanguageCommandConfirmation(input: StageNaturalLanguageCommandConfirmationInput): StageNaturalLanguageCommandConfirmationResult {
    const commandJson = JSON.stringify(naturalLanguageCommandEnvelopeSchema.parse(input.confirmation.envelope));
    const frozenTargetJson = JSON.stringify(frozenCommandTargetSchema.parse(input.confirmation.frozenTarget));
    return this.context.transaction("sqlite.natural-language-command-confirmation-store.write", () => {
      const prior = this.getBySourceMessageId(input.confirmation.sourceMessageId);
      if (prior) return { outcome: sameRequest(prior, input.confirmation, commandJson) ? "duplicate" : "conflict", confirmation: prior };
      const value = input.confirmation;
      this.context.database.prepare(`
        INSERT INTO natural_language_command_confirmations(
          id, source_message_id, actor_open_id, chat_id, topic_id, root_message_id, command_json, frozen_target_json, expected_binding_id, expected_binding_generation, expected_instance_id, expected_instance_generation, state, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(value.id, value.sourceMessageId, value.actorOpenId, value.chatId, value.topicId, value.rootMessageId, commandJson, frozenTargetJson, targetBindingId(value.frozenTarget), targetBindingGeneration(value.frozenTarget), targetInstanceId(value.frozenTarget), targetInstanceGeneration(value.frozenTarget), value.expiresAt, value.createdAt, value.createdAt);
      const outbound = {
        id: input.outbox.id,
        idempotencyKey: input.outbox.idempotencyKey,
        bindingId: targetBindingId(value.frozenTarget),
        bindingGeneration: targetBindingGeneration(value.frozenTarget),
        ...(value.frozenTarget.kind === "worker" ? {
          workerId: value.frozenTarget.instanceId,
          workerSessionGeneration: value.frozenTarget.workerSessionGeneration
        } : {}),
        targetRole: "operation_result" as const,
        rootMessageId: value.rootMessageId,
        kind: "card_reply" as const,
        payload: JSON.stringify(input.outbox.card)
      };
      if (value.frozenTarget.kind === "swarm" && value.frozenTarget.bindingId !== null) {
        if (value.frozenTarget.bindingGeneration === null || !this.hasExactActiveBinding(value.frozenTarget.bindingId, value.frozenTarget.bindingGeneration)) return { outcome: "staged", confirmation: this.require(value.id) };
        if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Natural Language Command Confirmation prepared delivery is not connected");
        this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply(outbound));
      } else if (value.frozenTarget.kind === "worker") {
        if (!this.hasExactActiveWorker(value.frozenTarget)) return { outcome: "staged", confirmation: this.require(value.id) };
        if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Natural Language Command Confirmation prepared delivery is not connected");
        this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply(outbound));
      } else {
        if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Natural Language Command Confirmation prepared delivery is not connected");
        this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply({ ...outbound, globalDelivery: true }));
      }
      return { outcome: "staged", confirmation: this.require(value.id) };
    });
  }

  getNaturalLanguageCommandConfirmation(id: string): NaturalLanguageCommandConfirmation | null {
    const row = this.getRow(id);
    return row ? mapNaturalLanguageCommandConfirmation(row) : null;
  }

  decideNaturalLanguageCommandConfirmation(input: { id: string; decision: "cancel"; actorOpenId: string; chatId: string; decidedAt: string } | { id: string; decision: "confirm"; actorOpenId: string; chatId: string; decidedAt: string; resolvedTarget?: ResolvedCommandTarget }): DecideNaturalLanguageCommandConfirmationResult {
    return this.context.transaction("sqlite.natural-language-command-confirmation-store.write", () => {
      const row = this.getRow(input.id);
      if (!row) return { outcome: "missing", confirmation: null };
      const current = mapNaturalLanguageCommandConfirmation(row);
      if (row.actor_open_id !== input.actorOpenId || row.chat_id !== input.chatId) return { outcome: "unauthorized", confirmation: current };
      if (row.state !== "pending") return { outcome: "already-resolved", confirmation: current };
      if (row.expires_at <= input.decidedAt) {
        this.resolve(row.id, "expired", "confirmation_expired", input.decidedAt);
        return { outcome: "expired", confirmation: this.getNaturalLanguageCommandConfirmation(row.id) };
      }
      if (input.decision === "cancel") {
        this.resolve(row.id, "cancelled", "cancelled_by_user", input.decidedAt);
        return { outcome: "cancelled", confirmation: this.getNaturalLanguageCommandConfirmation(row.id) };
      }
      if (!current) return this.cancelInvalidEnvelope(row.id, input.decidedAt);
      if (!input.resolvedTarget || !this.targetMatches(current, input.resolvedTarget)) return this.cancelStale(current.id, input.decidedAt);
      const state = input.decision === "confirm" ? "consumed" : "cancelled";
      this.resolve(current.id, state, input.decision === "confirm" ? "confirmed" : "cancelled_by_user", input.decidedAt);
      return { outcome: "consumed", confirmation: this.require(current.id) };
    });
  }

  confirmNaturalLanguageSwarmCommand(input: ConfirmNaturalLanguageSwarmCommandInput): ConfirmNaturalLanguageSwarmCommandResult {
    return this.context.transaction("sqlite.natural-language-command-confirmation-store.write", () => {
      const checked = this.checkPending(input, input.resolvedTarget);
      if (checked.outcome !== "pending") return checked;
      if (checked.confirmation.envelope.family !== "swarm" || JSON.stringify(checked.confirmation.envelope.command) !== JSON.stringify(input.commandIntent.command)) {
        this.resolve(checked.confirmation.id, "cancelled", "command_mismatch", input.decidedAt);
        return { outcome: "stale", confirmation: this.require(checked.confirmation.id) };
      }
      const commandIntent = this.commandIntents.accept(input.commandIntent, "natural-language", input.renderStatus);
      if (commandIntent.outcome === "conflict") {
        this.resolve(checked.confirmation.id, "cancelled", "command_intent_conflict", input.decidedAt);
        return { outcome: "stale", confirmation: this.require(checked.confirmation.id) };
      }
      this.resolve(checked.confirmation.id, "consumed", "confirmed", input.decidedAt);
      return { outcome: "consumed", confirmation: this.require(checked.confirmation.id), commandIntent };
    });
  }

  private targetMatches(value: NaturalLanguageCommandConfirmation, resolvedTarget: ResolvedCommandTarget): boolean {
    return value.frozenTarget !== null && frozenCommandTargetSchema.safeParse(resolvedTarget).success && commandTargetsEqual(value.frozenTarget, resolvedTarget);
  }
  private cancelStale(id: string, at: string): { outcome: "stale"; confirmation: NaturalLanguageCommandConfirmation } {
    const raw = this.context.database.prepare("SELECT frozen_target_json FROM natural_language_command_confirmations WHERE id = ?").get(id) as { frozen_target_json: string | null } | undefined;
    this.resolve(id, "cancelled", raw?.frozen_target_json === null ? "legacy_incomplete_frozen_identity" : "stale_context", at);
    return { outcome: "stale", confirmation: this.require(id) };
  }
  private cancelInvalidEnvelope(id: string, at: string): { outcome: "stale"; confirmation: null } {
    this.resolve(id, "cancelled", "invalid_command_envelope", at);
    return { outcome: "stale", confirmation: null };
  }
  private checkPending(input: { id: string; actorOpenId: string; chatId: string; decidedAt: string }, resolvedTarget: ResolvedCommandTarget): { outcome: "pending"; confirmation: NaturalLanguageCommandConfirmation } | Exclude<DecideNaturalLanguageCommandConfirmationResult, { outcome: "consumed" | "cancelled" }> {
    const row = this.getRow(input.id);
    if (!row) return { outcome: "missing", confirmation: null };
    const current = mapNaturalLanguageCommandConfirmation(row);
    if (row.actor_open_id !== input.actorOpenId || row.chat_id !== input.chatId) return { outcome: "unauthorized", confirmation: current };
    if (row.state !== "pending") return { outcome: "already-resolved", confirmation: current };
    if (row.expires_at <= input.decidedAt) { this.resolve(row.id, "expired", "confirmation_expired", input.decidedAt); return { outcome: "expired", confirmation: this.getNaturalLanguageCommandConfirmation(row.id) }; }
    if (!current) return this.cancelInvalidEnvelope(row.id, input.decidedAt);
    if (!naturalLanguageCommandEnvelopeSchema.safeParse(current.envelope).success || !this.targetMatches(current, resolvedTarget)) return this.cancelStale(current.id, input.decidedAt);
    return { outcome: "pending", confirmation: current };
  }

  private getRow(id: string): NaturalLanguageCommandConfirmationRow | undefined {
    return this.context.database.prepare("SELECT * FROM natural_language_command_confirmations WHERE id = ?").get(id) as NaturalLanguageCommandConfirmationRow | undefined;
  }

  private getBySourceMessageId(id: string): NaturalLanguageCommandConfirmation | null {
    const row = this.context.database.prepare("SELECT * FROM natural_language_command_confirmations WHERE source_message_id = ?").get(id) as NaturalLanguageCommandConfirmationRow | undefined;
    return row ? mapNaturalLanguageCommandConfirmation(row) : null;
  }
  private require(id: string): NaturalLanguageCommandConfirmation { const value = this.getNaturalLanguageCommandConfirmation(id); if (!value) throw new Error(`Natural-language confirmation not found: ${id}`); return value; }
  private resolve(id: string, state: "consumed" | "expired" | "cancelled", detail: string, at: string): void { this.context.database.prepare("UPDATE natural_language_command_confirmations SET state = ?, result_detail = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'").run(state, detail, at, at, id); }
  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void { queueMicrotask(() => { for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery); }); }
  private hasExactActiveBinding(id: string, generation: number): boolean { return this.context.database.prepare("SELECT 1 FROM bindings WHERE id=? AND generation=? AND state='active' AND lifecycle='active' AND attachment='attached'").get(id, generation) !== undefined; }
  private hasExactActiveWorker(target: Extract<ResolvedCommandTarget, { kind: "worker" }>): boolean {
    return this.context.database.prepare(`SELECT 1 FROM agent_instances worker
      JOIN bindings parent ON parent.id=worker.parent_binding_id
      WHERE worker.id=? AND worker.role='worker' AND worker.generation=?
        AND worker.worker_session_generation=? AND worker.worker_session_lifecycle='active'
        AND worker.parent_binding_id=? AND worker.parent_binding_generation=? AND worker.parent_pane_id=?
        AND worker.pane_id IS NOT NULL
        AND parent.generation=worker.parent_binding_generation AND parent.pane_id=worker.parent_pane_id
        AND parent.state='active' AND parent.lifecycle='active' AND parent.attachment='attached'`
    ).get(target.instanceId, target.instanceGeneration, target.workerSessionGeneration, target.parentBindingId, target.parentBindingGeneration, target.parentPaneId) !== undefined;
  }
}

function sameRequest(existing: NaturalLanguageCommandConfirmation, input: StageNaturalLanguageCommandConfirmationInput["confirmation"], commandJson: string): boolean {
  return existing.id === input.id && existing.actorOpenId === input.actorOpenId && existing.chatId === input.chatId && existing.topicId === input.topicId && existing.rootMessageId === input.rootMessageId
    && JSON.stringify(existing.envelope) === commandJson && existing.frozenTarget !== null && commandTargetsEqual(existing.frozenTarget, input.frozenTarget) && existing.expiresAt === input.expiresAt;
}

function targetBindingId(target: import("../../domain/natural-language-command-confirmation.js").FrozenCommandTarget): string | null { return target.kind === "swarm" ? target.bindingId : target.parentBindingId; }
function targetBindingGeneration(target: import("../../domain/natural-language-command-confirmation.js").FrozenCommandTarget): number | null { return target.kind === "swarm" ? target.bindingGeneration : target.parentBindingGeneration; }
function targetInstanceId(target: import("../../domain/natural-language-command-confirmation.js").FrozenCommandTarget): string | null { return target.kind === "worker" ? target.instanceId : null; }
function targetInstanceGeneration(target: import("../../domain/natural-language-command-confirmation.js").FrozenCommandTarget): number | null { return target.kind === "worker" ? target.instanceGeneration : null; }
