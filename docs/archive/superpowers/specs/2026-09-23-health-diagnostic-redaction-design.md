# Health Diagnostic Redaction

## Goal

Prevent credentials embedded in runtime failures from appearing in the local
`/ready` and `/status` diagnostic endpoints while preserving their operational
detail, schemas, health decisions, and bounded response behavior.

## Current problem

The health server's exception boundary uses a private prefix-only string slice.
It does not apply the service's standard credential redaction. The Herdr circuit
breaker also retains a raw bounded exception message in its status snapshot,
even though it logs the same failure through `safeLogError`. A command error can
therefore be safe in Pino output but expose a token through loopback diagnostics.

Loopback binding reduces reachability but is not a secrecy boundary: any process
running as another local user may be able to read an unauthenticated TCP endpoint.

## Chosen behavior

Use `safeLogError(error).message` at both diagnostic ownership boundaries:

- the health server converts exceptions thrown while collecting readiness and
  status diagnostics into the shared safe error representation;
- the Herdr circuit breaker stores the shared safe representation when it records
  its last transport failure.

This fixes data at its source instead of recursively rewriting arbitrary status
objects during HTTP serialization. Typed component snapshots retain their exact
shape and semantics. Components that expose error fields remain responsible for
storing safe diagnostics at their own error-capture boundary.

## Compatibility and security

No endpoint, status code, component state, degradation rule, TTL, or JSON field
changes. Short non-secret errors remain unchanged. Long errors gain the shared
head-and-tail diagnostic summary introduced for logs, still bounded to 500
characters. Full-message redaction occurs before truncation.

The circuit breaker continues to rethrow the original error to its caller. Only
the retained diagnostic copy changes, so transport classification, failure counts,
open/half-open behavior, and Prompt no-replay semantics remain unchanged.

## Verification

- `/ready` redacts a credential in a Herdr workspace exception.
- `/status` redacts the same cached readiness diagnostic.
- Herdr circuit-breaker status redacts its retained last failure while the caller
  still receives the original failure.
- Existing health and circuit-breaker tests remain unchanged and pass.
- Typecheck, build, and the full Vitest suite pass.
