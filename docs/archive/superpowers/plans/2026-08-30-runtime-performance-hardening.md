# Runtime Performance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the bridge's socket, transcript, Herdr observation, CardKit rendering, cache, and SQLite hot paths without weakening durable workflow or recovery behavior.

**Architecture:** Keep SQLite and Herdr as the durable and runtime authorities, respectively, while making process-local schedulers and caches bounded. Deliver changes in independently testable commits: local socket safety, shutdown draining, transcript/Herdr I/O, card rendering, persistence queries, then operational cleanup.

**Tech Stack:** Node.js 22+, TypeScript ESM, `node:net`, `node:fs/promises`, `node:sqlite`, Pino, Zod, Vitest, Herdr CLI/native socket, Lark CardKit.

**Spec:** `docs/superpowers/specs/2026-08-30-runtime-performance-hardening-design.md`

## Global Constraints

- Preserve per-binding FIFO and never replay a prompt after possible TraeX delivery.
- Persist workflow and delivery intent before external Lark delivery.
- Preserve canonical answer offsets, CardKit sequence ordering, and immutable frozen pages.
- Keep full durable tool history even when cards render a bounded window.
- Keep Herdr headless server as pane/process authority; do not introduce a TUI dependency.
- Do not modify or stage `docs/superpowers/plans/2026-08-30-standalone-service-cutover.md`.
- After every source batch run its focused tests, `npm run typecheck`, and `npm run build`; run `npm test` for shared workflow or persistence changes.

---

### Task 1: Make the Primary Tool socket single-frame and bounded

**Files:**
- Modify: `src/runtime/primary-tool-gateway.ts`
- Modify: `src/cli/primary-tools-mcp.ts`
- Test: `tests/primary-tool-gateway.integration.test.ts`
- Test: `tests/primary-worker-flow.integration.test.ts`

**Interfaces:**
- Consumes: the existing newline-delimited request and response envelopes.
- Produces: exactly one tool execution per socket, a request idle timeout, a concurrent-connection ceiling, and `MAX_PRIMARY_TOOL_RESPONSE_BYTES` enforcement in the MCP client.

- [ ] **Step 1: Add failing gateway tests**

Add tests that send a valid request followed by extra chunks/another frame and assert that the messaging method is called once, plus a client that connects without completing a frame and is closed after a test-configurable idle timeout. Keep the valid fragmented-single-frame case passing.

```ts
socket.write(firstFrame + "\n");
socket.write(secondFrame + "\n");
await vi.waitFor(() => expect(promptInstance).toHaveBeenCalledOnce());
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run tests/primary-tool-gateway.integration.test.ts tests/primary-worker-flow.integration.test.ts`

Expected: the duplicate-frame or idle-connection assertion fails against the current listener.

- [ ] **Step 3: Implement one-frame server handling**

Add a per-connection `handled` flag, remove/pause the data listener as soon as the first newline is accepted, reject non-whitespace trailing bytes, and set an idle timer. Maintain a bounded active-socket count and reject excess connections before reading input. Clear timers and accounting exactly once on close.

```ts
if (handled) return;
const newline = input.indexOf("\n");
if (newline < 0) return;
handled = true;
socket.pause();
socket.removeListener("data", onData);
```

- [ ] **Step 4: Bound MCP responses**

Export a small response limit constant for testing. Collect `Buffer` chunks while tracking bytes; destroy and reject immediately above the limit, and join only once at `end`. Guard promise settlement so timeout, error, oversize, and end cannot resolve twice.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run tests/primary-tool-gateway.integration.test.ts tests/primary-worker-flow.integration.test.ts
npm run typecheck
npm run build
```

Commit: `fix: bound primary tool socket work`

---

### Task 2: Drain active card convergence during shutdown

**Files:**
- Modify: `src/events/card-update-scheduler.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Test: `tests/card-update-scheduler.test.ts`
- Test: `tests/event-card-integration.test.ts`
- Test: `tests/runtime-shutdown.test.ts`

**Interfaces:**
- Consumes: `CardUpdateScheduler.schedule(cardKey, version, options)`.
- Produces: `CardUpdateScheduler.stop(): Promise<void>`, which stops new work and settles every flush started before stop.

- [ ] **Step 1: Add failing shutdown tests**

