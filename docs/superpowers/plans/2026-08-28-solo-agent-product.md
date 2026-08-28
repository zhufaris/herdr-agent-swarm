# Solo Agent Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the single-TraeX Lark bridge into a headless, human-controlled multi-agent product supporting multiple projects, one primary plus explicit workers per project, isolated worker worktrees, controlled primary-to-worker messaging, and honest Pi, Claude Code, Codex, and TraeX adapters.

**Architecture:** Preserve SQLite state machines, durable outbox, no-replay dispatch, and Herdr reconciliation. Add an instance model alongside legacy bindings, separate Herdr pane hosting from agent protocol drivers, route both human and primary messages through one instance messaging workflow, and migrate traffic incrementally. Human actions own topology; worker completion never creates a primary turn.

**Tech Stack:** Node.js 22.5+, TypeScript ESM, Zod, better-sqlite3, Vitest, Lark CardKit SDK, Herdr headless CLI/socket, Git worktrees, user systemd.

**Spec:** `docs/superpowers/specs/2026-08-28-solo-agent-product-design.md`

## Global Constraints

- Herdr headless server is mandatory; Herdr TUI is optional.
- SQLite owns workflow intent; Herdr owns live pane/process facts; Git owns worktree facts; Feishu is never a source of truth.
- A possibly delivered prompt is never replayed automatically.
- One ordinary turn may run per instance; different instances may run concurrently.
- Humans create, remove, promote, and retarget instances. The primary only controls existing same-project workers.
- Worker completion never creates a primary turn.
- Writable workers default to platform-owned branches and worktrees; unsafe worktrees are retained.
- Local ESM imports use `.js`; code uses two-space indentation and double-quoted strings.
- Every schema and external CLI result is validated with Zod.
- Every task preserves existing TraeX bridge behavior until its replacement path is covered by tests.

---

### Task 1: Instance and adapter contracts

**Files:**
- Create: `src/domain/agent-instance.ts`
- Create: `src/domain/agent-runtime.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/config.ts`
- Test: `tests/agent-instance.test.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces `AgentKind`, `AgentInstance`, `WorkspaceLease`, `AgentCapabilities`, `DispatchReceipt`, `validatePrimaryAssignment()`, and `resolveInstanceTarget()`.
- Extends `ProjectConfig` with `maxInstances` and optional declarative `instances`; legacy project files remain valid.

- [ ] Add failing domain tests proving one primary per project, symbolic primary routing, fixed explicit routing, stale generation rejection, and unavailable capabilities.
- [ ] Add failing configuration tests for all four agent kinds, duplicate instance names, multiple primaries, invalid main-checkout workers, and legacy registry compatibility.
- [ ] Run `npx vitest run tests/agent-instance.test.ts tests/config.test.ts` and confirm the new expectations fail.
- [ ] Implement the pure domain contracts and Zod registry schema. Runtime state and credentials must not be accepted from configuration.
- [ ] Re-run the focused tests, `npm run typecheck`, and `npm run build`.
- [ ] Commit the slice as `feat: define multi-agent instance contracts`.

### Task 2: Durable instance and workspace state

**Files:**
- Create: `src/store/instance-records.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes domain types from Task 1.
- Produces `InstanceStore` operations: `createInstance`, `listInstances`, `getInstance`, `setPrimary`, `transitionInstance`, `attachInstanceRuntime`, `createWorkspaceLease`, `updateWorkspaceLease`, and `planInstanceRemoval`.

- [ ] Add store tests for additive migration, unique project/name, at-most-one-primary, generation-fenced runtime writes, worktree ownership, and safe removal plans.
- [ ] Add a compatibility test proving a legacy binding can be projected as a TraeX instance without dispatching a prompt.
- [ ] Run the focused store tests and confirm the new cases fail.
- [ ] Add additive tables and indexes; keep multi-row role/runtime/workspace transitions transactional.
- [ ] Implement typed record mapping and capability-focused `InstanceStore`; do not expose raw SQL to workflows.
- [ ] Re-run focused tests, typecheck, build, and existing migration tests.
- [ ] Commit as `feat: persist agent instances and workspaces`.

