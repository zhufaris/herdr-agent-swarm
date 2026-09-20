# Primary Detached Skip and Wake Implementation Plan

## Objective

Add a creator-authorized `/swarm skip` command that atomically fails only the
oldest detached Primary prompt and wakes the existing FIFO scheduler, while
preserving `/swarm awake` as observation-only and `/swarm steer` as strict
exact-turn control.

## Invariants

- Never resend, interrupt, or inject terminal input for the skipped prompt.
- Never infer completion from an idle pane.
- One command invocation can terminalize at most one detached prompt.
- Command redelivery cannot skip another prompt.
- Prompt, Run Card, audit, and outbound intent changes are atomic.
- The scheduler remains the only component allowed to claim queued work.

## Batch 1: Command contract and red tests

1. Add `skip` to `BridgeCommand`, parsing, policy, context resolution, help, and
   user documentation.
2. Classify it as a creator-authorized, reconcilable active-turn mutation in the
   per-binding lane.
3. Add parser, policy, resolver, and gateway tests before implementing dispatch.

## Batch 2: Atomic skip transition

1. Add a prompt-store result type for `skipped`, `none`, and `stale`.
2. In one `BEGIN IMMEDIATE` transaction, verify binding generation, select the
   oldest `running` / `detached` ordinary prompt, compare-and-set it to
   `failed` / `completed`, update its Run Card through the durable projection
   contract, reserve required outbox work, and write an audit event.
3. Do not loop to another prompt when the selected candidate loses the race.
4. Add store tests for ordering, atomic projection, scope isolation, and races.

## Batch 3: Workflow and scheduling

1. Expose `skipDetached(bindingId, generation, actor, sourceMessage)` from
   `PromptRunWorkflow`.
2. Route `/swarm skip` through `SwarmCommandGateway`; on success wake the prompt
   scheduler and outbound dispatcher and publish a bounded result card.
3. Ensure duplicate command intents return the persisted result without running
   the skip effect again.
4. Keep `awake` and `steer` behavior unchanged and add regression assertions.

## Batch 4: Verification and commits

1. Run focused parser/policy/context/gateway/store/prompt lifecycle tests.
2. Run `npm test`, `npm run typecheck`, `npm run build`, and
   `git diff --check`.
3. Audit each design requirement against concrete code and tests.
4. Commit implementation and documentation as a dependency-complete batch.

Installation and service restart are not part of this plan.