Hold `deliver()` behind a promise, call `stop()`, assert stop remains pending, release delivery, then assert stop resolves and no retry or newer delivery starts. Add an integration assertion that `ConversationViewProjector.stop()` has the same behavior.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run tests/card-update-scheduler.test.ts tests/event-card-integration.test.ts tests/runtime-shutdown.test.ts`

- [ ] **Step 3: Track active flushes and make stop asynchronous**

Store launched flush promises in `Set<Promise<void>>`, remove them in `finally`, and make `stop()` idempotently return one promise that clears timers and awaits a stable snapshot of active work. Do not relaunch or arm retries once `stopped` is true.

```ts
private readonly activeFlushes = new Set<Promise<void>>();
private stopPromise: Promise<void> | null = null;

stop(): Promise<void> {
  this.stopped = true;
  // clear timers and pending work
  return this.stopPromise ??= Promise.allSettled([...this.activeFlushes]).then(() => undefined);
}
```

Await `this.scheduler.stop()` inside `ConversationViewProjector.stop()` before returning.

- [ ] **Step 4: Verify and commit**

Run the three focused files, `npm run typecheck`, `npm run build`, and `npm test`.

Commit: `fix: drain card convergence on shutdown`

---

### Task 3: Coalesce transcript discovery and parse one tail

**Files:**
- Modify: `src/runtime/traex-transcript.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Test: `tests/traex-transcript-cache.test.ts`
- Test: `tests/traex-transcript.test.ts`
- Test: `tests/concurrency-controls.integration.test.ts`

**Interfaces:**
- Consumes: `TraexTranscriptReader.open(session)`.
- Produces: the same `TraexTranscriptOpenResult`, backed by a bounded positive LRU, short negative TTL, coalesced in-flight discovery, and one tail read for baseline metadata.

- [ ] **Step 1: Add deterministic work-count tests**

Inject a clock and discovery function through optional reader dependencies. Assert concurrent opens for one session invoke discovery once, repeated not-found opens within the TTL do not rescan, and an open after expiry discovers a newly created transcript. Add a fixture containing both lifecycle and token events and assert one tail-read operation supplies both baselines.

- [ ] **Step 2: Run transcript tests and confirm failure**

Run: `npx vitest run tests/traex-transcript-cache.test.ts tests/traex-transcript.test.ts tests/concurrency-controls.integration.test.ts`

- [ ] **Step 3: Add negative and in-flight discovery caches**

Use bounded maps keyed only after session identity validation. Cache only `transcript_not_found`; do not cache ambiguity or validation failure as absence. Clear a negative entry on success and evict oldest entries at the same bounded capacity as path caching.

- [ ] **Step 4: Combine baseline parsing**

Replace `latestTokenCount()` and `latestTurnLifecycle()` with one helper returning:

```ts
interface TranscriptBaseline {
  tokenCount: number | null;
  turnLifecycle: TraexTranscriptObservation["turnLifecycle"];
}
```

Open and read the bounded tail once, parse each complete JSONL line once, reduce lifecycle forward, and update token count when a valid token event appears.

- [ ] **Step 5: Back off first-turn acquisition**

Replace fixed 50 ms retries with a small capped sequence while retaining the three-second grace deadline and abort behavior. Ensure the final attempt cannot sleep beyond the deadline.

- [ ] **Step 6: Verify and commit**

Run the three focused files, `npm run typecheck`, and `npm run build`.

Commit: `perf: bound transcript discovery and parsing`

---

### Task 4: Reduce Herdr polling and redundant snapshots

**Files:**
- Modify: `src/runtime/herdr-traex-shim.ts`
- Modify: `src/adapters/herdr-adapter.ts`
- Modify: `src/runtime/herdr/pane-host.ts`
- Modify: `src/coordinator/instance-turn-supervisor.ts`
- Test: `tests/herdr-traex-shim.test.ts`
- Test: `tests/herdr-adapter.test.ts`
- Test: `tests/instance-turn-supervisor.test.ts`

**Interfaces:**
- Produces: capped backoff for startup probes, one pane snapshot per turn-supervisor scan, and event-first close confirmation with a bounded fallback.

- [ ] **Step 1: Add poll-count and snapshot-count tests**