### Task 3: Pane host and TraeX driver extraction

**Files:**
- Create: `src/runtime/herdr/pane-host.ts`
- Create: `src/runtime/agents/agent-driver.ts`
- Create: `src/runtime/agents/traex-driver.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Test: `tests/pane-host.test.ts`
- Test: `tests/agent-driver-contract.test.ts`
- Test: `tests/herdr-adapter.test.ts`
- Test: `tests/concurrency-controls.integration.test.ts`

**Interfaces:**
- Produces `PaneHost`, `AgentRuntimeDriver`, `AgentDriverRegistry`, and a TraeX reference driver.
- Existing `HerdrPort` remains a compatibility facade delegating to pane host plus TraeX driver during migration.

- [ ] Write contract tests for availability, launch specification, identity detection, submit receipts, normalized lifecycle, redaction, steer, interrupt, and uncertain delivery.
- [ ] Run the contract and Herdr tests and confirm they fail for the absent modules.
- [ ] Move generic workspace/pane operations behind `PaneHost`; keep command execution through `CommandRunner`.
- [ ] Move TraeX-specific process, composer, session, transcript, and permission behavior into `TraexDriver`.
- [ ] Make the legacy facade delegate without changing externally observed bridge behavior.
- [ ] Run focused tests, concurrency integration tests, typecheck, build, and full tests.
- [ ] Commit as `refactor: separate Herdr host from TraeX driver`.

### Task 4: Human-controlled instance lifecycle

**Files:**
- Create: `src/coordinator/instance-control-workflow.ts`
- Create: `src/runtime/worktree-manager.ts`
- Modify: `src/domain/commands.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/main.ts`
- Test: `tests/instance-control.integration.test.ts`
- Test: `tests/worktree-manager.test.ts`

**Interfaces:**
- Produces `InstanceControlWorkflow.create/start/stop/setPrimary/planRemoval/confirmRemoval/inspect/list`.
- Produces `WorktreeManager.prepare/inspect/planRemoval/release` using argv-only Git commands and verified repository-relative ownership.

- [ ] Add failing tests for explicit creation, main-checkout primary, isolated worker allocation, branch conflicts, partial provisioning checkpoints, and one primary.
- [ ] Add failing removal tests for dirty, conflicted, ahead, uncertain, stale-plan, and clean worktrees.
- [ ] Run focused tests and confirm failures.
- [ ] Implement the durable provisioning saga with a checkpoint after each external effect.
- [ ] Implement safe removal planning; confirmation must match generation, branch head, and dirty fingerprint.
- [ ] Wire the workflow into the composition root without exposing it to Feishu yet.
- [ ] Run focused tests, typecheck, build, and full tests.
- [ ] Commit as `feat: add managed agent instance lifecycle`.

### Task 5: Unified instance messaging and primary tools

**Files:**
- Create: `src/coordinator/instance-messaging-workflow.ts`
- Create: `src/runtime/primary-tool-broker.ts`
- Create: `src/events/instance-work-scheduler.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/main.ts`
- Test: `tests/instance-messaging.integration.test.ts`
- Test: `tests/primary-tool-broker.test.ts`

**Interfaces:**
- Produces `InstanceMessagingWorkflow.submit/steer/interrupt/inspect`.
- Produces fixed primary tools `listInstances`, `promptInstance`, `followUpInstance`, `steerInstance`, `inspectInstance`, `waitInstance`, and `interruptInstance`.

- [ ] Add failing tests for per-instance FIFO, cross-instance parallel claims, explicit steering, unsupported steering, and no implicit fallback.
- [ ] Add failing authorization tests for human actors, current primary generation, same-project workers, cross-project denial, worker denial, and forbidden topology tools.
- [ ] Add a test proving worker completion records an event but does not enqueue a primary turn.
- [ ] Run focused tests and confirm failures.
- [ ] Implement durable accept-before-wake and generation-fenced claims using the new instance store.
- [ ] Implement the fixed tool broker with trusted context supplied outside model arguments.
- [ ] Run focused tests, typecheck, build, and full tests.
- [ ] Commit as `feat: add instance messaging and primary worker tools`.

### Task 6: Feishu instance controls and routing

**Files:**
- Create: `src/cards/instance-directory-card.ts`
- Create: `src/cards/instance-detail-card.ts`
- Create: `src/coordinator/instance-interaction-workflow.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/coordinator/card-interaction-workflow.ts`
- Modify: `src/adapters/lark-adapter.ts`
- Modify: `src/main.ts`
- Test: `tests/instance-cards.test.ts`
- Test: `tests/instance-routing.integration.test.ts`
- Test: `tests/card-interaction-workflow.test.ts`

**Interfaces:**
- Consumes Tasks 4 and 5 workflows.
- Produces `/projects`, `/project`, `/instances`, `/instance`, `/to`, `/steer`, and `/interrupt`, plus CardKit forms for lifecycle and persistent target selection.

- [ ] Add renderer tests for project summary, primary/target labels, capabilities, worktree evidence, and absent unsupported controls.
- [ ] Add routing tests for symbolic primary, fixed target, one-shot `/to`, missing-primary directory response, and duplicate Lark events.
- [ ] Add callback tests proving current generation, operator scope, and removal-plan freshness are reloaded from SQLite.
- [ ] Run focused tests and confirm failures.
- [ ] Implement pure renderers and a single interaction workflow used by both commands and callbacks.
- [ ] Connect inbound routing while retaining legacy topic behavior for unmigrated bindings.
- [ ] Run focused tests, typecheck, build, and full tests.
- [ ] Commit as `feat: add Feishu multi-agent controls`.

### Task 7: Codex, Claude Code, and Pi drivers

**Files:**
- Create: `src/runtime/agents/codex-driver.ts`
- Create: `src/runtime/agents/claude-code-driver.ts`
- Create: `src/runtime/agents/pi-driver.ts`
- Modify: `src/runtime/agents/agent-driver.ts`
- Modify: `src/config.ts`
- Test: `tests/agent-driver-contract.test.ts`
- Test: `tests/agent-driver-fixtures/`

**Interfaces:**
- Each driver implements the Task 3 `AgentRuntimeDriver` contract and supplies an exact `AgentCapabilities` descriptor.
- Availability requires executable discovery and successful Herdr integration detection.

- [ ] Capture bounded, non-secret lifecycle fixtures for Codex, Claude Code, and Pi.
- [ ] Add each driver to the shared contract suite with explicit supported and unsupported behavior.
- [ ] Run the contract test and confirm each missing driver fails.
- [ ] Implement Codex launch, identity, lifecycle, dispatch, steer, interrupt, and reconciliation.
- [ ] Implement Claude Code against its verified CLI and Herdr agent kind; mark unverified native features unsupported.
- [ ] Implement Pi against its verified CLI and Herdr agent kind; mark unverified native features unsupported.
- [ ] Validate configured binaries at startup and render unavailable drivers honestly.
- [ ] Run contract tests, typecheck, build, and full tests.
- [ ] Commit one driver at a time as `feat: add <agent> runtime driver`.

### Task 8: Approval tiers and recovery convergence

**Files:**
- Create: `src/domain/approval-policy.ts`
- Create: `src/coordinator/instance-runtime-reconciler.ts`
- Modify: `src/runtime/shutdown.ts`
- Modify: `src/health/server.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/main.ts`
- Test: `tests/approval-policy.test.ts`
- Test: `tests/instance-runtime-reconciler.test.ts`
- Test: `tests/shutdown.test.ts`
- Test: `tests/health-server.test.ts`

**Interfaces:**
- Produces deterministic `classifyAction()` and `fingerprintAction()` for routine, remote-confirmation, and local-only actions.
- Produces the sole `InstanceRuntimeReconciler` path for startup, periodic, and event-driven convergence.

- [ ] Add policy tests for workspace operations, tests, commit, push, deploy, delete, credentials, sensitive paths, and changed-action invalidation.
- [ ] Add recovery tests for matching runtime, mismatched process, missing idle pane, missing active pane, uncertain dispatch, stale generation, and unrecorded pane.
- [ ] Add readiness and shutdown tests for adapter initialization, reconciliation completion, lease loss, and detached observers.
- [ ] Run focused tests and confirm failures.
- [ ] Implement fixed policy tiers and single-use approval grants.
- [ ] Implement snapshot-based reconciliation and startup ordering; Herdr events remain hints.
- [ ] Integrate readiness and shared-deadline shutdown.
- [ ] Run focused tests, typecheck, build, and full tests.
- [ ] Commit as `feat: secure and recover multi-agent runtime`.

### Task 9: Standalone packaging, documentation, and live acceptance

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md`
- Modify: `install.sh`
- Modify: `plugin/`
- Create: `service/solo-agent.service`
- Create: `scripts/smoke-headless-multi-agent.ts`
- Test: `tests/config.test.ts`
- Test: `tests/plugin-lifecycle.test.ts`

