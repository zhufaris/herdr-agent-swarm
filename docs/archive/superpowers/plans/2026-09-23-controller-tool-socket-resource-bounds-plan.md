# Controller Tool Socket Resource Bounds Implementation Plan

## Objective

Give the Controller tool gateway the same bounded connection-admission and idle
client behavior as the Primary tool gateway.

## Work packages

### 1. Lock down socket behavior

- Extend `tests/controller-tool-gateway.test.ts` to construct the gateway with
  deterministic small timeout and connection-limit values.
- Verify an idle connection closes without sending a request.
- Verify a second connection is rejected while the first occupies the only slot,
  then verify capacity is released after close.

### 2. Implement the resource boundary

- Add optional `idleTimeoutMs` and `maxConnections` constructor policy.
- Add production defaults matching `PrimaryToolGateway`.
- Add an explicit accepting flag, bounded admission, unreferenced idle timer,
  one-request data listener, and socket-error handling.
- Preserve request parsing, authorization, response schema, and shutdown cleanup.

### 3. Verify and commit

- Run the Controller gateway tests before and after implementation.
- Run typecheck, build, documentation/public audits, and the full test suite.
- Archive completed records, inspect the final diff, and create a local commit
  without deployment or push.
