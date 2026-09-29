# Primary Main Card Pane Name

## Goal

Show the stable Herdr pane name alongside its native pane token in the Primary
Main Card identity row. For a managed pane whose stable name is `nxmz` and whose
native token is `yx0c`, the card renders:

```text
PANE  nxmz · yx0c
```

The name is presentation metadata. The native pane token and pane ID remain the
runtime identity used for routing, fencing, idempotency, and authorization.

## Scope

This change affects only the Primary Main Card identity row. Answer Cards
continue to use their durable session title, and Worker Cards, operational
cards, routing behavior, and pane-control behavior do not change.

When no stable name can be resolved, the Primary Main Card keeps the existing
token-or-pane-ID display. The change must not invent a name from a dynamic
terminal title.

## Stable name resolution

The Herdr adapter exposes a separate optional stable pane name while preserving
the raw pane label. Resolution uses these sources in order:

1. A non-blank pane label.
2. The pane's managed tab label, when it begins with `lark_`; the prefix is
   removed before display. For example, `lark_nxmz` becomes `nxmz`.
3. No stable name.

`terminal_title` and `terminal_title_stripped` are deliberately excluded. They
describe the active terminal task and may change during a turn, so they are not
a stable pane name.

The tab fallback applies only to the recognized `lark_` namespace. An unrelated
tab label is not silently promoted into a pane name. Whitespace is trimmed, and
an empty normalized result is treated as absent.

## Data flow and durability

`HerdrPane` gains an optional presentation-oriented pane-name field. Snapshot
normalization resolves it from the pane and tab records before the value reaches
coordinators. The original `label` remains available for workflows whose
semantics depend specifically on the pane label.

`TopicViewState` gains an optional `paneName`. Binding lifecycle projection and
runtime reconciliation copy the resolved value into the Topic View. Topic Views
are already stored as JSON, so this addition requires no SQLite schema migration.
Legacy views hydrate with no pane name and retain the existing fallback until a
fresh Herdr observation resolves one.

The Main Card renderer receives only the durable Topic View. It does not perform
a live Herdr lookup. This keeps CardKit rendering deterministic across retries,
service restarts, and outbox recovery.

If a later authoritative observation reports a different non-blank stable name,
the normal projection path increments the view version and reserves a refreshed
Main Card. A temporarily missing name does not erase an already persisted stable
name.

## Rendering

The Primary Main Card `PANE` value follows this order:

1. `<paneName> · <paneToken>` when both exist;
2. `<paneName> · <paneId>` when a name and pane ID exist but no token exists;
3. `<paneName>` when only a name exists;
4. the existing token-or-pane-ID fallback when no name exists.

Each component uses the existing card escaping and bounding behavior. Repeated
identical values are collapsed so the card never renders forms such as
`nxmz · nxmz`.

## Safety boundaries

- Pane name never participates in binding lookup, runtime identity matching,
  generation fencing, prompt dispatch, steering, stop, or close operations.
- Existing pane label behavior for discovery, rename reconciliation, and Worker
  naming remains unchanged.
- No coordinator writes directly to Lark. The durable Topic View and outbox
  remain the only Main Card publication path.
- Missing or malformed tab metadata degrades to the current identity display
  and does not block reconciliation.

## Verification

Focused tests cover:

1. Snapshot normalization prefers a non-blank pane label.
2. A blank pane label falls back from `lark_nxmz` to `nxmz`.
3. An unmanaged tab label does not become a pane name.
4. Topic View reduction persists a resolved pane name without clearing it on a
   later observation that omits the name.
5. Primary Main Card rendering produces `nxmz · yx0c`.
6. Missing-name rendering remains the current token-or-pane-ID value.
7. Existing Answer Card and Worker Card snapshots remain unchanged.

After focused Vitest coverage, verification runs `npm run typecheck`,
`npm run build`, and the full `npm test` suite because the change crosses the
Herdr adapter, durable projection, and CardKit rendering boundaries.

Installation and service restart are separate from implementation. Before a
restart, the existing active-work safety gate must be inspected; this design does
not authorize a forced restart.
