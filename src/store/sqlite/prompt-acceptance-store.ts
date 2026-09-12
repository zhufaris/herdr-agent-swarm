import { randomUUID } from "node:crypto";
import { createBridgeEvent } from "../../domain/create-bridge-event.js";
import type { AcceptPromptInput, PromptAcceptanceEffect, PromptAcceptanceReceipt } from "../../domain/ports/prompt-acceptance.js";
import type { Binding, PromptJob } from "../../domain/types.js";
import { mapPrompt, type PromptRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteProjectionStore } from "./projection-store.js";

export interface PromptAcceptanceStoreDependencies {
  getBinding(id: string): Binding | null;
  countPendingPrompts(bindingId: string): number;
}

export class SqlitePromptAcceptanceStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: PromptAcceptanceStoreDependencies
  ) {}

  enqueuePrompt(input: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "priority" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin"> & Partial<Pick<PromptJob, "priority" | "wasDetached" | "executionOrigin">>): { prompt: PromptJob; inserted: boolean } {
    const timestamp = now();
    const statement = this.context.database.prepare(`
      INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, parent_prompt_id, priority, was_detached, state, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?) ON CONFLICT(lark_message_id) DO NOTHING
    `);
    const inserted = statement.run(input.id, input.bindingId, input.larkMessageId, input.actorOpenId, input.body, input.parentPromptId ?? null, input.priority ?? "normal", input.wasDetached ? 1 : 0, timestamp, timestamp).changes === 1;
    const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE lark_message_id = ?").get(input.larkMessageId) as PromptRow | undefined;
    if (!row) throw new Error(`Prompt not found: ${input.larkMessageId}`);
    return { prompt: mapPrompt(row), inserted };
  }

  acceptPrompt(input: AcceptPromptInput): { prompt: PromptJob; view: import("../../domain/run-card-view.js").RunCardView; inserted: boolean } {
    return this.context.transaction(() => {
      const existing = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE lark_message_id = ?").get(input.prompt.larkMessageId) as PromptRow | undefined;
      if (existing) {
        const view = this.projections.loadRunCard(existing.id);
        if (!view) throw new Error(`Run card missing for prompt: ${existing.id}`);
        return { prompt: mapPrompt(existing), view, inserted: false };
      }
      if (input.expectedBindingGeneration !== undefined) {
        const binding = this.dependencies.getBinding(input.prompt.bindingId);
        if (!binding || binding.generation !== input.expectedBindingGeneration || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") throw new Error("Binding generation changed before prompt acceptance");
      }
      if (input.maxQueueDepth !== undefined && this.dependencies.countPendingPrompts(input.prompt.bindingId) >= input.maxQueueDepth) throw new Error("This topic's prompt queue is full");
      if (input.prompt.priority === "priority") {
        if (this.context.database.prepare("SELECT 1 FROM prompt_jobs WHERE binding_id = ? AND priority = 'priority' AND state IN ('queued','running') LIMIT 1").get(input.prompt.bindingId)) throw new Error("Primary binding already has a live priority turn");
        if (this.context.database.prepare("SELECT 1 FROM prompt_jobs WHERE binding_id = ? AND state = 'running' LIMIT 1").get(input.prompt.bindingId)) throw new Error("Primary binding already has an active runtime turn");
      }
      const timestamp = now();
      this.context.database.prepare(`INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, parent_prompt_id, priority, was_detached, state, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`)
        .run(input.prompt.id, input.prompt.bindingId, input.prompt.larkMessageId, input.prompt.actorOpenId, input.prompt.body, input.prompt.parentPromptId ?? null, input.prompt.priority ?? "normal", input.prompt.wasDetached ? 1 : 0, timestamp, timestamp);
      const view = input.view;
      this.projections.insertRunCard(view);
      this.context.database.prepare(`INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, card_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
        .run(randomUUID(), `run-card:create:${input.prompt.id}:answer`, input.prompt.bindingId, input.prompt.id, view.viewVersion, "answer", input.rootMessageId, "stream_card_create", JSON.stringify(input.answerCard), `gateway:${this.dependencies.getBinding(input.prompt.bindingId)?.gatewayId ?? "feishu:primary"}:answer:${input.prompt.id}`, timestamp, timestamp, timestamp);
      const prompt = this.getPrompt(input.prompt.id);
      if (!prompt) throw new Error(`Prompt not found: ${input.prompt.id}`);
      return { prompt, view: this.projections.loadRunCard(input.prompt.id)!, inserted: true };
    });
  }

  acceptPromptWithEffects(input: AcceptPromptInput): PromptAcceptanceReceipt {
    return this.context.transaction(() => {
      const result = this.acceptPrompt(input);
      const effects: PromptAcceptanceEffect[] = result.inserted ? [
        { kind: "outbound-wake" },
        { kind: "prompt-wake", bindingId: input.prompt.bindingId },
        { kind: "lifecycle-event", event: createBridgeEvent(input.prompt.bindingId, "PromptQueued", "lark", {
          promptId: result.prompt.id, queueDepth: this.dependencies.countPendingPrompts(input.prompt.bindingId), actorOpenId: input.prompt.actorOpenId
        }) }
      ] : [];
      return this.context.receipt(result, effects);
    });
  }

  acceptInterruptedContinuation(input: { interactionId: string; parentPromptId: string; sourceAnswerMessageId: string; expectedBindingGeneration: number; actorOpenId: string; accepted: AcceptPromptInput }): { prompt: PromptJob; view: import("../../domain/run-card-view.js").RunCardView; inserted: boolean } {
    return this.context.transaction(() => {
      const interaction = this.context.database.prepare("SELECT * FROM card_interactions WHERE id = ?").get(input.interactionId) as { binding_id: string; binding_generation: number; actor_open_id: string; action_kind: string; parent_prompt_id: string | null; state: string; expires_at: string } | undefined;
      const existing = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE lark_message_id = ?").get(input.accepted.prompt.larkMessageId) as PromptRow | undefined;
      if (interaction?.state === "consumed" && existing) {
        const view = this.projections.loadRunCard(existing.id);
        if (!view) throw new Error(`Run card missing for prompt: ${existing.id}`);
        return { prompt: mapPrompt(existing), view, inserted: false };
      }
      if (!interaction || interaction.state !== "active" || interaction.action_kind !== "continuation" || interaction.actor_open_id !== input.actorOpenId
        || interaction.binding_generation !== input.expectedBindingGeneration || interaction.parent_prompt_id !== input.parentPromptId || interaction.expires_at <= now()) {
        throw new Error("Interrupted-task continuation interaction is no longer active");
      }
      const parent = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(input.parentPromptId) as PromptRow | undefined;
      const parentView = this.projections.loadRunCard(input.parentPromptId);
      const binding = parent ? this.dependencies.getBinding(parent.binding_id) : null;
      if (!parent || !parentView || !binding || interaction.binding_id !== binding.id || binding.id !== input.accepted.prompt.bindingId || binding.creatorOpenId !== input.actorOpenId
        || binding.generation !== input.expectedBindingGeneration || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached"
        || parent.state !== "failed" || parent.error !== "TraeX turn was interrupted by a human operator" || parentView.answerMessageId !== input.sourceAnswerMessageId) {
        throw new Error("Interrupted-task continuation is no longer eligible");
      }
      if (input.accepted.prompt.parentPromptId !== input.parentPromptId || input.accepted.expectedBindingGeneration !== input.expectedBindingGeneration) throw new Error("Interrupted-task continuation identity mismatch");
      const result = this.acceptPrompt(input.accepted);
      const consumed = this.context.database.prepare("UPDATE card_interactions SET state = 'consumed', result_code = 'continuation', consumed_at = ? WHERE id = ? AND state = 'active'").run(now(), input.interactionId);
      if (Number(consumed.changes) !== 1) throw new Error(`Continuation interaction acceptance lost ownership: ${input.interactionId}`);
      return result;
    });
  }

  private getPrompt(id: string): PromptJob | null {
    const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(id) as PromptRow | undefined;
    return row ? mapPrompt(row) : null;
  }
}

function now(): string { return new Date().toISOString(); }
