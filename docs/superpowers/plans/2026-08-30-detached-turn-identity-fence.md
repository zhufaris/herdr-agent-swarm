# Detached Turn Identity Fence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist exact TraeX turn ownership for each dispatched ordinary prompt so detached recovery cannot consume or complete from a later manual turn in the same Herdr pane.

**Architecture:** SQLite records the dispatch checkpoint and one immutable transcript turn identity. The transcript cursor emits turn-scoped observations without combining adjacent turns, and `PromptRunWorkflow` passes every attached or detached observation through a shared ownership gate before publishing card output or accepting completion. Existing detached rows without durable identity remain uncertain and fail closed.

**Tech Stack:** TypeScript, Node.js ESM, better-sqlite3, Zod, Vitest, TraeX JSONL transcripts, Herdr runtime observation

**Spec:** `docs/superpowers/specs/2026-08-30-detached-turn-identity-fence-design.md`

## Global Constraints

- Never replay a prompt after it may have reached TraeX.
- Persist ownership before publishing any Answer/Main Card output for that turn.
- A matching persisted `transcript_turn_id` plus canonical `task_complete` is the only detached completion authority.
- Herdr `idle`, composer readiness, terminal output, Lark state, and timestamp proximity alone cannot complete a detached prompt.
- Existing detached prompts without exact identity remain visible and uncertain; do not silently fail, cancel, migrate, or rewrite them.
- Keep prompt, Run Card, and outbox transitions inside their existing SQLite/event boundaries.
- Do not modify the live SQLite database, cancel live prompts, or use `--force` during implementation.
- Preserve the user's existing modified `docs/superpowers/plans/2026-08-30-standalone-service-cutover.md` and untracked `TODO.md`.

---

### Task 1: Persist dispatch and exact transcript ownership

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-records.ts`
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: the existing `prompt_jobs` lifecycle and `markPromptDispatched(id)` checkpoint.
- Produces: nullable `PromptJob.dispatchedAt`, `PromptJob.transcriptTurnId`, and `PromptJob.transcriptTurnStartedAt`; `TranscriptTurnClaimOutcome`; `claimPromptTranscriptTurn(input)`.

- [ ] **Step 1: Write failing schema, mapper, and ownership tests**

Add focused cases in `tests/sqlite-store.test.ts` that create an ordinary prompt, claim it for dispatch, and assert the three new properties initially map as `null`. Assert `markPromptDispatched` sets `dispatchedAt` while changing the observation state to `attached`. Use the stored timestamp as the admission reference rather than a Run Card timestamp.

Add a table-driven ownership test with this public shape:

```ts
type TranscriptTurnClaimOutcome =
  | { state: "claimed"; prompt: PromptJob }
  | { state: "matched"; prompt: PromptJob }
  | { state: "conflict"; prompt: PromptJob }
  | { state: "ineligible"; prompt: PromptJob | null };

store.claimPromptTranscriptTurn({
  promptId: "p1",
  bindingId: "b1",
  turnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9",
  startedAt: new Date(Date.parse(dispatched.dispatchedAt!) + 250).toISOString()
});
```

Verify: the first eligible claim returns `claimed`; the same values return `matched`; a different turn returns `conflict` and does not replace stored values; a turn more than 1,000 ms before dispatch returns `ineligible`; queued, steering, completed, or already-detached prompts cannot make a first claim. Include a migration fixture created with the pre-change `prompt_jobs` schema and assert all legacy rows receive `null` values without state changes.

- [ ] **Step 2: Run the focused store tests and observe failure**

Run:

```bash
npx vitest run tests/sqlite-store.test.ts
```

Expected: FAIL because `PromptJob` and `prompt_jobs` do not expose durable dispatch/turn provenance and the claim operation does not exist.

- [ ] **Step 3: Add domain and storage contracts**

Extend `PromptJob` and `PromptRow` with exact nullable mappings:

```ts
dispatchedAt: string | null;
transcriptTurnId: string | null;
transcriptTurnStartedAt: string | null;
```

Define and expose:

```ts
export type TranscriptTurnClaimOutcome =
  | { state: "claimed"; prompt: PromptJob }
  | { state: "matched"; prompt: PromptJob }
  | { state: "conflict"; prompt: PromptJob }
  | { state: "ineligible"; prompt: PromptJob | null };

