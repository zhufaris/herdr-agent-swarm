# Answer Projection Identity Design

## Goal

Make Primary Answer identity and request context deterministic without mixing
Herdr runtime identity with user-visible conversation identity. Remove repeated
Human-message content from the Answer body while preserving canonical Core Agent
Events and stable pagination.

## Domain language

- **Runtime Pane Reference** is Herdr's internal `paneId`. Primary Session owns
  it for observation, ownership, and fencing. It is not a user-facing token.
- **Visible Pane Token** is the normalized native four-character `paneToken`.
  Conversation Projection may show it; it must never synthesize one from a
  Runtime Pane Reference.
- **Run Projection Context** is the project and pane identity copied into a Run
  Projection: Space name, workspace ID, Runtime Pane Reference, Visible Pane
  Token, session title, and Agent kind.
- **Reply Context** is the redacted, single-line request summary shown in an
  Answer header subtitle.

## Design

### Explicit projection context

One pure coordinator helper derives Run Projection Context from a Topic-Pane
Binding and `ProjectCatalog`. All production paths that create a Primary Run
Projection use it: ordinary prompt admission, priority steering, interrupted
continuation, and direct Herdr-turn adoption.

`createQueuedRunCard` requires `spaceName`; it no longer manufactures the value
`unknown`. A missing project route has the existing explicit
`legacy/unresolved` representation from `ProjectCatalog`. The helper keeps
mapping policy local and prevents creation paths from drifting.

### Separate display policies

Operational views may use a Runtime Pane Reference when a Visible Pane Token is
unavailable. Answer headers use a narrower policy that accepts only a Visible
Pane Token and renders `—` when it is unavailable. Because the Answer policy
does not receive `paneId`, leaking an internal Pane ID into a title is not a
representable outcome.

The first Answer page title is:

```text
<space-name> / <visible-pane-token-or-dash>
```

A continuation page appends only its page number:

```text
<space-name> / <visible-pane-token-or-dash> · 第 N 页
```

The request appears once, in the subtitle:

```text
Reply to 👤 <redacted-single-line-request-summary>
```

### Human timeline projection

Core `human_message` events remain canonical Answer timeline facts and remain
persisted. The Answer Card presentation consumes these items without rendering
them. This is a render policy, not a data migration or event filter.

The page planner advances its canonical item cursor across a Human item but adds
no CardKit element. It must continue planning following Agent and Tool items on
the same page. Human items do not create page breaks, empty continuation cards,
or visible projected-item entries. Frozen pages and persisted source cursors
retain their current item-index semantics.

## Failure and recovery behavior

- Missing or invalid native tokens render as `—`; internal Pane IDs remain
  available to ownership, fencing, logs, and operational cards.
- Unresolved project routing renders `legacy/unresolved` and is observable; it
  does not silently degrade to `unknown` or a workspace ID.
- Startup convergence may backfill a newly observed native token into an active
  Run Projection. Frozen Answer pages remain immutable.
- Delivery retries replay only durable CardKit intent. They never resubmit a
  Prompt or rewrite canonical timeline state.

## Verification

- Every production `createQueuedRunCard` caller supplies one shared Run
  Projection Context.
- Type checking fails if a new caller omits Space identity.
- Answer titles never contain an internal Pane ID or duplicate the Prompt title.
- Initial, streaming, completed, recovered, and continuation cards use the same
  title and subtitle policy.
- Human items before, between, and after visible items advance the cursor without
  rendering or forcing pagination.
- Existing Agent/Tool ordering, frozen-page immutability, late Tool results, and
  CardKit size limits remain unchanged.

## Non-goals

- No SQLite schema migration or historical timeline rewrite.
- No removal of Core Agent `human_message` ingestion.
- No change to operational cards that intentionally allow Pane ID fallback.
- No change to Prompt replay, dispatch, or exact-turn fencing semantics.
