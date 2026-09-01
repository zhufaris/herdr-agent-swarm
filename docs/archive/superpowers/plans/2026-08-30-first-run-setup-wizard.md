# First-Run Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one guided `swarm:setup` command and one read-only `swarm:doctor` command that produce and verify private Herdr Agent Swarm configuration before any optional service installation or startup.

**Architecture:** A deterministic setup workflow depends on explicit prompt, configuration-repository, probe, and lifecycle ports. Focused adapters own terminal I/O, atomic configuration persistence, read-only Herdr discovery, and read-only Lark HTTP probes; the standalone and plugin entrypoints call the same workflow.

**Tech Stack:** TypeScript 5.9, Node.js 22.12+ ESM, Zod, Node `fetch`, `readline/promises`, Vitest, Bash launchers, Herdr CLI, Lark Open APIs, user systemd.

**Spec:** `docs/superpowers/specs/2026-08-30-first-run-setup-wizard-design.md`

## Global Constraints

- Keep `swarm:init` non-interactive and idempotent.
- Configure only an already-created, published, and tenant-installed Lark application.
- Do not open a browser, mutate Lark settings, send a Lark message, create a Herdr pane, or start an agent during validation.
- Never emit `LARK_APP_SECRET`, tenant access tokens, or secret-bearing command arguments.
- Store the configuration directory as mode `0700` and drafts, backups, `.env`, and `projects.json` as mode `0600`.
- Reuse the production Zod schemas and existing lifecycle implementation rather than maintaining parallel rules.
- A failed check blocks save; a warning is visible but permits progress; explicitly skipped network checks permit save but block automatic startup.
- An existing active service is never restarted without a separate confirmation and the existing safe-restart gate.
- Preserve ESM `.js` import specifiers and the repository's compact two-space TypeScript style.
- Do not edit generated `dist/` files.

---

### Task 1: Setup domain contracts and validation policy

**Files:**
- Create: `src/setup/setup-types.ts`
- Create: `src/setup/setup-checks.ts`
- Create: `tests/setup-checks.test.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Consumes: `ProjectConfig` from `src/domain/types.ts` and the existing environment/project Zod rules.
- Produces: `SetupDraft`, `SetupCheck`, `SetupCheckReport`, `SetupPromptPort`, `SetupConfigPort`, `SetupHerdrProbe`, `SetupLarkProbe`, `SetupLifecyclePort`, `evaluateSetupChecks()`, `validateProjectRegistry()`, and `validateEnvironmentAndRegistry()`.

- [ ] **Step 1: Write failing policy and in-memory schema tests**

Add cases equivalent to:

```ts
import { describe, expect, it } from "vitest";
import { evaluateSetupChecks } from "../src/setup/setup-checks.js";

describe("setup check policy", () => {
  it("blocks saving and startup on failure", () => {
    expect(evaluateSetupChecks([{ id: "lark.auth", status: "fail", summary: "unauthorized" }]))
      .toEqual({ canSave: false, canStart: false, hasWarnings: false, hasSkipped: false });
  });

  it("allows saving but blocks startup after an explicit skip", () => {
    expect(evaluateSetupChecks([{ id: "lark.chat", status: "skipped", summary: "skipped by operator" }]))
      .toEqual({ canSave: true, canStart: false, hasWarnings: false, hasSkipped: true });
  });

  it("allows warnings while retaining them for review", () => {
    expect(evaluateSetupChecks([{ id: "lark.bot", status: "warning", summary: "verify manually" }]))
      .toEqual({ canSave: true, canStart: true, hasWarnings: true, hasSkipped: false });
  });
});
```

Extend `tests/config.test.ts` to validate a registry object without first writing JSON to disk and to validate an environment plus an explicit registry object.

- [ ] **Step 2: Run the focused tests and verify the new exports are missing**

Run: `npx vitest run tests/setup-checks.test.ts tests/config.test.ts`

Expected: FAIL because `setup-checks.ts`, `evaluateSetupChecks()`, and the in-memory config exports do not exist.

- [ ] **Step 3: Define the setup contracts**

Create exact domain shapes in `src/setup/setup-types.ts`:

```ts
import type { ProjectConfig } from "../domain/types.js";

