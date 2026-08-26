# Answer Card Fast Streaming Design

## Goal

Keep native CardKit streaming for Answer Cards while ensuring an already-large
full-content snapshot visibly catches up in seconds rather than minutes.

## Decision

Keep `streaming_mode`, full-content updates, CardKit ordering sequences, and
the existing 9,000-character page boundary. Change only the CardKit client
print configuration for a running Answer Card from one character every 70 ms
to 50 characters every 40 ms with the existing `fast` strategy.

At the current 8,500-character snapshot size this reduces worst-case visual
catch-up from roughly ten minutes to roughly seven seconds.

## Constraints

- Do not change SQLite projections, outbox ordering, idempotency keys, or
  stream sequence allocation.
- Do not change Answer Card pagination or finalization behavior.
- Completed cards must remain non-streaming and must not receive streaming
  configuration.

## Verification

`tests/run-card.test.ts` asserts the exact native streaming configuration for
running cards and the absence of that configuration for completed cards.
Focused card tests, type checking, build, and the complete test suite validate
the change before deployment.
