# Pane Entry Main Mirroring Design

## Goal

Keep every active group-published Pane Entry card synchronized with its
canonical Primary Main Card while preserving one authoritative Binding and
TopicView. A user interacting in the `🧭 herdr-agent-swarm / niru` thread should
see current phase, plan, queue, Worker summary, and runtime metadata on the entry
card instead of the snapshot captured when the thread was created.

## Production evidence

The `niru` Binding has two distinct card identities:

- canonical Main Card `om_x100b650e41ea38b0c149ecbe83925f6`;
- Pane Entry alias `om_x100b656ededb68a0c4313cc596f8919`.

The canonical Main lane continues to deliver increasing versions, while the
alias outbox contains only its original `group_card_create`. The renderer also
labels the alias as a passive snapshot and tells users to consult the original
Main Card. This is intentional old behavior, not a delivery failure.

## Selected design

`MainCardWorkflow` renders both the canonical Main Card and Pane Entry form from
the same hydrated `TopicView`. `MainCardStore.reserveMainCard()` persists the
view and atomically reserves:

1. the canonical Main Card create/update when required;
2. one update for every active alias owned by the exact Binding generation and
   pane.

Each alias update uses:

- the alias root message as its target;
- `pane-entry:<alias-id>` as an isolated durable lane;
- `pane-entry:update:<alias-id>:<view-version>` as its idempotency key;
- the same `live` or `history` work class as the canonical projection;
- the Pane Entry renderer, which remains passive and has no canonical-only
  action buttons.

Repeated convergence at the same version is idempotent. Pending unclaimed alias
updates coalesce through their dedicated lane. Startup convergence can repair an
alias even when the canonical Main Card has already delivered that version. The
method reports `reserved` when either the canonical card or at least one alias
reserved work, so the existing wake path drains both.

## Failure behavior and fences

Only aliases with `state = 'active'`, non-null root identity, and a currently
active/attached Binding whose generation and pane still match qualify. Stale,
reserving, generation-mismatched, or pane-mismatched aliases are ignored.

View persistence and all outbox reservations share the existing SQLite
transaction. A failure while reserving any alias rolls back the canonical intent
and TopicView change; restart can retry from unchanged durable state. A failed
alias delivery quarantines only its isolated alias lane and cannot block the
canonical Main Card or another alias.

## Presentation

The Pane Entry keeps the `HERDR PANE ENTRY · 回复此话题继续交互` subtitle and
passive interaction model. Its footer changes from “consult the original Main
Card” to explicitly state that it follows the current Pane state. The canonical
Main Card remains the workflow authority; both cards are projections only.

## Invariants

- SQLite remains the source of durable projection and alias lifecycle state.
- The alias never becomes a second Binding or workflow authority.
- One alias failure cannot block the canonical Main Card or other aliases.
- Alias update identity is fenced by Binding ID, generation, pane, and alias ID.
- No direct Gateway call occurs from the coordinator or store.
- Projection intent is durable before Gateway delivery.
- Existing Main Card sequence and replacement recovery behavior is unchanged.

## Testing

- Main Card projection reserves canonical and active alias updates together.
- Repeated same-version convergence does not duplicate alias work.
- A stale alias or generation/pane mismatch receives no update.
- Startup convergence repairs an alias when canonical delivery is already
  current.
- An alias delivery failure remains isolated from the canonical Main lane.
- Run Main Card, SQLite, outbox dispatcher, startup, typecheck, build,
  architecture, and full-suite validation.

## Non-goals

- No separate Answer Cards inside the Pane Entry root message.
- No copying visible Lark state back into SQLite.
- No automatic republishing of stale aliases.
- No service installation or restart without separate authorization.