export type SetupCheckStatus = "pass" | "warning" | "fail" | "skipped";
export interface SetupCheck { id: string; status: SetupCheckStatus; summary: string; remediation?: string }
export interface SetupCheckPolicy { canSave: boolean; canStart: boolean; hasWarnings: boolean; hasSkipped: boolean }
export interface SetupProjectRegistry { defaultProjectId: string; projects: ProjectConfig[] }
export interface SetupDraft { environment: Record<string, string>; registry: SetupProjectRegistry }
export interface SetupContext { root: string; configDirectory: string; stateDirectory: string; serviceName: string; cwd: string }
export interface SetupCommitResult { environmentFile: string; projectsFile: string; backupDirectory?: string }
export interface SetupCheckReport { checks: SetupCheck[]; policy: SetupCheckPolicy }

export interface SetupPromptPort {
  text(message: string, defaultValue?: string): Promise<string>;
  secret(message: string, existingValue: boolean): Promise<{ action: "retain" } | { action: "replace"; value: string }>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  choose<T extends string>(message: string, options: readonly { value: T; label: string }[]): Promise<T>;
  write(message: string): void;
}

export interface SetupConfigPort {
  load(context: SetupContext): Promise<SetupDraft | null>;
  validate(draft: SetupDraft, context: SetupContext): Promise<SetupCheck[]>;
  commit(draft: SetupDraft, context: SetupContext): Promise<SetupCommitResult>;
}
export interface SetupHerdrProbe { check(draft: SetupDraft, context: SetupContext): Promise<SetupCheck[]> }
export interface SetupLarkProbe { check(draft: SetupDraft): Promise<SetupCheck[]> }
export interface SetupLifecyclePort {
  inspect(context: SetupContext): Promise<{ installed: boolean; active: boolean; summary: string }>;
  install(context: SetupContext): Promise<void>;
  start(context: SetupContext): Promise<void>;
  restart(context: SetupContext): Promise<void>;
}
```

- [ ] **Step 4: Implement policy evaluation and export in-memory config validation**

Implement `evaluateSetupChecks(checks)` as a pure reduction. Refactor `src/config.ts` so file loading calls exported object-level functions:

```ts
export function validateProjectRegistry(raw: unknown): SetupProjectRegistry {
  return projectRegistrySchema.parse(raw);
}

export function validateEnvironmentAndRegistry(
  environment: NodeJS.ProcessEnv,
  registry: SetupProjectRegistry
): Omit<BridgeConfig, "projectsConfigPath"> & { projectsConfigPath: string } {
  return buildConfig(environmentSchema.parse(withPluginDefaults(environment)), registry);
}
```

Keep `loadConfig()` and `validateProjectRegistryFile()` behavior unchanged by routing them through these exports. Do not import setup modules into `config.ts`; place any shared registry type in `src/domain/types.ts` instead if that avoids a dependency from core configuration to setup.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/setup-checks.test.ts tests/config.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the contracts and policy**

```bash
git add src/setup/setup-types.ts src/setup/setup-checks.ts src/config.ts tests/setup-checks.test.ts tests/config.test.ts
git commit -m "feat: define setup validation policy" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

---

### Task 2: Private configuration repository and redacted summary

**Files:**
- Create: `src/setup/setup-config.ts`
- Create: `src/setup/setup-summary.ts`
- Create: `tests/setup-config.test.ts`
- Modify: `src/runtime/environment-file.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Consumes: `SetupDraft`, `SetupContext`, `SetupCheck`, `SetupConfigPort`, `validateEnvironmentAndRegistry()`, and `serializeEnvironmentValue()`.
- Produces: `FileSetupConfigRepository`, `renderSetupEnvironment()`, `renderSetupSummary()`, and deterministic private backup/rollback behavior.

- [ ] **Step 1: Write failing serialization, permission, rollback, and redaction tests**

Cover these observable cases in `tests/setup-config.test.ts`:

```ts
it("commits a validated environment and registry with private modes", async () => {
  const result = await repository.commit(draft, context);
  expect(statSync(context.configDirectory).mode & 0o777).toBe(0o700);
  expect(statSync(result.environmentFile).mode & 0o777).toBe(0o600);
  expect(statSync(result.projectsFile).mode & 0o777).toBe(0o600);
  expect(readEnvironmentFile(result.environmentFile).LARK_APP_SECRET).toBe("top-secret");
});

