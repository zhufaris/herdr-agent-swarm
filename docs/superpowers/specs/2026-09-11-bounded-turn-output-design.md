# Bounded Turn Output Design

## Goal

Bound process memory and append cost while observing long or noisy Agent turns.
Primary, externally adopted, and headless Worker paths must not retain an
unlimited number of transcript deltas or repeatedly copy/join all prior chunks.

## Decision

Introduce one pure `BoundedTurnOutput` accumulator with a 64 KiB retained-output
limit, matching the existing maximum rendered transcript delta and Worker output
boundary. It stores one accumulated string, its current length, and whether input
was truncated. Appending is proportional only to the retained new fragment; once
full, later deltas do not allocate or copy earlier content.

Fragments retain the existing two-newline separator. When content exceeds the
limit, the accumulator reserves space for a deterministic visible truncation
marker and never grows beyond the limit. Empty fragments are ignored.

The accumulator is fallback output. A trusted lifecycle `finalAnswer` remains
authoritative and replaces the accumulated partial output. Because the transcript
parser already bounds and redacts each lifecycle final answer, replacement does
not reintroduce unbounded memory. Output fingerprints are computed from the exact
bounded or authoritative value that is persisted.

## Integration

- Primary attached and detached observation stores one accumulator in
  `TurnOutputSource`; per-event publication still emits only the new delta.
- External turn adoption stores one accumulator per owned runtime turn.
- Headless Worker observation stores one accumulator per active logical turn.
- Worker turns with durable cards continue using the already bounded persisted
  answer, but append through the same utility to avoid repeated full joins.
- Terminal and invalidated ownership paths release accumulator entries.

## Verification

Tests append thousands of maximum-size or repeated deltas and assert retained
length never exceeds 64 KiB, the marker is stable, ordering is preserved, and
append after truncation is a no-op. Primary projector, external-turn, and Worker
observer tests verify bounded fallback completion. Separate cases prove trusted
`finalAnswer` still replaces truncated partial output.

The final gate is focused accumulator and three observer suites, typecheck, build,
architecture checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- Durable archival of an unlimited raw transcript.
- Changing Answer Card pagination or canonical page offsets.
- Increasing CardKit payload limits.
- Installing or restarting the service.
