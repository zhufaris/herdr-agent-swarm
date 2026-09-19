# Reconciliation Lifecycle Simplification Design

## Problem

`CardContextRebuilder` maintains its own timer, active-promise, stop flag, wake
subscription, and error isolation even though `CoalescingDrain` already owns that
lifecycle. Its current `requestScan()` returns the active pass without remembering
a wake that arrives during that pass, so durable invalidations can wait until the
next periodic scan. Runtime reconciliation also loads orphaned bindings but omits
them from its pane ownership map, causing an indexed SQLite lookup for each such
pane.

## Decision

- Delegate Card Context scheduling to `CoalescingDrain`. Keep projection batching,
  no-progress detection, durable invalidations, and outbound wake-up behavior inside
  `CardContextRebuilder`. Explicit `requestScan()` continues to surface the current
  pass failure to callers, while background start/wake failures remain logged and
  recoverable on later wakes.
- Seed the runtime reconciliation pane map with both active and orphaned bindings.
  Existing convergence remains limited by lifecycle policy, while ownership checks
  no longer repeat SQLite reads for bindings already loaded in the pass.

No payload queue is added, no durable authority moves out of SQLite, and discovery
remains serial.

## Verification

- Prove a wake received during an active Card Context pass causes exactly one
  follow-up pass.
- Preserve explicit scan error propagation, background error isolation, stop
  semantics, batching, and no-progress protection.
- Prove an orphaned pane is classified from the pass-local map without calling
  `findBindingByPane`.
- Run focused tests, typecheck, build, architecture validation, and the full suite.