it("restores both old files if the second replacement fails", async () => {
  await expect(failingRepository.commit(replacement, context)).rejects.toThrow(/restored previous configuration/);
  expect(readFileSync(envPath, "utf8")).toBe(originalEnvironment);
  expect(readFileSync(projectsPath, "utf8")).toBe(originalProjects);
});

it("never renders a secret in the review summary", () => {
  expect(renderSetupSummary(draft, report, context)).not.toContain("top-secret");
  expect(renderSetupSummary(draft, report, context)).toContain("Lark secret: set");
});
```

Also test first-run creation, valid-config backup, mode-`0600` backups, invalid existing files, draft cleanup after failure, JSON formatting, and preservation of unknown supported environment settings. Inject filesystem operations or a replacement hook so the second-rename rollback path is deterministic.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx vitest run tests/setup-config.test.ts tests/config.test.ts`

Expected: FAIL because the repository and summary do not exist.

- [ ] **Step 3: Add complete environment-file serialization**

Extend `src/runtime/environment-file.ts` with:

```ts
export function serializeEnvironmentFile(environment: Record<string, string>, order: readonly string[]): string {
  const known = order.filter((key) => environment[key] !== undefined);
  const remaining = Object.keys(environment).filter((key) => !known.includes(key)).sort();
  return [...known, ...remaining].map((key) => `${key}=${serializeEnvironmentValue(environment[key]!)}`).join("\n") + "\n";
}
```

Use a fixed setup key order beginning with the five Lark values, then paths, executables, permission mode, HTTP settings, logging, and tuning values. Do not serialize process-only variables such as `PATH`, `HOME`, `SWARM_ROOT`, or plugin directory variables.

- [ ] **Step 4: Implement validation and transactional persistence**

`FileSetupConfigRepository.validate()` must call the production schema and return stable check IDs such as `config.schema`, `config.directories`, `config.permissions`, and `config.port`. It must validate drafts without placing the secret in an exception string.

`commit()` must:

1. create the destination directory with mode `0700`;
2. render both new files entirely in memory;
3. write and `fsync` same-directory mode-`0600` draft files;
4. copy an existing valid pair into `backup-<UTC timestamp>/`;
5. rename the environment draft and then the registry draft;
6. if either rename fails, restore both prior files (or remove both for a failed first-run commit);
7. `fsync` the containing directory;
8. remove remaining drafts in `finally`.

Reject startup-era recovery ambiguity explicitly: if setup finds only one of `.env` and `projects.json`, or a prior `.setup-transaction.json` marker, return `config.incomplete-transaction` with the exact private backup path and do not overwrite automatically. Use the transaction marker only for crash diagnosis; normal caught failures must restore and remove it.

- [ ] **Step 5: Implement the redacted summary**

`renderSetupSummary(draft, report, context)` prints non-secret configuration, resolved routes, instance layout, check results, paths, endpoint, and unit name. It must derive the secret line from presence only:

```ts
const secretState = draft.environment.LARK_APP_SECRET ? "set" : "missing";
```

Never accept a raw token or secret as a summary argument.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run tests/setup-config.test.ts tests/config.test.ts`

Expected: PASS, including forced second-replacement rollback and secret-absence assertions.

- [ ] **Step 7: Commit private persistence**

```bash
git add src/setup/setup-config.ts src/setup/setup-summary.ts src/runtime/environment-file.ts tests/setup-config.test.ts tests/config.test.ts
git commit -m "feat: persist setup configuration safely" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

---

### Task 3: Read-only Herdr and local environment probes

