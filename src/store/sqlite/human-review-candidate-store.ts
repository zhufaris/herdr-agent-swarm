import { redactSecrets } from "../../runtime/redact-secrets.js";
import type { CoreEventProjectionSettlement } from "../../domain/core-event-inbox.js";
import type { SqliteContext } from "./context.js";

const MAX_PENDING_PER_OWNER = 8;
const MAX_NOTICE_CHARS = 1_000;
const RETENTION_MS = 24 * 60 * 60 * 1_000;

export class SqliteHumanReviewCandidateStore {
  constructor(private readonly context: SqliteContext) {}

  capture(settlement: CoreEventProjectionSettlement): void {
    const generation = this.ownerGeneration(settlement.owner);
    if (generation === null) return;
    for (const eventId of new Set(settlement.eventIds)) {
      const row = this.context.database.prepare(`SELECT session_id, turn_id, occurred_at, event_json
        FROM core_event_inbox WHERE event_id = ? AND payload_compacted_at IS NULL`).get(eventId) as {
          session_id: string; turn_id: string | null; occurred_at: string; event_json: string;
        } | undefined;
      if (!row?.turn_id) continue;
      const notice = candidateNotice(row.event_json);
      if (!notice) continue;
      const createdAt = validTime(row.occurred_at) ? row.occurred_at : settlement.occurredAt;
      const expiresAt = new Date(Date.parse(createdAt) + RETENTION_MS).toISOString();
      this.context.database.prepare(`INSERT OR IGNORE INTO human_review_candidates(
        source_event_id, owner_kind, owner_id, owner_generation, native_session_id, turn_id,
        notice, state, created_at, expires_at, absorbed_episode_id, absorbed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)`).run(
        eventId, settlement.owner.kind, settlement.owner.id, generation, row.session_id, row.turn_id,
        notice, createdAt, expiresAt
      );
    }
    this.expire(settlement.occurredAt);
    this.context.database.prepare(`UPDATE human_review_candidates SET state = 'expired'
      WHERE state = 'pending' AND owner_kind = ? AND owner_id = ? AND owner_generation = ?
        AND source_event_id NOT IN (
          SELECT source_event_id FROM human_review_candidates
          WHERE state = 'pending' AND owner_kind = ? AND owner_id = ? AND owner_generation = ?
          ORDER BY created_at DESC, source_event_id DESC LIMIT ?
        )`).run(
      settlement.owner.kind, settlement.owner.id, generation,
      settlement.owner.kind, settlement.owner.id, generation, MAX_PENDING_PER_OWNER
    );
  }

  absorb(input: {
    owner: CoreEventProjectionSettlement["owner"];
    ownerGeneration: number;
    nativeSessionId: string;
    turnId: string;
    episodeId: string;
    occurredAt: string;
  }): string[] {
    this.expire(input.occurredAt);
    const rows = this.context.database.prepare(`SELECT source_event_id, notice
      FROM human_review_candidates
      WHERE owner_kind = ? AND owner_id = ? AND owner_generation = ?
        AND native_session_id = ? AND turn_id = ? AND state = 'pending' AND expires_at > ?
      ORDER BY created_at, source_event_id LIMIT ?`).all(
        input.owner.kind, input.owner.id, input.ownerGeneration, input.nativeSessionId,
        input.turnId, input.occurredAt, MAX_PENDING_PER_OWNER
      ) as Array<{ source_event_id: string; notice: string }>;
    const update = this.context.database.prepare(`UPDATE human_review_candidates
      SET state = 'absorbed', absorbed_episode_id = ?, absorbed_at = ?
      WHERE source_event_id = ? AND state = 'pending'`);
    for (const row of rows) update.run(input.episodeId, input.occurredAt, row.source_event_id);
    return rows.map(({ notice }) => notice);
  }

  private expire(occurredAt: string): void {
    this.context.database.prepare("UPDATE human_review_candidates SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?").run(occurredAt);
  }

  private ownerGeneration(owner: CoreEventProjectionSettlement["owner"]): number | null {
    const row = owner.kind === "binding"
      ? this.context.database.prepare("SELECT generation FROM bindings WHERE id = ?").get(owner.id) as { generation: number } | undefined
      : this.context.database.prepare("SELECT instance_generation AS generation FROM instance_turns WHERE id = ?").get(owner.id) as { generation: number } | undefined;
    return row ? Number(row.generation) : null;
  }
}

function candidateNotice(eventJson: string): string | null {
  let event: unknown;
  try { event = JSON.parse(eventJson); } catch { return null; }
  if (!event || typeof event !== "object") return null;
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return null;
  const call = payload as { type?: unknown; name?: unknown; arguments?: unknown };
  if (call.type !== "tool_call" || typeof call.name !== "string" || !["request_user_input", "askuserquestion"].includes(call.name.toLowerCase())) return null;
  let argumentsValue: unknown;
  try { argumentsValue = typeof call.arguments === "string" ? JSON.parse(call.arguments) : null; } catch { argumentsValue = null; }
  const questions = argumentsValue && typeof argumentsValue === "object" && Array.isArray((argumentsValue as { questions?: unknown }).questions)
    ? (argumentsValue as { questions: unknown[] }).questions
    : [];
  const text = questions.flatMap((question) => question && typeof question === "object" && typeof (question as { question?: unknown }).question === "string"
    ? [(question as { question: string }).question]
    : []).join("\n");
  const safe = redactSecrets(text).replace(/\s+/g, " ").trim();
  return safe ? [...safe].slice(0, MAX_NOTICE_CHARS).join("") : "Agent requested structured input.";
}

function validTime(value: string): boolean { return Number.isFinite(Date.parse(value)); }
