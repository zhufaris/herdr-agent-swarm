# Answer Card Pane Identity Design

## Problem

Lark topic roots remain interactive cards, so the topic list can continue to
show the client-owned `[Card Message]` label. Main Cards already identify their
binding, but Answer Cards show only the request title. When several panes are
active in the same group, a streamed, completed, or paginated answer therefore
does not visibly identify the pane that produced it.

The bridge cannot reliably derive a friendly pane name from `paneId` during
rendering. The binding title is already the durable product-level session label
and is formatted as `<space> / <pane name>`, with the pane ID used when no
friendly name exists.

## Considered approaches

1. Resolve the pane name from a fresh Herdr snapshot whenever an Answer Card is
   rendered. This keeps no extra projection data, but makes rendering depend on
   live runtime availability and can rename historical pages inconsistently.
2. Render only `spaceName / paneId` from the existing Run Card view. This is
   durable and simple, but discards the friendly pane name the user asked for.
3. Persist the binding title on each Run Card view and render it with a safe
   fallback. This keeps every page stable across retries and restarts while
   preserving backward compatibility. This is the selected approach.

## Design

Add an optional `sessionTitle` field to `RunCardView`. New ordinary and steering
Run Cards receive the current `binding.title` when they are created. Converting
a rejected automatic steering request into an ordinary queued turn carries the
same session title forward.

Startup view convergence compares persisted Run Cards with their binding and
backfills or refreshes `sessionTitle` from `binding.title`. A changed value is a
normal projection update: increment `viewVersion` and update the timestamp so
the durable publisher can converge the visible card. Keeping the field optional
allows existing SQLite JSON views to load before convergence without a schema
migration.

Answer Card rendering uses one pure subtitle helper for streaming, completed,
and paginated variants:

```text
<sessionTitle> · <request title>
```

If `sessionTitle` is absent or blank, the helper constructs
`<spaceName> / <paneId>`; if the pane ID is also unavailable, it retains the
space name. The combined subtitle is bounded with the existing title-length
policy. Answer Card headers remain `✨ TraeX 回复`, continuation-page variants,
and `✅ TraeX 回复已完成`. The thread root, Main Card, Request Card, card summary,
and delivery topology do not change.

## Durability and safety

The new value is presentation metadata copied from the binding authority. It
does not change prompt dispatch, FIFO ordering, steering eligibility, answer
offsets, CardKit stream sequence, outbox idempotency, or Lark thread ownership.
Frozen Answer Card pages remain frozen; new or currently projected cards use
the stored identity. No runtime Herdr lookup is added to the publisher.

## Verification

Tests cover the subtitle on streaming, completed, and later-page Answer Cards,
including the pane-ID fallback. Coordinator tests verify that new ordinary and
steering views capture `binding.title`, conversion preserves it, and startup
convergence backfills a legacy view. Then run the affected Vitest files, the
full suite, TypeScript type checking, and a production build.

Deployment is separate from implementation. Before any restart, inspect active
and uncertain work using the existing restart gate. This design does not grant
permission for a force restart.
