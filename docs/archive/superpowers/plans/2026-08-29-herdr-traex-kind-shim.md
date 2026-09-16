# Herdr TraeX Kind Shim Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in the current session. Do not use subagents unless the user explicitly changes the collaboration constraint. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a reversible local shim so `herdr agent start <name> --kind traex --pane <id>` starts the real TraeX binary and exposes `traex` as the managed Herdr agent identity.

**Architecture:** A user-PATH `herdr` launcher delegates every command except `agent start --kind traex` to an absolute official Herdr binary. The intercepted path writes a private launch request, starts a fixed pane launcher that `exec`s TraeX with preserved arguments, and starts a detached reporter that maps the official Codex detection result onto `pane.report-agent --agent traex`. Agent-swarm then uses the managed `startAgent(kind=traex)` path while retaining legacy Codex observation compatibility.

**Tech Stack:** Node.js 22+, TypeScript, Bash, the then-supported Herdr release CLI/socket API, Vitest

**Spec:** `docs/superpowers/specs/2026-08-29-herdr-traex-kind-shim-design.md`

## Global Constraints

- Do not modify the official Herdr ELF, its remote manifest cache, or live Herdr session state during unit tests.
- Invoke the official Herdr binary through a validated absolute path embedded into the installed launcher; runtime environment variables cannot replace it or cause shim recursion.
- Invoke the real TraeX binary through a validated absolute path; never substitute the installed OpenAI Codex executable.
- Keep the installed Node entrypoints self-contained: they may import only Node built-ins and the copied shim runtime modules, not repository `node_modules`.
- Preserve forwarded argument boundaries with a private NUL-delimited request file; never interpolate forwarded arguments into a pane shell command.
- Never log forwarded arguments, environment secrets, prompt text, or session content.
- Never replay an uncertain start or prompt dispatch.
- Preserve legacy agent-swarm compatibility with panes reported as either `traex` or `codex`.
- Do not stage or commit unrelated working-tree changes.

---

## File Structure

- Create `src/cli/herdr-traex-shim.ts`: coordinate only intercepted TraeX startup and expose testable `runHerdrTraexStart`.
- Create `src/runtime/herdr-traex-shim.ts`: pure parsing, launch-request encoding, version gating, process inspection, and startup result types.
- Create `src/cli/herdr-traex-reporter.ts`: detached reporter entrypoint that observes one pane, maps Codex detection, reports TraeX state, and releases authority.
- Create `src/runtime/herdr-traex-reporter.ts`: testable reporter state machine and Herdr command/RPC adapter.
- Create `scripts/herdr-traex-command-shim.sh`: minimal PATH entrypoint that uses `exec` for ordinary Herdr commands and invokes the TypeScript entrypoint only for TraeX start.
- Create `scripts/herdr-traex-pane-launcher.sh`: fixed pane-side launcher that reads a private request and `exec`s the exact TraeX argv.
- Create `scripts/install-herdr-traex-shim.sh`: atomic install, status, smoke-check, and uninstall/rollback commands.
- Create `tests/herdr-traex-shim.test.ts`: parser, delegation, launch safety, timeout, and uncertainty tests.
- Create `tests/herdr-traex-reporter.test.ts`: state mapping, deduplication, process exit, sequence, and release tests.
- Create `tests/herdr-traex-shim-install.test.ts`: isolated filesystem installation and rollback tests.
- Modify `src/domain/ports.ts`: allow managed Herdr kind `traex`.
- Modify `src/adapters/herdr-adapter.ts`: route managed TraeX startup through `agent start --kind traex`.
- Modify `src/runtime/agents/traex-driver.ts`: request managed startup with a stable managed name.
- Modify `tests/agent-driver-contract.test.ts` and `tests/herdr-adapter.test.ts`: lock down agent-swarm integration and legacy observation compatibility.
- Modify `package.json`: add shim install/status/uninstall scripts and ensure new TypeScript entrypoints build into `dist/`.
- Modify `README.md`, `.env.example`, and `docs/architecture.md`: document installation, PATH ordering, `HERDR_BIN`, upgrade checks, rollback, and the bridge-owned SessionStart identity path.
- Modify `scripts/smoke-headless-multi-agent.ts`: add explicit non-mutating preflight and isolated `--traex-kind` acceptance support.

---

### Task 1: Parse and classify shim invocations

**Files:**
- Create: `src/runtime/herdr-traex-shim.ts`
- Create: `tests/herdr-traex-shim.test.ts`

