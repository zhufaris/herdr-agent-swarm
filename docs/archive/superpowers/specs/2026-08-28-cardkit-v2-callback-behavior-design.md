# CardKit 2.0 Callback Behavior Compatibility

## Problem

CardKit 2.0 renders direct button elements, but a visible button does not emit
`card.action.trigger` unless it declares a callback behavior. The bridge's
direct buttons currently place callback data in the legacy top-level `value`
field. As a result, Main Card controls such as `立即补充`, `查看队列`, and
`更多操作` are visible but inert.

## Design

Introduce one pure CardKit callback-button constructor. It renders callback
payloads only as:

```json
{
  "behaviors": [
    { "type": "callback", "value": { "action": "..." } }
  ]
}
```

Use the constructor for every non-form callback button in the card renderers.
Keep buttons directly under `body.elements`; do not restore the legacy
`tag: "action"` container. Form-submit buttons use the CardKit 2.0
`form_action_type: "submit"` field and also carry their business payload in a
callback behavior.

The Lark adapter continues reading the normalized callback from
`data.action.value`. Workflow authorization, generation fencing, idempotency,
and durable state transitions remain unchanged.

## Verification

- Renderer tests assert that Main Card and More Actions buttons carry exactly
  one callback behavior and no top-level `value`.
- Renderer tests cover the reported running-state controls: `立即补充`,
  `查看队列`, and `更多操作`.
- Renderer tests cover the supplement form's submit and callback behaviors.
- Completing a steering RunCard must not make its still-running parent TopicView
  complete; startup convergence prefers an active parent RunCard over a newer
  completed steering card.
- Existing card-interaction integration tests prove the normalized payload
  still reaches the current workflows.
- Run focused tests, type checking, the full suite, and the production build.

## Non-goals

- Changing button labels, visibility, authorization, or interaction outcomes.
- Restoring CardKit 1.0 action containers.
- Changing Lark callback normalization.
