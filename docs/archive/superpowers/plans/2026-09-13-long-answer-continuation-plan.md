# Long Answer Continuation Implementation Plan

**Goal:** Continue durable Answer pagination beyond the old 64 KiB boundary and
recover existing marker-truncated turns after restart without removing bounds.

## Task 1: Lock the new bounded behavior

- Add a projector regression proving a delta after 64 KiB is emitted.
- Keep a hard-cap test at 512 KiB proving the marker and later suppression.
- Run the focused test red before changing the bound.

## Task 2: Lock legacy detached recovery

- Add a transcript observer test whose persisted Answer ends with the legacy
  truncation marker and whose exact transcript contains a longer matching value.
- Assert recovery publishes one `replace-all` snapshot without the stale marker.
- Add a prefix-mismatch case that leaves durable output unchanged.

## Task 3: Implement bounded continuation

- Raise the typed-output hard budget to 512 KiB.
- Normalize only the exact legacy terminal marker during detached replay.
- Publish a full replacement only after exact-turn and prefix proof.
- Preserve existing suffix append behavior for ordinary detached recovery.

## Task 4: Verify and commit

- Run bounded-output, owned-projector, transcript-observer, Answer workflow, and
  crash-recovery tests.
- Run typecheck, build, architecture checks, the full suite, and diff checks.
- Commit independently; do not install or restart production in this slice.