**Interfaces:**
- Produces standalone daemon install/start/status/log/restart commands and retains the plugin only as an optional operator surface.
- Produces `npm run smoke:headless-multi-agent` for non-TUI operational acceptance.

- [x] Add packaging tests for private config/state paths, headless Herdr dependency, generated build identity, and optional plugin operation.
- [x] Implement user-systemd units and install flow without embedding secrets in unit files or project configuration.
- [x] Add a bounded smoke runner that creates an isolated project, explicitly provisions a TraeX Primary and TraeX Worker, exercises a primary worker call, restarts durable state, and verifies no replay.
- [x] Update README, architecture, Feishu command reference, configuration examples, safety boundaries, recovery guidance, and adapter availability documentation.
- [x] Run configuration validation and focused packaging tests.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [x] Run the real headless smoke for the selected TraeX deployment; record executable versions, instance IDs, pane IDs, turn IDs, restart evidence, and results without secrets. Executable discovery for other adapters remains distinct from authentication/live verification.
- [x] Commit as `feat: ship standalone solo agent daemon` (`c518b00`).

### Task 10: Completion audit

**Files:**
- Create: `docs/superpowers/audits/2026-08-28-solo-agent-product.md`
- Modify: ticket, spec, plan, and user documentation only where evidence reveals a mismatch.

