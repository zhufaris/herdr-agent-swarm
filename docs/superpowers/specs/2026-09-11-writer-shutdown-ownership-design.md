# Writer Shutdown Ownership Design

## Goal

Preserve the fenced single-writer invariant when a write-capable runtime
component cannot prove that it stopped cleanly. Shutdown must never deactivate
the SQLite write fence, release the instance lease, or close the database while
such a component may still execute durable work.

## Decision

`BridgeRuntimeShutdown` treats both of these outcomes as unsafe:

- a writer's `stop()` promise remains unsettled after the shared shutdown
  deadline and final settlement allowance;
- a writer's `stop()` promise rejects, even if the rejection is caught for
  orderly shutdown logging.

If either outcome occurs, shutdown returns `ownership_retained`. The existing
`unsettledWriters` result field contains the ordered, de-duplicated set of all
unsafe writer component names for API compatibility. Structured diagnostics
separately report failed and still-unsettled writer names.

Failures from non-writer cleanup components remain best-effort. They are logged
but do not prevent write-fence deactivation, lease release, or database close.
This distinction follows capability rather than shutdown stage: only a component
that can still mutate durable state can require ownership retention.

## Shutdown sequence

1. Stop every registered component in lifecycle order with one immutable
   deadline context.
2. Record stop failures without skipping later cleanup components.
3. Give writer promises the existing final settlement allowance.
4. Build the unsafe-writer set from failed or unsettled writer entries.
5. If the set is non-empty, keep the write fence, lease, and SQLite connection
   owned and return `ownership_retained`.
6. Otherwise deactivate the fence, release the lease, close SQLite, and return
   `completed`.

Repeated shutdown calls share the same promise and therefore cannot run a
second ownership-release sequence.

## Error handling and observability

The existing per-component failure event remains the first diagnostic record.
The terminal unsafe-writer event includes:

- all unsafe component names;
- the subset whose stop rejected;
- the subset still unsettled;
- `outcome: ownership_retained`.

The process exits unsuccessfully through the existing `main.ts` policy when
ownership is retained. No automatic lease handoff or forced database close is
attempted.

## Verification

Focused tests cover:

- writer rejection retains the fence, lease, and store;
- non-writer rejection still permits normal ownership release;
- failed and unsettled writers are reported together;
- repeated shutdown calls share one result;
- existing timeout, lifecycle ordering, and managed-runtime behavior remain
  unchanged.

The release gate is the focused runtime shutdown suites followed by typecheck,
build, architecture checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- Cancelling every individual writer operation in this slice.
- Changing the lease protocol or SQLite fence implementation.
- Treating non-writer cleanup failures as ownership hazards.
- Installing, restarting, or deploying the service.
