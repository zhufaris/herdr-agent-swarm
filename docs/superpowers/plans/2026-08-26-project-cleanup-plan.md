# Project Cleanup Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in the current session. Do not dispatch subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove proven dead TypeScript code, archive completed process documents, and make the four active documents accurately describe the current bridge.

**Architecture:** Treat strict TypeScript unused diagnostics as evidence for runtime cleanup while preserving persistence migrations and runtime fallbacks. Keep the active documentation surface small, move only completed artifacts into the existing archive hierarchy, and verify every move with repository-local link checks.

**Tech Stack:** TypeScript 5.9, Node.js 22.5+, Vitest, SQLite, Markdown, Git

**Spec:** `docs/superpowers/specs/2026-08-26-project-cleanup-design.md`

## Global Constraints

- Preserve FIFO, one ordinary turn per binding, no-replay, durable-before-delivery, CardKit sequence ordering, and local-only high-risk approval.
- Preserve SQLite migrations, legacy CardKit recovery, Main Card normalization, Herdr compatibility fallback, and detached observation.
- Do not edit `.env`, `config/projects.json`, `var/`, live SQLite files, generated `dist/`, plugin configuration, or service state.
- Do not restart the service or send Lark messages.
- Do not edit or stage the concurrent Answer Markdown work in `src/runtime/answer-stream.ts`, `src/runtime/lark-markdown.ts`, `tests/answer-stream.test.ts`, `tests/lark-markdown.test.ts`, or `docs/superpowers/plans/2026-08-26-answer-card-markdown-rendering.md`.
- Do not archive the active Answer Markdown artifacts, the outbox lane quarantine design, or this cleanup spec/plan until their corresponding work is complete.

---

## File Structure

### Runtime files modified

- `src/adapters/herdr-adapter.ts`: remove a superseded model-selector predicate.
- `src/cards/run-card.ts`: remove an unused request-status formatter.
- `src/coordinator/binding-provisioning-workflow.ts`: narrow recovery destructuring.
- `src/coordinator/herdr-runtime-reconciler.ts`: remove an unused telemetry parameter.
- `src/coordinator/inbound-router.ts`: stop destructuring an unused workflow dependency.
- `src/coordinator/model-selection-workflow.ts`: remove dead imports, destructured dependencies, helper, and method.
- `src/coordinator/operations-query-workflow.ts`: narrow destructuring to used dependencies.
- `src/coordinator/session-administration-workflow.ts`: remove an unused type import.
- `src/coordinator/startup-view-converger.ts`: retain only constructor values that are used after initialization.
- `src/store/sqlite-store.ts`: remove dead type/function imports and unused locals without changing transactions.

### Active documents modified

- `README.md`: synchronize configuration, delivery, pagination, and operational wording.
- `docs/architecture.md`: remove completed gaps and describe the current delivery/shutdown design.
- `docs/architecture-reference.md`: synchronize module and transaction descriptions.
- `docs/feishu-group-usage.md`: synchronize user-visible card and recovery behavior only where source differs.

### Documentation moved

- Completed files under `docs/superpowers/{specs,plans,tickets}/` move to `docs/archive/superpowers/{specs,plans,tickets}/`.
- Explicitly exclude the concurrent Answer Markdown spec/plan, `2026-08-26-outbox-lane-quarantine-design.md`, and the cleanup spec/plan.
- The cleanup spec and plan move only after all implementation and verification steps pass.

---

### Task 1: Remove Strict-Compiler Dead Code

**Files:**
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Modify: `src/coordinator/model-selection-workflow.ts`
- Modify: `src/coordinator/operations-query-workflow.ts`
- Modify: `src/coordinator/session-administration-workflow.ts`
- Modify: `src/coordinator/startup-view-converger.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: existing nearest tests for adapters, cards, workflows, and store

**Interfaces:**
- Consumes: existing constructor signatures and domain ports.
- Produces: behaviorally identical runtime modules with zero strict-unused diagnostics.

- [ ] **Step 1: Capture the exact unused baseline**

Run:

```bash
npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
```

Expected: the known 21 diagnostics only. If concurrent work adds diagnostics in files outside this task, stop and isolate them rather than editing those files.

- [ ] **Step 2: Delete standalone dead declarations and imports**

Apply these mechanical deletions:

```text
herdr-adapter.ts: delete isInteractiveModelSelector
run-card.ts: delete requestStatusLabel
model-selection-workflow.ts: delete createBridgeEvent import, reply method, and isApprovalPrompt
session-administration-workflow.ts: remove HerdrPane from the type import
sqlite-store.ts: remove PaneControlOperationState, RequestCardRole, and normalizeLarkElementId imports
```

Do not delete the similarly named live `isApprovalPrompt` in `pane-control-workflow.ts`.

- [ ] **Step 3: Narrow destructuring and constructor storage**

Make only the following signature-preserving changes:

```ts
// binding-provisioning-workflow.ts
const { store, outbound, logger } = this.options;

