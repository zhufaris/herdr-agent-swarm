# Exact-Turn Steering Transport Correction Plan

## Objective

Stop treating the TraeX session-peer socket as an app-server endpoint, fail
fast when the installed Herdr lacks exact-turn steering, and close the durable
priority-turn admission gaps without weakening no-replay behavior.

## Invariants

- Never send app-server JSON-RPC to a TraeX session-peer socket.
- Never substitute thread-level peer delivery for exact-turn steering.
- Only a proven no-effect native rejection may become an idle priority turn.
- Delivery-uncertain operations are terminal and are never replayed or
  converted.
- Priority admission is generation-fenced, capacity-bounded, and permits at
  most one live priority turn per owner.

## Batch 1: Fail-fast steering transport

1. Replace the shim's session-peer steering transport with capability-aware
   delegation to the configured real Herdr binary.
2. Detect absence of real `agent steer` without invoking a mutating command;
   return a structured `unsupported` receipt before creating an operation
   record or sending terminal input.
3. Keep the operation-record idempotency fence for a supported external
   dispatch and retain uncertainty after a started command loses its receipt.
4. Replace the fake JSON-RPC socket test with command-capability and structured
   receipt tests, including payload redaction.

## Batch 2: Safe race resolution and priority admission

1. Add one bounded re-resolution after native `not-active` for steer only.
2. Permit conversion only when owner generation, pane, and native session are
   unchanged and the fresh state is safely idle.
3. Add transactional store entry points for Primary and Worker priority steer
   admission. Enforce queue depth, no active runtime turn, and one live
   priority turn per owner generation.
4. Make duplicate idempotency return the original priority turn while a
   conflicting payload fails.
5. Add integration and store tests for all accepted and fail-closed branches.

## Batch 3: Stop wording and verification

1. Correct architecture and user documentation to describe the current stop as
   a freshly guarded, best-effort logical `ctrl+c`, not atomic native CAS or
   `Esc`.
2. Run focused tests for shim, adapter, turn control, and SQLite.
3. Run `npm run typecheck`, `npm run build`, and the full `npm test` suite.
4. Inspect the final diff and commit dependency-complete changes separately.

Installation and service restart remain outside this plan until explicitly
requested after verification.
