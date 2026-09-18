# Terminal Binding Runtime Convergence Eligibility

**Date:** 2026-09-18

## Problem

`HerdrRuntimeReconciler` intentionally uses `findBindingByPane()` while walking
live Herdr panes. That lookup includes historical bindings so an archived pane
remains owned and cannot be rediscovered as a new Lark session. The returned
binding is then passed to `BindingRuntimeConverger.converge()`.

Today, `converge()` checks legacy Agent identity and runtime compatibility before
checking the binding lifecycle. An archived binding whose still-live pane has a
retired or incompatible runtime therefore enters `orphan()`. The domain state
machine correctly rejects `pane_probe_failed` for `archived/attached`, producing
a recurring `pane-reconciliation-failed` warning:

```text
Cannot pane_probe_failed session in archived/attached
```

The rejected transaction does not corrupt durable state, but the warning repeats
on startup and later reconciliation passes. It makes reconciliation diagnostics
less trustworthy and spends work evaluating a binding that is no longer eligible
for automatic runtime convergence.

## Goals

- Make runtime convergence explicitly eligible only for bindings whose lifecycle
  is `active` or `draining`.
- Preserve historical pane ownership so an archived pane is not rediscovered as
  a new session.
- Preserve automatic recovery for active orphaned bindings.
- Preserve mismatch and missing-pane handling for active and draining bindings.
- Eliminate invalid lifecycle transitions and their repeated warning noise without
  changing durable state, cards, events, or delivery intent.

## Non-goals

- Do not delete, close, detach, or rewrite archived bindings or their panes.
- Do not change the `findBindingByPane()` contract globally; provisioning and
  explicit attachment workflows rely on seeing historical ownership.
- Do not broaden the state machine so archived, closed, failed, or provisioning
  sessions accept `pane_probe_failed`.
- Do not change orphan recovery identity fences, prompt replay behavior, CardKit
  rendering, or outbox semantics.
- Do not add a new module, store query, configuration switch, or schema migration.

## Design

`BindingRuntimeConverger` owns the lifecycle eligibility rule because every caller
crosses that seam to apply a live Herdr observation to a durable binding. At the
start of `converge()`, before legacy identity, compatibility, metadata, recovery,
or projection work, it returns when the lifecycle is neither `active` nor
`draining`.

Conceptually:

```ts
if (binding.lifecycle !== "active" && binding.lifecycle !== "draining") return;
```

This keeps the module deep: callers may pass any binding found for a pane and do
not need to duplicate the lifecycle transition table. The existing lookup still
claims the pane for routing purposes, while the converger alone decides whether
that owner may consume runtime observations.

No new logging is added for the expected skip. Archived panes are durable history,
not reconciliation failures. A periodic debug record would add recurring noise and
stateful log deduplication would add complexity without operational value.

## Lifecycle behavior

| Binding lifecycle | Runtime convergence | Result |
| --- | --- | --- |
| `active` | Eligible | Existing observation, degradation, orphan, recovery, rename, event, and wake-up behavior remains unchanged. |
| `draining` | Eligible | Existing observation and missing/mismatched runtime handling remains unchanged while the final active turn drains. |
| `provisioning` | Ineligible | Provisioning workflows remain the sole owner of partial runtime setup. |
| `archived` | Ineligible | The pane remains historically owned; no durable or external effect occurs. |
| `closed` | Ineligible | No runtime observation is applied to the terminal session. |
| `failed` | Ineligible | Explicit recovery or attachment workflows remain the only routes out of failure. |

The eligibility check is based on lifecycle rather than the legacy `state` field.
Lifecycle is the authoritative transition dimension, and using both fields would
create a second, partially overlapping state machine.

## Data flow and effects

For an ineligible binding, the flow ends inside `BindingRuntimeConverger`:

```text
fresh Herdr snapshot
  -> findBindingByPane (historical ownership retained)
  -> BindingRuntimeConverger.converge
  -> lifecycle eligibility check
  -> return with no effect
```

There is no SQLite write, lifecycle publication, scheduler wake-up, CardKit
render, outbox reservation, runtime probe, worktree lookup, or external-turn
observation. The reconciler continues processing later panes normally.

## Error handling

The skip is an expected domain decision, not an error, so it is not caught or
reported as a reconciliation failure. Errors from eligible bindings retain the
existing per-pane failure isolation and structured warning behavior.

The state machine remains strict. If another path attempts an invalid transition,
`transitionSession()` must continue throwing rather than silently accepting it.
The fix removes the invalid caller behavior instead of weakening the invariant.

## Verification

Focused reconciliation tests will prove:

1. An `archived/attached` binding with an incompatible live pane remains unchanged,
   emits no lifecycle event or outbound intent, and does not produce
   `pane-reconciliation-failed`.
2. `provisioning`, `closed`, and `failed` bindings are not mutated by runtime
   convergence.
3. An active binding with an incompatible runtime is still orphaned.
4. An active orphaned binding with the exact persisted runtime identity is still
   recovered.
5. A live pane owned by an archived binding is not passed to discovery and does
   not create a second binding.

After focused tests, run `npm run typecheck`, `npm run architecture:check`,
`npm run docs:audit`, `npm run build`, `git diff --check`, and `npm test`.
Production installation and restart remain separate operator actions behind the
existing active-work safety gate.

## Rejected alternatives

### Filter only in `HerdrRuntimeReconciler`

This would suppress the current call path but leave `BindingRuntimeConverger`
unsafe for targeted reconciliation or future callers. It also spreads knowledge
of eligible lifecycle states across orchestration code.

### Restrict `findBindingByPane()` to active bindings

This would make archived panes appear unowned and eligible for automatic
discovery, risking duplicate bindings and incorrect Lark routing. It would also
change unrelated attachment and observation callers.

### Permit `pane_probe_failed` from archived lifecycle

This weakens the state machine and mutates terminal history in response to live
runtime drift. Archived sessions must remain immutable unless an explicit
reattachment or cleanup workflow acts on them.