**Interfaces:**
- Produces: `parseHerdrShimInvocation(argv: readonly string[]): HerdrShimInvocation`.
- Produces: `HerdrShimInvocation = { kind: "delegate"; argv: string[] } | { kind: "start-traex"; name: string; paneId: string; timeoutMs: number; traexArgs: string[] }`.
- Produces: `validateShimPaths(config: ShimConfig): void`, where `ShimConfig` contains absolute `realHerdr`, `traex`, `installVersion`, and `validatedHerdrVersion`.

- [ ] **Step 1: Write parser tests for the exact supported syntax**

Cover an ordinary command, native `--kind codex`, a command with leading `--session` or `--remote`, TraeX start with options before `--`, exact argument preservation after `--`, missing name/kind/pane values, duplicate options, a non-positive timeout or one above 300000, and unknown pre-separator flags. Assert that only an invocation beginning exactly with `agent start ... --kind traex` returns `start-traex`; commands with global routing prefixes and every other command delegate byte-for-byte unchanged unless the exact local TraeX-start form is malformed.

- [ ] **Step 2: Run the parser tests and verify they fail**

Run: `npx vitest run tests/herdr-traex-shim.test.ts -t 'parses|delegates|rejects'`

Expected: FAIL because the shim parser module does not exist.

- [ ] **Step 3: Implement the discriminated parser and path/version validation**

Require `argv[0] === "agent"` and `argv[1] === "start"` before inspecting the start arguments. Use an index-based parser, stop option parsing at the first `--`, preserve the remaining strings exactly, default timeout to `30000`, and reject non-absolute or identical real-Herdr/shim paths. Keep this module free of process spawning and filesystem writes.

- [ ] **Step 4: Run the parser tests**

Run: `npx vitest run tests/herdr-traex-shim.test.ts -t 'parses|delegates|rejects'`

Expected: all selected tests PASS.

### Task 2: Implement safe pane launch and CLI delegation

**Files:**
- Create: `src/cli/herdr-traex-shim.ts`
- Create: `scripts/herdr-traex-command-shim.sh`
- Create: `scripts/herdr-traex-pane-launcher.sh`
- Modify: `tests/herdr-traex-shim.test.ts`

**Interfaces:**
- Consumes: `parseHerdrShimInvocation` and `ShimConfig` from Task 1.
- Produces: `runHerdrTraexStart(input, dependencies): Promise<number>`.
- Produces: a launch request containing `executable` plus `args` encoded as NUL-delimited bytes in a mode-0600 file.
- Produces: launcher usage `herdr-traex-pane-launcher.sh <validated-request-id>`, where installation generates the launcher with one safely shell-quoted absolute request directory under `${XDG_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-traex-shim/run}`; the installer creates it mode 0700 and pane input cannot override it.
- Produces: a detached reporter child started with inherited Herdr routing environment, ignored stdin, installer-owned log/error handling, and an explicit pane/process identity token.

- [ ] **Step 1: Add failing delegation and launch tests**

Use a fake real-Herdr executable to assert the shell shim replaces itself for ordinary commands with byte-identical argv, inherited environment, stdio, signals, and exit status. Include leading `--session` and `--remote` examples in this delegation coverage. For an exact local TraeX start, assert it invokes the Node entrypoint. Then use fake command/process dependencies to assert the Node path checks `--version`, inherits routing environment such as `HERDR_SESSION`/`HERDR_SOCKET_PATH` without parsing it, calls `pane process-info --pane <id>`, rejects a non-shell foreground process, creates a private request, invokes only the fixed launcher path plus a `[a-f0-9-]+` request ID through `pane run`, and never places TraeX arguments in the Herdr command argv or logs.

- [ ] **Step 2: Add failing uncertain-start tests**

Cover failure before `pane run`, failure after `pane run`, reporter startup timeout, and successful identity convergence. Assert the post-launch failures return `agent_start_uncertain` and never invoke `pane run` twice.

- [ ] **Step 3: Run the selected tests and verify red**

Run: `npx vitest run tests/herdr-traex-shim.test.ts -t 'delegates|launches|uncertain'`

Expected: FAIL because orchestration is not implemented.

- [ ] **Step 4: Implement the shim entrypoint and pane launcher**

The installed command shim embeds safely shell-quoted absolute paths for the official Herdr binary and Node entrypoint. It inspects only enough argv to distinguish the TraeX start and otherwise finishes with `exec <fixed-real-herdr> "$@"`; environment variables cannot redirect that target. The Node entrypoint uses `spawn`/`execFile` with argv arrays for intercepted host commands. Installation generates the Bash pane launcher with a safely shell-quoted absolute request directory. The launcher validates the request ID, opens only `<fixed-request-directory>/<id>`, reads the executable and NUL-delimited argv with `read -r -d ''`, removes the request, and finishes with `exec -- "$executable" "${args[@]}"`. The only pane shell string is the shell-quoted fixed launcher path plus validated request ID. After `pane run`, poll `pane process-info --pane <id>` until the absolute TraeX executable appears, capture its PID plus Linux `/proc/<pid>/stat` start-time ticks, then detach the reporter with that fence; do not infer identity from the process basename alone.

