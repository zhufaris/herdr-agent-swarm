# Event-first Lark channel delivery plan

1. Extend the event bus with a normalized inbound-message channel and extend
   SQLite with a durable outbound-reply outbox.
2. Add a Lark channel publisher that translates prompt and turn lifecycle
   events into idempotent outbox records, then drains those records to the
   matching Lark thread.
3. Refactor `SyncCoordinator` so ingress only validates, deduplicates, and
   emits inbound events; move command/prompt acceptance behind an inbound
   subscription and remove direct Lark replies from the worker paths.
4. Wire the publisher into startup/restart recovery and adjust integration
   fakes so the acknowledgement and final answer are both asserted.
5. Add store/publisher coverage for outbox deduplication and retry-on-restart,
   then run tests, typecheck, build, and live readiness validation.
