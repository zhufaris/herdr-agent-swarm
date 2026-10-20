import type { CardInteraction, CardInteractionActionKind, SessionOperation, SessionOperationState } from "../../domain/types.js";
import { mapCardInteraction, mapSessionOperation, type CardInteractionRow, type SessionOperationRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

export class SqliteSessionOperationStore {
  constructor(private readonly context: SqliteContext) {}

  createInteraction(input: { id: string; bindingId: string; bindingGeneration: number; actorOpenId: string; actionKind: CardInteractionActionKind; parentPromptId: string | null; targetPromptId: string | null; expiresAt: string }): CardInteraction {
    const timestamp = now();
    this.context.database.prepare(`INSERT INTO card_interactions(id, binding_id, binding_generation, actor_open_id, action_kind, parent_prompt_id, target_prompt_id, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)` )
      .run(input.id, input.bindingId, input.bindingGeneration, input.actorOpenId, input.actionKind, input.parentPromptId, input.targetPromptId, input.expiresAt, timestamp);
    return this.getInteraction(input.id)!;
  }

  getInteraction(id: string): CardInteraction | null {
    const row = this.context.database.prepare("SELECT * FROM card_interactions WHERE id = ?").get(id) as CardInteractionRow | undefined;
    return row ? mapCardInteraction(row) : null;
  }

  consumeInteraction(input: { id: string; actorOpenId: string; bindingId: string; bindingGeneration: number; now: string; resultCode: string }): { outcome: "consumed" | "duplicate" | "missing" | "unauthorized" | "expired" | "stale"; interaction: CardInteraction | null } {
    return this.context.transaction("sqlite.session-operation-store.write", () => {
      const current = this.getInteraction(input.id);
      if (!current) return { outcome: "missing", interaction: null };
      if (current.actorOpenId !== input.actorOpenId) return { outcome: "unauthorized", interaction: current };
      if (current.state === "consumed") return { outcome: "duplicate", interaction: current };
      if (current.expiresAt <= input.now) {
        this.context.database.prepare("UPDATE card_interactions SET state = 'expired' WHERE id = ?").run(input.id);
        return { outcome: "expired", interaction: this.getInteraction(input.id) };
      }
      if (current.bindingId !== input.bindingId || current.bindingGeneration !== input.bindingGeneration) return { outcome: "stale", interaction: current };
      this.context.database.prepare("UPDATE card_interactions SET state = 'consumed', result_code = ?, consumed_at = ? WHERE id = ? AND state = 'active'").run(input.resultCode, input.now, input.id);
      return { outcome: "consumed", interaction: this.getInteraction(input.id) };
    });
  }

  get(id: string): SessionOperation | null {
    const row = this.context.database.prepare("SELECT * FROM session_operations WHERE id = ?").get(id) as SessionOperationRow | undefined;
    return row ? mapSessionOperation(row) : null;
  }

  claimNext(bindingId?: string): SessionOperation | null {
    return this.context.transaction("sqlite.session-operation-store.write", () => {
      const row = this.context.database.prepare(`SELECT operation.* FROM session_operations operation WHERE operation.state = 'accepted' ${bindingId ? "AND operation.binding_id = ?" : ""} ORDER BY operation.created_at, operation.rowid LIMIT 1`).get(...(bindingId ? [bindingId] : [])) as SessionOperationRow | undefined;
      if (!row) return null;
      const changed = this.context.database.prepare("UPDATE session_operations SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'accepted'").run(now(), row.id);
      return changed.changes === 1 ? this.get(row.id) : null;
    });
  }

  finish(id: string, state: Extract<SessionOperationState, "succeeded" | "rejected" | "failed" | "uncertain">, detail: string | null = null): SessionOperation | null {
    const changed = this.context.database.prepare("UPDATE session_operations SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state IN ('running','uncertain')")
      .run(state, detail?.slice(0, 500) ?? null, now(), id);
    return changed.changes === 1 ? this.get(id) : null;
  }

  listRecoverable(): SessionOperation[] {
    return (this.context.database.prepare("SELECT * FROM session_operations WHERE state IN ('accepted','running','uncertain') ORDER BY created_at, rowid").all() as SessionOperationRow[]).map(mapSessionOperation);
  }

  pruneTerminal(cutoff: string, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    return Number(this.context.database.prepare(`DELETE FROM session_operations WHERE id IN (SELECT id FROM session_operations WHERE state IN ('succeeded','rejected','failed') AND updated_at < ? ORDER BY updated_at, rowid LIMIT ?)` ).run(cutoff, limit).changes);
  }
}

function now(): string { return new Date().toISOString(); }
