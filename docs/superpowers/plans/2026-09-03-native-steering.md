# Native Steering Implementation Plan

> **For agentic workers:** Execute this plan inline. This repository session explicitly forbids sub-agent delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact-turn, idempotent native steering to Herdr and consume it through one durable Swarm turn-control workflow shared by Primary bindings and Worker instances.

**Architecture:** Herdr owns the external steering effect, exact Agent session/runtime-turn verification, approval blocking, and idempotency receipt. Swarm persists the requested target and operation before dispatch, refreshes Herdr evidence before claiming the effect, and never replays an operation that reached `dispatching`. Primary and Worker entry points resolve their domain records into the same `TurnTarget`; no coordinator writes steering text to a terminal.

**Tech Stack:** Rust (upstream Herdr CLI/socket/runtime), TypeScript, Node.js 22+, SQLite, Vitest, Lark CardKit

**Spec:** `docs/superpowers/specs/2026-09-03-native-steering-design.md`

## Global Constraints

- Milestone 1 is an upstream Herdr change. Do not enable Swarm steering against Herdr 0.7.5.
- Native steering requires the exact `paneId + agentSession + generation + logicalTurnId + runtimeTurnId` fence.
- Never implement steering with Pane text, paste, key injection, or a priority ordinary prompt.
- Persist operation intent before calling Herdr. Once an operation enters `dispatching`, restart recovery must not automatically replay it.
- `blocked` means approval or question UI is active and must fail closed; approval remains local to Herdr.
- Primary and Worker steering must call the same `TurnControlWorkflow`; do not retain a second direct `driver.steer()` path.
- Ordinary FIFO dispatch and detached transcript observation remain independent of steering dispatch.
- Keep steering text out of structured logs, command errors, health output, and audit details.
- Persist one payload-free `operation_result` card with acceptance and update it
  transactionally with delivered, rejected, or uncertain terminal state.
- Preserve existing model-selection behavior and unrelated worktree changes. Do not edit generated `dist/`.

---

### Task 1: Implement the Herdr-compatible steering protocol in the TraeX shim

**Repository:** `herdr-agent-swarm`. Herdr 0.7.5 and current upstream master have no native steer method, while TraeX 0.202.2 exposes `turn/steer` with `threadId` and required `expectedTurnId`. The repository-owned shim is therefore the initial protocol adapter.

**Files:**
- Modify: `src/runtime/traex-session-peer.ts`
- Create: `src/runtime/traex-native-steering.ts`
- Modify: `src/runtime/herdr-traex-shim.ts`
- Modify: `src/cli/herdr-traex-shim.ts`
- Modify: `scripts/install-herdr-traex-shim.sh`
- Test: `tests/traex-session-peer.test.ts`
- Create: `tests/traex-native-steering.test.ts`
- Modify: `tests/herdr-traex-shim.test.ts`
- Modify: `tests/herdr-traex-shim-install.test.ts`

**Interfaces:**
- Produces: `herdr agent steer <target> <text> --turn-id <runtime-turn-id> --idempotency-key <key>` with structured JSON output.
- Consumes: TraeX session-peer v1 records containing `threadId`, `socketPath`, `pid`, and `startedAtMs`.
- Consumes: TraeX app-server `initialize`, `initialized`, and `turn/steer` JSONL messages.
- Produces: a durable shim operation-result lookup by idempotency key after process restart.

- [ ] **Step 1: Extend the exact shim command parser and add failing protocol tests**

Cover the exact wire request and result union before implementation:

```ts
interface AgentSteerRequest {
  target: string;
  text: string;
  expectedAgentSession: { source: string; agent: string; kind: "id" | "path"; value: string };
  expectedTurnId: string;
  idempotencyKey: string;
}

type AgentSteerResult =
  | { status: "delivered"; operationId: string; turnId: string }
  | { status: "not-active"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "unsupported"; reason: string }
  | { status: "delivery-uncertain"; operationId: string; reason: string };
```

Assert that the protocol rejects a missing session fence, missing turn ID, and empty idempotency key before any Agent input occurs.

- [ ] **Step 2: Resolve and validate the exact local session peer**

Resolve the session-peer record by the Herdr Agent session UUID. Require a canonical filename, protocol v1, matching thread ID, local location, live PID/start identity, absolute Unix socket path, owner-only file/socket permissions, and no symlink. Fail closed on missing, stale, or ambiguous records.

- [ ] **Step 3: Persist the idempotency record before invoking TraeX**

