# Remove the Compatibility Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `herdr-lark-bridge` compatibility plugin and make `herdr-agent-swarm` the repository's only supported build, service, installation, and operator identity.

**Architecture:** Preserve the existing standalone release staging and safe lifecycle machinery, but rename and narrow it so it has no plugin-mode branches. Delete the plugin bundle and one-time compatibility cutover implementation, then update active documentation and deploy only after resolving the live listener to its owning systemd unit and passing the no-active-work gate.

**Tech Stack:** TypeScript ESM, Node.js 22+, Vitest, Bash, systemd user units, SQLite, Herdr CLI/socket API.

**Spec:** `docs/superpowers/specs/2026-08-30-remove-compatibility-plugin-design.md`

## Global Constraints

- Keep Herdr as the authoritative pane and agent runtime; remove only the repository's compatibility plugin wrapper.
- Use `herdr-agent-swarm` as the only application and build identity.
- Use `herdr-agent-swarm.service` as the only supported user unit.
- Preserve `${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm` and `${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm` as canonical private paths.
- Preserve the configured absolute `BRIDGE_DATABASE_PATH`; never copy a live SQLite database without its WAL and SHM companions.
- Never run two processes against the same SQLite database.
- Never automatically replay a prompt that may have reached TraeX.
- Do not overwrite or stage the user's existing modifications to `docs/superpowers/plans/2026-08-30-standalone-service-cutover.md` or untracked `TODO.md`.
- Do not edit generated `dist/` output directly.
- Do not mutate the live service until repository tests pass and the runtime safety gate is clear, unless the user explicitly authorizes interruption.

---

### Task 1: Make the build and protocol identity canonical

**Files:**
- Modify: `src/runtime/build-identity.ts`
- Modify: `scripts/generate-build-info.mjs`
- Modify: `src/runtime/herdr-socket-subscriber.ts`
- Modify: `tests/build-identity.test.ts`
- Modify: `tests/health-server.test.ts`
- Modify: `tests/plugin-lifecycle.test.ts` (temporary name; renamed in Task 2)
- Modify: `tests/traex-transcript.test.ts`
- Modify: `tests/traex-transcript-cache.test.ts`

**Interfaces:**
- Consumes: `calculateBuildId({ serviceId, version, nodeVersion, nodeModulesAbi, lockfile, files })` and existing `BuildIdentity` consumers.
- Produces: `AGENT_SWARM_SERVICE_ID = "herdr-agent-swarm"`, strict `BuildIdentity`, canonical health/status identity, and canonical Herdr socket request IDs.

- [ ] **Step 1: Change identity expectations first**

Update the identity tests so valid fixtures use `herdr-agent-swarm`, while the rejection case explicitly uses the retired identity:

```ts
const base = {
  serviceId: "herdr-agent-swarm", version: "0.2.0", nodeVersion: "24.1.0", nodeModulesAbi: "137",
  lockfile: Buffer.from("lock-a"), files: [{ path: "main.js", content: Buffer.from("code-a") }]
};

expect(() => loadBuildIdentity(fixture({
  serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:abc123", gitCommit: null
}))).toThrow(/serviceId/);
```

Replace service-identity fixtures in health and lifecycle tests with `herdr-agent-swarm`. Keep `herdr-lark-bridge` only where it is the deliberately rejected identity. Replace transcript source fixtures with `herdr-agent-swarm:traex`.

- [ ] **Step 2: Run the red identity tests**

Run:

```bash
npx vitest run tests/build-identity.test.ts tests/health-server.test.ts tests/plugin-lifecycle.test.ts tests/traex-transcript.test.ts tests/traex-transcript-cache.test.ts
```

Expected: failures show that generated/loaded identity and socket request prefixes still use `herdr-lark-bridge`.

- [ ] **Step 3: Implement the canonical identity**

Replace the exported constant and its consumers:

