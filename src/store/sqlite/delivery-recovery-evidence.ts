import { createHash } from "node:crypto";
import type { SqliteContext } from "./context.js";

export function recordAnswerCoverage(context: SqliteContext, input: { replyId: string; promptId: string; bindingGeneration: number; pageIndex: number; sourceStart: number; source: string }): void {
  const end = input.sourceStart + input.source.length;
  context.database.prepare("INSERT INTO answer_delivery_coverage(reply_id, prompt_id, binding_generation, page_index, source_start, source_end, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.replyId, input.promptId, input.bindingGeneration, input.pageIndex, input.sourceStart, end, sourceHash(input.source));
  const links = context.database.prepare(`SELECT link.failed_reply_id, link.source_end, link.source_hash FROM answer_recovery_links link JOIN delivery_recoveries recovery ON recovery.failed_reply_id = link.failed_reply_id
    WHERE link.prompt_id = ? AND link.binding_generation = ? AND link.replacement_page_index = ? AND link.source_start = ? AND link.source_end <= ?
      AND recovery.action = 'rebuild_answer' AND recovery.state = 'replacement_pending'`).all(input.promptId, input.bindingGeneration, input.pageIndex, input.sourceStart, end) as Array<{ failed_reply_id: string; source_end: number; source_hash: string }>;
  for (const link of links) {
    if (sourceHash(input.source.slice(0, link.source_end - input.sourceStart)) !== link.source_hash) continue;
    context.database.prepare("INSERT INTO answer_recovery_candidates(failed_reply_id, reply_id) VALUES (?, ?)").run(link.failed_reply_id, input.replyId);
  }
}

export function linkAnswerRecovery(context: SqliteContext, promptId: string, generation: number, previousPage: number, nextPage: number, replacementId: string): void {
  context.database.prepare(`INSERT OR IGNORE INTO answer_recovery_links(failed_reply_id, prompt_id, binding_generation, source_page_index, replacement_page_index, source_start, source_end, source_hash)
    SELECT recovery.failed_reply_id, coverage.prompt_id, coverage.binding_generation, coverage.page_index, ?, coverage.source_start, coverage.source_end, coverage.source_hash
    FROM delivery_recoveries recovery JOIN answer_delivery_coverage coverage ON coverage.reply_id = recovery.failed_reply_id
    WHERE recovery.action = 'rebuild_answer' AND recovery.state = 'unresolved' AND coverage.prompt_id = ? AND coverage.binding_generation = ? AND coverage.page_index = ?`).run(nextPage, promptId, generation, previousPage);
  context.database.prepare(`UPDATE delivery_recoveries SET state = 'replacement_pending', replacement_reply_id = ?, updated_at = ? WHERE state = 'unresolved' AND action = 'rebuild_answer'
    AND failed_reply_id IN (SELECT failed_reply_id FROM answer_recovery_links WHERE prompt_id = ? AND binding_generation = ? AND source_page_index = ? AND replacement_page_index = ?)`).run(replacementId, new Date().toISOString(), promptId, generation, previousPage, nextPage);
}

export function confirmAnswerRecoveries(context: SqliteContext, replyId: string): void {
  context.database.prepare(`UPDATE delivery_recoveries AS recovery SET state = 'recovered', resolved_by_reply_id = ?,
    resolved_message_id = (SELECT delivered_message_id FROM outbound_replies WHERE id = ?), resolved_at = ?, updated_at = ?
    WHERE recovery.action = 'rebuild_answer' AND recovery.state = 'replacement_pending' AND EXISTS (
      SELECT 1 FROM answer_recovery_candidates candidate
      JOIN answer_recovery_links link ON link.failed_reply_id = candidate.failed_reply_id
      JOIN outbound_replies delivered ON delivered.id = candidate.reply_id
      JOIN outbound_replies replacement ON replacement.id = recovery.replacement_reply_id
      JOIN run_cards card ON card.prompt_id = link.prompt_id
      JOIN bindings binding ON binding.id = card.binding_id AND binding.generation = link.binding_generation
      JOIN answer_pages page ON page.prompt_id = link.prompt_id AND page.page_index = link.replacement_page_index
      WHERE candidate.failed_reply_id = recovery.failed_reply_id AND candidate.reply_id = ?
        AND card.binding_generation = link.binding_generation
        AND delivered.state = 'delivered' AND delivered.kind = 'card_update' AND delivered.card_role = 'answer'
        AND delivered.prompt_id = link.prompt_id AND delivered.binding_id = binding.id
        AND delivered.delivered_message_id = page.message_id AND delivered.root_message_id = page.message_id
        AND replacement.state = 'delivered' AND replacement.delivered_message_id = page.message_id
        AND page.delivery_mode = 'static' AND page.source_start = link.source_start
    )`).run(replyId, replyId, new Date().toISOString(), new Date().toISOString(), replyId);
}

function sourceHash(source: string): string { return createHash("sha256").update(source).digest("hex"); }

export function confirmDeliveryRecoveries(context: SqliteContext, replyId: string): void {
  context.database.prepare(`
    UPDATE delivery_recoveries AS recovery
    SET state = 'recovered', resolved_by_reply_id = ?,
      resolved_message_id = (SELECT delivered_message_id FROM outbound_replies WHERE id = ?),
      resolved_at = (SELECT updated_at FROM outbound_replies WHERE id = ?),
      updated_at = (SELECT updated_at FROM outbound_replies WHERE id = ?)
    WHERE recovery.state IN ('unresolved', 'replacement_pending') AND EXISTS (
      SELECT 1 FROM outbound_replies delivered JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      WHERE delivered.id = ? AND delivered.state = 'delivered' AND delivered.delivered_message_id IS NOT NULL
        AND (
          delivered.id = failed.id
          OR (recovery.action = 'rebuild_main' AND recovery.replacement_reply_id = delivered.id
            AND delivered.kind = 'card_reply' AND delivered.target_role = 'session_status'
            AND delivered.binding_id = failed.binding_id AND delivered.view_version >= failed.view_version
            AND delivered.delivery_order > failed.delivery_order
            AND EXISTS (SELECT 1 FROM bindings binding WHERE binding.id = failed.binding_id
              AND failed.lane_key = 'gateway:' || failed.gateway_id || ':primary-main:' || binding.id || ':' || binding.generation))
          OR (recovery.action = 'released_newer_snapshot'
            AND failed.kind = 'card_update' AND delivered.kind = 'card_update'
            AND delivered.delivery_order > failed.delivery_order
            AND delivered.root_message_id = failed.root_message_id AND delivered.lane_key = failed.lane_key
            AND delivered.binding_id IS failed.binding_id AND delivered.prompt_id IS failed.prompt_id
            AND delivered.worker_id IS failed.worker_id AND delivered.worker_session_generation IS failed.worker_session_generation
            AND delivered.worker_turn_id IS failed.worker_turn_id AND delivered.selection_id IS failed.selection_id
            AND delivered.card_role IS failed.card_role AND delivered.target_role IS failed.target_role
            AND (failed.view_version IS NULL OR delivered.view_version > failed.view_version
              OR (failed.projection_key IS NOT NULL AND delivered.projection_key = failed.projection_key AND delivered.snapshot_revision > failed.snapshot_revision))
            AND (failed.projection_key IS NULL OR (delivered.projection_key = failed.projection_key AND delivered.snapshot_revision > failed.snapshot_revision)))
        )
    )
  `).run(replyId, replyId, replyId, replyId, replyId);
}
