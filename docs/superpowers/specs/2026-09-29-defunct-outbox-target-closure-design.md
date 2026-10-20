# Defunct Outbox Target Closure Design

## Goal

Automatically close durable Lark delivery failures only when the provider has
explicitly proved that the original target no longer exists. This reduces
historical outbox/dead-letter noise without retrying a delivery effect, replaying
Agent work, or concealing an uncertain external outcome.

## Scope

The first release recognizes only these Feishu provider codes:

- `230011`: the target message was withdrawn;
- `230019`: the target thread does not exist.

It applies to a new failure immediately and to matching historical failures
during the existing bounded startup stale-quarantine recovery. It does not add a
manual database cleanup command or send any new Lark request.

## Non-goals

- Do not close timeout, connection-reset, 5xx, crash, or lease-handover
  failures. Their delivery effect remains uncertain and requires an operator or
  a separately proved replacement recovery.
- Do not infer a defunct target from error text, HTTP status alone, card payload,
  or a missing local projection.
- Do not replace Answer, Main Card, Worker, or text delivery with a newly
  created message merely because its old target is defunct.
- Do not change existing semantic recovery for expired Answer targets, closed
  streams, stale Primary Main Cards, or rich-text edit-limit rollover.

## Failure classification

`classifyFeishuFailure` maps only `230011` and `230019` to the provider-neutral
`defunct_target` recovery kind. A provider response already establishes
`effectCertainty: rejected`; the recovery store must require that value again
rather than relying on classification alone.

`defunct_target` is intentionally narrower than a generic permanent failure:
content rejection (`230028`), malformed card rejection (`230099`), closed stream
(`300309`), stale card (`300317`), and expired Answer view target (`230031`)
retain their current recovery or operator-review behavior.

## Closure proof

A failed reply may be closed only when every condition holds:

1. it remains `dead_letter`;
2. its failure is permanent, `effect_certainty = rejected`, and has recovery
   kind `defunct_target` (or is a historical row with provider code `230011` or
   `230019` and the same rejected certainty);
3. its active quarantine still identifies that exact reply and lane;
4. the lane has no pending successor; and
5. the reply is not eligible for an existing semantic rebuild path.

The final condition preserves the priority of current Answer/Main Card recovery
rules. An uncertain effect fails condition 2 even if the target later appears
missing. Any competing manual retry/dismissal, new lane failure, or successor
reservation makes the compare-and-swap update fail harmlessly.

## Transactional behavior

For an eligible row, one SQLite transaction performs the following transition:

```text
outbound_replies       dead_letter -> dismissed
delivery_recoveries    unresolved/replacement_pending -> dismissed
outbox_lane_quarantines active -> released
outbox_lane_heads      refresh after the above fences hold
```

The reply retains its original provider code, HTTP status, failure class, and
safe error evidence. Its replacement error is a stable closure notice, not a
provider error rewrite. The recovery action is
`startup_dismiss_defunct_target`; the recovery ledger records `dismissed` and a
resolution timestamp. No state transition touches prompts, Worker turns, or card
projections.

The operation is idempotent: a subsequent pass cannot select the dismissed row,
and a stale row cannot release another reply's quarantine.

## Execution paths

### New failures

`OutboundFailureTransitionProtocol` evaluates a rejected `defunct_target` after
the durable failure record is written. If the closure proof holds in that same
transaction, it settles the failed revision immediately. Otherwise it preserves
the usual blocked quarantine for a later evaluation.

### Historical failures

`ImmutableEffectRecovery`, called by
`recoverStaleOutboxQuarantines()`, scans matching historic dead letters in a
bounded deterministic order. It uses the stored provider code and rejected
effect certainty; it does not recreate a Gateway plan or invoke Lark. The scan
uses the same closure transaction and therefore remains safe during startup and
repeated convergence.

## Observability

`recoverStaleOutboxQuarantines()` returns `dismissedDefunctTargets`, alongside
the existing recovery counters. Startup/recovery logs emit that count plus a
small provider-code distribution. They never log message text, CardKit payloads,
tokens, or other sensitive configuration.

The status totals remain historically honest: total dead letters are cumulative,
while `unresolvedDeadLetters` and active quarantine counts decrease once the
ledger is dismissed. A closed defunct target is therefore distinguishable from
an uncertain effect that is still awaiting human review.

## Tests

- classify `230011` and `230019` as `defunct_target` and ensure unrelated
  operations/codes do not get that kind;
- immediately dismiss an eligible newly rejected failure and settle its recovery
  ledger/quarantine atomically;
- close an eligible historic failed head during stale-quarantine recovery;
- retain rows with pending successors, stale active-quarantine identity, or
  repeated recovery scans;
- retain uncertain failures even if their provider code/error text resembles an
  invalid target;
- preserve existing Answer/Main Card/stream/rich-text rebuild tests and prove no
  prompt or Worker transition occurs during closure.

Before production installation run focused Feishu, outbox-recovery, SQLite, and
dispatcher tests; then run `npm run typecheck`, `npm run build`, and the full
Vitest suite.
