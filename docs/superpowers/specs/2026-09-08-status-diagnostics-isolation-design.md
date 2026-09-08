# Status Diagnostics Isolation Design

## Problem

The `/status` endpoint is an operational recovery surface and must remain usable
when an individual diagnostics provider fails. It currently isolates several
providers with repeated `try`/`catch` blocks, but calls some providers directly:

- lifecycle event diagnostics;
- workspace-cache diagnostics;
- Herdr socket diagnostics;
- the lease snapshot included in the response.

A synchronous exception from one of these providers can reject the request
handler instead of returning a structured degraded status. The repeated local
error handling also makes it easy for a newly added provider to omit isolation.

## Goals

- Keep `/status` available when any optional diagnostics provider throws.
- Return the failed provider as `{ "error": "<bounded safe message>" }`.
- Mark the aggregate status as `degraded` for every provider collection failure.
- Preserve `/health` behavior and existing `/ready` success/failure semantics.
- Keep diagnostics read-only and process-local; no durable state or workflow
  transition is created by observation.
- Bound every exposed diagnostic error to 500 characters and avoid serializing
  stack traces, causes, provider inputs, or workflow payloads.

## Non-goals

- Retrying diagnostics providers.
- Persisting diagnostics snapshots or failures.
- Changing readiness gates or restart-safety policy.
- Recovering a failed workflow from the health server.
- Adding remote metrics export.

## Considered approaches

### 1. Add three more local `try`/`catch` blocks

This is the smallest patch, but keeps a shallow pattern in which every caller
must remember error bounding and aggregate degradation. A future provider can
repeat the same omission.

### 2. Collect all optional snapshots through one safe helper (selected)

Introduce a small health-local function that accepts an optional provider read
and returns either its value, `undefined`, or a bounded error result. The status
handler collects every optional provider through this function and derives one
`diagnosticCollectionFailed` flag from the collected results. This hides the
exception-normalization rule behind one interface without introducing a new
domain port or production adapter.

The module is deep enough to justify itself: callers supply a read operation and
receive a serializable result; exception conversion, bounding, and failure
detection remain internal. Tests exercise the observable `/status` interface
rather than the helper implementation.

### 3. Create a diagnostics registry with named providers

A registry could remove more handler code and support dynamic providers, but the
set is static and strongly typed. A heterogeneous registry would either weaken
types or add type machinery without a second runtime implementation. It is not
justified for this change.

## Design

The health server keeps ownership of status assembly. For each optional
diagnostics dependency it calls a single health-local collector:

```text
provider absent  -> undefined
provider succeeds -> typed snapshot
provider throws   -> { error: boundedError(error) }
```

The collector result remains the value exposed under the provider's existing
JSON key. Existing response shapes therefore remain unchanged for successful
providers. Reconciliation keeps its existing nested shape, with independently
isolated binding and instance snapshots.

After collection, aggregate status is `degraded` when any collected result is an
error result, in addition to the existing operational degradation rules. A
successful lifecycle-event snapshot containing historical subscriber failures
does not by itself change aggregate status: those failures are already isolated,
durable state remains authoritative, and the counters are informational. Only a
failure to collect that snapshot degrades the status surface.

The mandatory lease snapshot is also collected once per request through the safe
collector. A successful result becomes the existing readiness lease component. A
failure becomes an `ok: false` component with the bounded error and conservative
fallback fields (`held: false`, null fencing/expiry data, and an empty owner
suffix). The `/status` response reuses that readiness component rather than
calling the provider a second time. This prevents one request from observing two
different lease values and ensures an unreadable lease can never report ready.

## Failure semantics

- Provider exceptions never escape `/status`.
- A lease snapshot exception never escapes `/ready`; it produces HTTP 503 and an
  explicit failed lease component.
- Error text uses the existing bounded error conversion and is capped at 500
  characters.
- One failed provider does not suppress healthy provider snapshots.
- The endpoint continues to return HTTP 200 because `/status` describes the
  process; the JSON `status` field carries operational degradation.
- `/ready` continues to return 200 or 503 solely from readiness dependencies.

## Test plan

Extend the health-server tests at the public HTTP seam:

1. A lifecycle-event snapshot exception returns HTTP 200, a bounded error object,
   and aggregate `degraded`, while `/ready` remains ready.
2. A workspace-cache status exception has the same containment behavior.
3. A Herdr-socket status exception has the same containment behavior.
4. One request with multiple failing providers reports every failure rather than
   short-circuiting at the first.
5. A lease snapshot exception makes `/ready` return 503 and makes `/status`
   degraded without invoking the provider twice within either request.
6. Existing successful-provider and readiness tests continue to pass.

Verification requires the focused health-server test, TypeScript typecheck, the
architecture import check, build, and the full test suite because the health
response is consumed by lifecycle tooling.