// herdr-runtime-reconciler.ts
private async publishTerminalTelemetry(binding: Binding, output: string): Promise<void>

// inbound-router.ts start()
const { config, store, herdr, lark, logger, promptRun, reconciler, paneControl, provisioning, retiredPaneCleanup, inboundWork, startupViews } = this.options;

// operations-query-workflow.ts listSpaces()
const { config, herdr, store, logger } = this.options;
```

In `model-selection-workflow.ts`, remove `config`, `logger`, and `outbound` only from destructuring sites where the compiler identifies them as unused; retain the fields in `Options` because other methods use them.

In `StartupViewConverger`, change parameter properties that are used only to initialize fields into ordinary constructor parameters:

```ts
constructor(
  config: BridgeConfig,
  private readonly store: PromptAcceptanceStore & ProjectionStore,
  private readonly outbound: OutboundIntentPort,
  private readonly outboundWork: OutboundWorkNotifier,
  answerPages?: AnswerPageWorkflowPort,
  mainCards?: MainCardWorkflowPort
)
```

- [ ] **Step 4: Remove the two unused SQLite timestamps**

Delete only `const timestamp = now();` in `transitionBindingWithOutbox` and `reserveMainCard`. Keep each transaction, event timestamp, outbox idempotency key, and delivery checkpoint unchanged.

- [ ] **Step 5: Run strict compiler and focused tests**

Run:

```bash
npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
npx vitest run tests/herdr-adapter.test.ts tests/run-card.test.ts tests/provisioning-recovery.test.ts tests/herdr-runtime-reconciler.test.ts tests/model-command-integration.test.ts tests/operations-integration.test.ts tests/startup-view-converger.test.ts tests/sqlite-store.test.ts
```

Expected: strict compilation exits 0 and every selected test passes.

- [ ] **Step 6: Commit the runtime cleanup without concurrent files**

```bash
git add src/adapters/herdr-adapter.ts src/cards/run-card.ts src/coordinator/binding-provisioning-workflow.ts src/coordinator/herdr-runtime-reconciler.ts src/coordinator/inbound-router.ts src/coordinator/model-selection-workflow.ts src/coordinator/operations-query-workflow.ts src/coordinator/session-administration-workflow.ts src/coordinator/startup-view-converger.ts src/store/sqlite-store.ts
git diff --cached --check
git commit -m "refactor: remove dead runtime code"
```

### Task 2: Correct the Active Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture-reference.md`
- Modify if source audit finds drift: `docs/feishu-group-usage.md`

**Interfaces:**
- Consumes: `src/config.ts`, `.env.example`, `herdr-plugin.toml`, `src/main.ts`, workflow implementations, SQLite store, and tests.
- Produces: four current documents whose claims trace to implementation.

- [ ] **Step 1: Reconcile README configuration with `src/config.ts`**

Add the currently omitted settings and defaults to the README environment block:

```dotenv
OUTBOX_RETENTION_DAYS=14
OUTBOX_RETENTION_BATCH_SIZE=500
OUTBOX_RETENTION_MAX_BATCHES=20
```

State explicitly that `LARK_MESSAGE_CHUNK_SIZE=3500` controls bounded text-message chunks, while Answer Card streaming uses an internal 9,000-character page limit. Do not change either value.

Correct the sample checkout path from `/absolute/path/to/swarm-lark-bridge` to `/absolute/path/to/herdr-lark-bridge`.

- [ ] **Step 2: Update architecture facts that are already implemented**

In `docs/architecture.md`:

