# CardKit Form Submit Fix Design

## Problem

The instance creation and steering cards render their submit buttons with
`form_action_type: "submit"`. CardKit 2.0 requires
`action_type: "form_submit"`. The invalid button contract prevents the client
from producing the expected `card.action.trigger`, so clicking `创建实例` can
fail before the bridge persists an instance or operation.

## Design

Change the shared `formSubmitButton()` helper to emit the canonical CardKit 2.0
field and value. Do not emit both old and new fields: the old field is not part
of the protocol and retaining it would leave an ambiguous payload. This single
boundary change fixes both instance creation and steering forms. Ordinary
callback buttons remain unchanged.

Lock the contract down at two levels. Card rendering tests assert that form
submit buttons contain `action_type: "form_submit"` and do not contain
`form_action_type`. An integration test feeds a representative Lark
`card.action.trigger` form payload through normalization and the instance
interaction workflow, proving that the normalized values reach instance
creation.

## Safety and rollout

The fix does not change persistence, authorization, idempotency, or lifecycle
rules. Existing callback-boundary logging remains redacted. After focused and
full verification, build the plugin, inspect current active and uncertain work,
and use the existing safe restart gate. A live click is performed only after a
safe restart; no force restart is allowed.
