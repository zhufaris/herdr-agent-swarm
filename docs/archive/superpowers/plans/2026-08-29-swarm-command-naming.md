# Swarm command naming migration implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every active `solo` operations and runtime integration name and make `swarm` the only supported naming surface.

**Architecture:** Rename the standalone shell and service entrypoints at the repository boundary, then rename the standalone lifecycle environment contract and Primary-tool runtime contract internally. Preserve canonical configuration, state, and database paths while intentionally invalidating old capability and approval identifiers.

**Tech Stack:** Bash, npm scripts, TypeScript ESM, Node.js user systemd lifecycle, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-swarm-command-naming-design.md`

## Global Constraints

- Do not provide `solo:*` aliases or `SOLO_AGENT_*` fallbacks.
- Keep `~/.config/herdr-agent-swarm`, `~/.local/state/herdr-agent-swarm`, and the existing SQLite schema unchanged.
- Keep plugin mode named `herdr-lark-bridge`; it is a separate installation surface.
- Do not edit generated `dist/` files.
- Preserve unrelated worktree changes and stage only migration-owned paths or hunks.

---

### Task 1: Canonical standalone lifecycle surface

**Files:**
- Rename: `scripts/solo-agent.sh` to `scripts/swarm-service.sh`
- Rename: `service/solo-agent.service` to `service/herdr-agent-swarm.service`
- Modify: `package.json`
- Modify: `install.sh`
- Modify: `src/cli/plugin-lifecycle.ts`
- Test: `tests/plugin-lifecycle.test.ts`

**Interfaces:**
- Consumes: existing lifecycle action contract `install|uninstall|start|status|restart|stop|logs`.
- Produces: npm `swarm:*` commands and standalone environment variables `SWARM_ROOT`, `SWARM_CONFIG_DIR`, `SWARM_STATE_DIR`.

- [ ] **Step 1: Change lifecycle tests to the canonical contract**

Replace standalone fixture variables and expectations with `SWARM_*` and `herdr-agent-swarm.service`; add a package-script assertion that `swarm:*` exists and `solo:*` does not.

- [ ] **Step 2: Run the focused test and verify the old implementation fails**

Run: `npx vitest run tests/plugin-lifecycle.test.ts`
Expected: FAIL because the lifecycle still detects `SOLO_AGENT_ROOT` and package scripts still expose `solo:*`.

- [ ] **Step 3: Rename and wire the standalone entrypoints**

Rename both files, replace package script keys and paths, update `install.sh --standalone`, and make `runtimePaths`, `loadRuntimeEnvironment`, and `renderUnit` detect standalone mode exclusively through `SWARM_ROOT`.

- [ ] **Step 4: Run the focused lifecycle test**

Run: `npx vitest run tests/plugin-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the lifecycle migration**

```bash
git add package.json install.sh scripts/solo-agent.sh scripts/swarm-service.sh service/solo-agent.service service/herdr-agent-swarm.service src/cli/plugin-lifecycle.ts tests/plugin-lifecycle.test.ts
git commit -m "feat: migrate lifecycle commands to swarm"
```

### Task 2: Canonical Primary-tool runtime contract

**Files:**
- Modify: `src/runtime/primary-tool-gateway.ts`
- Modify: `src/runtime/agents/traex-driver.ts`
- Modify: `src/runtime/agents/terminal-agent-driver.ts`
- Modify: `src/cli/primary-tools-mcp.ts`
- Modify: `src/infra/command-runner.ts`
- Modify: `src/domain/approval-policy.ts`
- Modify: `scripts/smoke-headless-multi-agent.ts`
- Test: `tests/agent-driver-contract.test.ts`
- Test: `tests/herdr-adapter.test.ts`
- Test: `tests/instance-control.integration.test.ts`
- Test: `tests/primary-tool-gateway.integration.test.ts`
- Test: `tests/command-runner.test.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: `PrimaryToolLaunch.environment`, TraeX `-c` configuration arguments, and approval policy identity matching.
- Produces: `SWARM_PRIMARY_CAPABILITY`, MCP key `herdr_agent_swarm`, server name `herdr-agent-swarm-primary-tools`, and policy version `herdr-agent-swarm-v1`.

- [ ] **Step 1: Update contract tests to require canonical identifiers**

Change exact environment, MCP argument, redaction, and policy-version expectations. Preserve all unrelated test modifications, especially in `tests/sqlite-store.test.ts`.

- [ ] **Step 2: Run focused tests and verify the old identifiers fail**

Run: `npx vitest run tests/agent-driver-contract.test.ts tests/herdr-adapter.test.ts tests/instance-control.integration.test.ts tests/primary-tool-gateway.integration.test.ts tests/command-runner.test.ts`
Expected: FAIL on the old capability and MCP names.

- [ ] **Step 3: Replace active runtime identifiers**

Issue and read `SWARM_PRIMARY_CAPABILITY`, inject `mcp_servers.herdr_agent_swarm`, report the canonical MCP server name, redact the new secret variable, update the approval policy version, and update the smoke prompt and temporary prefix. Do not accept the old names.

- [ ] **Step 4: Run the focused runtime tests**

Run: `npx vitest run tests/agent-driver-contract.test.ts tests/herdr-adapter.test.ts tests/instance-control.integration.test.ts tests/primary-tool-gateway.integration.test.ts tests/command-runner.test.ts tests/sqlite-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit runtime naming**

Stage only the named source files and migration-owned test hunks, then commit:

```bash
git commit -m "refactor: rename swarm runtime identifiers"
```

### Task 3: Active documentation cleanup and repository verification

**Files:**
- Modify: `README.md`
- Modify: current non-historical plans that prescribe lifecycle commands

**Interfaces:**
- Consumes: the commands and identifiers established by Tasks 1 and 2.
- Produces: one canonical operator workflow with no active `solo` instructions.

- [ ] **Step 1: Update active operator instructions**

Replace lifecycle examples and environment-variable documentation with `swarm:*` and `SWARM_*`. Retain links to historical artifacts without rewriting their historical content.

- [ ] **Step 2: Scan active surfaces for obsolete names**

Run:

```bash
rg -n 'solo_agent|SOLO_AGENT|solo-agent|solo:' src tests scripts service package.json install.sh README.md docs/architecture.md docs/feishu-group-usage.md docs/superpowers/plans/2026-08-29-queue-feedback-auto-steering.md
```

Expected: no matches. Historical specs, plans, tickets, and audits are excluded from this active-surface gate.

- [ ] **Step 3: Run complete verification**

Run `npm run typecheck`, `npm run build`, and `npm test`. Then run `git diff --check`.
Expected: all commands pass.

- [ ] **Step 4: Commit documentation cleanup**

```bash
git add README.md docs/superpowers/plans/2026-08-29-queue-feedback-auto-steering.md
git commit -m "docs: use canonical swarm lifecycle commands"
```
