# Prompt Run Consumer Ports Design

## Goal

Replace the broad application-facing `PromptRunStore` with consumer-shaped
dispatch, recovery, and session interfaces now that SQLite implementation
ownership has been separated into deep modules.

## Problem

`PromptRunStore` currently exposes more than twenty operations spanning four
protocols. `PromptTurnExecutor`, `PromptSafetyScanner`, `TranscriptObserver`, and
the outer `PromptRunWorkflow` all receive that aggregate even though each uses a
small, different subset. The SQLite implementation has already been decomposed,
but the application seam still lets callers reach unrelated recovery, dispatch,
projection, and Binding operations. This hides dependency direction and makes a
test double for one protocol pretend to implement all protocols.

## Selected design

Define three application interfaces in `domain/ports/prompt-run.ts`:

- `PromptDispatchStore` owns FIFO claim, exact Prompt/turn identity, model
  dispatch fences, attached settlement, Binding observation transitions, and
  queue-count queries used during one execution.
- `PromptRecoveryStore` owns startup recovery, safety scanning, stale claim
  release, detached observation/settlement, manual skip, and the identity queries
  needed to resume that work.
- `PromptSessionStore` owns the Binding and Topic projection operations used to
  finish a draining session.

`PromptRunWorkflow` receives `{ dispatch, recovery, session }`. It passes only
the dispatch interface to `PromptTurnExecutor`, only the recovery interface to
`PromptSafetyScanner`, and a minimal intersection to `TranscriptObserver`. The
workflow itself uses the named owner for each transition.

SQLite exposes three concrete capability adapters over the existing deep
modules. The production `SqliteStoreBundle` replaces `promptRun` with
`promptDispatch`, `promptRecovery`, and `promptSession`; `createPrimaryRuntime`
must inject all three explicitly. Test compatibility stores may satisfy all
three interfaces, but production composition cannot collapse them back into one
aggregate.

## Alternatives

### Keep `PromptRunStore` and use `Pick` everywhere

This narrows local types but retains a broad production capability and allows
new consumers to reach unrelated methods. The seam remains hypothetical.

### Give every class a bespoke anonymous interface

This provides compile-time narrowing but loses shared protocol vocabulary and
makes composition difficult to audit. Three named interfaces match the three
state machines already present.

### One interface per method cluster

More interfaces would fragment the dispatch and recovery state machines and
make callers coordinate protocol ordering. The selected interfaces remain deep:
one dispatch or recovery capability hides many fenced transitions.

## Invariants

- No persistence or behavior changes; only dependency visibility and composition
  change.
- Dispatch and recovery each retain their complete no-replay protocol.
- `PromptTurnExecutor` cannot call recovery or session projection methods.
- `PromptSafetyScanner` cannot claim or settle attached execution.
- Production composition exposes no broad `promptRun` bundle field.
- Existing transaction ownership stays in SQLite deep modules.

## Testing

Architecture tests must reject `PromptRunStore`, require the three named bundle
fields, verify `PromptRunWorkflow` receives `stores`, and ensure executor/scanner
types reference only their consumer interface. Existing prompt safety,
concurrency, steering, transcript, lifecycle, and full-suite tests prove behavior
is unchanged. Run typecheck, build, all tests, and `git diff --check`.

## Non-goals

- No SQL, schema, coordinator behavior, timing, card, or production lifecycle
  changes.
- No further split of queue feedback, model selection, or session administration.