claimPromptTranscriptTurn(input: {
  promptId: string;
  bindingId: string;
  turnId: string;
  startedAt: string;
}): TranscriptTurnClaimOutcome;
```

Keep `markPromptDispatched(id): void`; update its single SQL statement to set `dispatched_at` with the same `now()` value used for `updated_at`. Do not derive it from `run_cards.started_at`.

- [ ] **Step 4: Add the additive migration and atomic compare-and-set**

Add the three nullable columns to the fresh `CREATE TABLE prompt_jobs` definition and a focused idempotent migration helper invoked with the existing prompt migrations:

```sql
ALTER TABLE prompt_jobs ADD COLUMN dispatched_at TEXT;
ALTER TABLE prompt_jobs ADD COLUMN transcript_turn_id TEXT;
ALTER TABLE prompt_jobs ADD COLUMN transcript_turn_started_at TEXT;
```

Update any table-rebuild migration, especially `ensurePromptCancelledState`, to copy these columns when present so a later migration cannot erase provenance. Do not backfill legacy rows.

Implement `claimPromptTranscriptTurn` inside `BEGIN IMMEDIATE`. Parse and validate both timestamps before mutation. The initial claim update must include all lifecycle predicates in its `WHERE` clause:

```sql
UPDATE prompt_jobs
SET transcript_turn_id = ?, transcript_turn_started_at = ?, updated_at = ?
WHERE id = ? AND binding_id = ?
  AND dispatch_kind = 'turn' AND state = 'running'
  AND observation_state = 'attached' AND was_detached = 0
  AND dispatched_at IS NOT NULL AND transcript_turn_id IS NULL
```

Reject a first claim when `Date.parse(startedAt) < Date.parse(dispatchedAt) - 1_000`. After the conditional update, reload inside the transaction. If this invocation changed the row, return `claimed`. Otherwise, exact equality with an already persisted ID returns `matched` even after recovery changed observation state to `detached`; a different persisted ID returns `conflict`; and a missing ID or otherwise ineligible row returns `ineligible`. Never replace an existing ID, and never make a first claim for a detached prompt.

- [ ] **Step 5: Run focused verification**

Run:

```bash
npx vitest run tests/sqlite-store.test.ts
npm run typecheck
git diff --check
```

Expected: all commands exit `0`; the migration test proves existing row state is unchanged and the CAS test proves ownership cannot be replaced.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/domain/types.ts src/domain/ports.ts src/store/sqlite-records.ts src/store/sqlite-store.ts tests/sqlite-store.test.ts
git commit -m "feat: persist prompt transcript ownership" -m "Co-authored-by: TRAE CLI <noreply@trae.ai>"
```

---

### Task 2: Emit turn-scoped transcript observations and fence attached output

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/runtime/traex-transcript.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Test: `tests/traex-transcript.test.ts`
- Test: `tests/concurrency-controls.integration.test.ts`

**Interfaces:**
- Consumes: `claimPromptTranscriptTurn`, persisted prompt provenance, and `TraexTranscriptCursorPort.readObservation()`.
- Produces: turn-scoped `TraexTranscriptObservation.turnId`; a workflow ownership decision that must succeed before `TurnOutputObserved` is published.

- [ ] **Step 1: Write failing transcript-boundary tests**

Extend `tests/traex-transcript.test.ts` with ordered JSONL fixtures that prove one observation cannot mix adjacent turns. For an input containing `task_started(A)`, Answer A, `task_complete(A)`, `task_started(B)`, and Answer B in one file append:

```ts
expect(await cursor.readObservation()).toMatchObject({
  turnId: turnA,
  answerDelta: "Answer A",
  turnLifecycle: { turnId: turnA, state: "completed" }
});
expect(await cursor.readObservation()).toMatchObject({
  turnId: turnB,
  answerDelta: "Answer B",
  turnLifecycle: { turnId: turnB, state: "active" }
});
```

Also assert assistant/tool/status/token records before the next `task_started` are not attributed to a new turn, and a mismatched `task_complete` does not change ownership.

- [ ] **Step 2: Run transcript tests and observe the aggregation failure**

Run:

```bash
npx vitest run tests/traex-transcript.test.ts
```

Expected: FAIL because the cursor currently aggregates the whole readable chunk and reports only its latest lifecycle.

- [ ] **Step 3: Make transcript reads lifecycle-scoped**

Add `turnId?: string` to `TraexTranscriptObservation`. Refactor `FileTraexTranscriptCursor` to retain complete parsed lines that follow a lifecycle boundary for the next call. Each `readObservation()` must return records for at most one turn:

- begin a batch at a valid `task_started`;
- associate subsequent history/status/token records with that active turn;
- include its matching `task_complete`;
- stop before a different `task_started` and leave that record plus following bytes pending; and
- never attach records outside an active turn to a future turn.

