export const actionablePrimaryAnswerProjectionDebtSql = `
  FROM run_cards card
  JOIN bindings binding ON binding.id = card.binding_id
    AND binding.generation = card.binding_generation
    AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
  JOIN completion_action_sets action ON action.owner_kind = 'primary-prompt'
    AND action.owner_id = card.prompt_id AND action.owner_generation = card.binding_generation
    AND action.binding_id = card.binding_id AND action.binding_generation = card.binding_generation
    AND action.state IN ('available','consumed','superseded')
  JOIN answer_pages page ON page.prompt_id = card.prompt_id
    AND page.page_index = action.page_index AND page.card_id = action.card_id
    AND page.message_id = action.card_message_id AND page.state IN ('active','finished')
  WHERE card.phase = 'completed' AND card.view_version > card.answer_delivered_version
    AND page.page_index = (SELECT MAX(latest.page_index) FROM answer_pages latest WHERE latest.prompt_id = card.prompt_id)
`;

export const unrepresentedPrimaryAnswerProjectionDebtSql = `
  ${actionablePrimaryAnswerProjectionDebtSql}
    AND NOT EXISTS (
      SELECT 1
      FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      WHERE recovery.state IN ('unresolved','replacement_pending')
        AND failed.card_role = 'answer' AND failed.prompt_id = card.prompt_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM outbound_replies pending
      WHERE pending.state = 'pending' AND pending.card_role = 'answer'
        AND pending.prompt_id = card.prompt_id
    )
`;
