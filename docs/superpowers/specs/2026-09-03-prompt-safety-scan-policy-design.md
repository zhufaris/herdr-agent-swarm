# Prompt Safety Scan Policy Extraction

## Purpose

Reduce the application-policy surface in `PromptRunWorkflow` without changing
durable prompt execution. The workflow currently owns both the side effects of
a safety scan and deterministic decisions derived from its result. This change
moves only the deterministic decisions into a pure module.

## Scope

Create `src/coordinator/prompt-safety-scan-policy.ts`. Given a durable scan
result, the base interval, and the previous consecutive idle count, it returns:

- a redacted diagnostic summary of discovered ordinary, steering, detached,
  cancelled, and failed-detached work;
- whether the scan outcome is `idle` or `work_found`;
- the updated consecutive idle count; and
- the next scan delay.

The policy uses exponential idle backoff from the configured base interval and
caps the multiplier at 6. Any discovered hint, cancellation, or failed
detached convergence resets the idle count and schedules the base interval. A
scan failure is handled by the workflow as a base-interval retry and resets the
idle count; it deliberately does not expose the failure detail through the
diagnostic projection.

## Boundaries

`PromptRunWorkflow` remains the application orchestrator. It continues to:

- invoke `PromptRunStore.scanDurablePromptWork()`;
- clear stale in-memory detached/transcript-conflict tracking;
- publish each durable wake-up hint to `PromptWorkScheduler`;
- emit aggregate convergence and failure logs;
- arm and clear the runtime timer; and
- expose the existing prompt-worker diagnostic snapshot.

The policy has no dependency on SQLite, Herdr, Lark, timers, clocks, logging,
or prompt identity. It cannot authorize dispatch, replay, or a durable state
transition.

## Invariants

- SQLite remains the authoritative source for prompt work; a scan is only a
  durable-work discovery pass.
- Wake-ups remain best-effort hints emitted only after durable state exists.
- FIFO dispatch, no-replay handling, detached observer recovery, lease fences,
  and shutdown behavior remain unchanged.
- The diagnostic summary is aggregate-only and contains no prompt, binding,
  message, or terminal-content identity.
- At most one safety timer is active, and stopped workflows never re-arm one.

## Verification

Add direct policy tests for idle backoff, cap behavior, work discovery reset,
terminal convergence classification, and aggregate-only summaries. Retain the
existing `PromptRunWorkflow` safety-scan tests to verify timer ownership,
durable hint wake-up, shutdown behavior, and diagnostic integration. Run the
focused tests, typecheck, build, and `git diff --check` before committing the
implementation as a separate theme.
