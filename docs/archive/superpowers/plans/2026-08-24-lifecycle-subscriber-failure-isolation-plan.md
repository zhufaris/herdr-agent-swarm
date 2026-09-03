# Lifecycle Subscriber Failure Isolation Plan

## Goal

Prevent process-local lifecycle subscriber failures from changing an already
durable workflow outcome, while exposing bounded diagnostics through `/status`.

## Test seams

- `BridgeEventBus`: publication, subscriber isolation, named diagnostics, and
  redacted structured logging.
- health server: bounded diagnostics appear only in `/status` and do not change
  `/ready`.
- `PromptRunWorkflow`: a terminal SQLite commit remains completed when the
  lifecycle projector subscriber rejects the terminal notification.

## Steps

- [x] Add failing event-bus tests for synchronous and asynchronous subscriber
  failures, continued fan-out, diagnostics, and safe log context.
- [x] Implement named subscriber registration, all-settled publication, and an
  in-memory diagnostic snapshot in `BridgeEventBus`.
- [x] Add failing health tests, then expose lifecycle diagnostics through
  `/status` without changing readiness.
- [x] Add the terminal workflow regression test and make only the minimum
  integration changes required for it to pass.
- [x] Run focused tests, full tests, typecheck, build, and diff validation.
- [x] Commit the implementation without restarting or deploying the service.

Verification record: focused tests passed 22/22; the full suite passed 49 files
and 355 tests; TypeScript typecheck and the production build passed. The build
identity was `sha256:67251153b03a28ae4f731a8f08edb429e319fc8f937bf1528ee7ca5503d28214`.

## Acceptance criteria

- Subscriber exceptions never reject lifecycle publication.
- Every subscriber present at publication time is invoked exactly once.
- Diagnostics identify only the latest failed subscriber and event metadata; no
  event payload is logged or returned by status.
- Historical subscriber failures do not make `/ready` fail.
- A prompt committed as completed remains completed when terminal projection
  fails.
