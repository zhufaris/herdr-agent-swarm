import { randomUUID } from "node:crypto";
import type { IncomingLarkMessage, ProjectSelection, ProjectSelectionClaim } from "../../domain/types.js";
import { mapProjectSelection, type ProjectSelectionRow } from "../sqlite-records.js";
import type { SqlValue } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

export class SqliteInboundProjectStore {
  constructor(private readonly context: SqliteContext) {}
  private get database() { return this.context.database; }

  recordInboundMessage(message: IncomingLarkMessage): boolean {
    return this.context.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM inbound_messages WHERE event_id = ? OR message_id = ?").get(message.eventId, message.messageId)) return false;
      const timestamp = now();
      return this.database.prepare(`INSERT INTO inbound_messages(event_id, gateway_id, message_id, payload_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'received', ?, ?)`).run(message.eventId, message.gatewayId ?? "feishu:primary", message.messageId, JSON.stringify(message), timestamp, timestamp).changes === 1;
    });
  }

  claimNextInboundMessage(): IncomingLarkMessage | null {
    return this.context.transaction(() => {
      const row = this.database.prepare("SELECT event_id, payload_json FROM inbound_messages WHERE state = 'received' ORDER BY created_at, event_id LIMIT 1").get() as { event_id: string; payload_json: string } | undefined;
      if (!row) return null;
      this.database.prepare("UPDATE inbound_messages SET state = 'processing', error = NULL, updated_at = ? WHERE event_id = ?").run(now(), row.event_id);
      return JSON.parse(row.payload_json) as IncomingLarkMessage;
    });
  }

  markInboundMessageAccepted(eventId: string): void { this.database.prepare("UPDATE inbound_messages SET state = 'accepted', error = NULL, updated_at = ? WHERE event_id = ?").run(now(), eventId); }
  releaseInboundMessage(eventId: string, error: string): void { this.database.prepare("UPDATE inbound_messages SET state = 'received', error = ?, updated_at = ? WHERE event_id = ?").run(error, now(), eventId); }
  recoverProcessingInboundMessages(): number { return Number(this.database.prepare("UPDATE inbound_messages SET state = 'received', error = 'Interrupted during inbound acceptance; retrying', updated_at = ? WHERE state = 'processing'").run(now()).changes); }
  pruneAcceptedInboundMessages(cutoff: string, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    const result = this.database.prepare(`DELETE FROM inbound_messages WHERE event_id IN (SELECT event_id FROM inbound_messages WHERE state = 'accepted' AND updated_at < ? ORDER BY updated_at, event_id LIMIT ?)` ).run(cutoff, limit);
    return Number(result.changes);
  }
  isBridgeMessage(messageId: string): boolean { return Boolean(this.database.prepare("SELECT 1 FROM bridge_messages WHERE message_id = ?").get(messageId)); }
  recordBridgeMessage(messageId: string): void { this.database.prepare("INSERT OR IGNORE INTO bridge_messages(message_id, created_at) VALUES (?, ?)").run(messageId, now()); }

  createProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; initialPromptText?: string | null; expiresAt: string; card: object }): ProjectSelection {
    return this.context.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM project_selections WHERE command_message_id = ?").get(input.commandMessageId) as ProjectSelectionRow | undefined;
      if (existing) return mapProjectSelection(existing);
      const timestamp = now();
      this.database.prepare(`INSERT INTO project_selections(id, command_message_id, chat_id, topic_id, root_message_id, actor_open_id, requested_title, initial_prompt_text, state, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(input.id, input.commandMessageId, input.chatId, input.topicId, input.rootMessageId, input.actorOpenId, input.requestedTitle, input.initialPromptText ?? null, input.expiresAt, timestamp, timestamp);
      this.database.prepare(`INSERT INTO outbound_replies(id, idempotency_key, selection_id, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'card_reply', ?, ?, 'pending', 0, ?, ?, ?)`).run(randomUUID(), `project-selection:create:${input.id}`, input.id, input.rootMessageId, JSON.stringify(input.card), `gateway:feishu:primary:message:${input.rootMessageId}`, timestamp, timestamp, timestamp);
      return this.getProjectSelection(input.id)!;
    });
  }

  getProjectSelection(id: string): ProjectSelection | null { const row = this.database.prepare("SELECT * FROM project_selections WHERE id = ?").get(id) as ProjectSelectionRow | undefined; return row ? mapProjectSelection(row) : null; }

  claimProjectSelection(input: { selectionId: string; projectId: string; messageId: string; chatId: string; actorOpenId: string; allowedProjectIds: string[] }): ProjectSelectionClaim {
    return this.context.transaction(() => {
      const selection = this.getProjectSelection(input.selectionId);
      if (!selection) return { outcome: "missing", selection: null };
      if (selection.chatId !== input.chatId || selection.selectorMessageId !== input.messageId || !input.allowedProjectIds.includes(input.projectId)) return { outcome: "invalid", selection };
      if (selection.actorOpenId !== input.actorOpenId) return { outcome: "unauthorized", selection };
      if (selection.state === "completed") return { outcome: "completed", selection };
      if (selection.state === "processing") return { outcome: "processing", selection };
      if (selection.state !== "pending") return { outcome: selection.state === "expired" ? "expired" : "invalid", selection };
      if (Date.parse(selection.expiresAt) <= Date.now()) { this.database.prepare("UPDATE project_selections SET state = 'expired', updated_at = ? WHERE id = ?").run(now(), selection.id); return { outcome: "expired", selection: { ...selection, state: "expired" } }; }
      this.database.prepare("UPDATE project_selections SET state = 'processing', selected_project_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(input.projectId, now(), selection.id);
      return { outcome: "claimed", selection: this.getProjectSelection(selection.id)! };
    });
  }

  recoverProcessingProjectSelections(): number { return Number(this.database.prepare("UPDATE project_selections SET state = 'failed', error = 'Interrupted during project creation; inspect Herdr before retrying', updated_at = ? WHERE state = 'processing'").run(now()).changes); }
  listProcessingProjectSelections(): ProjectSelection[] { return (this.database.prepare("SELECT * FROM project_selections WHERE state = 'processing' ORDER BY created_at").all() as ProjectSelectionRow[]).map(mapProjectSelection); }
  listCompletedProjectSelectionsWithInitialPrompt(): ProjectSelection[] { return (this.database.prepare("SELECT * FROM project_selections WHERE state = 'completed' AND initial_prompt_text IS NOT NULL ORDER BY created_at").all() as ProjectSelectionRow[]).map(mapProjectSelection); }
  linkProjectSelectionBinding(id: string, bindingId: string): ProjectSelection { return this.updateSelection(id, "binding_id = ?, updated_at = ?", [bindingId, now()], "AND state = 'processing'"); }
  pauseProjectSelection(id: string, error: string): ProjectSelection { return this.updateSelection(id, "error = ?, updated_at = ?", [error, now()], "AND state = 'processing'"); }
  completeProjectSelection(id: string, bindingId: string): ProjectSelection { return this.updateSelection(id, "state = 'completed', binding_id = ?, error = NULL, updated_at = ?", [bindingId, now()], "AND state = 'processing'"); }
  failProjectSelection(id: string, error: string): ProjectSelection { return this.updateSelection(id, "state = 'failed', error = ?, updated_at = ?", [error, now()]); }

  private updateSelection(id: string, assignments: string, values: SqlValue[], condition = ""): ProjectSelection {
    this.database.prepare(`UPDATE project_selections SET ${assignments} WHERE id = ? ${condition}`).run(...values, id);
    const selection = this.getProjectSelection(id);
    if (!selection) throw new Error(`Project selection not found: ${id}`);
    return selection;
  }
}

function now(): string { return new Date().toISOString(); }
