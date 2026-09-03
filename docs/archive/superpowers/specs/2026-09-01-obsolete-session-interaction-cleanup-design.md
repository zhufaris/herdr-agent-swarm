# Obsolete Session Interaction Cleanup Design

## Goal

Repair durable Session-card dispatch and remove production code that can no
longer execute under the current FIFO-only TraeX contract.

## Scope

The cleanup covers the current uncommitted Session-operation durability work
and adjacent obsolete card-interaction paths. It does not redesign prompt
execution, remove persisted legacy columns or values, or change slash-command
behavior outside the unsupported model response.

## Session interaction authority

Opening the More Actions card creates the durable authorization used by its
buttons and child forms. `acceptSessionOperation` must therefore accept an
active, correctly scoped `more_actions` interaction. It must continue checking
the actor, binding generation, Pane identity, Agent session identity, expiry,
and one-operation-per-interaction idempotency inside one SQLite transaction.

Tests must exercise the real chain: open More Actions, extract the callback
value, submit it through a real `SessionOperationWorkflow`, and observe the
persisted operation. Tests must not manufacture a different interaction kind.

## Unsupported model control

Runtime model selection is unsupported. New More Actions cards must not render
the model button. A callback from an already delivered card remains recognized
but returns an explicit unsupported warning without creating a Session or Pane
control operation. Slash-command compatibility remains unchanged in this
cleanup.

## Obsolete steering and supplement paths

The service advertises neither immediate supplement nor queued-to-steering
conversion. Remove the unused supplement renderer, form workflow, queued prompt
conversion method, and the unreachable forced-parent steering branch in
`InboundRouter`. Remove the corresponding workflow dependencies, port methods,
and tests that only assert those removed production capabilities.

Callbacks from historical cards must fail closed with a concise unsupported
warning. They must not create interactions, modify prompt dispatch kind, write
terminal input, or enqueue prompts. The failed-automatic-steering action that
converts a rejected historical steering attempt back into a normal FIFO task is
still an active recovery feature and remains. Existing database schema values
stay accepted so upgraded databases remain readable.

## Local dead-code cleanup

After Session mutations use the durable dispatcher, `CardInteractionWorkflow`
needs only Session status plus the dispatcher capability. Remove its unused
synthetic message, constant success variable, imports, store methods, and direct
workflow dependencies. Composition roots and test harnesses must inject only
the narrowed interface.

## Documentation cleanup

Completed or superseded implementation plans that describe the removed plugin,
the removed migration command, or obsolete deployment identities are historical
records. Move directly relevant stale plans/specs out of the active
`docs/superpowers` entry path into `docs/archive/superpowers`, preserving their
contents. Do not bulk-move unrelated active work and do not delete history.

## Verification

Add focused regression coverage for the real More Actions flow, unsupported
legacy model callback, and fail-closed legacy supplement/steering callbacks.
Run the affected Vitest files, TypeScript with unused-local checks, the normal
typecheck, the full Vitest suite, the production build, and `git diff --check`.
