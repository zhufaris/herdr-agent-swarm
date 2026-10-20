import type { SqliteContext } from "./context.js";

export const supersededDetachedPromptNotice = "A newer exact TraeX turn started while this detached turn had an uncertain outcome.";

export interface ExactPromptOwner {
  promptId: string;
  bindingId: string;
  bindingGeneration: number;
  turnId: string;
  startedAt: string;
}

export function listNewestExactRunningPromptOwners(context: SqliteContext): ExactPromptOwner[] {
  return (context.database.prepare(`
    SELECT newer.id AS prompt_id, newer.binding_id, card.binding_generation,
      newer.transcript_turn_id AS turn_id, newer.transcript_turn_started_at AS started_at
    FROM prompt_jobs newer
    JOIN run_cards card ON card.prompt_id = newer.id
    WHERE newer.state = 'running'
      AND newer.transcript_turn_id IS NOT NULL AND newer.transcript_turn_started_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM prompt_jobs older
        JOIN run_cards older_card ON older_card.prompt_id = older.id
        WHERE older.binding_id = newer.binding_id AND older.id != newer.id
          AND older.state = 'running' AND older.observation_state = 'detached'
          AND older.transcript_turn_id IS NOT NULL AND older.transcript_turn_started_at IS NOT NULL
          AND older_card.binding_generation = card.binding_generation
          AND older.transcript_turn_started_at < newer.transcript_turn_started_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM prompt_jobs later
        JOIN run_cards later_card ON later_card.prompt_id = later.id
        WHERE later.binding_id = newer.binding_id AND later.id != newer.id
          AND later.state = 'running'
          AND later.transcript_turn_id IS NOT NULL AND later.transcript_turn_started_at IS NOT NULL
          AND later_card.binding_generation = card.binding_generation
          AND later.transcript_turn_started_at > newer.transcript_turn_started_at
      )
    ORDER BY newer.binding_id
  `).all() as Array<{ prompt_id: string; binding_id: string; binding_generation: number; turn_id: string; started_at: string }>).map((row) => ({
    promptId: row.prompt_id,
    bindingId: row.binding_id,
    bindingGeneration: Number(row.binding_generation),
    turnId: row.turn_id,
    startedAt: row.started_at
  }));
}

export function terminalizeOlderDetachedPromptOwners(
  context: SqliteContext,
  successor: ExactPromptOwner,
  occurredAt: string,
  onTerminalized: (promptId: string) => void
): string[] {
  const candidates = context.database.prepare(`
    SELECT older.id, older.transcript_turn_id, older.transcript_turn_started_at
    FROM prompt_jobs older
    JOIN run_cards card ON card.prompt_id = older.id
    WHERE older.binding_id = ? AND older.id != ?
      AND older.state = 'running' AND older.observation_state = 'detached'
      AND older.transcript_turn_id IS NOT NULL AND older.transcript_turn_started_at IS NOT NULL
      AND card.binding_generation = ?
      AND older.transcript_turn_started_at < ?
    ORDER BY older.transcript_turn_started_at, older.created_at, older.rowid
  `).all(successor.bindingId, successor.promptId, successor.bindingGeneration, successor.startedAt) as Array<{
    id: string;
    transcript_turn_id: string;
    transcript_turn_started_at: string;
  }>;
  const terminalized: string[] = [];
  for (const candidate of candidates) {
    const changed = context.database.prepare(`
      UPDATE prompt_jobs
      SET state = 'uncertain', observation_state = 'completed', error = ?, updated_at = ?
      WHERE id = ? AND binding_id = ? AND state = 'running' AND observation_state = 'detached'
        AND transcript_turn_id = ? AND transcript_turn_started_at = ?
        AND EXISTS (SELECT 1 FROM run_cards card WHERE card.prompt_id = prompt_jobs.id AND card.binding_generation = ?)
    `).run(
      supersededDetachedPromptNotice,
      occurredAt,
      candidate.id,
      successor.bindingId,
      candidate.transcript_turn_id,
      candidate.transcript_turn_started_at,
      successor.bindingGeneration
    );
    if (Number(changed.changes) !== 1) continue;
    onTerminalized(candidate.id);
    context.database.prepare("DELETE FROM external_turn_recovery_attempts WHERE prompt_id = ?").run(candidate.id);
    context.database.prepare("DELETE FROM detached_prompt_recovery_attempts WHERE prompt_id = ?").run(candidate.id);
    context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES ('system:prompt-integrity', 'prompt.superseded_exact_turn', ?, 'uncertain', ?)")
      .run(`binding:${successor.bindingId}:prompt:${candidate.id}:successor:${successor.promptId}:turn:${successor.turnId}`, occurredAt);
    terminalized.push(candidate.id);
  }
  return terminalized;
}