Use fake clocks/dependencies to prove a long startup makes materially fewer than one check per 50 ms. Configure multiple observable turns and assert one `listPanes`/snapshot call per reconciliation scan. Test close-event success and compatibility fallback separately.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/herdr-traex-shim.test.ts tests/herdr-adapter.test.ts tests/instance-turn-supervisor.test.ts`

- [ ] **Step 3: Implement shared capped backoff**

Add a local deterministic helper with delays such as `50, 100, 250, 500, 1000`, capped at 1 second. Inject jitter only in production dependencies so tests remain deterministic. Apply it to process registration and `agent_pane_busy` retries.

- [ ] **Step 4: Inspect turns from one snapshot**

Extend `PaneHost` with a bulk read returning normalized panes, fetch it once at the start of `reconcileOnce()`, and pass the indexed pane into turn observation. Preserve generation, workspace, cwd, and agent-kind checks before each SQLite transition.

- [ ] **Step 5: Prefer pane-close events**

After issuing close, await `waitForPaneEvent` when available, then perform one authoritative lookup. Retain backoff polling only for older Herdr versions or a missed event.

- [ ] **Step 6: Verify and commit**

Run the focused files, `npm run typecheck`, `npm run build`, and `npm test`.

Commit: `perf: reduce Herdr polling and snapshots`

---

### Task 5: Isolate failures in the native Herdr transport

**Files:**
- Modify: `src/adapters/herdr-adapter.ts`
- Create: `src/runtime/native-herdr-circuit.ts` only if keeping the state inside the adapter would obscure its public behavior
- Test: `tests/herdr-adapter.test.ts`
- Test: `tests/herdr-circuit-breaker.test.ts`

**Interfaces:**
- Produces: native request state `closed | open | half-open`, while retaining CLI fallback for every operation.

- [ ] **Step 1: Add failure-threshold and cooldown tests**

Assert repeated native timeouts stop calling the socket during cooldown, CLI fallback continues to work, one probe is allowed after cooldown, and a successful probe closes the native circuit.

- [ ] **Step 2: Implement the transport-local circuit**

Count only native transport/protocol failures. Do not report the entire Herdr workflow unavailable when CLI fallback succeeds. Expose bounded diagnostics through the existing adapter/circuit status rather than logging every fallback.

- [ ] **Step 3: Verify and commit**

Run the two focused files, `npm run typecheck`, and `npm run build`.

Commit: `perf: circuit-break native Herdr fallback`

---

### Task 6: Make Markdown pagination linear and source-stable

**Files:**
- Modify: `src/runtime/lark-markdown.ts`
- Modify: `src/cards/run-card.ts`
- Test: `tests/lark-markdown.test.ts`
- Test: the existing run-card Markdown test file located with `rg -l "renderAnswerStreamPage|renderLarkMarkdownPage" tests`

**Interfaces:**
- Consumes: canonical source plus source offset and rendered character limit.
- Produces: identical `RenderedLarkMarkdownPage` semantics with linear delimiter/range scans and bounded active-page parsing.

- [ ] **Step 1: Add adversarial and offset regression tests**

Cover long unmatched backtick runs, many tool blocks, many fenced blocks, tables, diffs, and multi-page answers. Assert exact page text, monotonic `nextPageStart`, reconstruction from canonical source offsets, and bounded parser invocation counts rather than elapsed milliseconds.

- [ ] **Step 2: Run focused tests and confirm failure of the work-bound assertions**

Run the Markdown and run-card test files.

- [ ] **Step 3: Replace inline-code regex with a scanner**

Walk the string once, identify each opening backtick-run length, search forward without regex backtracking for the matching run on the same line, and preserve unmatched delimiters as plain text.

- [ ] **Step 4: Merge protected ranges and page candidates linearly**

Keep tool ranges sorted and advance one range pointer while visiting line ends. Replace `findIndex`-from-zero fence handling with a single-pass fence state machine. Avoid rendering `source[start..source.length]` before establishing a bounded candidate window.

- [ ] **Step 5: Verify and commit**

Run focused tests, `npm run typecheck`, and `npm run build`.

Commit: `perf: bound Lark markdown pagination`

---

### Task 7: Bound visible CardKit histories, directories, and caches

**Files:**
- Modify: `src/cards/progress-timeline.ts`
- Modify: `src/cards/run-card.ts`
- Modify: `src/cards/instance-directory-card.ts`
- Modify: `src/cards/space-directory-card.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `src/adapters/lark-adapter.ts`
- Test: corresponding progress, run-card, directory, projector, and Lark adapter tests under `tests/`