Atomically validate the pane occupant, Agent session, current runtime turn, steerable state, and idempotency key. Persist an operation before the external effect. A duplicate key returns its stored result and cannot invoke the runtime twice.

- [ ] **Step 4: Add the native TraeX app-server call and fail-closed states**

Connect to the peer socket, perform `initialize`/`initialized`, then call `turn/steer` with one text `UserInput`, the peer thread ID, and `expectedTurnId`. Return `blocked` for `activeTurnNotSteerable`, `not-active` for a stale/completed turn, `unsupported` when the session peer lacks the protocol, and `delivery-uncertain` when the effect may have happened but confirmation was lost.

- [ ] **Step 5: Add CLI and app-server socket tests**

Cover successful delivery, stale turn, replaced Agent session, blocked UI, duplicate idempotency key, response loss after delivery, and stored-result lookup after Herdr restart. Assert that no successful or failing case calls Pane text/key input.

- [ ] **Step 6: Build and install a pinned shim release**

Run the focused shim tests, typecheck, and build. Install through `npm run herdr:traex:install -- --bin-dir <absolute-path>` and record the immutable shim release ID plus validated Herdr and TraeX versions.

### Task 2: Add capability and native steer contracts to Swarm

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/agent-runtime.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `src/runtime/workspace-snapshot-cache.ts`
- Modify: `src/runtime/herdr-circuit-breaker.ts`
- Test: `tests/herdr-adapter.test.ts`

**Interfaces:**
- Consumes: upstream Herdr snapshot capability, `activeTurnId`, and structured steer JSON result.
- Produces: `HerdrPort.steerAgent(...)` and a lossless `SteerReceipt` containing `delivered | not-active | blocked | unsupported | delivery-uncertain`.

- [ ] **Step 1: Add failing snapshot and command parsing tests**

Add adapter cases for `native`, `terminal-input`, and `unsupported` capability values plus nullable `activeTurnId`. Add command cases for all five outcomes, malformed JSON, timeout before command start, and timeout after command start. Assert that steering text is absent from thrown errors and recorded command summaries.

- [ ] **Step 2: Extend normalized Herdr types**

Add `steeringCapability` and `activeTurnId` to `HerdrPane` and preserve them through `RuntimeObservation`. Extend `SteerReceipt` so `blocked` and `delivery-uncertain` are not collapsed into generic failure. Include upstream `operationId` and confirmed `turnId` where returned.

- [ ] **Step 3: Add the structured port and adapter implementation**

Add:

```ts
steerAgent(input: {
  paneId: string;
  agentSession: HerdrAgentSession;
  runtimeTurnId: string;
  text: string;
  idempotencyKey: string;
}): Promise<SteerReceipt>;
```

Invoke only the upstream `agent steer` command/socket operation. Classify a lost response after command start as `delivery-uncertain`; never retry inside the adapter. Forward the new method through cache and circuit-breaker wrappers without caching the operation result.

- [ ] **Step 4: Keep text-only driver steering disabled**

Do not route native steering through `AgentRuntimeDriver.steer(runtime, text)`: that seam cannot carry the Agent session and exact runtime-turn fence. Keep it unsupported until Task 6 removes the old direct Worker call. Native enablement comes only from fresh per-pane Herdr capability observed by `TurnControlWorkflow`; static driver capabilities are not sufficient.

- [ ] **Step 5: Run focused adapter and driver tests**

Run: `npx vitest run tests/herdr-adapter.test.ts`

Expected: every outcome is preserved, wrappers forward exactly once, and no steering test expects `pane send-text` or `pane send-keys`.

### Task 3: Introduce durable exact-turn control operations

**Files:**
- Create: `src/domain/turn-control.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-records.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Produces: one `turn_control_operations` table for Primary and Worker `steer`/`interrupt` operations.
- Produces: atomic acceptance, claim, terminal transition, duplicate lookup, and restart recovery methods.

- [ ] **Step 1: Define the normalized target and state machine**

```ts
interface TurnTarget {
  owner: { kind: "binding"; id: string } | { kind: "instance"; id: string };
  projectId: string;
  paneId: string;
  generation: number;
  agentSession: HerdrAgentSession;
  logicalTurnId: string;
  runtimeTurnId: string;
}

type TurnControlState =
  | "accepted"
  | "dispatching"
  | "delivered"
  | "rejected"
  | "uncertain";
