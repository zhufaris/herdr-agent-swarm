# Lark Endpoint Error Semantics Design

## Problem

The delivery classifier currently derives CardKit recovery from a Lark business
code alone. The SQLite recovery store then has a second fallback that infers the
same recovery from the persisted code and the broad outbox reply shape. This is
not enough evidence to identify the failed external operation. A durable reply
can perform more than one Lark call, and the same business code can be returned
by endpoints whose recovery boundaries differ.

As a result, a code intended to repair a Primary Main Card or Primary Answer
stream can be interpreted too broadly. In particular, a `230099`, `300317`, or
`300309` response must not rebuild an unrelated card, Worker surface, reply, or
stream operation. Content rejection `230028` must not consume an automatic retry
budget because repeating the same immutable revision cannot repair its content.

## Goals

- Derive semantic recovery from the exact Lark operation and durable target, not
  from a business code alone.
- Keep recovery decisions outside the Lark transport adapter.
- Make the classifier the single normalization boundary for failure class,
  effect certainty, and semantic recovery.
- Make SQLite execute an explicit recovery decision without reinterpreting raw
  error codes.
- Preserve claim fencing, durable recovery evidence, lane ordering, effect
  certainty, and the no-Prompt-replay guarantee.
- Treat `230028` as a definitive rejection of the current content revision.

## Non-goals

- Adding app-wide or endpoint-wide quota cooldown.
- Querying Lark to reconcile uncertain external effects.
- Changing Lark port method signatures or exposing SDK response bodies.
- Adding a new database column or migration.
- Generalizing all Lark business codes into an exhaustive registry.
- Changing the existing Main Card, Answer, or Worker projection model.

## Considered approaches

### 1. Classify with exact operation context (selected)

The executor associates every external call with a bounded, immutable operation
context. When that call fails, the classifier receives the error and the context
and returns the complete durable failure policy. The recovery store consumes only
the resulting `recoveryKind`.

This keeps transport normalization, workflow policy, and durable settlement in
their existing layers while supplying the evidence missing from the current
classifier.

### 2. Infer the operation from `OutboundReply` in SQLite

This requires less executor code, but a single durable reply can contain multiple
external calls. For example, a streaming-card create can create an entity and
then send a reference. The reply kind cannot prove which call returned the code.
This option retains ambiguous recovery.

### 3. Add endpoint-specific exception classes to the Lark adapter

This provides strong typing near the SDK, but it moves workflow recovery policy
into a transport adapter and expands every port implementation and fake. It also
does not naturally include durable target identity. The added coupling is not
justified for this slice.

## Operation context

Introduce an internal `DeliveryOperationContext` carried only while executing an
external call. It uses finite enums and durable identity facts already present on
the claimed reply. It does not contain payloads, prompt text, SDK configuration,
or raw responses.

The operation enum maps one-to-one to the Lark port call that can fail:

- `create_topic`;
- `update_card`;
- `update_cardkit`;
- `create_streaming_card`;
- `reply_streaming_card_reference`;
- `reply_streaming_card`;
- `stream_card_content`;
- `finish_streaming_card`;
- `reply_text`;
- `reply_card`.

Target identity is derived from the frozen claim: Primary Main, Primary Answer,
Worker Main, Worker Turn, group thread, or ordinary operation result. The
executor constructs the context at the call site after local target validation
and before invoking the Lark port. A small internal wrapper preserves that exact
context and the original error as its cause. The classifier unwraps the cause for
safe status, code, timeout, and message normalization while retaining the wrapper
context for policy. Local materialization and target validation failures have no
external operation context and retain their existing permanent rejection
semantics.

The context is not persisted. The durable result already records the bounded
facts needed after settlement: failure class, effect certainty, HTTP status,
Lark code, recovery action, and a sanitized error summary. Logs may include only
the finite operation and target enums.

## Classification contract

`classifyDeliveryError` accepts the error and optional operation context. It
first determines effect certainty from response and transport evidence, then
derives semantic policy from the exact operation, target, and Lark code. A
definite Lark response is `rejected`; an operation-specific recovery rule cannot
override an `uncertain` effect.

The classifier remains a pure function. Its output is the complete
`DeliveryFailureMetadata`, safe message, and optional retry delay. The executor
passes that output through the existing claim-fenced failure transition. No
downstream component should reconstruct semantic policy from the raw code.

## Error policy matrix

| Lark code | Exact operation and target | Failure policy | Recovery |
| --- | --- | --- | --- |
| `230028` | Any Lark delivery with a definite response | permanent, rejected | Dead-letter the current revision; no automatic retry or content rewrite |
| `230099` | Primary Main Card `update_card` or `update_cardkit` | permanent, rejected | `stale_main_card` |
| `230099` | Any other operation or target | permanent, rejected | None |
| `300317` | Primary Main Card `update_cardkit` | permanent, rejected | `stale_main_card` |
| `300317` | Any other operation or target | permanent, rejected | None |
| `300309` | Primary Answer `stream_card_content` | permanent, rejected | `closed_answer_stream` |
| `300309` | Any other operation or target | permanent, rejected | None |

