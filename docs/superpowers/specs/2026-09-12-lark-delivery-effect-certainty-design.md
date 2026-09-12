# Lark Delivery Effect-Certainty Design

## Problem

The delivery classifier currently treats timeouts, connection resets, and most
network errors as ordinary transient failures. The executor then settles the
active claim as pending and automatically retries the same external operation. A
timeout or reset can occur after Lark accepted a message/card create or mutation
but before the client received the response. Retrying that effect may create a
duplicate message or repeat a non-idempotent operation.

The existing frozen claim, attempt ID, fencing token, and old-owner quarantine
prevent stale local acknowledgements, but they do not distinguish a request that
provably never reached Lark from one whose external outcome is unknown.

## Goals

- Automatically retry only failures that prove the external effect did not start
  or that contain a definite rejecting HTTP/Lark response.
- Persist request-outcome uncertainty as blocked durable work, not an ordinary
  retry.
- Preserve the frozen claim and no-Prompt-replay guarantees.
- Keep explicit operator retry/dismiss and existing recovery workflows available.
- Expose bounded structured certainty in logs and operational diagnostics.
- Preserve existing behavior for target validation and documented CardKit
  semantic recovery codes.

## Non-goals

- Claiming exactly-once Lark delivery.
- Querying Lark to discover an unknown result in this slice.
- Assuming every endpoint honors a common idempotency window.
- Adding app-wide quota cooldown; that remains a separate rate-limit slice.
- Automatically retrying an uncertain create because it carries a UUID.

## Considered approaches

### 1. Explicit effect certainty with conservative quarantine (selected)

Classify the external effect separately from retryability. Definite HTTP/Lark
responses and provable pre-connection failures retain existing retry/permanent
semantics. Request timeouts, headers timeouts, resets, and unclassified network
failures become `uncertain`, causing an immediate blocked dead letter.

This avoids duplicate effects without penalizing failures that demonstrably did
not reach the endpoint.

### 2. Treat every network failure as uncertain

This is safest but would require manual intervention for DNS lookup failures,
connection refusal, and connect timeout, where no application request reached
Lark. It would unnecessarily reduce availability.

### 3. Retry every transient error using endpoint idempotency keys

This preserves availability but assumes endpoint-specific idempotency semantics
that are not established uniformly across message create, reply, patch, and
CardKit operations. It cannot justify automatic replay after an ambiguous effect.

## Failure contract

Extend delivery failure metadata with:

```ts
type DeliveryEffectCertainty = "not-started" | "rejected" | "uncertain";
```

- `not-started`: the transport failed before an endpoint could accept the
  request. Initial evidence includes DNS resolution failure, connection refusal,
  and explicit connect timeout codes.
- `rejected`: an HTTP response, Lark business response, or local durable target
  validation definitively rejected the operation. Existing transient/permanent
  classification and Retry-After behavior apply.
- `uncertain`: the client cannot prove whether Lark applied the effect. Request or
  headers timeout, `AbortError`, connection reset after request dispatch, generic
  network errors, and unknown transport failures fall here.

The classifier derives certainty only from bounded normalized facts already
available on the error: HTTP status, Lark error code, transport code, name, and
message. It does not inspect or log request payloads. HTTP/Lark response evidence
takes precedence over transport-like message text.

## Classification table

| Evidence | Effect certainty | Failure class | Settlement |
| --- | --- | --- | --- |
| Local target validation | rejected | permanent | existing semantic dead-letter/recovery |
| Lark business code | rejected | existing permanent/unknown rule | existing semantic handling |
| HTTP 429 | rejected | transient | bounded Retry-After retry |
| HTTP 5xx | rejected | transient | ordinary backoff retry |
| `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, explicit connect timeout | not-started | transient | ordinary backoff retry |
| `AbortError`, request timeout, headers timeout, `ECONNRESET`, generic network error | uncertain | unknown | immediate blocked dead letter |
| No reliable evidence | uncertain | unknown | immediate blocked dead letter |

`ETIMEDOUT` without a connect-phase marker is uncertain.
`UND_ERR_CONNECT_TIMEOUT` is not-started, while
`UND_ERR_HEADERS_TIMEOUT` is uncertain.

## Durable settlement

`OutboundDeliveryExecutor.fail()` passes effect certainty through the existing
claim-fenced failure transition. The SQLite recovery module treats
`effectCertainty=uncertain` as a terminal unknown effect regardless of the
ordinary retry budget:

- state becomes `dead_letter`;
- the active claim is cleared only inside the same fenced transaction;
- the lane receives an active `blocked` quarantine;
- error text states that the external effect may have completed and requires
  inspection before manual retry;
- no successor is dispatched past the lane head;
- no automatic recovery budget is consumed or reopened.

This uses the existing dead-letter/quarantine and recovery-evidence tables; no new
state enum or table is required. Add `effect_certainty` to `outbound_replies` so
diagnostics and later operator tooling do not have to infer uncertainty from error
text. The latest schema and an additive migration backfill existing failures as
`rejected` when they have HTTP/Lark response evidence and `uncertain` otherwise;
pending/delivered rows remain null until an attempt settles. The column is
claim-settlement metadata and may not alter a frozen intent.

Manual retry remains explicit authorization to repeat the same revision. It
clears the active quarantine for scheduling but preserves the prior failure and
recovery evidence. Automatic transient recovery must never select a row whose
effect certainty is uncertain.

## Adapter responsibility

The Lark adapter keeps its existing bounded request timeout. It normalizes only
transport phase facts that are otherwise lost by the SDK:

- calls into the SDK are considered dispatched;
- SDK errors that already expose a reliable code/status are preserved;
- the adapter does not wrap every error as uncertain or expose request bodies;
- if future HTTP clients expose an explicit pre-send/connect phase, that fact may
  be attached as bounded metadata without changing workflow interfaces.

The first implementation can classify the SDK's current standard codes directly;
no speculative instrumentation of private SDK internals is required.

## Diagnostics

Delivery logs include `effectCertainty` alongside reply ID, kind, attempt, safe
status/code, and outcome. `/status` extends outbound failure summaries with an
uncertain-effect count, without exposing payloads or identifiers. An uncertain
effect already contributes to active quarantine and unresolved recovery health;
readiness policy is unchanged.

## Tests

- Classifier table tests distinguish definite HTTP rejection, pre-connect
  failure, and uncertain transport loss.
- Executor tests prove uncertain errors never schedule retry and produce a
  blocked dead letter through the exact claim.
- SQLite tests prove the transition is atomic, stale receipts cannot mark a new
  attempt uncertain, restart does not auto-reopen it, and explicit manual retry
  remains possible.
- Migration tests preserve existing rows and backfill conservatively.
- Operational tests report uncertain counts without payload data.
- Existing 429, 5xx, CardKit recovery, retry-budget, owner-loss, lane-order, and
  no-replay tests remain green.

Run focused classifier, outbox executor/store, migration, and health tests, then
typecheck, build, architecture checks, `git diff --check`, and the full Vitest
suite.

## Acceptance criteria

- A request/headers timeout or reset cannot become an automatic pending retry.
- DNS, connection refusal, and explicit connect timeout remain retryable.
- Definite HTTP/Lark responses retain existing semantic classification.
- Unknown effects are persisted, blocked, visible, and manually recoverable.
- No Prompt or Worker turn is replayed by the new path.
- No logs or diagnostics expose delivery payloads.