**Files:**
- Create: `src/adapters/herdr-setup-probe.ts`
- Create: `tests/herdr-setup-probe.test.ts`
- Modify: `src/setup/setup-checks.ts`
- Modify: `src/setup/setup-types.ts`

**Interfaces:**
- Consumes: `CommandRunner`, configured executable names, `SetupDraft`, and `SetupContext`.
- Produces: `HerdrSetupProbe.listWorkspaces(): Promise<SetupWorkspace[]>`, `HerdrSetupProbe.check()`, and local preflight checks with stable IDs.

- [ ] **Step 1: Write failing Herdr discovery and no-mutation tests**

Use a fake `CommandRunner` and assert exact calls:

```ts
expect(calls).toEqual([
  ["herdr", ["workspace", "list"]],
  ["herdr", ["workspace", "get", "w1"]],
  ["herdr", ["agent"]]
]);
expect(calls.flatMap(([, args]) => args)).not.toContain("start");
expect(calls.flatMap(([, args]) => args)).not.toContain("prompt");
```

Cover malformed JSON, missing workspace, Space-name mismatch, unavailable `herdr`, unavailable selected agent executable, unsupported agent kind, non-loopback host, occupied port with no matching managed service, and current-workspace preference from `HERDR_WORKSPACE_ID`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/herdr-setup-probe.test.ts`

Expected: FAIL because `HerdrSetupProbe` does not exist.

- [ ] **Step 3: Implement bounded read-only discovery**

Define:

```ts
export interface SetupWorkspace { id: string; name: string; current: boolean }

export class HerdrSetupProbe implements SetupHerdrProbe {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable: string,
    private readonly timeoutMs: number,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  listWorkspaces(): Promise<SetupWorkspace[]>;
  check(draft: SetupDraft, context: SetupContext): Promise<SetupCheck[]>;
}
```

Parse Herdr envelopes with Zod. Use only `workspace list`, `workspace get <id>`, and the non-mutating agent capability/help surface discovered from the installed CLI. Treat `HERDR_WORKSPACE_ID` only as a default-selection hint; verify it against live output. Check executables without shell interpolation.

Add local checks to `setup-checks.ts` for Node `>=22.12`, user systemd availability, directory mode, loopback host, port ownership, and required executable resolution. Return remediation text rather than throwing raw command output.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/herdr-setup-probe.test.ts tests/setup-checks.test.ts`

Expected: PASS and no fake command uses a mutating Herdr verb.

- [ ] **Step 5: Commit Herdr preflight support**

```bash
git add src/adapters/herdr-setup-probe.ts src/setup/setup-checks.ts src/setup/setup-types.ts tests/herdr-setup-probe.test.ts tests/setup-checks.test.ts
git commit -m "feat: add read-only Herdr setup checks" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

---

### Task 4: Read-only Lark connectivity probe

**Files:**
- Create: `src/adapters/lark-setup-probe.ts`
- Create: `tests/lark-setup-probe.test.ts`
- Modify: `src/setup/setup-types.ts`

**Interfaces:**
- Consumes: Lark values from `SetupDraft` and an injected bounded HTTP client.
- Produces: `LarkSetupProbe.check(draft): Promise<SetupCheck[]>` and `SetupHttpClient.request()`.

- [ ] **Step 1: Write failing probe and credential-redaction tests**

Use a fake HTTP client and cover:

```ts
it("authenticates, reads the chat, and verifies bot identity without writes", async () => {
  const checks = await probe.check(draft);
  expect(checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "lark.auth", status: "pass" }),
    expect.objectContaining({ id: "lark.chat", status: "pass" }),
    expect.objectContaining({ id: "lark.bot", status: "pass" })
  ]));
  expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
  expect(requests.filter((request) => request.method !== "GET")).toHaveLength(1);
});
```

The sole POST is the required token exchange, not a Lark resource mutation. Test 401-equivalent authentication failure, 403, missing chat, 429, timeout, malformed JSON, unavailable bot-info scope, and mismatched bot open ID. For every failure, stringify checks and thrown errors and assert that neither the app secret nor returned token appears.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/lark-setup-probe.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the bounded HTTP port and Lark probe**

Define an injectable transport:

```ts
export interface SetupHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}
export interface SetupHttpClient { request(input: SetupHttpRequest): Promise<{ status: number; body: unknown }> }
```

The production implementation uses Node `fetch` with `AbortSignal.timeout()`, a bounded response body, and JSON parsing. `LarkSetupProbe` calls these documented endpoints:

```text
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
GET  https://open.feishu.cn/open-apis/im/v1/chats/{LARK_CHAT_ID}
GET  https://open.feishu.cn/open-apis/bot/v3/info
```

Send the App ID and secret only in the token request JSON body. Send the token only in the `Authorization: Bearer` header. Map Lark `code`, HTTP status, and timeout into stable checks, retain only safe code/message metadata, and discard the token after `check()` returns. Bot-info absence caused by insufficient read scope is a warning with event-console remediation; a returned, different `open_id` is a failure.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/lark-setup-probe.test.ts`