```

The durable row also stores kind, actor JSON, source message/card identity, idempotency key, result JSON, and timestamps. Payload text is stored only where required to resume an `accepted` operation and is never selected by health/diagnostic summaries.

- [ ] **Step 2: Add migration tests before the schema change**

Test a fresh database and an upgrade database. Assert all target fence columns are non-null, owner kind is checked, idempotency is unique, and state transitions cannot move a terminal row back to dispatching.

- [ ] **Step 3: Implement transactional acceptance and claim**

Acceptance must persist the steering prompt/run-card projection and control operation in one SQLite transaction for Primary requests. Worker requests must persist their operation and card projection atomically when a card exists. Claim changes `accepted -> dispatching` exactly once and rechecks owner generation and logical/runtime turn identity.

- [ ] **Step 4: Implement strict recovery**

On startup, retain `accepted` for safe redispatch and convert every orphaned `dispatching` row to `uncertain` in one transaction. Never restore `dispatching` to `accepted`. Terminal duplicate requests return the stored receipt.

- [ ] **Step 5: Retire overlapping legacy steering records safely**

Keep `pane_control_operations` for model and compatibility-period stop behavior. Migrate no legacy steer row into a dispatchable state: existing accepted/running/applied steer rows become rejected or uncertain according to whether delivery could have started. Stop creating steer rows in `pane_control_operations` and stop creating steer operations in `instance_operations` after callers move to the new store.

- [ ] **Step 6: Run store tests**

Run: `npx vitest run tests/sqlite-store.test.ts`

Expected: fresh migration, upgrade migration, duplicate acceptance, stale generation, exact-turn claim, accepted recovery, dispatching recovery, and terminal idempotency all pass.

### Task 4: Build the unified TurnControlWorkflow

**Files:**
- Create: `src/coordinator/turn-control-workflow.ts`
- Modify: `src/coordinator/pane-runtime-identity.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/main.ts`
- Test: `tests/turn-control-workflow.integration.test.ts`

**Interfaces:**
- Consumes: durable owner/turn records, a forced fresh Herdr pane observation, and `HerdrPort.steerAgent`.
- Produces: `steer(input: SteerCommand): Promise<SteerOutcome>` and `interrupt(input: InterruptCommand): Promise<InterruptOutcome>`.

- [ ] **Step 1: Add failing target-resolution tests**

Cover Primary and Worker targets, attached and detached observers, stale generations, changed pane occupant, missing session, missing runtime turn, changed runtime turn, `idle`, `done`, `blocked`, `terminal-input`, and `unsupported`. Assert that process-local `activeTurn()` is never the sole authority.

- [ ] **Step 2: Implement owner resolvers**

Resolve Primary from the binding plus its exact active/detached ordinary prompt (`transcriptTurnId`). Resolve Worker from the instance plus exact active turn (`runtimeTurnId`). Normalize both into `TurnTarget` and require a persisted Agent session.

- [ ] **Step 3: Revalidate against a fresh Herdr observation**

Bypass the workspace snapshot TTL for control dispatch. Require the same pane, Agent session, native steering capability, active runtime turn, and `working` state immediately before claim/invocation. Return a deterministic rejection for `blocked`, `idle`, `done`, or stale identity without calling Herdr steer.

- [ ] **Step 4: Implement dispatch and outcome mapping**

Accept durably, wake a per-owner single-flight worker, claim to `dispatching`, and call Herdr with the durable operation ID as idempotency key. Map `delivered` to delivered, explicit pre-effect results to rejected, and `delivery-uncertain` or unclassified post-start failures to uncertain. Do not convert uncertain into failed or FIFO work.

- [ ] **Step 5: Implement startup recovery and stored-result reconciliation**

Drain accepted operations after startup. For uncertain rows, query the upstream durable Herdr operation result only if that lookup is part of the published protocol; reconcile only an exact stored result and otherwise leave the row uncertain.

- [ ] **Step 6: Add redacted structured logs and audit records**

Log operation ID, owner ID/kind, generation, pane ID, logical turn ID, runtime turn ID, and outcome. Audit actor and outcome without payload. Add a test that serializes captured logs/status and proves the steering text is absent.

- [ ] **Step 7: Run the unified workflow tests**

Run: `npx vitest run tests/turn-control-workflow.integration.test.ts`

Expected: both owner kinds use the same execution path, detached exact-turn steering succeeds, and every stale/blocked/uncertain case performs at most one external call.

### Task 5: Route Primary steering through the unified workflow

**Files:**
- Modify: `src/coordinator/pane-control-workflow.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/events/prompt-work-scheduler.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/domain/events.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `src/domain/run-card-view.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/main.ts`
- Test: `tests/steering-integration.test.ts`
- Test: `tests/concurrency-controls.integration.test.ts`
- Test: `tests/run-card.test.ts`

