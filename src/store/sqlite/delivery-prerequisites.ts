import type { SqliteContext } from "./context.js";

export function removeDependentDeliveryPrerequisites(
  context: SqliteContext,
  dependentReplyId: string,
): number {
  return Number(context.database.prepare(`DELETE FROM outbound_reply_prerequisites
    WHERE dependent_reply_id=?`).run(dependentReplyId).changes);
}

export function transferDeliveryPrerequisites(
  context: SqliteContext,
  failedReplyId: string,
  replacementReplyId: string,
): void {
  context.database.prepare(`DELETE FROM outbound_reply_prerequisites
    WHERE prerequisite_reply_id=? AND dependent_reply_id IN (
      SELECT dependent_reply_id FROM outbound_reply_prerequisites WHERE prerequisite_reply_id=?
    )`).run(replacementReplyId, failedReplyId);
  context.database.prepare(`UPDATE outbound_reply_prerequisites
    SET prerequisite_reply_id=?,required_state='delivered'
    WHERE prerequisite_reply_id=?
      AND NOT EXISTS (
        SELECT 1
        FROM completion_notification_obligations obligation
        WHERE obligation.owner_kind='primary-segment'
          AND obligation.notification_reply_id=outbound_reply_prerequisites.dependent_reply_id
          AND obligation.presentation_reply_id=outbound_reply_prerequisites.prerequisite_reply_id
          AND NOT EXISTS (
            SELECT 1 FROM outbound_replies failed JOIN outbound_replies replacement
              ON replacement.id=?
            WHERE failed.id=outbound_reply_prerequisites.prerequisite_reply_id
              AND failed.kind='card_update' AND replacement.kind='card_update'
              AND failed.projection_key=replacement.projection_key
              AND failed.root_message_id=replacement.root_message_id
          )
      )`).run(replacementReplyId, failedReplyId, replacementReplyId);
  context.database.prepare(`UPDATE completion_notification_obligations
    SET presentation_reply_id=?,updated_at=?
    WHERE owner_kind='primary-segment' AND presentation_reply_id=?
      AND notification_reply_id IN (
        SELECT dependent_reply_id FROM outbound_reply_prerequisites
        WHERE prerequisite_reply_id=? AND required_state='delivered'
      )`).run(replacementReplyId, new Date().toISOString(), failedReplyId, replacementReplyId);
}
