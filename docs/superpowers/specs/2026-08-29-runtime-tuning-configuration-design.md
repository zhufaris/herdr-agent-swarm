# Runtime Tuning Configuration Design

## Goal

Move the remaining operator-relevant cache, safety-scan, and debounce intervals
from the composition root into validated configuration without changing default
runtime behavior.

## Scope and decision

Add four environment variables and expose them through one `runtimeTuning`
configuration group:

| Variable | Default | Valid range | Consumer |
| --- | ---: | ---: | --- |
| `HERDR_SNAPSHOT_CACHE_TTL_MS` | 2000 | 0–60000 | `WorkspaceSnapshotCache` |
| `OUTBOX_SAFETY_SCAN_INTERVAL_MS` | 30000 | 1000–300000 | `LarkOutboxDispatcher` |
| `CARD_UPDATE_DEBOUNCE_MS` | 750 | 0–10000 | `CardUpdateScheduler` |
| `HERDR_EVENT_DEBOUNCE_MS` | 100 | 0–5000 | `HerdrEventInbox` |

Zero is valid only for cache TTL and debounce values because it is useful for
diagnostics and deterministic deployments. The outbox safety scan remains at
least one second to prevent a tight background loop. Existing constructor
defaults remain unchanged for tests and direct library consumers; production
wiring passes the validated values explicitly.

`ConversationViewProjector` receives the card debounce through its options and
passes it to `CardUpdateScheduler`. This keeps timing policy in configuration
and scheduling mechanics in the event module.

## Non-goals

- CardKit payload limits, protocol field lengths, hashing lengths, parser safety
  bounds, retry backoff, and security limits remain code constants.
- No live reload, per-project overrides, or changes to default timings.
- No service restart or deployment.

## Verification

Configuration tests cover defaults, explicit values, and invalid bounds. Wiring
tests cover the projector debounce where behavior is observable; existing unit
tests continue to cover the other constructors. Run focused tests, the full
suite, typecheck, build, and diff checks before integration.