- keep the AnswerPage and Main Card authority descriptions;
- describe the shared shutdown context/deadline if confirmed in `src/runtime/shutdown-context.ts` and `src/main.ts`;
- remove “Shutdown deadline coordination” from Known implementation gaps when the source confirms it is complete;
- remove or rewrite evolution priorities already implemented by current lane diagnostics or shutdown code;
- retain terminal heuristics, configuration hardcoding, and Herdr circuit protection only when still supported by source evidence;
- avoid documenting the unimplemented outbox quarantine design as current behavior.

- [ ] **Step 3: Synchronize the maintainer reference**

In `docs/architecture-reference.md`, ensure the module table and flows name the current workflows and record that:

```text
AnswerPageWorkflow = sole Answer delivery convergence owner
MainCardWorkflow = sole Main Card desired/delivered convergence owner
LarkOutboxDispatcher = per-lane serial, cross-lane bounded concurrency
BridgeRuntimeShutdown + ShutdownContext = shared shutdown budget and detach boundary
```

Remove future-tense items that the current source already implements. Do not translate or duplicate the full English architecture document.

- [ ] **Step 4: Audit the user guide against command parsing**

Compare `docs/feishu-group-usage.md` with `src/domain/commands.ts`, `src/coordinator/inbound-router.ts`, `src/coordinator/pane-control-workflow.ts`, and `src/coordinator/pane-closure-workflow.ts`. Edit only mismatches in accepted syntax, FIFO/steering behavior, Answer Card pagination, pane-close confirmation, or local approval. If no mismatch exists, leave the file unchanged.

- [ ] **Step 5: Verify source-backed terminology**

Run:

```bash
rg -n "3500|3,500|9000|9,000|OUTBOX_RETENTION|shared deadline|shutdown|MainCardWorkflow|AnswerPageWorkflow" README.md docs/architecture.md docs/architecture-reference.md docs/feishu-group-usage.md src/config.ts src/runtime/answer-stream.ts src/runtime/shutdown-context.ts src/main.ts
git diff --check -- README.md docs/architecture.md docs/architecture-reference.md docs/feishu-group-usage.md
```

Expected: configuration values match source, the two size limits are not conflated, and no whitespace errors exist.

- [ ] **Step 6: Commit active-document corrections**

```bash
git add README.md docs/architecture.md docs/architecture-reference.md docs/feishu-group-usage.md
git diff --cached --check
git commit -m "docs: align active guides with runtime"
```

If `docs/feishu-group-usage.md` is unchanged, omit it from the staged paths.

### Task 3: Archive Completed Process Documents

**Files:**
- Move: completed `docs/superpowers/specs/*.md` to `docs/archive/superpowers/specs/`
- Move: completed `docs/superpowers/plans/*.md` to `docs/archive/superpowers/plans/`
- Move: completed `docs/superpowers/tickets/*.md` to `docs/archive/superpowers/tickets/`
- Modify: relative Markdown references inside moved files when necessary

**Interfaces:**
- Consumes: the active/in-progress exclusions in Global Constraints.
- Produces: a minimal active docs surface with historical records still available.

- [ ] **Step 1: Build and inspect the archive allowlist**

List every tracked current artifact, then exclude these active files:

```text
docs/superpowers/specs/2026-08-26-answer-card-markdown-rendering-design.md
docs/superpowers/plans/2026-08-26-answer-card-markdown-rendering.md
docs/superpowers/specs/2026-08-26-outbox-lane-quarantine-design.md
docs/superpowers/specs/2026-08-26-project-cleanup-design.md
docs/superpowers/plans/2026-08-26-project-cleanup-plan.md
```

Run:

```bash
git ls-files 'docs/superpowers/**/*.md'
git status --short -- docs/superpowers
```

Do not move any file with concurrent unstaged changes.

- [ ] **Step 2: Move the allowlisted files with `git mv`**

Create only the missing archive category directory, then use explicit `git mv` source and target paths. Do not use a glob that can capture an active file. Existing archived files are preserved.

- [ ] **Step 3: Rewrite relative links affected by the extra `archive/` path segment**

For each moved document, inspect Markdown links beginning with `../`, `../../`, or `docs/`. Rewrite only links whose resolved target changed. Links between files moved together should point within `docs/archive/superpowers/`; links to active architecture documents should resolve back to `docs/`.