```ts
export const AGENT_SWARM_SERVICE_ID = "herdr-agent-swarm" as const;

export interface BuildIdentity {
  serviceId: typeof AGENT_SWARM_SERVICE_ID;
  version: string;
  buildId: string;
  gitCommit: string | null;
}
```

Use `AGENT_SWARM_SERVICE_ID` in `loadBuildIdentity` and lifecycle endpoint checks. Use the literal `herdr-agent-swarm` in `scripts/generate-build-info.mjs` for both hash input and emitted JSON. Change socket request identifiers to `herdr-agent-swarm:<sequence>` and `herdr-agent-swarm-events`; these identifiers are correlation labels, not durable database keys.

- [ ] **Step 4: Run focused tests and build generation**

Run:

```bash
npx vitest run tests/build-identity.test.ts tests/health-server.test.ts tests/plugin-lifecycle.test.ts tests/traex-transcript.test.ts tests/traex-transcript-cache.test.ts
npm run build
node -e 'const v=require("./dist/build-info.json"); if(v.serviceId!=="herdr-agent-swarm") process.exit(1); console.log(v.serviceId, v.buildId)'
```

Expected: focused tests pass, build exits `0`, and the final command prints `herdr-agent-swarm sha256:...`.

- [ ] **Step 5: Commit the identity migration**

```bash
git add src/runtime/build-identity.ts scripts/generate-build-info.mjs src/runtime/herdr-socket-subscriber.ts tests/build-identity.test.ts tests/health-server.test.ts tests/plugin-lifecycle.test.ts tests/traex-transcript.test.ts tests/traex-transcript-cache.test.ts
git commit -m "refactor: make agent swarm the canonical service identity"
```

### Task 2: Rename and narrow lifecycle code to standalone service ownership

**Files:**
- Rename: `src/cli/plugin-lifecycle.ts` to `src/cli/service-lifecycle.ts`
- Rename: `tests/plugin-lifecycle.test.ts` to `tests/service-lifecycle.test.ts`
- Modify: `src/cli/setup.ts`
- Modify: `scripts/swarm-service.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: `AGENT_SWARM_SERVICE_ID`, `SWARM_ROOT`, `SWARM_CONFIG_DIR`, `SWARM_STATE_DIR`, and the existing setup lifecycle port.
- Produces: `runServiceLifecycle(action, environment, options)`, `inspectServiceLifecycle(environment)`, and `createSetupLifecycleAdapter(environment)` with standalone-only path resolution.

- [ ] **Step 1: Rename test imports and assert plugin variables are rejected or ignored**

Rename the test file and imports:

```ts
import { createSetupLifecycleAdapter, inspectServiceLifecycle, runServiceLifecycle } from "../src/cli/service-lifecycle.js";
```

Update calls from `runPluginLifecycle`/`inspectPluginLifecycle`. Add a test that passes only `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, and `HERDR_PLUGIN_STATE_DIR` and expects a `SWARM_ROOT is required` error. Assert every normal fixture uses `SWARM_ROOT`, canonical config/state paths, and `herdr-agent-swarm.service`.

- [ ] **Step 2: Run the renamed test to verify it is red**

Run:

```bash
npx vitest run tests/service-lifecycle.test.ts tests/setup-cli.integration.test.ts tests/setup-config.test.ts
```

Expected: module resolution or standalone-only assertions fail because `service-lifecycle.ts` does not exist and setup still accepts plugin context.

- [ ] **Step 3: Rename and simplify the lifecycle module**

Move the file and rename exports. Replace dual-mode path resolution with these invariants:

```ts
const root = requiredDirectory(environment.SWARM_ROOT, "SWARM_ROOT");
const configDirectory = requiredDirectory(
  environment.SWARM_CONFIG_DIR || `${environment.XDG_CONFIG_HOME || `${homedir()}/.config`}/herdr-agent-swarm`,
  "SWARM_CONFIG_DIR",
  false
);
const stateDirectory = requiredDirectory(
  environment.SWARM_STATE_DIR || `${environment.XDG_STATE_HOME || `${homedir()}/.local/state`}/herdr-agent-swarm`,
  "SWARM_STATE_DIR",
  false
);
const serviceName = environment.BRIDGE_SYSTEMD_SERVICE_NAME || "herdr-agent-swarm.service";
```

