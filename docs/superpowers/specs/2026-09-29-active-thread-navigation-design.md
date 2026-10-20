# Active thread navigation card

## Goal

Give a Feishu group one durable, continuously updated navigation card for active
Primary Panes. A user can identify the current Pane by its native token and
open the corresponding conversation without scanning unrelated group messages.

## Scope

Extend the existing `🧭 Swarm Panes` CardKit directory. It remains one
canonical group-root card, driven by the existing durable Topic/Panes projection
and outbound-card update pipeline. It does not create another source of binding
or prompt state.

The card lists only active Primary bindings. Rows sort by most recent durable
`activityAt`, then by title for a stable tie-break. Each row contains the native
Pane token (falling back to the pane ID only when no token exists), title,
state, and a bounded current-task summary. Worker state is a compact count and
summary beneath its owning Primary rather than a second navigation hierarchy.

## Thread entry behavior

Each Primary row has an `打开会话` operation. A verified Feishu message/thread
permalink may be rendered as a direct link only after client validation. The
Open Platform does not publish a stable URI template derived solely from
`root_message_id`, so the initial implementation must not invent one.

Without a verified permalink, the operation uses the existing identity-fenced
card action to forward or reveal the exact Primary thread. The action is bound
to `bindingId`, generation, pane ID, and source root ID. A stale binding is
rejected rather than opening a newer Pane with the same title.

## Data flow and safety

Binding/runtime reconciliation and Core Agent Events update SQLite Topic/Panes
views. The existing directory projection reserves a versioned CardKit update in
the durable outbox. Lark delivery retries only that rendered snapshot; it never
submits, replays, or redirects a TraeX prompt.

The navigation card is presentation-only. It does not change topic ordering,
write Lark-derived state back to SQLite, expose prompt bodies beyond the already
sanitized current-task summary, or add a public HTTP endpoint.

## Tests

Focused rendering and workflow tests must cover:

1. active-Primary filtering and stable recent-activity ordering;
2. native token preference and bounded task text;
3. the identity-fenced `打开会话` fallback action;
4. a direct URL only when an explicitly configured, validated permalink is
   available; and
5. repeated source events coalescing into one versioned directory update.

## Verification

Run the focused directory/card-action tests, `npm run typecheck`, and the full
test suite before installation. Deployment follows the normal active-work
safety gate; no prompt is replayed to validate navigation.