**Interfaces:**
- Produces: bounded serialized CardKit trees and bounded process-local LRU caches; durable `RunCardView.progressEvents` remains complete.

- [ ] **Step 1: Add payload-bound and eviction tests**

Generate hundreds of progress entries/projects/directories and assert each serialized page stays below the shared maximum. Assert the card contains recent details plus an older-count summary, while the stored view remains complete. Exercise LRU eviction and reload-after-eviction.

- [ ] **Step 2: Implement bounded visible history and pagination**

Keep a fixed recent event window in CardKit and replace the full collapsed history with a summary. Reuse one serialized-size pagination helper for project, instance, and space cards; split a single oversized directory group before page assembly.

- [ ] **Step 3: Bound process-local maps**

Use a small generic insertion-ordered LRU helper or focused private helpers. Evict topic views after terminal/archive projection scheduling, clear both maps during stop, and rely on SQLite/Lark conversion after cache misses.

- [ ] **Step 4: Verify and commit**

Run all affected card/projector/adapter tests, `npm run typecheck`, `npm run build`, and `npm test`.

Commit: `perf: bound card payloads and projection caches`

---

### Task 8: Add SQLite hot-path indexes and bound history APIs

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/coordinator/instance-interaction-workflow.ts`
- Modify: `src/coordinator/instance-messaging-workflow.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: relevant instance interaction and messaging integration tests

**Interfaces:**
- Produces: `listInstanceTurns(instanceId, options)` with a bounded limit/cursor result, while explicit recovery paths retain the complete records they require.

- [ ] **Step 1: Add migration and query-plan tests**

Open both a fresh database and a pre-index fixture, then assert the three indexes exist idempotently. Use `EXPLAIN QUERY PLAN` with representative rows and assert observable turns, instance events, and instance history use their intended indexes.

- [ ] **Step 2: Add history pagination tests**

Insert more records than one page, request pages using `(createdAt, id)` cursor ordering, and assert no duplicates or gaps when timestamps match. Assert list/detail card callers do not load large result/error/text columns unless required.

- [ ] **Step 3: Add indexes and cursor API**

Apply the exact additive indexes in the design spec. Return an explicit page shape such as:

```ts
interface InstanceTurnPage {
  items: InstanceTurn[];
  nextCursor: { createdAt: string; id: string } | null;
}
```

Use a strict maximum page size and stable `(created_at, id)` predicates. Update callers deliberately instead of preserving an unbounded default.

- [ ] **Step 4: Make startup recovery deduplication linear**

Preserve ordered arrays but maintain companion `Set<string>` membership indexes during quarantine recovery. Keep all current changes inside the existing `BEGIN IMMEDIATE` transaction.

- [ ] **Step 5: Verify and commit**

Run focused store and workflow tests, `npm run typecheck`, `npm run build`, and `npm test`.

Commit: `perf: index and bound instance history queries`

---

### Task 9: Deduplicate dependency-outage logging

**Files:**
- Modify: `src/runtime/herdr-socket-subscriber.ts`
- Modify: `src/coordinator/instance-turn-supervisor.ts`
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Test: corresponding subscriber, turn-supervisor, and reconciler tests

**Interfaces:**
- Produces: first-failure, periodic-summary, and recovery records with stable identifiers and bounded representative ID lists.

- [ ] **Step 1: Add log-count and recovery tests**

Simulate repeated identical failures and assert one warning plus bounded summaries, then one recovery record. For a failed workspace, assert one workspace-level warning rather than one warning per binding.

- [ ] **Step 2: Implement transition-aware failure state**

Track normalized failure key, first failure time, repeat count, and last summary time. Keep durable degradation transitions unchanged; change only emitted diagnostic volume.

- [ ] **Step 3: Verify and commit**

Run focused tests, `npm run typecheck`, and `npm run build`.

Commit: `perf: deduplicate Herdr outage logs`

---

### Task 10: Repair lifecycle configuration and remove proven dead paths

**Files:**
- Modify: `plugin/setup.sh`
- Modify: `plugin/configure-projects.sh`
- Modify: `src/cli/plugin-lifecycle.ts`
- Modify: `src/coordinator/binding-provisioning-workflow.ts`
- Modify: `src/domain/commands.ts` only if reset syntax needs clarification
- Modify: confirmed unused imports/exports reported by `tsc --noUnusedLocals --noUnusedParameters`
- Test: `tests/plugin-lifecycle.test.ts`
- Test: `tests/commands.test.ts`
- Test: relevant provisioning integration tests

