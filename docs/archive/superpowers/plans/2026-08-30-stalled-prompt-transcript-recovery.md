# Stalled Prompt Transcript Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and publish TraeX answers when Herdr reports `agent_prompt_stalled` after the prompt was actually submitted.

**Architecture:** Before a possibly-dispatched failure becomes detached, `PromptRunWorkflow` performs one bounded final transcript drain through the existing exact-turn ownership gate. If the drain claims a fresh turn, its durable identity allows the existing detached observer to complete it without replay. Existing live backlog is recovered separately by auditing each session for one exact post-dispatch turn and writing only that identity while the service is stopped.

**Tech Stack:** TypeScript, Node.js ESM, SQLite, Vitest, TraeX JSONL transcripts, Herdr runtime observation

**Spec:** `docs/superpowers/specs/2026-08-30-stalled-prompt-transcript-recovery-design.md`

## Global Constraints

- Never replay a prompt after it may have reached TraeX.
- Never publish transcript output before exact `turnId` and `startedAt` ownership is persisted.
- Do not weaken first-claim eligibility for already detached prompts in normal runtime code.
- Preserve unrelated modifications in the standalone cutover plan and `TODO.md`.
- Do not restart or mutate the live database until active instance work and outbound delivery are safe.

---

### Task 1: Capture transcript identity on stalled dispatch

**Files:**
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Test: `tests/concurrency-controls.integration.test.ts`

**Interfaces:**
- Consumes: `readTypedDelta`, `ownTranscriptObservation`, `retainOwnedObservation`, `publishTypedObservation`, and `PromptRunStore.claimPromptTranscriptTurn`.
- Produces: a private bounded handoff helper used only after `runPrompt` may have dispatched and before `markPromptObservationDetached`.

- [ ] **Step 1: Write the failing stalled-dispatch regression test**

Create a fake transcript cursor whose first attached read returns no turn and whose post-error read returns a completed fresh turn. Make fake `runPrompt` call `onDispatched` and then throw `agent_prompt_stalled` without invoking `onObservation`. Assert that the prompt is submitted once, gains the exact transcript identity, completes through detached observation, and stores the authoritative answer.

- [ ] **Step 2: Run the focused test and observe the exact failure**

Run `npx vitest run tests/concurrency-controls.integration.test.ts -t "recovers a dispatched turn when Herdr reports stalled"`. Expected before implementation: the prompt remains detached with null transcript identity and an empty answer.

- [ ] **Step 3: Implement the bounded pre-detach drain**

Add a private helper that performs at most `FINAL_TRANSCRIPT_DRAIN_LIMIT` reads from the already-open cursor. For each non-empty observation, pass it through `ownTranscriptObservation`; only retain and publish owned output. Stop on a repeated/empty observation or after observing completion. Call the helper in the `dispatched` catch branch before `markPromptObservationDetached`. Transcript read failures must keep the existing detached-without-replay behavior.

- [ ] **Step 4: Add the negative ownership test**

Use a completed transcript lifecycle whose `startedAt` predates the persisted dispatch tolerance. Assert the prompt remains detached without identity, no transcript answer is published, and `runPrompt` was called once.

- [ ] **Step 5: Run focused verification**

Run `npx vitest run tests/concurrency-controls.integration.test.ts tests/traex-transcript.test.ts tests/sqlite-store.test.ts`. Expected: all tests pass.

- [ ] **Step 6: Commit the implementation**

Stage only the workflow and focused test, then commit as `fix: recover transcript after stalled prompt`.

---

### Task 2: Verify the repository change

**Files:**
- Verify: `src/coordinator/prompt-run-workflow.ts`
- Verify: `tests/concurrency-controls.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 implementation.
- Produces: a build suitable for immutable service installation.

- [ ] **Step 1: Run static and build checks**

Run `npm run typecheck`, `npm run build`, and `git diff --check`. All must exit zero.

- [ ] **Step 2: Run the full workflow/persistence suite**

Run `npm test`. Any failure blocks deployment.

- [ ] **Step 3: Confirm repository state**

Verify the implementation commit exists and the only remaining worktree changes are the user's pre-existing standalone cutover plan and `TODO.md`.

---

### Task 3: Deploy and recover the live backlog without replay

**Files:**
- Runtime database: `/home/feiyu.zhu/.local/state/herdr-agent-swarm/bridge.db` plus WAL/SHM companions
- Runtime service: `herdr-agent-swarm.service`

**Interfaces:**
- Consumes: verified immutable build and the three detached prompt/session pairs identified during diagnosis.
- Produces: completed Answer Cards for uniquely matched turns and resumed FIFO processing.

- [ ] **Step 1: Audit the safety gate and exact transcript matches**

Read `/status` and require zero active instance turns, zero uncertain instance turns, and zero active outbound deliveries. For every detached prompt without identity, use its binding session and `dispatchedAt` to identify exactly one `task_started` at or after dispatch and its matching `task_complete`. Abort recovery for any ambiguous prompt.

- [ ] **Step 2: Install the verified immutable release**

Run `./install.sh`. Confirm the installed unit points to the new build identity.

- [ ] **Step 3: Stop and snapshot the live database coherently**

Stop only `herdr-agent-swarm.service`, confirm it is inactive, then copy the database together with WAL/SHM companions to a timestamped recovery directory. Do not alter the independent multiproject service.

- [ ] **Step 4: Persist audited identities transactionally**

Within one SQLite transaction, update only the audited prompt IDs where `state='running'`, `observation_state='detached'`, and both transcript identity columns remain null. Set exact `transcript_turn_id`, `transcript_turn_started_at`, and `updated_at`; verify the affected-row count equals the audited count. Never modify prompt bodies, dispatch timestamps, run cards, or outbox rows.

- [ ] **Step 5: Restart and observe convergence**

Start the service and wait for `detached-turn-completed` for each recovered prompt. Confirm each run card has a non-empty answer, matching delivered versions, no pending outbox work, and queued prompts resume FIFO without duplicate dispatch of recovered prompt IDs.

- [ ] **Step 6: Verify live health**

Require `/health` and `/ready` to succeed, SQLite quick check to remain healthy, lease ownership to be valid, and Lark delivery failures/dead letters not to increase. Report any prompt that could not be uniquely recovered.