Expected: PASS, with all request methods and redaction assertions satisfied.

- [ ] **Step 5: Commit the Lark probe**

```bash
git add src/adapters/lark-setup-probe.ts src/setup/setup-types.ts tests/lark-setup-probe.test.ts
git commit -m "feat: verify Lark setup connectivity" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

---

### Task 5: Deterministic setup workflow and terminal prompts

**Files:**
- Create: `src/setup/setup-workflow.ts`
- Create: `src/setup/setup-prompts.ts`
- Create: `tests/setup-workflow.test.ts`
- Create: `tests/setup-prompts.test.ts`
- Modify: `src/setup/setup-summary.ts`

**Interfaces:**
- Consumes: all setup ports, `evaluateSetupChecks()`, `renderSetupSummary()`, and workspace candidates from `HerdrSetupProbe`.
- Produces: `runSetupWorkflow(dependencies, context): Promise<SetupOutcome>` and `TerminalSetupPrompts`.

- [ ] **Step 1: Write failing workflow state-transition tests**

Drive the workflow through scripted prompt fakes. Cover:

- first-run defaults from `context.cwd`;
- normalization of project ID;
- current Herdr workspace preference;
- existing non-secret defaults;
- retain and replace secret branches;
- explicit editing of existing multi-project configuration;
- back-navigation without losing non-secret answers;
- cancellation before commit;
- failure returning to the relevant section;
- warning confirmation;
- skipped-network save with no lifecycle calls;
- independent save, install, active-service restart, and start confirmations;
- refusal to restart while lifecycle safety rejects active work.

Assert ordering explicitly:

```ts
expect(events).toEqual([
  "load", "collect:lark", "collect:project", "validate:local",
  "validate:herdr", "validate:lark", "review", "commit",
  "inspect-service", "confirm-install", "install", "confirm-start", "start"
]);
```

- [ ] **Step 2: Write failing terminal secret-input tests**

Inject input/output and a fake TTY controller. Verify that typed secret bytes are never written to output, Ctrl-C yields a typed cancellation, non-TTY secret input is rejected unless provided through the scripted test adapter, and terminal raw mode is restored in `finally`.

- [ ] **Step 3: Run the focused tests and verify they fail**

Run: `npx vitest run tests/setup-workflow.test.ts tests/setup-prompts.test.ts`

Expected: FAIL because the workflow and prompt adapter do not exist.

- [ ] **Step 4: Implement the deterministic workflow**

Define:

```ts
export type SetupOutcome =
  | { status: "saved"; commit: SetupCommitResult }
  | { status: "installed"; commit: SetupCommitResult }
  | { status: "started"; commit: SetupCommitResult }
  | { status: "cancelled" };

export interface SetupWorkflowDependencies {
  prompts: SetupPromptPort;
  config: SetupConfigPort;
  herdr: SetupHerdrProbe & { listWorkspaces(): Promise<SetupWorkspace[]> };
  lark: SetupLarkProbe;
  lifecycle: SetupLifecyclePort;
  runLocalChecks(draft: SetupDraft, context: SetupContext): Promise<SetupCheck[]>;
}