Return `turnId` whenever the observation contains lifecycle-scoped output or lifecycle state. Keep redaction, size bounds, item deduplication, plan parsing, token baselines, and malformed-record behavior unchanged. Do not read terminal text.

- [ ] **Step 4: Write failing attached-workflow ownership tests**

In `tests/concurrency-controls.integration.test.ts`, capture `TurnOutputObserved` events and use a fake cursor that first returns an observation without lifecycle ownership, then an active lifecycle for turn A with output, then a conflicting turn B. Assert:

- no output is published before the turn claim;
- turn A becomes persisted before its first event is observed by the bus;
- only turn A output is published;
- turn B output/status/tools do not reach either card projection; and
- the ordinary prompt is submitted to Herdr exactly once.

Add the negative time case: a baseline `task_started` older than `dispatchedAt - 1_000 ms` cannot claim or publish.

- [ ] **Step 5: Run the attached workflow test and observe failure**

Run:

```bash
npx vitest run tests/concurrency-controls.integration.test.ts
```

Expected: FAIL because `publishTypedObservation` currently runs before any durable exact-turn ownership check.

- [ ] **Step 6: Add the shared ownership gate to attached observation**

Introduce one private workflow helper with an explicit result, for example:

```ts
private ownTranscriptObservation(
  binding: Binding,
  prompt: PromptJob,
  observation: TraexTranscriptObservation
): { owned: boolean; prompt: PromptJob; observation: TraexTranscriptObservation }
```

When an active lifecycle is first observed, call `claimPromptTranscriptTurn` before publication. For an attached prompt, accept `claimed` or `matched`; for a detached prompt, accept only `matched` against ownership persisted before detachment. In both cases `observation.turnId` must equal the persisted ID. Treat `conflict` and `ineligible` as unowned and publish nothing from that observation. Reload the prompt after claims so later reads use durable state. Log `transcript-turn-owned` and `transcript-turn-conflict` with IDs only.

Move attached `publishTypedObservation` and final Answer accumulation behind this gate. Store answer chunks only after ownership; do not let `readTypedDelta` append unowned text to its final-answer buffer. When typed output exists but exact ownership is unavailable, finalize attached work with `STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE`, not with baseline or conflicting text. Keep Herdr's settled result as the attached prompt completion trigger.

- [ ] **Step 7: Run focused verification**

Run:

```bash
npx vitest run tests/traex-transcript.test.ts tests/concurrency-controls.integration.test.ts
npm run typecheck
git diff --check
```

Expected: all commands exit `0`; adjacent transcript turns remain separate and attached output is published only after durable ownership.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/domain/ports.ts src/runtime/traex-transcript.ts src/coordinator/prompt-run-workflow.ts tests/traex-transcript.test.ts tests/concurrency-controls.integration.test.ts
git commit -m "fix: fence attached output by turn identity" -m "Co-authored-by: TRAE CLI <noreply@trae.ai>"
```

---

### Task 3: Fail closed during detached recovery and preserve FIFO

**Files:**
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `docs/architecture.md`
- Test: `tests/pane-thread-lifecycle-integration.test.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: persisted `transcriptTurnId`, turn-scoped observations, the shared ownership gate, `recoverRunningPrompts()`, and the existing prompt scheduler.
- Produces: exact-ID detached completion; fail-closed legacy recovery; FIFO wake-up only after owned completion.

- [ ] **Step 1: Write failing detached and FIFO regressions**

Extend `tests/pane-thread-lifecycle-integration.test.ts` with three scenarios.

First, persist turn A before simulating restart, recover the prompt to detached, then emit output/completion for turn A. Assert the prompt completes, the queued prompt dispatches next, and Herdr receives no second submission for turn A.

Second, persist turn A, recover to detached, then emit a complete later manual turn B. Assert the old Run Card's answer, progress, status, version, and `activityAt` do not change; the old prompt remains `running/detached`; the queued prompt remains queued; and no Herdr prompt is submitted.

Third, construct a legacy `running/detached` prompt with `transcriptTurnId === null`, emit new answer and completion records, and assert the same fail-closed behavior. Capture the logger and assert one bounded `detached-turn-identity-missing` diagnostic without prompt body or transcript content.

In `tests/sqlite-store.test.ts`, assert `recoverRunningPrompts()` preserves all three provenance fields for a claimed attached prompt and leaves legacy nulls null.

- [ ] **Step 2: Run detached recovery tests and observe failure**

