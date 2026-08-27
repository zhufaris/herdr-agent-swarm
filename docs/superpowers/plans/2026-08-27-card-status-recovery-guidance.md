# Card Status and Recovery Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make individual Feishu CardKit cards show relative freshness, distinguish active output from final results, and give safe Herdr-local recovery guidance for blocked or orphaned work.

**Architecture:** Keep all behavior inside the CardKit presentation boundary. Run cards derive freshness from existing RunCardView.updatedAt; main/topic cards receive an optional render-only lastActivityAt from the Binding already available at their caller. State labels and recovery copy derive only from existing topic/run phases, so no durable model, event, or delivery workflow changes.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, Lark CardKit 2.0.

**Spec:** docs/superpowers/specs/2026-08-27-card-status-recovery-guidance-design.md

## Global Constraints

- Do not change SQLite schema, migrations, reducers, view versions, outbox records, or idempotency keys.
- Do not add a CardKit action/button or any remote TraeX stop, approval, restart, or replay control.
- Keep approval and high-risk recovery local to the Herdr Pane.
- Do not change stream sequence, answer-page source offsets, continuation decisions, or head/tail preview limits.
- Use relative time only; omit invalid or absent main-card activity times.
- Preserve custom diagnostic notices while supplementing blocked/orphaned presentation with safe recovery instructions.

---

## File structure

- Modify src/cards/run-card.ts: add focused relative-time formatting, run freshness/result-state text, optional main-card activity display, and safe recovery callout copy.
- Modify src/coordinator/main-card-workflow.ts: pass Binding.lastActivityAt as render-time input when reserving a main card.
- Modify src/coordinator/herdr-runtime-reconciler.ts: pass the already-loaded binding activity time to durable main-card render calls.
- Modify src/coordinator/prompt-run-workflow.ts, src/coordinator/session-administration-workflow.ts, and src/coordinator/binding-provisioning-workflow.ts: pass activity time only where those paths already own a Binding.
- Modify tests/run-card.test.ts: specify relative-time, active/final wording, compatibility, and safe recovery behavior through public rendering functions.

### Task 1: Specify card-local state metadata and recovery copy

**Files:**
- Modify: src/cards/run-card.ts
- Modify: tests/run-card.test.ts

**Interfaces:**
- Consumes: RunCardView.updatedAt, RunCardView.phase, TopicViewState.phase, and optional render-time activity input { lastActivityAt?: string | null }.
- Produces: compatible optional second arguments for renderRequestRunCard, renderRequestAnswerCard, renderRunCard, and renderProjectEntryCard where needed.

- [ ] **Step 1: Write failing request/answer-card assertions**

In tests/run-card.test.ts import vi, freeze time at 2026-08-27T12:03:00Z, and construct copies of a queued run with phase running or completed and updatedAt values three and one minutes earlier. Assert serialized request and answer cards include the following exact strings:

    最后更新 3 分钟前
    实时更新中
    最终结果

Restore real timers in a finally block or afterEach hook.

- [ ] **Step 2: Run the new test and verify it fails**

Run: npx vitest run tests/run-card.test.ts -t "relative freshness"

Expected: FAIL because existing metadata contains no freshness or active/final wording.

- [ ] **Step 3: Implement minimal card-local metadata helpers**

Add a local relativeTime(value: string | null | undefined): string | null in src/cards/run-card.ts. Return null for absent/unparsable input, clamp future values to 刚刚, and match operations-card thresholds: under 60 seconds 刚刚; under one hour N 分钟前; under one day N 小时前; under one week N 天前; otherwise ISO date.

Add outputStateLabel(phase: RunCardView.phase): string | null that returns 实时更新中 for running, 最终结果 for completed, and null otherwise. Extend conversationalMetadata to append those values after existing state/Pane/duration/page metadata. Do not alter answer content or streaming configuration.

- [ ] **Step 4: Run the new test and verify it passes**

Run: npx vitest run tests/run-card.test.ts -t "relative freshness"

Expected: PASS.

- [ ] **Step 5: Write failing blocked/orphaned recovery assertions**

Extend existing blocked-request and topic-card tests to assert custom diagnostics remain visible and that the serialized card contains all of:

    已保留当前任务
    Herdr Pane
    自动重新同步

Also assert it contains neither 重新发送 nor a CardKit button tag. Cover blocked RunCardView, blocked TopicViewState, and orphaned TopicViewState. Retain failed/error tests to prove they remain failure-oriented.

- [ ] **Step 6: Run recovery tests and verify they fail**

Run: npx vitest run tests/run-card.test.ts -t "safe recovery"

Expected: FAIL because current callouts use generic Herdr-panel text.

- [ ] **Step 7: Implement phase-safe recovery callouts**

In src/cards/run-card.ts add safeRecoveryNotice(diagnostic). It returns the non-empty custom diagnostic followed by two newlines and this exact guidance, or only the guidance when no diagnostic exists:

    桥已保留当前任务并停止自动派发。请前往对应 Herdr Pane 完成审批或检查 TraeX；处理后桥会自动重新同步。

Use this helper only for blocked request/answer cards and blocked/orphaned topic cards. Do not use it for failed/error states and do not add a button.

- [ ] **Step 8: Run the focused card suite**

Run: npx vitest run tests/run-card.test.ts

