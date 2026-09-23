# Health Workspace Probe Concurrency

## Goal

Bound Herdr workspace validation fan-out from the health server so a large project
registry cannot create an unbounded burst of external commands.

## Current problem

`/ready` and `/status` share a short-lived readiness cache, but a cache refresh
validates every unique workspace with one unbounded `Promise.all`. Project
configuration has no fixed maximum size, so one refresh can submit every Herdr
workspace assertion at once. This competes with reconciliation and interactive
work precisely when Herdr may already be degraded.

## Chosen design

Use the existing ordered `mapWithConcurrency` helper with a fixed concurrency of
four. Each workspace still produces one independent success or safe bounded error
entry, and the returned workspace order remains stable. Readiness caching and
in-flight refresh coalescing remain unchanged.

Serial probing would avoid bursts but unnecessarily multiply health latency. An
adaptive pool would add state and tuning without evidence that health probes need
it. Four matches the repository's existing bounded Herdr discovery policy.

## Boundaries

- Only health workspace assertions are affected.
- No workflow, SQLite, outbox, prompt, or reconciliation state changes.
- Every unique workspace is still checked on each uncached refresh.
- Partial failures remain visible without cancelling healthy probes.

## Verification

- A readiness request with more than four unique workspaces never runs more than
  four assertions concurrently.
- All workspaces are eventually represented in the response.
- Existing readiness caching, redaction, and partial-failure tests remain green.