export function runSetupWorkflow(
  dependencies: SetupWorkflowDependencies,
  context: SetupContext
): Promise<SetupOutcome>;
```

Collect Lark and project sections into immutable draft replacements. Run local, Herdr, and Lark checks in defined order so remediation maps back to a section. Render all warning and skipped results before confirmation. Never call `commit()` unless `policy.canSave`; never call lifecycle methods unless `policy.canStart`.

When the service is inactive, confirm install and start separately. When it is active, show its identity and work summary, confirm installation/update, then separately confirm restart; delegate the actual safety decision to `runPluginLifecycle("restart")`.

- [ ] **Step 5: Implement terminal prompting and cancellation**

Use `readline/promises` for text, choice, and confirmation prompts. Implement hidden secret input behind a small injected TTY interface so raw mode restoration is testable. Parse empty input as the displayed default, require exact option values or numbers, and throw a dedicated `SetupCancelledError` for Ctrl-C/Escape rather than calling `process.exit()` inside the adapter.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run tests/setup-workflow.test.ts tests/setup-prompts.test.ts tests/setup-config.test.ts tests/setup-checks.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the workflow**

```bash
git add src/setup/setup-workflow.ts src/setup/setup-prompts.ts src/setup/setup-summary.ts tests/setup-workflow.test.ts tests/setup-prompts.test.ts
git commit -m "feat: guide first-run swarm setup" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

---

### Task 6: CLI, doctor, plugin, and lifecycle integration

**Files:**
- Create: `src/cli/setup.ts`
- Create: `src/cli/doctor.ts`
- Create: `tests/setup-cli.integration.test.ts`
- Modify: `src/cli/plugin-lifecycle.ts`
- Modify: `tests/plugin-lifecycle.test.ts`
- Modify: `scripts/swarm-service.sh`
- Modify: `package.json`
- Modify: `plugin/setup.sh`
- Modify: `tests/plugin-manifest.test.ts`

**Interfaces:**
- Consumes: `runSetupWorkflow()`, setup adapters, `runPluginLifecycle()`, runtime path/environment conventions, and existing plugin launcher environment.
- Produces: `npm run swarm:setup`, `npm run swarm:doctor`, shared plugin setup delegation, and setup-safe lifecycle inspection.

- [ ] **Step 1: Write failing CLI and lifecycle integration tests**

Test these command contracts with temporary XDG roots and injected adapters:

```ts
expect(packageJson.scripts["swarm:setup"]).toBe("node dist/cli/setup.js");
expect(packageJson.scripts["swarm:doctor"]).toBe("node dist/cli/doctor.js");
expect(pluginSetup).toContain("dist/cli/setup.js");
expect(pluginSetup).not.toContain("$EDITOR_COMMAND");
```

Cover exit `0` for saved/installed/started and healthy doctor results, exit `1` for validation or lifecycle failure, exit `2` for invalid flags, and exit `130` for cancellation. Prove doctor does not write files or call lifecycle mutation methods.