**Interfaces:**
- Produces: fresh plugin config from `projects.example.json`, fail-closed safe restart, validation matching the rendered unit environment, and a truthful `/swarm reset <title>` contract.

- [ ] **Step 1: Add fresh-config and fail-closed tests**

Assert missing private config copies `config/projects.example.json`. Assert an active unit with unreachable, mismatched, or incomplete `/status` blocks restart unless `--force` is present. Assert caller-only environment values cannot make validation differ from the installed unit.

- [ ] **Step 2: Fix plugin initialization and restart safety**

Change both scripts to the checked-in example path. Make `assertRestartSafe` throw on unknown safety state for an active unit. Build validation input from the environment file plus only values explicitly rendered into the unit.

- [ ] **Step 3: Honor reset titles and delete only proven dead code**

Apply the requested reset title through the existing title normalization/uniqueness path. Remove uncalled `createRoot`, the unnecessary pane lookup, and imports/exports confirmed unused by repository search and TypeScript unused checks. Do not combine unrelated structural refactors.

- [ ] **Step 4: Verify and commit**

Run focused lifecycle, command, and provisioning tests followed by:

```bash
npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
npm run typecheck
npm run build
npm test
```

Commit: `fix: harden service lifecycle configuration`

---

### Task 11: Trim deploy artifacts without reducing diagnostics

**Files:**
- Modify: `tsconfig.json` or create a production-specific `tsconfig.build.json`
- Modify: `package.json`
- Modify: `install.sh`
- Modify: `plugin/build.sh`
- Modify: service/unit generation if source maps are retained
- Test: installation/build tests located with `rg -l "npm ci|npm prune|sourceMap|declaration" tests scripts`

**Interfaces:**
- Produces: a reproducible build with no unused declarations and either enabled production source-map consumption or no emitted maps; deployed dependencies exclude dev-only packages.

- [ ] **Step 1: Record artifact and dependency baselines**

Capture byte/file counts for `.js`, `.d.ts`, `.js.map`, total `node_modules`, and production dependencies. Add script-level assertions for the chosen production build/install behavior.

- [ ] **Step 2: Separate development and production build concerns**

Disable declaration emission for the private daemon. Choose one explicit source-map policy: retain maps and start Node with `--enable-source-maps`, or disable maps. Prefer retaining mapped production stacks unless measured install constraints justify removal.

- [ ] **Step 3: Prune only after compilation**

Keep locked full installation before `tsc`, then run `npm prune --omit=dev` only in the deployed artifact/tree. Do not make the source checkout unusable for subsequent test runs; if necessary, stage into a deployment directory rather than pruning the developer checkout.

- [ ] **Step 4: Verify and commit**

Run installation tests, `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`. Re-measure artifacts and confirm the compiled service starts in a temporary configured environment.

Commit: `build: trim production service artifacts`

---

### Task 12: Deploy and verify one batch at a time

**Files:**
- No source changes expected.
- Preserve: `/home/your-user/.config/herdr-agent-swarm/projects.json` and `/home/your-user/.local/state/herdr-agent-swarm/bridge.db`.

**Interfaces:**
- Consumes: verified commits from Tasks 1-11.
- Produces: one healthy `herdr-agent-swarm.service`; legacy services remain stopped and disabled.

- [ ] **Step 1: Inspect durable and runtime state before restart**

Use the supported status surface and `/status` to confirm no active/uncertain work, no outbox backlog, and no unresolved card convergence. Do not copy SQLite without WAL/SHM companions.

- [ ] **Step 2: Restart only the standalone service**

Use the standalone lifecycle action or `systemctl --user restart herdr-agent-swarm.service`. Do not start `herdr-agent-swarm-multiproject.service` or `herdr-lark-bridge.service`.

- [ ] **Step 3: Verify readiness and live behavior**

Confirm `/health`, `/ready`, and `/status`; inspect bounded recent logs. Run one Feishu smoke turn that produces answer text and tool activity, verify Main and Answer Cards update through terminal state, and confirm the Herdr pane exists without requiring or opening the Herdr TUI.

- [ ] **Step 4: Record final evidence**

Report exact test counts, build exit status, service state, readiness state, outbox depth, card convergence failures, and the commits deployed.