Remove all reads and writes of `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, and `HERDR_PLUGIN_STATE_DIR`. Always render `Description=Herdr Agent Swarm`, `PROJECTS_CONFIG_PATH`, and `BRIDGE_DATABASE_PATH`. Rename CLI diagnostics from `plugin lifecycle failed` and `plugin-lifecycle` to `service lifecycle failed` and `service-lifecycle`. Preserve restart safety, two consecutive startup checks, expected build verification, redaction, and `enable --now` start behavior.

- [ ] **Step 4: Make setup standalone-only**

In `src/cli/setup.ts`, import `createSetupLifecycleAdapter` from `service-lifecycle.js`. Make `resolveSetupContext` use only `SWARM_*` variables and canonical XDG defaults:

```ts
return {
  root: resolve(environment.SWARM_ROOT || cwd),
  configDirectory: resolve(environment.SWARM_CONFIG_DIR || `${environment.XDG_CONFIG_HOME || `${homedir()}/.config`}/herdr-agent-swarm`),
  stateDirectory: resolve(environment.SWARM_STATE_DIR || `${environment.XDG_STATE_HOME || `${homedir()}/.local/state`}/herdr-agent-swarm`),
  cwd: resolve(cwd),
  serviceName: environment.BRIDGE_SYSTEMD_SERVICE_NAME || "herdr-agent-swarm.service"
};
```

Always construct lifecycle dependencies with `SWARM_ROOT`, `SWARM_CONFIG_DIR`, and `SWARM_STATE_DIR`.

- [ ] **Step 5: Update executable paths and package scripts**

Change `scripts/swarm-service.sh` to execute `dist/cli/service-lifecycle.js`. Replace the package script named `plugin` with:

```json
"service": "node dist/cli/service-lifecycle.js"
```

Do not change the public `swarm:*` command names.

- [ ] **Step 6: Run focused lifecycle and setup verification**

Run:

```bash
npx vitest run tests/service-lifecycle.test.ts tests/setup-cli.integration.test.ts tests/setup-config.test.ts tests/setup-workflow.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript exits `0`.

- [ ] **Step 7: Commit the standalone lifecycle boundary**

```bash
git add src/cli/plugin-lifecycle.ts src/cli/service-lifecycle.ts tests/plugin-lifecycle.test.ts tests/service-lifecycle.test.ts src/cli/setup.ts scripts/swarm-service.sh package.json
git commit -m "refactor: make service lifecycle standalone only"
```

### Task 3: Delete compatibility plugin and obsolete cutover machinery

