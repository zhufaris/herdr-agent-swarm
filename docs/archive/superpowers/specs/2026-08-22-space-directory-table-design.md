# Space Directory Table Design

## Goal

Render `/herdr spaces` as a compact table so each Pane's identity, state,
process, and thread action can be scanned as one row. Keep human-readable Space
names as the primary grouping and do not expose workspace IDs in the card.

## Card layout

Each configured Space renders as a separate section with its registered
directories above a table. The table columns are:

| Pane | State | Foreground | Thread |
|---|---|---|---|
| `p20` | working | traex | Open thread |

The card header remains `Herdr Spaces`. If the card exceeds the existing size
budget, pagination occurs between Space sections or bounded row groups without
dropping Pane rows. Empty and unavailable Spaces remain visible with an explicit
status row.

Pane IDs are shortened for display by removing the `<workspace>:` prefix. The
full Pane ID and workspace ID remain in action payloads and are never inferred
from display text.

## Row actions

The final column is tied to that row:

- A Pane with an active binding shows `Open thread`. It dispatches the existing
  `open_project_thread` action and uses Lark's native thread-forward operation.
- An eligible unbound TraeX Pane shows `Claim`. It dispatches the existing
  `claim_pane` action with the full project, workspace, and Pane identifiers.
- Other rows show an em dash and have no action.

Lark does not provide a stable thread URL before the native forward operation.
Therefore `Open thread` is an interactive row action, not a fabricated URL.
If the native table schema cannot host an action element in a cell, the renderer
uses a compact row-aligned multi-column layout whose last column contains the
button. It must preserve the same one-row-to-one-action association and must not
move actions into an unrelated footer.

## Safety and compatibility

This change is presentation-only. Existing chat-scope checks, force refresh for
claim, binding validation, thread forwarding, and the prohibition on close or
delete actions remain unchanged. Cards continue to use schema 2.0 and the
existing Lark action callback path.

When several historical bindings reference the same Pane, the directory only
considers bindings owned by the requesting chat that contain a `topicId` or
`rootMessageId`. It prefers `active`, then `draining`, then `archived`; within
the same lifecycle it chooses the most recently updated binding. Bindings from
another chat are never exposed, and a Pane without an eligible binding has no
thread action.

## Verification

Unit tests must assert column ordering, readable Space names, short displayed
Pane IDs, full identifiers in action payloads, row-local open/claim actions,
empty and failure rows, pagination, and absence of close actions. Integration
tests must prove deterministic binding selection, same-chat isolation, that open
forwards the correct thread, and that claim force-refreshes the workspace before binding. A real `/herdr spaces` message is
required after deployment to confirm Lark accepts and renders the chosen native
card structure.
