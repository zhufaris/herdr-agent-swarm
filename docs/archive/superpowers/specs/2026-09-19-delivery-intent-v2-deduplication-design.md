# Delivery Intent V2 Deduplication Design

## Problem

Each durable outbound reply currently stores the same materialized body in
`payload` and in `intent_json.materializedPayload`. Once delivery preparation
runs, the provider-neutral Gateway plan can contain another materialized copy.
The duplicate intent body adds substantial SQLite and WAL write volume without
providing independent recovery information.

## Design

Delivery intent schema version 2 stores only the typed delivery kind:

```json
{ "schemaVersion": 2, "kind": "card" }
```

The canonical materialized body remains in `outbound_replies.payload`. The
materializer accepts both formats: version 1 returns its embedded immutable
body for compatibility, while version 2 returns the row's canonical payload.
New enqueue operations and SQLite fallback triggers write version 2.

The schema migration upgrades the fallback triggers once and records migration
46. The existing retention maintainer then rewrites valid version 1 intent
envelopes incrementally when their kind matches the persisted `intent_kind`,
their embedded body is identical to `payload`, and the renderer revision is
supported. Rows that are malformed, mismatched, or otherwise ambiguous remain
untouched and continue to fail closed at delivery.

Compaction may update previously claimed delivered or dismissed rows, so the
claim-immutability trigger admits only that exact byte-equivalent v1-to-v2
transition. Pending and dead-letter rows that were ever claimed remain
unchanged. Compaction does not change payload, state, claims, checkpoints,
delivery plans, hashes, lanes, or recovery evidence, and it dispatches no
delivery or TraeX work.

## Compatibility and Safety

- Existing version 1 records remain readable across restart.
- New version 2 records pin their immutable body through the existing canonical
  payload and claimed-row immutability trigger.
- Invalid typed intents never fall back silently to payload.
- Existing claim payload hashes continue to validate because migration runs
  before dispatch ownership starts; an interrupted migration rolls back fully.
- Gateway plans remain unchanged in this milestone; post-ACK plan compaction is
  a separate optimization with a different recovery proof boundary.

## Acceptance

- Newly enqueued replies persist a version 2 intent without materialized body.
- Version 2 materializes the canonical row payload.
- Version 1 materializes its embedded payload for backward compatibility.
- Reopening an existing database converts only safe version 1 envelopes and is
  idempotent.
- Claimed, delivered, dead-letter, and recovery state is otherwise unchanged.
- Focused tests, full tests, typecheck, build, architecture audit, docs audit,
  and public audit pass.