**Files:**
- Delete: `herdr-plugin.toml`
- Delete: `.codex-plugin/plugin.json`
- Delete: `plugin/build.sh`
- Delete: `plugin/common.sh`
- Delete: `plugin/configure-projects.sh`
- Delete: `plugin/logs.sh`
- Delete: `plugin/open-pane.sh`
- Delete: `plugin/relay-event.sh`
- Delete: `plugin/service.sh`
- Delete: `plugin/setup.sh`
- Delete: `plugin/status.sh`
- Delete: `src/cli/swarm-service-cutover.ts`
- Delete: `tests/swarm-service-cutover.test.ts`
- Replace: `tests/plugin-manifest.test.ts` with `tests/standalone-install.test.ts`
- Modify: `install.sh`
- Modify: `scripts/swarm-service.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: `scripts/stage-production-runtime.sh`, standalone private config, and `dist/cli/service-lifecycle.js`.
- Produces: one non-interactive `./install.sh` path and no repository-owned Herdr plugin surface.

- [ ] **Step 1: Replace plugin manifest tests with standalone installer contract tests**

Create `tests/standalone-install.test.ts` with static assertions that:

```ts
expect(existsSync("herdr-plugin.toml")).toBe(false);
expect(existsSync(".codex-plugin")).toBe(false);
expect(existsSync("plugin")).toBe(false);
expect(installScript).not.toContain("herdr plugin");
expect(installScript).not.toContain("HERDR_PLUGIN_");
expect(installScript).toContain('bash "$ROOT/scripts/stage-production-runtime.sh" "$STATE_DIR"');
expect(installScript).toContain('dist/cli/service-lifecycle.js" install');
```

Also retain the existing Node-version, configuration-placeholder, immutable-release, source-map, and no-checkout-prune assertions from `tests/plugin-manifest.test.ts`, rewritten for a single installer path. Assert `package.json` has no `plugin` or `swarm:migrate` script.

- [ ] **Step 2: Run the installer contract test red**

Run:

```bash
npx vitest run tests/standalone-install.test.ts
```

Expected: failures identify the still-present manifest/plugin directory, plugin branch, old lifecycle path, and migration script.

- [ ] **Step 3: Make `install.sh` standalone-only**

Remove `PLUGIN_ID`, `RUN_SETUP`, `STANDALONE`, plugin checks, plugin linking, and plugin action invocation. Accept only no arguments or `-h|--help`; for `--setup`, `--standalone`, or `--compat-plugin`, exit `2` with this migration guidance:

```text
Herdr plugin installation has been removed. Run ./install.sh, then npm run swarm:setup.
```

The normal path must perform, in order:

```bash
npm ci
npm run build
bash "$ROOT/scripts/stage-production-runtime.sh" "$STATE_DIR"
SWARM_ROOT="$SWARM_RUNTIME_ROOT" SWARM_STATE_DIR="$STATE_DIR" \
  node "$SWARM_RUNTIME_ROOT/dist/cli/service-lifecycle.js" install
```

Keep the existing private configuration completeness guard and do not source or print `.env`.

- [ ] **Step 4: Remove compatibility files and migration command**

Delete the listed manifest/plugin/cutover files. Remove the `migrate)` branch from `scripts/swarm-service.sh`, remove `swarm:migrate` from `package.json`, and update both usage strings to omit `migrate`. Do not delete `service/herdr-agent-swarm.service`; it remains the documented template.

- [ ] **Step 5: Run deletion and installer verification**

Run:

```bash
npx vitest run tests/standalone-install.test.ts tests/service-lifecycle.test.ts tests/setup-cli.integration.test.ts
test ! -e herdr-plugin.toml
test ! -e .codex-plugin
test ! -e plugin
test ! -e src/cli/swarm-service-cutover.ts
test ! -e tests/swarm-service-cutover.test.ts
! rg -n 'herdr plugin|HERDR_PLUGIN_|swarm:migrate|swarm-service-cutover|plugin-lifecycle' install.sh package.json scripts src tests
```

Expected: all tests and shell assertions exit `0`.

- [ ] **Step 6: Commit compatibility implementation removal**

```bash
git add -A -- herdr-plugin.toml .codex-plugin plugin install.sh package.json scripts/swarm-service.sh src/cli/swarm-service-cutover.ts tests/swarm-service-cutover.test.ts tests/plugin-manifest.test.ts tests/standalone-install.test.ts
git commit -m "refactor: remove compatibility plugin surface"
```

### Task 4: Remove compatibility claims from active documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture-reference.md` if it contains current operator guidance
- Modify: current non-archived plans/specs that are linked as active guidance
- Preserve: `docs/archive/**`
- Preserve: `docs/superpowers/specs/2026-08-30-standalone-service-cutover-design.md` as superseded history
- Preserve: `docs/superpowers/plans/2026-08-30-standalone-service-cutover.md` because it contains user-owned unstaged edits

