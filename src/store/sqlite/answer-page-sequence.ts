import type { SqliteContext } from "./context.js";

export function incrementPrimaryAnswerPageSequence(
  context: SqliteContext,
  promptId: string,
  pageIndex: number,
): number | null {
  const row = context.database
    .prepare("SELECT sequence FROM answer_pages WHERE prompt_id = ? AND page_index = ?")
    .get(promptId, pageIndex) as { sequence: number } | undefined;
  if (!row) return null;
  const sequence = Number(row.sequence) + 1;
  const changed = context.database
    .prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND sequence = ?")
    .run(sequence, now(), promptId, pageIndex, row.sequence);
  if (Number(changed.changes) !== 1) throw new Error("Primary Answer page sequence changed during reservation");
  context.database
    .prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?")
    .run(sequence, now(), promptId, pageIndex);
  return sequence;
}

export function incrementWorkerTurnPageSequence(
  context: SqliteContext,
  turnId: string,
  pageIndex: number,
): number | null {
  const row = context.database
    .prepare("SELECT sequence FROM worker_turn_card_pages WHERE turn_id = ? AND page_index = ?")
    .get(turnId, pageIndex) as { sequence: number } | undefined;
  if (!row) return null;
  const sequence = Number(row.sequence) + 1;
  const changed = context.database
    .prepare("UPDATE worker_turn_card_pages SET sequence = ?, updated_at = ? WHERE turn_id = ? AND page_index = ? AND sequence = ?")
    .run(sequence, now(), turnId, pageIndex, row.sequence);
  if (Number(changed.changes) !== 1) throw new Error("Worker Task page sequence changed during reservation");
  context.database
    .prepare("UPDATE worker_turn_cards SET sequence = ?, updated_at = ? WHERE turn_id = ? AND page_index = ?")
    .run(sequence, now(), turnId, pageIndex);
  return sequence;
}

function now(): string {
  return new Date().toISOString();
}