- [ ] **Step 5: Make startup response compatible and bounded**

After starting the reporter, poll `agent get <pane>` until the requested name, `agent=traex`, and state other than `unknown` appear or the deadline expires. Print the final official Herdr JSON result to stdout; route errors to stderr without forwarded arguments.

- [ ] **Step 6: Run the complete shim unit test file**

Run: `npx vitest run tests/herdr-traex-shim.test.ts`

Expected: PASS with no request files left behind after pre-launch failures or confirmed completion.

### Task 3: Implement the TraeX authority reporter

**Files:**
- Create: `src/runtime/herdr-traex-reporter.ts`
- Create: `src/cli/herdr-traex-reporter.ts`
- Create: `tests/herdr-traex-reporter.test.ts`

**Interfaces:**
- Produces: `TraexAgentReporter.run(input, signal): Promise<"released" | "lost-pane">`.
- Consumes injected operations: `readPane`, `readProcessInfo`, `explainCodexSnapshot`, `reportAgent`, `renameAgent`, `releaseAgent`, and `sleep`.
- Reports source `herdr-traex-shim`, agent `traex`, and monotonically increasing sequence values serialized as decimal strings from `process.hrtime.bigint()` so they are never truncated through JavaScript `number`.

- [ ] **Step 1: Write the reporter state-machine tests**

Feed bounded snapshots that map through fake Codex explanation results to `unknown`, `idle`, `working`, and `blocked`. Assert the reporter emits only transitions, never reports `done` directly, never treats `unknown` as completion, and renames only after the first stable non-unknown state.

- [ ] **Step 2: Write lifecycle and fencing tests**

Assert the reporter verifies the original pane, exact executable, PID, and Linux `/proc/<pid>/stat` start-time ticks on every cycle, exits if pane/process identity changes or `/proc` disappears, releases only its own source+agent authority, uses a final higher sequence, and performs release in `finally` after cancellation or errors.

- [ ] **Step 3: Run the reporter tests and verify red**

Run: `npx vitest run tests/herdr-traex-reporter.test.ts`

Expected: FAIL because the reporter module does not exist.

- [ ] **Step 4: Implement state observation by reusing Codex explanation**

Read at most 240 unwrapped lines into a mode-0600 temporary file, call the absolute real Herdr as `agent explain --file <path> --agent codex --format json`, parse only `idle|working|blocked|unknown`, and unlink the snapshot immediately. Do not duplicate manifest regexes in this repository.

- [ ] **Step 5: Implement report, rename, and release commands**

Use official CLI argv forms `pane report-agent`, `agent rename`, and `pane release-agent`. Start with `unknown`, transition only on changed states, and ensure cleanup is idempotent. The detached CLI entrypoint accepts only installer-generated configuration and writes no pane content to logs.

- [ ] **Step 6: Run reporter and security-focused tests**

Run: `npx vitest run tests/herdr-traex-reporter.test.ts tests/command-runner.test.ts`

Expected: PASS; no assertion output contains forwarded arguments or snapshot contents.

### Task 4: Add atomic install, status, compatibility check, and rollback

**Files:**
- Create: `scripts/install-herdr-traex-shim.sh`
- Create: `tests/herdr-traex-shim-install.test.ts`
- Modify: `package.json`
- Modify: `.gitignore` only if repository-local generated test artifacts require it

**Interfaces:**
- Produces npm commands: `herdr:traex:install`, `herdr:traex:status`, and `herdr:traex:uninstall`.
- Installs versioned files under `${XDG_DATA_HOME:-$HOME/.local/share}/herdr-traex-shim/releases/<build-id>/`.
- Stores non-secret config under `${XDG_CONFIG_HOME:-$HOME/.config}/herdr-traex-shim/config.json`.
- Creates a single `herdr` symlink in a configured user bin directory that already precedes the real Herdr directory in `PATH`.
- Accepts the install target only through `HERDR_TRAEX_SHIM_BIN_DIR` or `--bin-dir <absolute-path>`; it has no default that could overwrite the official `~/.local/bin/herdr`.

- [ ] **Step 1: Write isolated installer tests**