**Interfaces:**
- Produces a prompt-to-artifact matrix mapping every ticket criterion and explicit user requirement to code, tests, and live evidence.

- [x] Restate the objective as concrete deliverables and list every ticket acceptance criterion.
- [x] Map each criterion to exact implementation modules, focused tests, and live evidence; mark missing or weak coverage as incomplete.
- [x] Inspect Git status, staged and committed diffs, generated build identity, configuration validation, test output, and daemon readiness.
- [x] Re-run `npm test`, `npm run typecheck`, and `npm run build` after the final edit.
- [x] Re-run the selected TraeX Primary plus TraeX Worker headless smoke and confirm no Herdr TUI process is required.
- [x] Verify unavailable adapters are documented as unavailable rather than claimed complete.
- [x] Verify no secret, database, WAL/SHM, log, runtime state, or live project registry is tracked.
- [x] Record residual non-goals separately from incomplete requirements.
- [x] Mark the ticket complete only when every in-scope criterion has direct evidence.

## Plan Self-Review

- Spec coverage: Tasks 1-10 cover domain, configuration, persistence, pane/driver seams, human lifecycle, primary tools, Feishu, all four adapters, approvals, recovery, packaging, documentation, real smoke, and final audit.
- Type consistency: `AgentKind`, `AgentInstance`, `WorkspaceLease`, `AgentRuntimeDriver`, `InstanceControlWorkflow`, and `InstanceMessagingWorkflow` are introduced before their consumers.
- Scope discipline: automatic orchestration, automatic worker creation, automatic primary continuation, merge/push/deploy, cross-host scheduling, and plugin marketplaces remain excluded.
- Verification discipline: every implementation task starts with failing tests and ends with focused tests, typecheck/build, and an independently reviewable commit; cross-cutting tasks run the full suite.