Add lifecycle tests for an exported read-only inspection result and setup-driven install/start/restart delegation. Add a `requireReady` case that returns failure when startup completes but `/ready` is degraded, while keeping the existing ordinary start behavior and restart-safety tests unchanged.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/setup-cli.integration.test.ts tests/plugin-lifecycle.test.ts tests/plugin-manifest.test.ts`

Expected: FAIL because the CLI files and package scripts do not exist and plugin setup still opens editors.

- [ ] **Step 3: Expose a narrow lifecycle adapter**

Export a read-only lifecycle inspection function from `src/cli/plugin-lifecycle.ts` rather than duplicating systemd and `/status` logic. Extend `LifecycleOptions` with `requireReady?: boolean`; after startup identity and recovery converge, this option throws a bounded error unless `/ready` reports `ready`. The default remains `false`, preserving ordinary `swarm:start` and `swarm:restart` behavior. Add a setup adapter with exactly these mappings:

```ts
inspect(context) -> inspectPluginLifecycle(process.env)
install(context) -> runPluginLifecycle("install", process.env)
start(context) -> runPluginLifecycle("start", process.env, { requireReady: true })
restart(context) -> runPluginLifecycle("restart", process.env, { requireReady: true })
```

Convert non-zero lifecycle results to bounded errors. Do not expose or use the force-restart option from setup.

- [ ] **Step 4: Implement setup and doctor composition roots**

`src/cli/setup.ts` resolves standalone paths from `SWARM_CONFIG_DIR`,
`SWARM_STATE_DIR`, XDG defaults, and `BRIDGE_SYSTEMD_SERVICE_NAME`; plugin paths
come from `HERDR_PLUGIN_*`. It constructs production adapters, handles
`SetupCancelledError`, and owns exit-code mapping. Support only `--skip-network`;
the flag records skipped checks and therefore cannot auto-start.

`src/cli/doctor.ts` accepts `--env <path>` and `--projects <path>`, defaulting to
the resolved setup paths. It loads existing configuration, runs the same local,
Herdr, and Lark checks, prints the redacted report, and never constructs a
mutating lifecycle adapter.

- [ ] **Step 5: Wire npm, standalone shell, and plugin entrypoints**

Add package scripts:

```json
"swarm:setup": "node dist/cli/setup.js",
"swarm:doctor": "node dist/cli/doctor.js"
```

Teach `scripts/swarm-service.sh` to dispatch `setup` and `doctor` to the compiled
CLIs while retaining `init` semantics. Replace `plugin/setup.sh`'s editor and
direct service operations with environment setup followed by:

```bash
exec "${NODE_BIN:-$(resolve_command node)}" "$ROOT/dist/cli/setup.js"
```

Keep `plugin/configure-projects.sh` unchanged.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run tests/setup-cli.integration.test.ts tests/plugin-lifecycle.test.ts tests/plugin-manifest.test.ts`

Expected: PASS, including all legacy lifecycle assertions.

- [ ] **Step 7: Commit shared entrypoints**