Use temporary HOME/XDG/PATH roots and fake Herdr/TraeX executables. Assert install requires an explicit absolute bin directory, refuses a directory that is absent from PATH or appears after the real Herdr path, refuses recursion, captures the exact official version, copies only built shim assets, atomically switches the symlink, and preserves an existing unrelated `herdr` file.

- [ ] **Step 2: Write upgrade and rollback tests**

Assert delegated commands warn but continue on a Herdr version mismatch, TraeX start refuses until `status --accept-version` succeeds, reinstall switches releases atomically, uninstall removes only shim-owned links/config, and rollback never deletes the official binary.

- [ ] **Step 3: Run installer tests and verify red**

Run: `npx vitest run tests/herdr-traex-shim-install.test.ts`

Expected: FAIL because the installer does not exist.

- [ ] **Step 4: Implement install/status/uninstall**

Build first, validate `herdr --version`, `traex --version`, `herdr pane report-agent --help`, `herdr agent explain --help`, and the socket schema methods. The status command must also run a non-mutating shim self-check that parses the exact local TraeX form and confirms ordinary/global-prefixed commands remain delegation. Copy `dist/cli/herdr-traex-shim.js`, `dist/cli/herdr-traex-reporter.js`, the exact local JavaScript import closure under `dist/runtime/`, a minimal release `package.json` containing `{ "type": "module" }`, the command shim, and the pane launcher into the versioned release. Fail installation if either Node entrypoint imports outside that copied closure or imports a third-party package. Write config via temporary file plus rename, then atomically switch the symlink.

- [ ] **Step 5: Add package scripts and run isolated tests**

Add:

```json
"herdr:traex:install": "bash scripts/install-herdr-traex-shim.sh install",
"herdr:traex:status": "bash scripts/install-herdr-traex-shim.sh status",
"herdr:traex:uninstall": "bash scripts/install-herdr-traex-shim.sh uninstall"
```

Run: `npx vitest run tests/herdr-traex-shim-install.test.ts tests/herdr-traex-shim.test.ts tests/herdr-traex-reporter.test.ts`

Expected: PASS.

### Task 5: Route agent-swarm TraeX startup through the managed kind

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `src/runtime/workspace-snapshot-cache.ts`
- Modify: `src/runtime/herdr-circuit-breaker.ts`
- Modify: `src/runtime/agents/traex-driver.ts`
- Modify: `tests/agent-driver-contract.test.ts`
- Modify: `tests/herdr-adapter.test.ts`

**Interfaces:**
- Changes `HerdrPort.startAgent` kind to `"pi" | "claude" | "codex" | "traex"`.
- Changes `TraexDriver.start` to call `startAgent(paneId, { name, kind: "traex", executable, args })`.
- Keeps `matchesHerdrAgentKind("traex", observed)` compatible with both `traex` and `codex`.
- Keeps the existing bridge-owned SessionStart override ahead of user and Primary MCP arguments: `--permission-mode <mode> --dangerously-bypass-hook-trust -c <session-hook> ...`.

- [ ] **Step 1: Change the TraeX driver contract test first**

Replace the `startTraex` expectation with a `startAgent` expectation containing the deterministic managed name, `kind: "traex"`, the configured TraeX executable, and exact Primary MCP arguments. Add adapter coverage proving the formal command is emitted through the configured `HERDR_BIN`; its `--` tail begins with the configured permission mode, hook-trust flag, and existing `report-traex-session.js` SessionStart override; and a missing/incompatible shim error is propagated without raw-launch fallback.

- [ ] **Step 2: Run focused tests and verify red**

Run: `npx vitest run tests/agent-driver-contract.test.ts tests/herdr-adapter.test.ts`

Expected: FAIL because the port and adapter do not accept managed TraeX startup.

- [ ] **Step 3: Extend the managed-start port and adapter**

Permit `traex` in the port. In `HerdrCliAdapter.startAgent`, always emit the formal argv-only `agent start` command for `kind: "traex"` through the configured Herdr executable, appending the existing bridge-owned TraeX permission and SessionStart-hook arguments after `--` before caller arguments. The shim remains responsible for selecting the absolute installed TraeX binary and transparently preserves this tail. Retain the existing raw `startTraex` method only for compatibility binding flows that have not migrated. Propagate the widened method type through cache and circuit-breaker decorators.

- [ ] **Step 4: Switch `TraexDriver` and runtime availability wiring**

Give `TraexDriver` the same deterministic managed-name behavior as terminal drivers and pass through model and Primary MCP arguments. Keep the existing TraeX executable availability behavior and require operations to configure `TRAEX_BIN` to the same absolute binary recorded by the shim installer. Shim installation/version compatibility is an operator preflight owned by `npm run herdr:traex:status`, not a claim inferred from native `agent start --help` output. A managed start must surface a missing or version-gated shim error and must never silently fall back to raw launch.