**Interfaces:**
- Consumes: standalone installer and `npm run swarm:*` commands from Tasks 2-3.
- Produces: one current operational story with no supported compatibility plugin instructions.

- [ ] **Step 1: Add a static documentation authority test**

Extend `tests/standalone-install.test.ts` to scan current authority files:

```ts
for (const path of ["AGENTS.md", "README.md", "docs/architecture.md", "docs/architecture-reference.md"]) {
  const text = readFileSync(path, "utf8");
  expect(text).not.toMatch(/herdr plugin action|--plugin herdr-lark-bridge|herdr-lark-bridge\.service/);
}
```

Assert `AGENTS.md` no longer claims the compatibility workflow remains available, and README installation examples use `./install.sh` followed by `npm run swarm:setup` or direct `npm run swarm:*` commands.

- [ ] **Step 2: Run the documentation test red**

Run:

```bash
npx vitest run tests/standalone-install.test.ts
```

Expected: active documentation still contains compatibility plugin commands and the old unit.

- [ ] **Step 3: Update current documentation authority**

In `AGENTS.md`, remove the sentence saying the original bridge remains available, replace plugin build/operations rows with standalone commands, and state that user systemd plus `npm run swarm:*` is the supported operator surface.

In README and architecture docs:

- describe `./install.sh` as the standalone release installer;
- direct first-run configuration to `npm run swarm:setup`;
- use `npm run swarm:start|status|restart|stop|logs`;
- remove plugin linking, action, overlay, config-directory, and compatibility rollback instructions;
- state that legacy plugin registration and unit are unsupported and removed during the one-time live cleanup;
- preserve Herdr CLI/socket requirements for pane orchestration.

Do not rewrite archived documents or the user-modified cutover plan. Add a short superseded notice to a current document only if it is linked from README or architecture as operational guidance.

- [ ] **Step 4: Run documentation and targeted literal checks**

Run:

```bash
npx vitest run tests/standalone-install.test.ts
! rg -n 'herdr plugin action|--plugin herdr-lark-bridge|herdr-lark-bridge\.service|compatibility workflow remains available' AGENTS.md README.md docs/architecture.md docs/architecture-reference.md
rg -n 'npm run swarm:(setup|doctor|install|start|status|restart|stop|logs)' AGENTS.md README.md docs/architecture.md
```

Expected: the negative scan has no output and exits `0`; the positive scan shows the standalone operator surface.

- [ ] **Step 5: Commit documentation separately**

```bash
git add AGENTS.md README.md docs/architecture.md docs/architecture-reference.md tests/standalone-install.test.ts
git commit -m "docs: retire the compatibility bridge workflow"
```

Before committing, inspect `git diff --cached --name-status` and ensure the user's modified cutover plan and `TODO.md` are not staged.

### Task 5: Verify the repository and perform the guarded live cleanup

**Files:**
- Verify: all changed repository files
- Runtime inspect: canonical `.env`, configured `/status` and `/ready`, listening PID, systemd user units, Herdr plugin registry
- Runtime remove after verification: obsolete `herdr-lark-bridge.service` user-unit file and old linked plugin registration

**Interfaces:**
- Consumes: the canonical build, standalone lifecycle, runtime status schema, and existing absolute database path.
- Produces: one active/enabled `herdr-agent-swarm.service`, no old plugin registration or user unit, correct build identity, ready dependencies, and no replay.

- [ ] **Step 1: Run full repository verification after the last edit**

Run:

```bash
npm run typecheck
npm run build
npm test
git diff --check
node -e 'const v=require("./dist/build-info.json"); if(v.serviceId!=="herdr-agent-swarm") process.exit(1); console.log(v)'
! rg -n 'herdr plugin|HERDR_PLUGIN_|swarm:migrate|swarm-service-cutover|plugin-lifecycle' install.sh package.json scripts src tests
```

