# Terminal-Read-Free Herdr Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every maintained bridge and TraeX-shim terminal-content read and use Herdr's structured Agent control surface for startup, prompt settlement, observation, and interruption.

**Architecture:** `HerdrCliAdapter` becomes a narrow structured-control adapter: snapshots provide identity/state, `agent prompt --wait` owns submission and settlement, and `agent send-keys` owns interruption. The reconciler consumes only structured pane/Agent facts, the typed TraeX transcript remains the sole answer source, and the shim reporter retains only process fencing plus display metadata.

**Tech Stack:** TypeScript ESM, Node.js 22+, Vitest, SQLite, Herdr 0.7.5 CLI/native request API, TraeX JSONL transcript.

**Spec:** `docs/superpowers/specs/2026-08-29-terminal-read-free-herdr-control-design.md`

## Global Constraints

- Never read terminal content through `pane read`, `agent read`, native `agent.read`, or an equivalent snapshot API.
- Never fall back from Agent commands to Pane text or key commands.
- Preserve no-replay semantics after a prompt command may have started.
- Keep the real TraeX executable and public `agent: "traex"` projection.
- Keep the shim reversible and version-gated for Herdr 0.7.5.
- Answers come only from the validated typed TraeX transcript or the bounded structured-output-unavailable notice.
- Do not force a production restart while durable work is active.

## File structure

- `src/adapters/herdr-adapter.ts`: structured Herdr commands and snapshot mapping only.
- `src/domain/ports.ts`, `src/domain/types.ts`: remove terminal-output seams and simplify turn observation contracts.
- `src/runtime/herdr-circuit-breaker.ts`, `src/runtime/workspace-snapshot-cache.ts`, `src/runtime/herdr/pane-host.ts`: mirror the reduced structured interfaces.
- `src/coordinator/herdr-runtime-reconciler.ts`: reconcile structured identity/state without terminal baselines or telemetry.
- `src/coordinator/model-selection-workflow.ts`: reject runtime model-menu operations without terminal input.
- `src/runtime/herdr-traex-reporter.ts`, `src/cli/herdr-traex-reporter.ts`: process-fenced display metadata only.
- `scripts/smoke-headless-multi-agent.ts`: structured blocked/ready checks only.
- Focused tests named below: exact regression evidence for each boundary.

---

### Task 1: Make prompt settlement and interruption native

**Files:**
- Modify: `tests/herdr-adapter.test.ts`
- Modify: `tests/agent-driver-contract.test.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/herdr-circuit-breaker.ts`
- Modify: `src/runtime/workspace-snapshot-cache.ts`
- Modify: `src/runtime/herdr/pane-host.ts`
- Modify: `tests/pane-host.test.ts`

**Interfaces:**
- Consumes: `HerdrPane.agentState`, `HerdrPane.stateChangeSeq`, `CommandRunner.run`.
- Produces: `runPrompt(paneId, text, timeoutMs, onObservation?, signal?, onDispatched?): Promise<AgentState>` backed by one `agent prompt --wait --timeout`; `sendEscape(paneId)` backed by `agent send-keys`.

- [ ] Replace adapter tests with assertions that the exact prompt argv is `agent prompt w1:p1 <text> --wait --timeout <ms>`, the returned structured state is parsed, and no read/Pane command appears.
- [ ] Add explicit tests for `agent_not_found`, `agent_not_ready`, and `agent_blocked` as pre-dispatch failures, plus `agent_prompt_stalled` and post-start transport failure as potentially dispatched.
- [ ] Run `npx vitest run tests/herdr-adapter.test.ts tests/agent-driver-contract.test.ts tests/pane-host.test.ts`; expect the new native assertions to fail against terminal polling and Pane Escape.
- [ ] Remove `readOutput`, native read caches, composer helpers, output-marker waits, `waitForTraexTurn`, and Pane-read schemas from the adapter and port wrappers.
- [ ] Implement prompt-result parsing with a single structured `agent get` fallback and change Escape to `agent send-keys <pane> esc`. Preserve `onStarted` uncertainty classification and AbortSignal preflight.
- [ ] Run the focused tests; expect PASS.
- [ ] Commit with `git commit -m "refactor: use native Herdr prompt settlement"`.

### Task 2: Remove terminal-derived reconciliation

**Files:**
- Modify: `tests/herdr-runtime-reconciler.test.ts`
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Modify: `src/domain/ports.ts`
- Modify if dead after call-site removal: `src/runtime/traex-output-parser.ts`
- Modify if dead after call-site removal: `tests/traex-output-parser.test.ts`

**Interfaces:**
- Consumes: `listAllPanes/listPanes`, `observeRuntime`, `applyRuntimeObservation`, typed transcript processing in `PromptRunWorkflow`.
- Produces: reconciliation driven only by pane/Agent identity and monotonic `stateChangeSeq`.

- [ ] Rewrite reconciler tests so discovery, baseline capture, unknown state, telemetry absence, queue wakeup, and tab/worktree changes require zero `readOutput` calls.
- [ ] Run `npx vitest run tests/herdr-runtime-reconciler.test.ts`; expect failures from existing baseline/output code.
- [ ] Delete `observedTerminalOutputs`, baseline-read concurrency, `captureBaselines` output reads, `publishChangedLocalOutput`, output checkpoint helpers, terminal telemetry extraction, and terminal observation construction.
- [ ] Keep `captureBaselines()` as structured-state baseline capture if startup wiring requires the method; it must not read content. Keep tab/worktree metadata projection because those fields come from structured snapshots/filesystem metadata.
- [ ] Remove `checkpointRuntimeOutput*` from `RuntimeReconciliationStore` only if no non-terminal caller remains; leave SQLite migration/state columns intact for backward-compatible database opening.
- [ ] Run `npx vitest run tests/herdr-runtime-reconciler.test.ts tests/session-reconciler.test.ts tests/pane-thread-lifecycle-integration.test.ts`; expect PASS.
- [ ] Commit with `git commit -m "refactor: reconcile from structured Herdr state"`.

