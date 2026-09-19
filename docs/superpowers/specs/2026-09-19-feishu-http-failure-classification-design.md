# Feishu HTTP Failure Classification Design

## Problem

The Feishu gateway currently classifies an unrecognized HTTP 400 response as an
unknown failure even though the provider rejected the request. The durable outbox
therefore retries the same malformed or invalid-target operation five times before
dead-lettering it. Production logs show this exact pattern for provider code
`230011`.

## Goal

- Stop retrying HTTP responses that conclusively reject a request and are not
  retryable by protocol semantics.
- Preserve retries for overload, timeout, conflict, and server-side failures.
- Preserve provider-code-specific recovery such as stale Main Card rebuilding.
- Keep the durable outbox, idempotency, quarantine, and no-Prompt-replay boundaries
  unchanged.

## Decision

Classification remains at the Feishu adapter boundary. Known permanent provider
codes continue to take precedence. Otherwise:

- HTTP `408`, `409`, `425`, and `429` are transient;
- HTTP `500` through `599` are transient;
- all other HTTP `400` through `499` responses are permanent and rejected;
- pre-connect failures are transient;
- timeouts and transport failures with an uncertain effect remain unknown.

This is preferred over adding only code `230011` because the retry decision is an
HTTP transport property and malformed payloads may arrive with new or absent
provider codes. It is preferred over making every 4xx permanent because the
explicit retryable statuses have standard temporary semantics.

## Delivery and recovery behavior

A permanent rejection follows the existing one-attempt dead-letter and quarantine
path. Replaceable lanes may release a newer snapshot; immutable or uncertain lanes
retain their existing safety behavior. This change does not automatically reopen
old dead letters and does not add any new delivery mechanism.

## Verification

- Unit-test generic and provider-coded non-retryable 4xx responses as permanent.
- Unit-test the retryable 4xx allowlist as transient.
- Update the dispatcher integration test to prove a generic 400 makes one provider
  call and is immediately dead-lettered.
- Run focused tests, typecheck, build, architecture validation, and the full suite.