- [ ] **Step 5: Preserve legacy observation compatibility**

Keep and explicitly test `matchesHerdrAgentKind("traex", "codex")` plus `matchesHerdrAgentKind("traex", "traex")`. Existing panes must remain attachable during rollout.

- [ ] **Step 6: Run the focused integration tests**

Run: `npx vitest run tests/agent-driver-contract.test.ts tests/herdr-adapter.test.ts tests/instance-control.integration.test.ts tests/instance-runtime-reconciler.test.ts`

Expected: PASS.

### Task 6: Document operations and run repository verification

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/architecture.md`
- Modify: `scripts/smoke-headless-multi-agent.ts`

**Interfaces:**
- Documents shim install/status/uninstall, PATH precedence, the real binary path, version gating, rollback, and the limitation on native resume.
- Extends the existing headless smoke script with an explicit `--traex-kind` opt-in; no live pane is changed without that flag.

- [ ] **Step 1: Add a non-mutating preflight mode to the smoke script**

Preflight must resolve the shim and real Herdr paths, call the installer's non-mutating status/self-check, validate versions, and check reporter RPC/schema availability without creating a pane. It must not require delegated native `herdr agent start --help` output to advertise `traex`, because help is intentionally unchanged.

- [ ] **Step 2: Document installation and rollback**

Include exact npm commands, expected `command -v herdr`, how to inspect the official path, the effect of `herdr update`, how to uninstall, and that existing Codex starts remain native. State that the shim is local compatibility rather than upstream Herdr support.

- [ ] **Step 3: Run static and automated verification**

Run sequentially:

```bash
npm run typecheck
npm test
npm run build
npm run herdr:traex:status
```

Expected: typecheck exit 0, all Vitest tests pass, build emits both shim entrypoints, and status reports either `not installed` before installation or a fully consistent installation without mutating it.

### Task 7: Install and verify in an isolated Herdr session

**Files:**
- No source changes expected.
- Writes only the approved user-level shim installation and a temporary named Herdr test session.

**Interfaces:**
- Consumes the install/status commands from Task 4.
- Acceptance target: `herdr agent start smoke-traex --kind traex --pane <id>` plus native agent operations.

- [ ] **Step 1: Install the verified shim atomically**

Select a dedicated user-owned directory that already precedes `/home/your-user/.local/bin` in `PATH`, export it as `HERDR_TRAEX_SHIM_BIN_DIR`, and run `npm run herdr:traex:install`. Confirm `command -v herdr` resolves to the shim while the recorded real binary remains `/home/your-user/.local/bin/herdr`; then verify `npm run herdr:traex:status` reports official the then-supported Herdr release plus absolute the configured TraeX build. Do not replace the official file or restart the production Herdr server.

- [ ] **Step 2: Start a named isolated Herdr session and disposable pane**

Use the absolute official Herdr binary to run `herdr --session <unique-name> workspace create --cwd <temporary-cwd> --no-focus`; this non-interactive command creates the separate local server and returns the disposable workspace/root-pane JSON. Resolve the matching socket from `herdr session list --json`, then export its reported `HERDR_SESSION` and `HERDR_SOCKET_PATH` into the acceptance shell. From this point onward the shim receives commands beginning with `agent`, while its child official-Herdr calls inherit the isolated routing environment. Do not reuse or close any production pane.

- [ ] **Step 3: Execute the end-to-end TraeX start**

With the isolated session environment active, run the exact supported form `herdr agent start smoke-traex --kind traex --pane <id> --timeout 30000`. Verify `agent get`, `agent list`, `pane list`, and `api snapshot` all show name `smoke-traex`, agent `traex`, and a settled state. Also verify `herdr --session <test-session> agent list` delegates unchanged, documenting that global-prefix forms are native delegation rather than an alternate intercepted start syntax.

- [ ] **Step 4: Verify native control semantics**

Send a harmless prompt with `agent prompt --wait`, observe working followed by idle or done, read bounded output, and verify focus/send-keys operate on the same named agent. Confirm session identity is reported as agent `traex` when TraeX emits SessionStart.

- [ ] **Step 5: Verify cleanup and Codex non-regression**

Exit TraeX, confirm reporter authority is released and the pane becomes an available shell, then use a separate disposable pane to confirm native `--kind codex` still launches the actual Codex binary. Close only the named test session created by this task.

- [ ] **Step 6: Final fresh verification before completion**

Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run herdr:traex:status` again after the last source change. Record the exact test count, Herdr version, TraeX version, shim release ID, and isolated acceptance results in the handoff.
