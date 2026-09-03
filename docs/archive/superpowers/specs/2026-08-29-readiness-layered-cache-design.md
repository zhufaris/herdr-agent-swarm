# Readiness Layered Cache Design

## Status

Approved for implementation under the operator's standing instruction to use the recommended design without another confirmation gate.

## Problem

The health server caches the complete readiness response for two seconds. This avoids repeated Herdr workspace probes, but it also caches cheap volatile state: SQLite access, project-directory validation, Lark connectivity, lease ownership, and instance-runtime readiness. A lost lease or disconnected Lark client can therefore remain falsely ready for the cache TTL.

## Design

Cache only the asynchronous Herdr workspace component. Keep its TTL and concurrent-request coalescing. On every readiness request, synchronously inspect database, projects, Lark, lease, and optional instance runtime, then combine those current values with the cached workspace result. Preserve the response schema and status rules.

The cache stores no aggregate `Readiness` object. Workspace failures remain cached for the same bounded TTL to avoid hammering Herdr. A cache refresh rejection still clears the in-flight promise so a later request can retry.

## Testing

Within a nonzero TTL, make an initial ready request, then flip lease, Lark, and instance-runtime state while counting workspace probes. The next request must immediately return 503 while the workspace probe count remains one. Existing concurrent-request coverage continues to prove coalescing.

## Deployment

No configuration or response-schema migration is required. Do not restart production while unrelated runtime source remains uncommitted.
