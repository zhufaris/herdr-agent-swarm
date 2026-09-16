# CardKit 2.0 Action Layout Compatibility

## Problem

Main Cards started returning Lark HTTP 400 with error code `230099` after
state-driven controls added legacy `tag: "action"` containers to cards that
declare `schema: "2.0"`. The same invalid renderer is used both when creating a
new project topic and when updating existing Main Cards. Project provisioning
therefore pauses safely at `runtime_started`, while existing Main Card updates
retry and eventually dead-letter.

## Design

Render callback buttons as direct `body.elements` entries in CardKit 2.0 cards.
Keep each button's text, type, callback action, binding identity, and
state-dependent visibility unchanged. Do not roll back the interaction workflow
or alter provisioning checkpoints.

Apply the same representation to every repository renderer that currently emits
the legacy action container, including the Main Card and the More Actions card.
This avoids repairing only topic creation while leaving callback response cards
invalid. Forms keep their existing nested button representation because their
layout and submission contract are separate.

## Recovery

No database repair is required. The affected project selection and Binding stay
linked to the already-created Pane at the durable `runtime_started` checkpoint.
After deploying the renderer fix, normal startup recovery calls `createTopic`
again with the same Binding idempotency key, records the returned topic identity,
and activates the Binding without creating another Pane.

Existing Main Card dead letters remain historical delivery records. Normal view
convergence may create fresh valid delivery intent; this change does not bulk
retry unknown dead letters or weaken outbox ordering.

## Verification

- Add a renderer regression test that recursively rejects `tag: "action"` in
  all affected CardKit 2.0 cards and confirms the expected buttons remain.
- Run the focused card renderer and project-selection recovery tests.
- Run TypeScript type checking, the full Vitest suite, and the production build.
- After restart, verify the paused selection becomes completed, Binding
  `<binding-id>` becomes active on Pane `wH:p3N`, and no
  duplicate Pane appears.

## Non-goals

- Redesigning button copy or interaction authorization.
- Changing provisioning or outbox durability semantics.
- Automatically replaying unrelated unknown or permanent dead letters.
