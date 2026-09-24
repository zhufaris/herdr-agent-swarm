# Runtime Health Snapshot Implementation Plan

## Objective

Extract health observation policy from the HTTP adapter while preserving every
endpoint contract, readiness gate, degradation rule, cache behavior, failure
isolation guarantee, and lifecycle ownership decision.

## Step 1: Characterize the collector interface

Add `tests/health-snapshot-collector.test.ts` with focused tracer tests through
`readiness()` and `status()`. Prove fail-closed required dependencies,
isolated/redacted diagnostic failures, and single-flight cache behavior without
opening an HTTP listener.

## Step 2: Extract `HealthSnapshotCollector`

Create `src/health/health-snapshot-collector.ts`. Move workspace readiness
probing and caching, volatile readiness inspection, operational and diagnostic
collection, degradation classification, safe bounded failures, and status caching
from the server. Preserve provider read counts and non-cacheable failure behavior.

## Step 3: Reduce the HTTP adapter

Construct one collector in `startHealthServer`. Route `/ready` and `/status`
through its two reads. Keep `/health`, GET/HEAD enforcement, 404/405 responses,
JSON serialization, listener errors, and server close behavior unchanged.

## Step 4: Audit lifecycle ownership and enforce seams

Retain `ManagedBridgeRuntime`, `RuntimeLifecycleLedger`, and
`BridgeRuntimeShutdown` after confirming every write-capable runtime is
registered before or with start and unsafe writers retain the fence, lease, and
store. Add architecture guards that HTTP transport does not inspect stores,
providers, or degradation policy. Update the architecture map and mark the final
inventory seam complete.

## Step 5: Verify

Run collector and HTTP health tests, managed lifecycle and shutdown tests,
architecture tests, typecheck, build, architecture check, docs audit, full tests,
and `git diff --check`. Commit implementation separately; do not install,
restart, or push.
