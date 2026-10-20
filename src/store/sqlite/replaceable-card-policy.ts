export function exactReplaceableCardTargetSql(failed: string, candidate: string): string {
  return `${candidate}.kind = 'card_update'
    AND ${candidate}.gateway_id = ${failed}.gateway_id
    AND ${candidate}.gateway_profile_id = ${failed}.gateway_profile_id
    AND ${candidate}.lane_key = ${failed}.lane_key
    AND ${candidate}.binding_id IS ${failed}.binding_id
    AND ${candidate}.prompt_id IS ${failed}.prompt_id
    AND ${candidate}.worker_id IS ${failed}.worker_id
    AND ${candidate}.worker_session_generation IS ${failed}.worker_session_generation
    AND ${candidate}.worker_turn_id IS ${failed}.worker_turn_id
    AND ${candidate}.root_message_id IS ${failed}.root_message_id
    AND ${candidate}.selection_id IS ${failed}.selection_id
    AND ${candidate}.card_role IS ${failed}.card_role
    AND ${candidate}.target_role IS ${failed}.target_role`;
}
