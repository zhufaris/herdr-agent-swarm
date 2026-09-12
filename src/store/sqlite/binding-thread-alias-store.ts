import { randomUUID } from "node:crypto";
import type { Binding } from "../../domain/types.js";
import { mapBinding, type BindingRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteOutboxQueueStore } from "./outbox-queue-store.js";

export interface ReservePaneThreadAliasInput {
  publicationKey: string; actionMessageId: string; bindingId: string; bindingGeneration: number; paneId: string;
  sourceMainMessageId: string; targetChatId: string; card: object;
}

export class SqliteBindingThreadAliasStore {
  constructor(private readonly context: SqliteContext) {}

  reserve(input: ReservePaneThreadAliasInput, queue: SqliteOutboxQueueStore): "reserved" | "duplicate" | "stale" {
    return this.context.transaction(() => {
      const existing = this.context.database.prepare("SELECT state FROM binding_thread_aliases WHERE publication_key = ?").get(input.publicationKey);
      if (existing) return "duplicate";
      const binding = this.context.database.prepare("SELECT chat_id, generation, pane_id, status_message_id, state, lifecycle, attachment FROM bindings WHERE id = ?").get(input.bindingId) as { chat_id: string; generation: number; pane_id: string | null; status_message_id: string | null; state: string; lifecycle: string; attachment: string } | undefined;
      if (!binding || binding.chat_id !== input.targetChatId || Number(binding.generation) !== input.bindingGeneration || binding.pane_id !== input.paneId || binding.status_message_id !== input.sourceMainMessageId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return "stale";
      const timestamp = now(); const aliasId = randomUUID();
      this.context.database.prepare("INSERT INTO binding_thread_aliases(id, publication_key, binding_id, binding_generation, chat_id, pane_id, source_main_message_id, action_message_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserving', ?, ?)").run(aliasId, input.publicationKey, input.bindingId, input.bindingGeneration, input.targetChatId, input.paneId, input.sourceMainMessageId, input.actionMessageId, timestamp, timestamp);
      queue.enqueue({ id: randomUUID(), idempotencyKey: input.publicationKey, bindingId: input.bindingId, threadAliasId: aliasId, targetChatId: input.targetChatId, rootMessageId: null, kind: "group_card_create", payload: JSON.stringify(input.card) });
      return "reserved";
    });
  }

  findBindingByScope(topicId: string | null, rootMessageId: string | null): Binding | null {
    if (!topicId && !rootMessageId) return null;
    const row = this.context.database.prepare(`SELECT b.* FROM binding_thread_aliases a JOIN bindings b ON b.id = a.binding_id WHERE a.state = 'active' AND ((? IS NOT NULL AND a.topic_id = ?) OR (? IS NOT NULL AND a.root_message_id = ?)) AND b.chat_id = a.chat_id AND b.generation = a.binding_generation AND b.pane_id = a.pane_id AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' ORDER BY a.created_at DESC LIMIT 1`).get(topicId, topicId, rootMessageId, rootMessageId) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  isActiveScope(topicId: string | null, rootMessageId: string | null): boolean { return this.findBindingByScope(topicId, rootMessageId) !== null; }
  isActiveBindingRoot(bindingId: string, rootMessageId: string): boolean { return Boolean(this.context.database.prepare(`SELECT 1 FROM binding_thread_aliases a JOIN bindings b ON b.id = a.binding_id WHERE a.binding_id = ? AND a.root_message_id = ? AND a.state = 'active' AND b.chat_id = a.chat_id AND b.generation = a.binding_generation AND b.pane_id = a.pane_id AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'`).get(bindingId, rootMessageId)); }
}

function now(): string { return new Date().toISOString(); }