**Interfaces:**
- Consumes: `/swarm steer <text>` and exact parent prompt identity.
- Produces: a dedicated durable operation-result card that reaches delivered, rejected, or uncertain.

- [ ] **Step 1: Replace unconditional-rejection tests with capability-gated acceptance tests**

Test native working target, unsupported Herdr 0.7.5-style target, blocked target, detached matching target, missing runtime identity, duplicate Lark event, and parent completion race. Assert the inbound handler returns after durable acceptance and does not await native delivery.

- [ ] **Step 2: Make PaneControlWorkflow a thin Primary adapter**

Resolve authorization and binding identity, then call `TurnControlWorkflow`. Remove `executeSteer()` and all steer creation/claim/recovery through `pane_control_operations`. Keep model and compatibility stop behavior isolated.

- [ ] **Step 3: Remove the legacy steering worker from PromptRunWorkflow**

Stop scanning `dispatch_kind='steering'` as prompt execution work. Preserve existing ordinary FIFO and detached observer logic. Delete recovery logic that blanket-rejects legacy steering only after the schema migration provides its one-time terminalization.

- [x] **Step 4: Project all explicit outcomes**

Persist the operation transition and its `operation_result` outbox intent transactionally. Render accepted, delivered, rejected, and uncertain distinctly. If the accepted card is pending, coalesce its payload; if it has already been delivered, enqueue one idempotent card update.

- [ ] **Step 5: Verify FIFO independence and races**

Test that steering neither consumes nor reorders queued ordinary turns, a completed parent cannot be steered, a turn change between acceptance and dispatch rejects before effect, and a bridge restart in dispatching produces uncertain without replay.

- [ ] **Step 6: Run Primary steering and card tests**

Run: `npx vitest run tests/steering-integration.test.ts tests/concurrency-controls.integration.test.ts tests/run-card.test.ts`

### Task 6: Route Worker steering through the unified workflow

**Files:**
- Modify: `src/coordinator/instance-messaging-workflow.ts`
- Modify: `src/coordinator/instance-interaction-workflow.ts`
- Modify: `src/domain/agent-runtime.ts`
- Modify: `src/runtime/agents/traex-driver.ts`
- Modify: `src/cards/worker-turn-card.ts`
- Modify: `src/domain/worker-turn-card-view.ts`
- Modify: `src/main.ts`
- Test: `tests/instance-messaging.integration.test.ts`
- Test: `tests/primary-worker-flow.integration.test.ts`
- Test: `tests/primary-tool-gateway.integration.test.ts`

**Interfaces:**
- Consumes: explicit Worker steer commands, active-card replies, and Primary MCP steer calls.
- Produces: the same durable outcome semantics as Primary steering.

- [ ] **Step 1: Add shared-path Worker tests**

Assert explicit command, card reply, and Primary tool calls resolve the same instance generation and exact Worker runtime turn before entering `TurnControlWorkflow`. Include duplicate idempotency, restarted instance generation, completed turn, blocked state, and detached matching-turn cases.

- [ ] **Step 2: Remove direct driver steering**

Replace `InstanceMessagingWorkflow.steer()` authorization-plus-`driver.steer()` execution with authorization plus the unified workflow. Remove the text-only `AgentRuntimeDriver.steer(runtime, text)` contract and TraeX stub after all callers are gone. Stop creating `instance_operations(kind='steer')`; retain interrupt compatibility only until it is moved through the same normalized workflow.

- [x] **Step 3: Make asynchronous outcomes visible**

Do not report success merely because acceptance succeeded. Worker cards and command responses must distinguish accepted, delivered, rejected, and uncertain. Wake the durable outbox after every projected transition.

- [ ] **Step 4: Verify Primary tool idempotency and generation fencing**

Replay the same MCP idempotency key and assert one Herdr effect. Replace/restart the Worker between acceptance and dispatch and assert rejection with zero effect.

- [ ] **Step 5: Run Worker and gateway tests**

Run: `npx vitest run tests/instance-messaging.integration.test.ts tests/primary-worker-flow.integration.test.ts tests/primary-tool-gateway.integration.test.ts`

### Task 7: Add recovery diagnostics, documentation, and feature gates

**Files:**
- Modify: `src/config.ts`
- Modify: `src/runtime/health-server.ts`
- Modify: `src/coordinator/operations-query-service.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/health-server.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md`