```bash
git add src/cli/setup.ts src/cli/doctor.ts src/cli/plugin-lifecycle.ts tests/setup-cli.integration.test.ts tests/plugin-lifecycle.test.ts scripts/swarm-service.sh package.json plugin/setup.sh tests/plugin-manifest.test.ts
git commit -m "feat: expose swarm setup and doctor commands" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

---

### Task 7: Standalone installer guard and operator documentation

**Files:**
- Modify: `install.sh`
- Modify: `tests/plugin-manifest.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md`

**Interfaces:**
- Consumes: compiled setup/doctor commands and existing standalone staging.
- Produces: a non-interactive standalone installer guard and implementation-backed operator guidance.

- [ ] **Step 1: Write failing standalone installer contract tests**

Extend the static installer tests to assert that `--standalone` detects either
missing config or shipped placeholders (`replace-me`,
`REPLACE_WITH_HERDR_WORKSPACE_ID`, and `/absolute/path/to/your/project`) before
service installation and prints this exact remediation:

```text
Configuration is missing or still contains placeholders. Run: npm run swarm:setup
```

Also assert that the installer does not invoke the interactive setup command
itself and still stages/installs when non-placeholder configuration exists.

- [ ] **Step 2: Run the installer test and verify it fails**

Run: `npx vitest run tests/plugin-manifest.test.ts`

Expected: FAIL because `install.sh --standalone` currently proceeds directly to lifecycle installation.

- [ ] **Step 3: Add the non-interactive guard**

After build/staging but before lifecycle install, resolve the standalone `.env`
and `projects.json`. If either file is missing or contains a shipped placeholder,
print the remediation and exit `1`. Do not source `.env`, print file contents,
or invoke `swarm:setup` implicitly. Keep the existing behavior for complete
configuration.

- [ ] **Step 4: Rewrite the first-run documentation around the wizard**

Update `README.md` so the primary flow is:

```bash
npm ci
npm run build
npm run swarm:setup
```

Retain a clearly labeled non-interactive path using `swarm:init`, manual edits,
`swarm:doctor`, `swarm:install`, and `swarm:start`. Document which Lark facts are
automatically checked, which remain manual, the meaning of warnings/skips,
secret retention, backup location, cancellation behavior, and recovery commands.

Update `docs/architecture.md` with the setup workflow ports and the rule that it
cannot mutate Lark or Herdr. Update `docs/feishu-group-usage.md` only where an
operator needs to know the post-setup `/swarm new` action; keep user-command
documentation separate from installer internals.

- [ ] **Step 5: Run focused documentation and installer checks**

Run: `npx vitest run tests/plugin-manifest.test.ts tests/setup-cli.integration.test.ts`

Run: `bash -n install.sh scripts/swarm-service.sh plugin/setup.sh`

Run: `git diff --check`

Expected: all commands exit `0`.

- [ ] **Step 6: Commit installer and documentation changes**

```bash
git add install.sh tests/plugin-manifest.test.ts README.md docs/architecture.md docs/feishu-group-usage.md
git commit -m "docs: guide first-run swarm setup" -m "Co-authored-by: TRAE CLI <traecli@bytedance.com>"
```

---

### Task 8: Full regression and acceptance audit

**Files:**
- Read: `docs/superpowers/specs/2026-08-30-first-run-setup-wizard-design.md`
- Read: all files changed in Tasks 1-7
- Modify only if a verification failure identifies a scoped defect.

**Interfaces:**
- Consumes: the complete setup feature.
- Produces: repository-wide evidence that configuration, lifecycle, adapters, security, and generated build output remain valid.

- [ ] **Step 1: Run all focused setup and lifecycle tests together**

Run:

```bash
npx vitest run \
  tests/setup-checks.test.ts \
  tests/setup-config.test.ts \
  tests/herdr-setup-probe.test.ts \
  tests/lark-setup-probe.test.ts \
  tests/setup-workflow.test.ts \
  tests/setup-prompts.test.ts \
  tests/setup-cli.integration.test.ts \
  tests/config.test.ts \
  tests/plugin-lifecycle.test.ts \
  tests/plugin-manifest.test.ts
```

Expected: PASS with no skipped security or rollback tests.

- [ ] **Step 2: Run static and build verification**

Run: `npm run typecheck`

Run: `npm run build`

Run: `bash -n install.sh scripts/swarm-service.sh plugin/setup.sh plugin/configure-projects.sh`

Expected: every command exits `0`; generated `dist/` remains untracked or ignored.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: all Vitest files and tests pass.

- [ ] **Step 4: Audit non-mutation and secret handling against the spec**

Run:

```bash
rg -n "createTopic|replyCard|message.create|pane.*create|agent.*start|agent.*prompt" \
  src/setup src/adapters/lark-setup-probe.ts src/adapters/herdr-setup-probe.ts
rg -n "LARK_APP_SECRET|tenant_access_token" src/setup src/cli/setup.ts src/cli/doctor.ts
git diff --check
```

Expected: the first search finds no mutating adapter call in setup paths; the
second finds only input, serialization, and redaction-aware probe references;
the diff check exits `0`. Inspect every hit rather than relying on count alone.

- [ ] **Step 5: Exercise doctor against temporary fake services**

Run the CLI integration fixture with a temporary config directory, fake Herdr
runner, and fake Lark HTTP server. Capture hashes and modes of the two config
files before and after.

Expected: doctor returns the expected pass/warning report; hashes and modes are
unchanged; no systemd call, Lark write, pane creation, or agent launch is
recorded.

- [ ] **Step 6: Review the commit and worktree boundaries**

Run:

```bash
git log --oneline --decorate -8
git status --short
git diff --stat
```

Expected: setup work is split into the thematic commits above. Pre-existing
unrelated changes, including
`docs/superpowers/plans/2026-08-30-standalone-service-cutover.md`, remain outside
the setup commits unless separately authorized.

No live Lark message or production service restart is part of this acceptance
task. A live read-only probe may run only when the operator explicitly supplies
the intended private configuration and requests it.
