# Native Turn Stop and Steer Implementation Plan

## Objective

Implement the approved native turn-control design so Primary and Worker stop
and steer commands share one durable, exact-turn workflow. Preserve FIFO and
no-replay behavior, keep local approvals local, and remove user-facing raw pane
interrupt paths.

## Invariants

- Every `/swarm` command continues through `SwarmCommandGateway`.
- A control operation targets one binding/instance generation, pane, native
  session, logical turn, and runtime turn.
- SQLite records `dispatching` before any Herdr side effect.
- A dispatched or uncertain control is never replayed automatically.
- Stop acknowledgement does not settle the durable turn; existing observers do.
- Stop and steer never create ordinary FIFO work.
- Blocked approval/question state rejects remote stop and steer.

## Batch 1: Shared native turn-control core

### Tests first

Extend `tests/turn-control-workflow.integration.test.ts` with Primary and Worker
interrupt cases covering exact target resolution, duplicate idempotency, blocked
state, runtime-turn drift, missing native capability, thrown transport errors,
and restart recovery. Assert that an acknowledged interrupt leaves the prompt or
Worker turn active until its observer reports termination.

Extend `tests/sqlite-store.test.ts` only where needed to prove interrupt payload
validation and per-target control claim ordering. The existing
`turn_control_operations` schema already permits `interrupt`; do not add a
migration unless a failing invariant demonstrates a missing persisted field.

Extend `tests/herdr-adapter.test.ts` for the identity-bearing interrupt command.
The test must prove a fresh agent observation happens before logical `ctrl+c`,
that pane/session/runtime-turn drift prevents the key send, and that command
arguments contain no prompt payload.

### Implementation

1. Add an `InterruptAgentRequest`/receipt contract to the runtime domain and an
   optional `interruptAgent` method to `HerdrPort`.
2. Implement `HerdrCliAdapter.interruptAgent` as an exact-target adapter
   operation: read the target agent/pane through the structured CLI, validate
   pane, session, active runtime turn, working state, and non-blocked state, then
   issue `herdr agent send-keys <pane> ctrl+c`. Return a structured immediate
   delivery result without claiming turn termination.
3. Forward the new capability through `HerdrNativeCircuitBreaker` and
   `WorkspaceSnapshotCache`. Invalidate relevant cached observations after the
   key send.
4. Refactor `TurnControlWorkflow` around a shared `control(kind, input)` path.
   Expose `steer` and `interrupt`; share target resolution, fresh revalidation,
   durable acceptance, claim, result-card update, duplicate handling, and
   recovery. Keep payload rules exhaustive by operation kind.
5. Serialize controls for the same exact logical/runtime turn in-process and
   revalidate after entering that lane. The durable idempotency/effect fence
   remains the crash boundary; process serialization prevents concurrent local
   stop/steer calls from racing between observation and dispatch.
6. Generalize `renderTurnControlResultCard` for steering and stop, preserving
   payload secrecy and distinguishing “interrupt sent” from “turn terminated.”

### Verification

```text
npx vitest run tests/sqlite-store.test.ts
npx vitest run tests/herdr-adapter.test.ts tests/turn-control-workflow.integration.test.ts
npm run typecheck
```

Commit as one dependency-complete core change.

## Batch 2: Primary and Worker routing migration

### Primary

1. Change `PaneControlWorkflow.stop` to call
   `TurnControlWorkflow.interrupt` with the same actor, message, result target,
   and immutable active-prompt context used by steer.
2. Remove Primary stop acceptance and dispatch through legacy
   `PaneControlOperation`. Preserve legacy-row startup handling by terminalizing
   old accepted/running stop rows conservatively; do not replay them.
3. Remove `sendEscape` from the workflow dependency and update composition.
4. Keep `/swarm stop` policy as active-turn, creator-and-administrator, and
   non-replayable. Verify `SwarmCommandGateway` revalidates the captured active
   prompt before calling the workflow.

### Worker

1. Change `InstanceMessagingWorkflow.interrupt` to authorize the Worker and then
   call `TurnControlWorkflow.interrupt`. Remove the user-facing AgentDriver /
   PaneHost selection and its separate `InstanceOperation` interrupt write.
2. Rename the normalized Worker command to `stop_instance`. Parse
   `/stop <worker>` as canonical and `/interrupt <worker>` as a compatibility
   alias producing the same command.
3. Route text commands, card callbacks, and Primary-tool interruption through
   the same messaging/workflow path with stable idempotency keys and durable
   result cards where a Lark message target exists.
4. Rename visible Worker controls from `Interrupt` to `Stop`/`停止`; keep stored
   legacy callback action compatibility if old cards can still invoke it.

### Tests

Update and extend:

- `tests/commands.test.ts`
- `tests/swarm-command-context-resolver.test.ts`
- `tests/swarm-command-gateway.test.ts`
- `tests/steering-integration.test.ts`
- `tests/instance-messaging.integration.test.ts`
- `tests/instance-interaction-integration.test.ts` and card interaction tests
- `tests/primary-tools-mcp.test.ts` if the MCP description or method mapping
  changes while retaining protocol compatibility

Assert all entry points reach `TurnControlWorkflow`, no stop request becomes a
queued turn, duplicate requests cause one native effect, and the next FIFO item
is claimable only after observer-driven settlement.

### Verification

```text
npx vitest run tests/commands.test.ts tests/swarm-command-context-resolver.test.ts tests/swarm-command-gateway.test.ts
npx vitest run tests/steering-integration.test.ts tests/instance-messaging.integration.test.ts tests/instance-control.integration.test.ts
npm run typecheck
```

Commit as one routing migration.

## Batch 3: Presentation, documentation, and compatibility cleanup

1. Update help cards, Worker detail/main cards, and control-result cards to use
   Stop/停止 terminology and explain exact-turn/no-fallback behavior.
2. Update `docs/feishu-group-usage.md` and `docs/architecture.md`: replace the
   old “send Esc” workflow description with the identity-fenced native stop
   contract; document `/stop <worker>` and the temporary `/interrupt` alias.
3. Remove dead user-control code and imports after both routes compile. Retain
   low-level `sendEscape` only where internal runtime drivers or lifecycle code
   still require it; do not broaden this cleanup beyond turn control.
4. Search for stale user-visible `Interrupt`, `/interrupt`, and raw-Escape stop
   claims. Keep only intentional compatibility references and tests.

### Verification

```text
npx vitest run tests/run-card.test.ts tests/instance-cards.test.ts tests/worker-main-card.test.ts tests/turn-control-workflow.integration.test.ts
npm run typecheck
npm run build
npm test
```

Commit the presentation/docs cleanup separately.

## Final audit

1. Run `git diff --check` and inspect the complete commit range.
2. Confirm no live config, database, log, or generated `dist/` file is staged.
3. Confirm the worktree is clean and report commit IDs plus exact test totals.
4. Do not install, restart, or push without a separate user request.