**Interfaces:**
- Produces: disabled-by-default rollout control plus redacted operation counts and oldest nonterminal age.

- [ ] **Step 1: Add an explicit rollout gate**

Add a configuration flag whose default is disabled. Native capability is necessary but not sufficient: steering is accepted only when the flag is enabled and the fresh target reports `native`. Validate the setting at startup.

- [ ] **Step 2: Add redacted operational diagnostics**

Report counts for accepted, dispatching, delivered, rejected, and uncertain operations plus oldest nonterminal age. Do not expose actor, payload, session value, or prompt text. Mark readiness degraded only according to an explicit threshold for stuck accepted operations; uncertain is an operator-visible outcome, not a replay trigger.

- [ ] **Step 3: Update architecture and user semantics**

Document the Herdr/SQLite/Lark ownership boundary, exact target fence, detached behavior, restart rules, blocked rejection, and absence of terminal fallback. Keep `/swarm steer` documented as unavailable while the rollout flag is off; update it to capability-gated only in the release that enables the flag.

- [ ] **Step 4: Run config and health tests**

Run: `npx vitest run tests/config.test.ts tests/health-server.test.ts`

### Task 8: Cross-repository verification and staged rollout

**Files:**
- Verify: all files changed by Tasks 2-7
- Verify: pinned upstream Herdr build from Task 1
- Update: release/operator notes with Herdr version and smoke evidence

**Interfaces:**
- Consumes: configured real Herdr workspace and Lark bridge.
- Produces: a tested immutable Swarm release with native steering initially disabled, then progressively enabled.

- [ ] **Step 1: Run static and full repository verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
rg -n "send-text|send-keys|submitPromptText" src/coordinator src/runtime/agents
```

Expected: tests, typecheck, and build pass; the scan finds no steering path that writes terminal input. Review every remaining match as non-steering behavior.

- [ ] **Step 2: Validate configured bridge without external mutation**

Run `npm run config:validate -- <env-file> <projects-file>` and `npm run smoke:real-user`. Confirm the observed Herdr build matches the pinned version, native capability is present only for supported TraeX sessions, exact active-turn IDs are visible, and steering remains disabled by configuration.

- [ ] **Step 3: Exercise the protocol in an isolated Herdr/Lark test project**

Start a controlled long turn and steer it once. Replay the same Lark event and verify one injection. Repeat with blocked, detached, just-completed, replaced-session, and replaced-generation targets. Restart Swarm with one accepted operation and one dispatching operation; verify accepted resumes and dispatching becomes uncertain without a second injection.

- [ ] **Step 4: Build and install an immutable disabled release**

Run `./install.sh`, then inspect `npm run swarm:status`. Confirm expected and observed build IDs match, lease and SQLite integrity are healthy, startup recovery completed, and no control operation was replayed. Installation enables but does not start the unit.

- [ ] **Step 5: Enable Worker steering in one test project**

Turn on the gate only for the controlled route supported by the chosen configuration design. Restart through `npm run swarm:restart` only after the active-work safety gate permits it. Verify Worker command, card reply, duplicate, blocked, detached, and restart behavior. Monitor rejected/uncertain counts and logs by operation ID.

- [ ] **Step 6: Enable Primary steering in one test project**

Run `/swarm steer 输出当前阶段后继续` during a controlled long-running Primary turn. Verify the same transcript turn incorporates the instruction, the ordinary FIFO is unchanged, and the dedicated Answer Card reaches delivered. Repeat the race cases before broader enablement.

- [ ] **Step 7: Complete rollout and documentation switch**

Enable only after isolated Worker and Primary evidence is clean. Update the user guide from "unsupported" to capability-gated native steering in the same release. Keep automatic continuation steering disabled; it requires a separate design and rollout.

## Completion Criteria

- Herdr publishes native steering, exact runtime-turn identity, and durable idempotency receipts.
- Swarm enables steering only with both the rollout gate and fresh `native` capability.
- Primary and Worker calls execute through one durable `TurnControlWorkflow`.
- Detached targets work only when SQLite and fresh Herdr evidence identify the same turn.
- Duplicate requests cause at most one external effect.
- Restart after dispatch starts never automatically replays the operation.
- Blocked, stale session, stale generation, completed turn, and uncertain delivery are explicit user-visible outcomes.
- Ordinary FIFO order, local-only approval, CardKit sequencing, and frozen pages remain intact.
- Production steering contains no terminal text/key fallback.