### Task 3: Remove terminal model-menu automation

**Files:**
- Modify: `tests/model-command-integration.test.ts`
- Modify: `src/coordinator/model-selection-workflow.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/runtime/herdr-circuit-breaker.ts`
- Modify: `src/runtime/workspace-snapshot-cache.ts`
- Modify: `src/cards/run-card.ts` or model-card copy only if needed for the unsupported response.

**Interfaces:**
- Consumes: durable model-control operation store and outbound card/message path.
- Produces: deterministic unsupported/failed terminal state for live and recovered runtime model changes, with no Herdr input.

- [ ] Replace model integration tests with cases proving a new request and a recovered in-flight request are rejected/terminalized without calling any Herdr command.
- [ ] Run `npx vitest run tests/model-command-integration.test.ts`; expect failure while `/model` automation remains.
- [ ] Remove `runPaneCommand`, `beginPaneModelSelection`, and `completePaneModelMode` from all ports/wrappers and delete their adapter implementation plus menu/composer parsers.
- [ ] Simplify `ModelSelectionWorkflow` to return a bounded message: runtime model switching is unavailable; select the model when creating or replacing the Agent. Ensure recovery does not send input.
- [ ] Run model, pane-control, card-interaction, and store tests; expect PASS.
- [ ] Commit with `git commit -m "refactor: remove terminal model automation"`.

### Task 4: Make the TraeX reporter metadata-only

**Files:**
- Modify: `tests/herdr-traex-reporter.test.ts`
- Modify: `src/runtime/herdr-traex-reporter.ts`
- Modify: `src/cli/herdr-traex-reporter.ts`
- Modify: `tests/herdr-traex-shim.test.ts` if reporter dependency shape changes.

**Interfaces:**
- Consumes: fenced process identity, `report-metadata`, `agent get` only if needed for rename readiness, and process disappearance.
- Produces: TraeX display metadata lifecycle without state classification from terminal content.

- [ ] Rewrite reporter tests to prove it publishes metadata, retains the fenced process, optionally renames after structured non-unknown Agent state, and clears/releases on process loss without a snapshot read/explain operation.
- [ ] Run `npx vitest run tests/herdr-traex-reporter.test.ts tests/herdr-traex-shim.test.ts`; expect type/assertion failures from `readPane` and `explainCodexSnapshot`.
- [ ] Remove reporter `readPane`, `explainCodexSnapshot`, temporary file creation, and terminal-derived `reportAgent`. Poll process identity and structured `agent get` only.
- [ ] Keep the shim's pre-prompt `working` report only if isolated short-turn E2E still needs it; it must remain input-triggered rather than terminal-derived.
- [ ] Run the reporter/shim tests; expect PASS.
- [ ] Commit with `git commit -m "refactor: remove terminal reads from TraeX reporter"`.

### Task 5: Remove terminal-reading smoke behavior and stale documentation

**Files:**
- Modify: `scripts/smoke-headless-multi-agent.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/feishu-group-usage.md` if it documents runtime model switching.
- Modify/delete focused tests and imports found by the source audit.

**Interfaces:**
- Consumes: `agent get`, `agent wait`, snapshot Agent status.
- Produces: smoke diagnostics that report `blocked` without answering dialogs and docs describing the strict native boundary.

- [ ] Change smoke startup checks to inspect structured Agent state; fail with an operator-required diagnostic on `blocked`, and remove all terminal reads/trust-dialog automation.
- [ ] Update active documentation to remove terminal fallback and runtime `/model` claims; retain historical specs unchanged except where they are linked as current authority.
- [ ] Run both source-audit searches from the spec; remove every maintained runtime hit, including dead helpers/imports/tests.
- [ ] Run focused smoke-script/type tests if present, then `npm run typecheck`; expect PASS.
- [ ] Commit with `git commit -m "docs: enforce structured Herdr control boundary"`.

### Task 6: Verify, install, and safely roll out

**Files:**
- Generated by build only: `dist/` (do not edit manually).
- External reversible installation: active Herdr TraeX shim release via `scripts/install-herdr-traex-shim.sh`.

**Interfaces:**
- Consumes: all preceding commits and the managed service drain gate.
- Produces: fresh verification evidence, isolated real E2E evidence, installed shim status, and a matching ready production build when safe.

- [ ] Run the exact no-terminal-read and no-Pane-control `rg` audits; require zero executed-command hits.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; require all PASS.
- [ ] Create a disposable isolated Herdr server/workspace/Pane, install or invoke the built shim, start `--kind traex`, verify `/proc/<pid>/exe`, run short and normal `agent prompt --wait` turns, inspect structured state sequence, then `/exit` and destroy only the disposable resources.
- [ ] If short-turn E2E passes without the pre-prompt compatibility report, remove that report and rerun Task 4 plus E2E; otherwise document it as the only non-terminal lifecycle hint.
- [ ] Commit any E2E-driven correction, rerun full verification, and confirm `git status --short` is clean.
- [ ] Build/install the reversible shim release, inspect plugin service status and durable work diagnostics, and invoke the normal plugin restart only if the drain gate permits it. Never use `--force`.
- [ ] Verify `/ready`, build identity, shim version, and no prompt replay after restart; if work is still active, leave the healthy old service running and report the deferred restart separately rather than claiming deployment.
