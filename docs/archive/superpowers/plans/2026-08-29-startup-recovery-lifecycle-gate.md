# Startup Recovery Lifecycle Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent plugin start and restart actions from reporting success before the matching bridge build completes startup recovery.

**Architecture:** Replace lifecycle polling of the liveness-only `/health` endpoint with a narrow parser over `/status`. Require active systemd state, exact service/build identity, and completed startup recovery for two consecutive samples, while retaining `/ready` as post-success diagnostic output only.

**Tech Stack:** TypeScript, Node.js HTTP/systemd integration, Vitest, npm

**Spec:** `docs/superpowers/specs/2026-08-29-startup-recovery-lifecycle-gate-design.md`

## Global Constraints

- Do not gate lifecycle success on Lark/Herdr readiness.
- Do not weaken exact service/build identity verification.
- Do not change systemd unit or `--force` semantics.
- Do not expose raw `/status` content or configuration in timeout errors.
- Require two consecutive completed-startup observations.

---

### Task 1: Reproduce premature lifecycle success

**Files:**
- Modify: `tests/plugin-lifecycle.test.ts`

**Interfaces:**
- Consumes: `runPluginLifecycle("start" | "restart", environment)`.
- Produces: HTTP fixture responses that independently model `/status` and `/ready`.

- [x] **Step 1: Add a failing test for incomplete startup recovery**

Create a fixture server where `/health` is matching and healthy but `/status` reports matching identity with `startupRecovery.state = "running"`. Use a short lifecycle timeout and assert rejection includes `startup running`.

- [x] **Step 2: Run the focused test and observe failure**

Run: `npx vitest run tests/plugin-lifecycle.test.ts -t "does not accept liveness before startup recovery completes"`

Expected: FAIL because current code polls `/health` and returns success.

### Task 2: Implement and cover the startup-completion gate

**Files:**
- Modify: `src/cli/plugin-lifecycle.ts`
- Modify: `tests/plugin-lifecycle.test.ts`

**Interfaces:**
- Consumes: `/status` response with top-level `status`, nested `identity`, and nested `startupRecovery.state`.
- Produces: bounded `{ status, serviceId, buildId, startupRecoveryState }` observation used only by lifecycle polling.

- [x] **Step 1: Parse bounded startup status**

Replace `probeHealthIdentity()` with a `/status` probe that accepts only string fields and never retains the raw response. Return unavailable values for malformed or missing fields.

- [x] **Step 2: Strengthen the consecutive-success predicate**

Require systemd active, top-level `ok`, exact service ID, exact expected build ID, and startup state `completed`. Reset the counter on every other sample. Include final observed build and startup state in timeout errors.

- [x] **Step 3: Add behavior matrix tests**

Cover `idle`, `running`, and `failed` startup states; counter reset after an intervening incomplete observation; two completed observations; `not_ready` after completed startup; stale build; inactive unit; and timeout diagnostic fields. Update existing success fixtures to serve completed `/status` plus their intended `/ready` response.

- [x] **Step 4: Run focused lifecycle tests**

Run: `npx vitest run tests/plugin-lifecycle.test.ts`

Expected: all lifecycle tests PASS.

### Task 3: Verify, commit, and deploy

**Files:**
- Verify: lifecycle source, tests, spec, and this plan

**Interfaces:**
- Consumes: repository verification commands and supported plugin lifecycle actions.
- Produces: independently reviewable commit and live normal-restart evidence.

- [x] **Step 1: Run repository verification**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Run: `git diff --check`

- [x] **Step 2: Audit exact spec coverage**

Confirm `/health` is no longer the lifecycle gate, startup completion and identity are required in one `/status` sample, two consecutive samples remain required, readiness remains diagnostic, error fields are bounded, and restart guard/systemd unit are unchanged.

- [x] **Step 3: Commit the implementation**

```bash
git add src/cli/plugin-lifecycle.ts tests/plugin-lifecycle.test.ts docs/superpowers/plans/2026-08-29-startup-recovery-lifecycle-gate.md
git commit -m "fix: gate service startup on recovery"
```

- [x] **Step 4: Build the committed identity and perform a normal restart**

Rebuild after commit, confirm zero active work through `/status`, then invoke the supported normal plugin restart without `--force`. Verify it returns only after the expected build reports completed startup recovery.

- [x] **Step 5: Verify stable runtime**

After another health cycle, confirm systemd is active with no unexpected restarts, `/ready` is ready or explicitly reports only an external dependency degradation, live identity matches the commit, and durable running/queued/outbox counts remain zero.

**Execution evidence:** Implementation commit `79f272d`; 93 test files and
1019 tests passed; a normal guarded restart returned only after
`startupRecovery.state=completed`; the deployed unit then reported `NRestarts=0`,
`ready`, and the matching build identity.
