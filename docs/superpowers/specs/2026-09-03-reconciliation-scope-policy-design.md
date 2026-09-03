# Reconciliation Scope Policy Extraction

## Purpose

Separate deterministic reconciliation-request scope decisions from the Herdr
runtime adapter and durable binding convergence. `HerdrRuntimeReconciler`
currently decides whether a running or recently completed pass already covers a
new request, and merges requested workspace scopes while also owning snapshots,
SQLite transitions, lifecycle events, and scheduling.

## Scope

Create `src/coordinator/reconciliation-scope-policy.ts` with pure functions
that operate on workspace scope values:

- `undefined` represents no queued request;
- `null` represents an all-workspace reconciliation; and
- a set represents an explicit workspace scope.

The policy will determine whether an active scope covers an incoming request,
whether a recent completed scope is still within the cooldown window, and how
to merge a queued request with another requested scope. A full request absorbs
all scoped requests; two scoped requests are unioned; duplicate workspace IDs
do not change the result.

## Boundaries

`HerdrRuntimeReconciler` retains all side effects and all workflow ownership:

- calls to `listAllPanes`, `listPanes`, and `observeRuntime`;
- mapping live panes to configured projects;
- SQLite binding/projection transitions and identity fences;
- lifecycle publishing, prompt wake-ups, failure logs, metrics, timers, and
  the in-flight Promise lifecycle; and
- recording the timestamps of successfully reconciled workspaces.

The policy has no dependency on Herdr, SQLite, Lark, clocks, promises, loggers,
or binding/pane identity. It cannot cause a reconciliation run by itself.

## Invariants

- A scoped request is coalesced only if the active or recent successful pass
  covers every requested workspace.
- An all-workspace request is never considered covered by a scoped pass.
- A cooldown decision uses only successfully recorded completion timestamps; it
  must not suppress a request after a failed run.
- Scope merging changes only best-effort request scheduling. Each run still
  obtains authoritative Herdr observations and converges SQLite state normally.
- The refactor preserves existing cooldown duration, metrics increments, and
  pending-run drain order.

## Verification

Add direct policy tests for full/scoped coverage, deduplicated merges, cooldown
boundaries, and empty requested scopes. Retain the runtime reconciler tests for
coalesced calls, `w1` then `w2` sequencing, duplicate in-flight requests, and
recent-pass cooldown behavior. Run focused tests, typecheck, build, and
`git diff --check` before an isolated refactor commit.