Run:

```bash
npx vitest run tests/pane-thread-lifecycle-integration.test.ts tests/sqlite-store.test.ts
```

Expected: FAIL because detached recovery currently publishes all typed deltas and accepts any sufficiently late completed lifecycle.

- [ ] **Step 3: Enforce exact identity before detached reads affect state**

At the start of `observeDetachedTurn`, reload the prompt. If `transcriptTurnId` is null, add its ID to a process-local `legacyDetachedWithoutIdentity` set, log `detached-turn-identity-missing` only on the first insertion, leave the row unchanged, and return without reading or publishing transcript output. `scheduleDetachedObserver` skips IDs already in this set, preventing the periodic safety scan from creating a hot observer/log loop. Remove an ID from the set only when durable scan state says it is no longer `running/detached`, or during workflow shutdown. This cache is not workflow authority: restart may emit one new diagnostic, while SQLite remains the source of truth. A detached prompt must never make a first turn claim.

For prompts with an ID, pass every transcript observation through the shared ownership gate. Publish only when `observation.turnId === prompt.transcriptTurnId`. Replace the old `lifecycleBelongsToPrompt` timestamp condition with exact checks:

```ts
const lifecycleCompletesOwnedTurn =
  lifecycle?.state === "completed" &&
  lifecycle.turnId === prompt.transcriptTurnId &&
  lifecycle.startedAt === prompt.transcriptTurnStartedAt;
```

Require the existing `traexProcess` evidence as well. Only then call `completeTurn`, emit `TurnCompleted`, and wake FIFO. A conflict leaves the prompt detached without altering the Run Card. Do not infer completion from Herdr idle.

- [ ] **Step 4: Update architecture authority text**

Update `docs/architecture.md` where it describes detached recovery and transcript lifecycle authority. State that dispatch time admits the first exact turn claim, the prompt row persists immutable `turn_id` ownership, all typed projections are identity-gated, and legacy detached prompts without identity remain uncertain and cannot consume later pane turns. Remove wording that implies the Run Card start window alone is sufficient.

- [ ] **Step 5: Run focused and full verification**

Run, in this order:

```bash
npx vitest run tests/traex-transcript.test.ts tests/sqlite-store.test.ts tests/concurrency-controls.integration.test.ts tests/pane-thread-lifecycle-integration.test.ts tests/steering-integration.test.ts tests/turn-supervisor.test.ts
npm run typecheck
npm run build
npm test
git diff --check
```

Expected: every command exits `0`; the full suite has no skipped or failed tests; the production build regenerates build identity normally without editing `dist/` by hand.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/coordinator/prompt-run-workflow.ts docs/architecture.md tests/pane-thread-lifecycle-integration.test.ts tests/sqlite-store.test.ts
git commit -m "fix: require exact identity for detached turns" -m "Co-authored-by: TRAE CLI <noreply@trae.ai>"
```

---

### Task 4: Prepare deployment without mutating legacy prompts

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: built release, canonical installer, restart safety gate, `/status`, private `swarm:logs`, and read-only SQLite inspection.
- Produces: an evidence-backed operator decision for the two legacy detached prompts, followed by deployment only under separately authorized conditions.

- [ ] **Step 1: Install the verified build without restarting**

Run `./install.sh`, confirm the installed build ID and commit match `HEAD`, and verify the unit still targets the private log path. Installation must not stop or restart the live process.

- [ ] **Step 2: Re-run read-only live diagnosis**

Use `/status`, `herdr agent get` for the exact panes, transcript lifecycle inspection, and `sqlite3 -readonly` against the configured database. Confirm whether the two legacy prompts still have null exact identity, whether queued work remains, and whether any outbox delivery is active. Do not copy the live database without WAL/SHM and do not mutate it.

- [ ] **Step 3: Stop at the operator boundary**

If legacy detached prompts still block restart, report their exact IDs, pane/session evidence, queued dependents, and why the new build intentionally cannot infer ownership. Request explicit direction before any `--force`, cancellation, binding lifecycle transition, or repair migration. A previous force authorization does not carry forward.

- [ ] **Step 4: After explicit authorization, deploy and accept**

Use only the newly authorized operation. Verify the new PID owns the listener, `/ready` is ready in two consecutive samples, build identity matches `HEAD`, SQLite quick check is `ok`, lease is held, no prompt was replayed, private `swarm:logs` contains new non-secret startup records, log permissions remain `0700`/`0600`, and Worker-only/Thread Primary cards behave as specified.