Expected: PASS, including current previews, stable answer element IDs, streaming configuration, blocked diagnostics, and failed-card coverage.

- [ ] **Step 9: Commit Task 1 if Git metadata is writable**

Run: git add src/cards/run-card.ts tests/run-card.test.ts && git commit -m "feat: clarify lark card status recovery"

Expected: one presentation-only commit. If .git remains read-only, do not stage partial work; record the blocker and retain verified work uncommitted.

### Task 2: Thread optional binding activity time into main-card rendering

**Files:**
- Modify: src/cards/run-card.ts
- Modify: src/coordinator/main-card-workflow.ts
- Modify: src/coordinator/herdr-runtime-reconciler.ts
- Modify: src/coordinator/prompt-run-workflow.ts
- Modify: src/coordinator/session-administration-workflow.ts
- Modify: src/coordinator/binding-provisioning-workflow.ts
- Modify: tests/run-card.test.ts

**Interfaces:**
- Consumes: Binding.lastActivityAt at callers that already hold a Binding.
- Produces: renderProjectEntryCard(view, { lastActivityAt?: string | null }) and renderRunCard(view, { lastActivityAt?: string | null }); original one-argument calls remain valid.

- [ ] **Step 1: Write a failing main-card compatibility test**

Freeze time at 2026-08-27T12:03:00Z. Render a project-entry card with options { lastActivityAt: "2026-08-27T12:00:00Z" } and assert 最后更新 3 分钟前. Render without options and with not-a-date and assert neither includes 最后更新. Assert the TopicViewState object has no updatedAt property.

- [ ] **Step 2: Run the compatibility test and verify it fails**

Run: npx vitest run tests/run-card.test.ts -t "optional main-card relative activity time"

Expected: FAIL because topic render functions currently accept only TopicViewState.

- [ ] **Step 3: Extend renderer inputs without extending TopicViewState**

Add a local TopicCardRenderOptions interface with optional lastActivityAt. Make renderRunCard and renderProjectEntryCard accept options defaulting to an empty object. Add a topicStateLine helper that joins the current icon/label with 最后更新 plus relativeTime(options.lastActivityAt) only when valid. Replace only the final existing state markdown element with topicStateLine. Do not add updatedAt to domain/topic-view.ts.

- [ ] **Step 4: Propagate an already-owned binding timestamp at every main-card caller**

For each renderProjectEntryCard call that already has a Binding named binding, pass { lastActivityAt: binding.lastActivityAt }. Use the same optional object with renderRunCard only where that binding is already available. Do not add a store lookup or alter store method signatures.

Confirm exhaustive source coverage with:

    rg -n -F -e 'renderProjectEntryCard(' -e 'renderRunCard(' src tests

The listed call sites include main-card-workflow, herdr-runtime-reconciler, prompt-run-workflow, session-administration-workflow, and binding-provisioning-workflow. Preserve render calls that lack a Binding by leaving their optional argument absent.

- [ ] **Step 5: Run focused card and TypeScript validation**

Run: npx vitest run tests/run-card.test.ts && npm run typecheck

Expected: PASS. TypeScript confirms every render call is valid under the optional input contract.

- [ ] **Step 6: Commit Task 2 if Git metadata is writable**

Run: git add src/cards/run-card.ts src/coordinator/main-card-workflow.ts src/coordinator/herdr-runtime-reconciler.ts src/coordinator/prompt-run-workflow.ts src/coordinator/session-administration-workflow.ts src/coordinator/binding-provisioning-workflow.ts tests/run-card.test.ts && git commit -m "feat: show lark card freshness"

Expected: one commit limited to render-time timestamp propagation and card coverage. If .git remains read-only, do not stage partial work and report the verified limitation.

### Task 3: Verify rendering boundaries and final evidence

**Files:**
- Modify: docs/architecture.md only if final code creates a durable-facing contract not already described by the current CardKit presentation boundary.
- Test: tests/run-card.test.ts

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: fresh verification that the visual-only change preserves runtime, store, pagination, and full-suite behavior.

- [ ] **Step 1: Inspect final diff for forbidden behavior changes**

Run: git diff -- src/cards/run-card.ts src/coordinator/main-card-workflow.ts src/coordinator/herdr-runtime-reconciler.ts src/coordinator/prompt-run-workflow.ts src/coordinator/session-administration-workflow.ts src/coordinator/binding-provisioning-workflow.ts tests/run-card.test.ts docs/architecture.md

Verify no SQLite schema/store transaction, TopicView persistence, outbox idempotency, answer pagination/offset, or CardKit button change exists.

- [ ] **Step 2: Run required verification**

Run:

    npm run typecheck
    npm run build
    npm test
    git diff --check

Expected: all commands exit 0.

- [ ] **Step 3: Make documentation decision explicitly**

If implementation is only an optional renderer argument and docs already identify cards as presentation-only, do not modify docs. If a new caller-owned display-input seam needs explanation, add one sentence to docs/architecture.md saying that binding activity timestamps are render-time metadata and never TopicView state.

- [ ] **Step 4: Commit documentation only if it changed and Git metadata is writable**

Run: git add docs/architecture.md && git commit -m "docs: clarify card activity metadata"

Expected: create no empty commit. If .git is still read-only, report the blocker rather than retrying.
