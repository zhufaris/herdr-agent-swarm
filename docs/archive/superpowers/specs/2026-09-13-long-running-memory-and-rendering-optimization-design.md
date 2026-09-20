# Long-Running Memory and Rendering Optimization Design

## Goal

Bound process-local memory retained across completed Worker operations and
archived Primary bindings, and remove a quadratic worst case from native task
frame rendering. Preserve all durable workflow, recovery, and presentation
semantics.

## Scope

This batch contains exactly three focused optimizations:

1. release transient Worker-creation results after the waiting caller consumes
   them;
2. remove transcript observers for bindings that no longer require live or
   recovery observation;
3. replace repeated backward scans in native task-frame stripping with a linear
   scan.

The batch does not change Worker dispatch concurrency, SQLite query contracts,
Answer Markdown pagination, external APIs, CardKit layouts, or deployment
configuration.

## Worker-creation result lifecycle

`SwarmCommandGateway` may use process-local state to connect completion of an
in-process Worker-creation command to its current waiter. That state must not be
the durable authority and must not retain completed results indefinitely.

After a waiting caller reads a completed result, the corresponding transient
entry is removed. Duplicate or later idempotent calls continue to reconstruct
their result from the durable command intent and current instance state through
the existing path. Failure and cancellation behavior remain unchanged.

Tests will prove both properties: consumed transient state is released, and a
later duplicate still resolves from durable state without creating a second
Worker.

## External-turn observer lifecycle

Each periodic active-binding scan will compare the currently observed cursor
registry with durable bindings that still need observation. Entries absent from
that required set will be removed so their cursor, projector, and per-turn maps
can be collected.

Pruning must not discard an observer that still owns an active or detached turn
requiring exact completion recovery. Active binding identity changes continue to
use the existing close-and-reopen path. Shutdown continues to clear all observer
state.

Tests will cover an archived inactive binding being pruned, an active binding
remaining observed, and a detached/recoverable binding remaining available until
its durable recovery obligation ends.

## Linear native task-frame stripping

The current renderer searches backward from every task-count-looking line to
find its enclosing nonblank block, producing quadratic work on adversarial long
blocks. The replacement will make one forward pass that records block
boundaries and valid task-frame candidates, then removes only the latest valid
frame using the existing recognition rules.

The transformation must preserve output exactly for valid terminal-wrapped
frames, embedded prose, multiple candidate blocks, malformed candidates, and
text with no task frame. It must not broaden recognition or remove user prose.

Tests will preserve existing examples and add a deterministic inspection-count
or equivalent structural regression demonstrating linear work on a long block
containing many task-count-like lines without task metadata.

## Preserved invariants

- SQLite remains authoritative for commands, bindings, prompts, and recovery.
- No prompt or Worker turn is replayed after an uncertain external effect.
- Binding and instance generation fences remain unchanged.
- Active and detached exact-turn observation is not dropped prematurely.
- Card output remains byte-for-byte compatible for existing rendering cases.
- All new process-local collections are bounded by active work and have explicit
  cleanup behavior.

## Verification

Run the focused gateway, external-observer, and native-task-frame test files,
then `npm run typecheck` and `npm run build`. Because observer lifecycle touches
shared recovery behavior, run the full Vitest suite with the writable config
loader workaround used by this worktree. Any known baseline failure must be
reproduced independently and reported separately from this batch.

## Acceptance criteria

- Consumed Worker-creation results are not retained in process memory.
- Durable idempotent Worker-creation replay still returns the existing result.
- Inactive bindings no longer retain unnecessary transcript cursors.
- Active and recoverable detached observations survive pruning.
- Native task-frame stripping performs one linear traversal and preserves
  existing output.
- Focused tests, typecheck, and build pass; unrelated baseline failures are
  explicitly identified.
- No Git commit, installation, deployment, or service restart is performed.