Expected: typecheck/build/full Vitest suite pass, diff check is clean, identity is canonical, and the compatibility implementation scan is empty.

- [ ] **Step 2: Resolve any verification failure in its owning task**

If Step 1 fails, return to Task 1 for identity failures, Task 2 for lifecycle or
setup failures, Task 3 for installer/deletion failures, or Task 4 for active-doc
failures. Add the exact failing assertion before changing implementation, rerun
that task's focused command, amend only that task's file set, and then rerun all
Step 1 commands. Do not create a catch-all verification commit.

- [ ] **Step 3: Inspect live ownership without mutation**

Load only non-secret paths and port values from the canonical environment, then record:

```bash
npm run swarm:status
systemctl --user show herdr-agent-swarm.service herdr-lark-bridge.service -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID
ss -ltnp
herdr plugin list --json
```

Correlate the configured listener port with `MainPID`. Query `/status` and require complete prompt, worker, instance, outbox, startup recovery, SQLite integrity, and lease fields. Do not print `.env` or credentials.

- [ ] **Step 4: Enforce the no-active-work gate**

Proceed only when `/status` reports all of the following:

```text
operational.prompts.running = 0
operational.prompts.queued = 0
promptWorker.activeTurnWorkers = 0
instanceWorker.activeDispatchWorkers = 0
instanceWorker.activeObservers = 0
instanceWorker.activeTurns = 0
instanceWorker.uncertainTurns = 0
operational.pendingOutbox = 0
outboxDispatcher.activeDeliveries = 0
startupRecovery.state = completed
sqliteIntegrity.quickCheck = ok
```

If any field is absent or non-zero, stop the live-cleanup phase and report the exact counters. Do not use `--force` without a new explicit user instruction.

- [ ] **Step 5: Stage and install the canonical runtime**

Run the standalone installer from the verified commit, then stop and disable obsolete units before starting the canonical one. Resolve exact installed unit names from Step 3; do not use globs. The intended sequence is:

```bash
./install.sh
systemctl --user disable --now herdr-lark-bridge.service
npm run swarm:start
```

If a transitional Agent Swarm unit owns the same database or port, stop and disable that exact unit before `swarm:start`. Preserve the canonical `.env`, `projects.json`, database, WAL, and SHM files.

- [ ] **Step 6: Verify canonical runtime before deleting old registration**

Read the configured loopback port without printing any other environment value,
then run:

```bash
npm run swarm:status
SWARM_HTTP_PORT=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; const p=`${process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`}/herdr-agent-swarm/.env`; const line=readFileSync(p,"utf8").split(/\r?\n/).find((v)=>v.startsWith("BRIDGE_HTTP_PORT=")); process.stdout.write(line ? line.slice(17) : "8788")')
curl -fsS "http://127.0.0.1:${SWARM_HTTP_PORT}/ready"
systemctl --user show herdr-agent-swarm.service -p ActiveState -p SubState -p UnitFileState -p MainPID
```

Require two consecutive `/status` observations with the generated build ID, `identity.serviceId=herdr-agent-swarm`, completed startup recovery, healthy SQLite, held lease, and ready dependencies. Compare prompt/outbox IDs and counts captured in Step 3 to verify the transition did not replay work.

- [ ] **Step 7: Remove obsolete unit and plugin registration**

Only after Step 6 succeeds, remove the exact retired unit file and unlink the exact installed plugin using the installed Herdr CLI syntax discovered from `herdr plugin` help. Then reload user systemd and verify absence:

```bash
systemctl --user daemon-reload
systemctl --user is-enabled herdr-lark-bridge.service
systemctl --user is-active herdr-lark-bridge.service
herdr plugin list --json
```

Expected: the old unit is not found or disabled/inactive, the old plugin ID is absent, the canonical service remains active/enabled, and `/ready` remains ready. Report which private legacy config/state directories remain preserved; do not delete them without a separate explicit request.
