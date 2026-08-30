# Standalone Agent Swarm Service Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compatibility `herdr-lark-bridge.service` production unit with an enabled, standalone `herdr-agent-swarm.service` while preserving configuration and durable SQLite state.

**Architecture:** Reuse the existing standalone lifecycle renderer and startup verifier. Add standalone-only `enable --now` start semantics and a TypeScript cutover command that copies private configuration, proves the compatibility service is drained, performs stop-before-start handoff, verifies the new service, and rolls back safely on failure.

**Tech Stack:** TypeScript ESM, Node.js 22+, Vitest, Bash entrypoint, systemd user units, SQLite, HTTP health probes.

**Spec:** `docs/superpowers/specs/2026-08-30-standalone-service-cutover-design.md`

## Global Constraints

- Never run both service units against the same SQLite database.
- Preserve the existing absolute `BRIDGE_DATABASE_PATH`; do not copy a live SQLite database.
- Never print `.env` contents or credentials.
- Reject normal cutover when prompt, outbox, worker, or instance work is active or uncertain.
- Do not force restart or replay prompts.
- Preserve compatibility plugin lifecycle behavior outside the explicit cutover.
- Require matching build identity, completed startup recovery, ready dependencies, healthy SQLite, and a held lease before accepting the new service.

---

### Task 1: Standalone start enables the user unit

**Files:**
- Modify: `src/cli/plugin-lifecycle.ts`
- Test: `tests/plugin-lifecycle.test.ts`

**Interfaces:**
- Consumes: standalone detection through `SWARM_ROOT`.
- Produces: `runPluginLifecycle("start", env)` delegates to `systemctl --user enable --now <service>` only in standalone mode.

- [x] Add a lifecycle test asserting standalone start records `--user enable --now herdr-agent-swarm.service`, while plugin-mode start still records `--user start <service>`.
- [x] Run `npx vitest run tests/plugin-lifecycle.test.ts` and confirm the standalone assertion fails.
- [x] Change only the start argument selection in `runPluginLifecycle`; keep restart, stop, install, and plugin behavior unchanged.
- [x] Re-run `npx vitest run tests/plugin-lifecycle.test.ts` and confirm it passes.
- [x] Commit `src/cli/plugin-lifecycle.ts` and `tests/plugin-lifecycle.test.ts` as `fix: enable standalone service on start`.

### Task 2: Safe compatibility-to-standalone cutover command

**Files:**
- Create: `src/cli/swarm-service-cutover.ts`
- Create: `tests/swarm-service-cutover.test.ts`
- Modify: `scripts/swarm-service.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: compatibility config/state defaults, standalone config/state defaults, generated build identity, `runPluginLifecycle`, systemd status, and `/status`.
- Produces: `runStandaloneCutover(environment): Promise<number>` and `npm run swarm:migrate`.

- [x] Add focused tests with fake `systemctl` and HTTP status endpoints for private config copy, active-work rejection, strict old-stop/new-start ordering, rollback after failed new startup, and idempotent already-migrated execution.
- [x] Run `npx vitest run tests/swarm-service-cutover.test.ts` and confirm failure because the module and command do not exist.
- [x] Implement configuration preparation with `0700` directories and `0600` files; retain explicit `BRIDGE_DATABASE_PATH` and validate before stopping a service.
- [x] Implement a bounded safety parser requiring zero running prompts, active prompt workers, active or uncertain instance turns, and pending outbox.
- [x] Implement stop-before-start handoff using the existing lifecycle verifier; on failure stop the new unit before restoring the old unit's prior active/enabled state.
- [x] Add `migrate` to `scripts/swarm-service.sh` and `swarm:migrate` to `package.json`.
- [x] Re-run `npx vitest run tests/swarm-service-cutover.test.ts tests/plugin-lifecycle.test.ts` and confirm all cases pass.
- [x] Commit the module, tests, shell entrypoint, and package manifest as `feat: add standalone service cutover`.

### Task 3: Operator documentation and repository verification

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/plans/2026-08-30-standalone-service-cutover.md`

**Interfaces:**
- Consumes: `npm run swarm:migrate`, canonical service/config/state paths, and rollback behavior.
- Produces: one documented production operator path with the compatibility unit explicitly non-authoritative.

- [x] Document prerequisites, migration command, safety refusal, retained absolute database path, success checks, and rollback outcome.
- [x] Update architecture ownership to name `herdr-agent-swarm.service` as canonical and the plugin service as compatibility-only.
- [x] Run `rg -n "herdr-lark-bridge.service|herdr-agent-swarm.service|swarm:migrate" README.md docs/architecture.md` and verify every active reference has the correct role.
- [x] Run `npm run typecheck`, `npm run build`, and `npm test`.
- [x] Run `git diff --check`.
- [ ] Commit documentation and checked plan state as `docs: document standalone service cutover`.

### Task 4: Live single-instance migration

**Files:**
- Runtime configuration: `~/.config/herdr-agent-swarm/.env` and `projects.json`
- Runtime state: `~/.local/state/herdr-agent-swarm/`
- User units: `herdr-agent-swarm.service` and `herdr-lark-bridge.service`

**Interfaces:**
- Consumes: committed build and `npm run swarm:migrate`.
- Produces: enabled and ready standalone service with the compatibility service inactive and disabled.

- [ ] Read current compatibility `/status`; require zero running and queued prompts, active workers, active or uncertain instance turns, pending outbox, and active deliveries.
- [ ] Run `npm run swarm:migrate`.
- [ ] Verify `systemctl --user is-active herdr-agent-swarm.service` is `active` and `is-enabled` is `enabled`.
- [ ] Verify `systemctl --user is-active herdr-lark-bridge.service` is `inactive` and `is-enabled` is `disabled`.
- [ ] Verify `/status` identity matches `dist/build-info.json`, startup recovery is completed, SQLite quick check is healthy, the lease is held, and no prompt or outbox work was replayed.
- [ ] Verify `/ready` is `ready` for database, projects, Herdr, Lark, lease, and instance runtime.
- [ ] Send a new Feishu prompt only when explicitly requested; otherwise report that typed JSONL delivery awaits the next user-originated prompt.
