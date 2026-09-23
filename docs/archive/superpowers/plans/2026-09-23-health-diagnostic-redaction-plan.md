# Health Diagnostic Redaction Implementation Plan

## Objective

Apply the shared safe error boundary to health collection failures and retained
Herdr circuit-breaker diagnostics without changing health or recovery behavior.

## Work packages

### 1. Capture the leak as public behavior

- Add an HTTP health-server regression in `tests/health-server.test.ts` that
  throws a credential-bearing Herdr readiness error and asserts both `/ready`
  and `/status` omit the credential while retaining useful context.
- Add a circuit-breaker regression in `tests/herdr-circuit-breaker.test.ts` that
  asserts its status snapshot stores a redacted failure.
- Run both focused tests and confirm they fail against the current code.

### 2. Apply the shared error boundary

- Replace the health server's local raw slice with `safeLogError`.
- Replace the circuit breaker's raw retained message with `safeLogError`.
- Keep thrown errors, diagnostic types, and health decisions unchanged.

### 3. Verify and commit

- Re-run the focused tests.
- Run typecheck, build, documentation audit, public-release audit, and the full
  test suite.
- Review for unintended schema or status changes and commit without deployment or
  push.
