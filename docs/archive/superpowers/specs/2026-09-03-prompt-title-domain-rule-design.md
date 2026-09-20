# Prompt Title Domain Rule Design

## Purpose

Make the title shown for a Prompt's Run Card a single domain rule. Ordinary
Lark prompt acceptance and externally observed Herdr turn adoption currently
each normalize, truncate, and default request titles independently.

## Scope

Add `src/domain/prompt-title.ts` exporting a pure title formatter. It:

- collapses whitespace and trims the request text;
- limits a visible title to 64 characters, reserving the last character for an
  ellipsis when truncation is needed; and
- returns `TraeX request` for an empty normalized request.

`InboundMessageRoutingWorkflow` and `ExternalTurnObserver` will call this rule
when creating their respective Run Card views.

## Boundaries and invariants

The formatter has no Lark, Herdr, SQLite, queue, event, or timestamp
dependency. It does not modify the stored prompt body; titles are a compact
read-model label only. The change does not alter prompt classification, FIFO
order, external-turn adoption, or no-replay behavior.

## Verification

Add direct tests for whitespace normalization, empty fallback, exact-length
input, and truncation. Retain inbound routing and external turn observer tests,
then run typecheck, build, and `git diff --check` before committing.