The Main Card sequence rule applies only to the CardKit update path that supplies
a sequence number. A non-CardKit fallback update does not claim sequence-conflict
recovery merely because it returns `300317`.

For codes outside this matrix, existing rules remain: HTTP 429 and 5xx are
transient, DNS/refused/connect-timeout failures are `not-started` transient,
request or headers timeout and connection reset are uncertain, and known invalid
target codes are permanent. This slice does not reclassify unrelated unknown 4xx
or Lark responses. The four codes in the matrix are permanent when their
operation does not match, but they never receive semantic recovery merely from
the raw code.

## Durable settlement and recovery

The executor catches an external-call failure together with its operation
context and invokes the classifier once. It passes the normalized metadata to
`markOutboundReplyFailedWithQuarantine` under the original claim. The existing
SQLite transaction continues to own:

1. claim-fence validation;
2. failure settlement and sanitized error storage;
3. recovery-ledger creation or update;
4. lane quarantine state;
5. replacement intent creation, when explicitly authorized by `recoveryKind`;
6. lane-head refresh or removal.

The recovery store changes its semantic predicates as follows:

- only `recoveryKind === "stale_main_card"` can create a Main Card replacement;
- only `recoveryKind === "closed_answer_stream"` can freeze a Primary Answer
  stream and release it into the static replacement workflow;
- `larkErrorCode` remains audit metadata and cannot independently trigger either
  recovery;
- an uncertain effect remains an active blocked quarantine even if malformed or
  manually constructed metadata also contains a recovery kind;
- a permanent rejection without a recovery kind follows the ordinary
  dead-letter/quarantine policy for its lane. Replaceable projections may later
  converge through a genuinely new visible revision, but the rejected revision
  itself is never retried automatically.

This deliberately removes the current SQLite fallback checks for `230099`,
`300317`, and `300309`. It also makes direct store callers and migration fixtures
provide an explicit recovery kind when they intend to exercise semantic repair.

## Safety and compatibility

- No Lark port or public HTTP surface changes.
- No schema migration or historical-row rewrite. Existing settled recovery
  records remain authoritative; this change affects future failure decisions.
- Frozen claim identity, snapshot revision, attempt ID, and lease fence are
  unchanged.
- Semantic recovery never submits or replays a TraeX Prompt or Worker turn.
- `230028` does not trigger content mutation intended to bypass moderation. A
  newly rendered, genuinely different visible snapshot may receive a new
  revision through normal projection convergence.
- The safe error boundary continues to truncate messages and expose only bounded
  HTTP/Lark codes and request identifiers. Operation and target diagnostics are
  finite enums.
- Manual retry and dismiss remain explicit operator actions. Manual retry is the
  only authorization to repeat the same permanent revision.

## Testing

### Classifier matrix

Table-driven tests cover every allowed recovery combination and important
counterexample:

- Primary Main Card `update_card` or `update_cardkit` with `230099`, and Primary
  Main Card `update_cardkit` with `300317`, produce `stale_main_card`;
- ordinary card reply, Answer update, Worker Main, and Worker Turn with the same
  codes do not produce a recovery kind;
- Primary Answer `stream_card_content` with `300309` produces
  `closed_answer_stream`;
- Worker content/progress stream, stream creation, stream finish, and full-card
  update with `300309` do not produce that recovery kind;
- `230028` is permanent and rejected for every representative operation;
- transport uncertainty and definite-response precedence remain unchanged.

### Executor and dispatcher integration

- Existing Main Card `230099` and CardKit `300317` cases create and deliver one
  replacement while preserving the old pointer until the replacement ACK.
- Existing Primary Answer `300309` content-stream recovery freezes the old page
  and enters the static replacement workflow.
- The same codes injected at nonmatching call sites dead-letter without creating
  a Main or Answer replacement.
- `230028` dead-letters on the first rejected attempt and is not selected by
  automatic recovery.
- timeout/reset remains uncertain and blocked; a semantic code cannot weaken the
  uncertainty rule.
- logs include only bounded operation/target fields and the existing sanitized
  error object.

### SQLite policy tests

- Raw `230099`, `300317`, or `300309` metadata without a recovery kind cannot
  trigger a semantic rebuild.
- Explicit matching recovery kinds retain the existing atomic replacement,
  recovery-ledger, quarantine, and lane-head behavior.
- An uncertain effect with a recovery kind remains blocked.
- Claim-stale settlement cannot create a replacement or alter a newer attempt.

Run the focused classifier, dispatcher, adapter, and SQLite tests, followed by
`npm run typecheck`, `npm run build`, `npm run architecture:check`, `npm test`,
and `git diff --check`. Tests use fake Lark adapters and temporary SQLite only;
they send no real messages.

## Acceptance criteria

- Recovery actions require a matching Lark code, external operation, and durable
  target identity.
- The recovery store never derives semantic recovery directly from a raw Lark
  code.
- `230028` cannot automatically retry the same revision.
- Valid Main Card and Primary Answer recovery behavior remains intact.
- Nonmatching endpoints cannot rebuild unrelated cards or mutate Answer state.
- Uncertain external effects remain conservatively quarantined.
- No Prompt replay, sensitive logging, schema migration, deployment, or real
  Lark delivery is introduced by this slice.
