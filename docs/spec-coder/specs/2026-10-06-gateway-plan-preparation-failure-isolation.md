# Gateway Plan Preparation Failure Isolation

## Problem Statement

Outbound delivery prepares a Gateway plan before claiming the durable row. If synchronous `gateway.prepare()` throws, the exception escapes the item executor, marks the entire lane drain fatal, and leaves the row pending with `attempt_count = 0`. Periodic scans then retry the same deterministic renderer/plan failure forever, repeatedly truncating work across unrelated lanes.

## Solution

Treat a thrown Gateway plan-preparation error as one durable, per-item permanent rejection before external delivery:

- sanitize and persist the error through the existing unclaimed rejection transition;
- classify it `failureClass=permanent`, `effectCertainty=rejected`, with no provider status/code;
- dead-letter/quarantine only that delivery lane;
- return an ordinary failed delivery result so the lane drain continues with unrelated lanes;
- never call the Gateway executor and never fabricate a prepared plan or external attempt.

## User Stories

- **P1 — Poison isolation:** one malformed render intent cannot abort delivery scans for unrelated lanes.
- **P2 — Durable terminal state:** the poison row reaches dead-letter/quarantine exactly once and is not retried automatically after restart.
- **P3 — No external effect:** prepare failure leaves no Gateway plan/checkpoint and never invokes `execute()`.
- **P4 — Error hygiene:** only the bounded sanitized error is persisted/logged.

## Implementation Decisions

### Domain Model

Gateway preparation is local deterministic conversion, before claim and before the external-effect boundary. A thrown preparation error is therefore a definite rejected effect, not transient uncertainty. The Outbox aggregate owns the terminal row and lane quarantine; scan coordination does not own retries for this failure.

### Architecture

`OutboundDeliveryExecutor.deliver()` expands its existing pre-claim error boundary to include `gateway.prepare()` and plan serialization. `PermanentDeliveryError` and preparation failures share the durable unclaimed rejection transition but retain their existing safe messages. SQLite plan persistence stays outside this boundary: a storage/lease failure remains scan-fatal rather than being misclassified as bad content. `OutboundLaneDrain` and `GatewayOutboxDispatcher` remain unchanged and observe an ordinary `{ outcome: "failed" }` result.

No new schema, counters, timer, or in-memory poison registry is introduced.

### Behavior & Failure Modes

If durable rejection unexpectedly cannot transition the pending row, delivery still returns failed and later durable scans can re-evaluate it. A successful prepare retains the existing plan-first/claim-second crash-consistency contract. External execution and retry behavior are unchanged.

### Compatibility & Migration

No migration. Existing pending poison rows terminalize on their next scan.

## Testing Decisions

Replace the legacy test that expected scan rejection and an untouched row. Use independent lanes for prepare failure, circular-plan serialization failure, and a healthy sibling in the same forced scan. Assert each poison row is permanent dead-letter with rejected certainty, attempt count one, no plan/checkpoint, active quarantine, and no execution; assert sibling delivery succeeds and a later scan does not prepare poison rows again. Separately force SQLite plan persistence and unclaimed-rejection persistence to throw; both scans must reject while the row remains pending and unclaimed.

Run the full outbox dispatcher module, focused store behavior as needed, typecheck, build, full suite, two-axis review, install/restart, and live outbox diagnostics.

## Out of Scope

- errors after plan persistence or during external execution;
- automatic repair of renderer code or card payloads;
- manual retry/dismiss UX for binding-less dead letters.

## Further Notes

- Workspace: in-place `main` at `/workspace/herdr-agent-swarm`.
- Starting revision: `6e22b2837145b4bd83b580d603e5f6be535385a5`.
- Existing user `TODO.md` and untracked documents remain untouched.
- Fresh baseline: `tests/lark-outbox-dispatcher.test.ts` 75/75 passed.
- Standing authorization covers implementation, verification, commit, installation, and deployment.