- [ ] **Step 4: Verify the active surface and archive history**

Run:

```bash
find docs/superpowers -type f -name '*.md' | sort
find docs/archive/superpowers -type f -name '*.md' | sort
git diff --summary
```

Expected: only the five explicit active/in-progress exclusions remain under `docs/superpowers/`; completed records appear as renames under `docs/archive/superpowers/`. If the untracked Answer Markdown plan remains untracked, it must not be staged.

- [ ] **Step 5: Commit the archive move**

Stage only explicit moved paths and link corrections, inspect `git diff --cached --summary`, then commit:

```bash
git commit -m "docs: archive completed implementation records"
```

### Task 4: Final Verification and Cleanup-Record Archive

**Files:**
- Move: `docs/superpowers/specs/2026-08-26-project-cleanup-design.md`
- Move: `docs/superpowers/plans/2026-08-26-project-cleanup-plan.md`
- Modify: their mutual `Spec` link after moving

**Interfaces:**
- Consumes: Tasks 1–3 and the repository test/build commands.
- Produces: verified cleanup with its own records archived.

- [ ] **Step 1: Run the complete verification suite after the final content edit**

```bash
npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: strict compiler exit 0, typecheck exit 0, all Vitest files and tests pass, build exit 0, and no whitespace errors.

- [ ] **Step 2: Check all repository-local Markdown links**

Run this read-only checker. It walks tracked Markdown files, ignores fenced code
and absolute/protocol/anchor links, resolves each relative target from the
containing file, and reports every missing path:

```bash
node --input-type=module -e 'import { existsSync, statSync } from "node:fs"; import { dirname, resolve } from "node:path"; import { execFileSync } from "node:child_process"; const files = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" }).trim().split("\n").filter(Boolean); const failures = []; for (const file of files) { const source = execFileSync("git", ["show", `:${file}`], { encoding: "utf8" }); const visible = source.replace(/```[\s\S]*?```/g, ""); for (const match of visible.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) { const raw = match[1].trim().replace(/^<|>$/g, "").split(/\s+[\"']/)[0]; if (!raw || /^(?:[a-z]+:|#)/i.test(raw)) continue; const target = decodeURIComponent(raw.split("#")[0]); const path = resolve(dirname(file), target); if (!existsSync(path)) failures.push(`${file} -> ${raw}`); else if (target.endsWith("/") && !statSync(path).isDirectory()) failures.push(`${file} -> ${raw}`); } } if (failures.length) { console.error(failures.join("\n")); process.exit(1); } console.log(`checked ${files.length} Markdown files; local links ok`);'
```

Expected: zero missing repository-local targets. External URLs are not fetched.

- [ ] **Step 3: Confirm concurrent work is untouched**

```bash
git status --short
git diff -- src/runtime/answer-stream.ts src/runtime/lark-markdown.ts tests/answer-stream.test.ts tests/lark-markdown.test.ts docs/superpowers/plans/2026-08-26-answer-card-markdown-rendering.md
```

Expected: concurrent changes remain present exactly as owned by the other work and are absent from this task's commits.

- [ ] **Step 4: Archive the cleanup spec and plan**

Move them with explicit commands:

```bash
git mv docs/superpowers/specs/2026-08-26-project-cleanup-design.md docs/archive/superpowers/specs/2026-08-26-project-cleanup-design.md
git mv docs/superpowers/plans/2026-08-26-project-cleanup-plan.md docs/archive/superpowers/plans/2026-08-26-project-cleanup-plan.md
```

Update the plan header to:

```markdown
**Spec:** `../specs/2026-08-26-project-cleanup-design.md`
```

Re-run the Markdown link check and `git diff --check`.

- [ ] **Step 5: Commit the verified cleanup records**

```bash
git add docs/archive/superpowers/specs/2026-08-26-project-cleanup-design.md docs/archive/superpowers/plans/2026-08-26-project-cleanup-plan.md
git diff --cached --check
git commit -m "docs: archive project cleanup records"
```

- [ ] **Step 6: Report evidence**

Report the strict-unused result, exact Vitest file/test counts, typecheck/build exit status, local-link result, cleanup commits, and any concurrent work deliberately left untouched. Do not claim the live service was validated because this plan intentionally performs no restart or Lark smoke test.
