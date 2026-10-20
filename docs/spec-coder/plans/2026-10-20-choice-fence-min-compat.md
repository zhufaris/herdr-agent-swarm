<!-- spec-coder:artifact-v1 plan -->

# Minimal Compatible Choice Fence Plan

Specification:
[`2026-10-20-choice-fence-min-compat.md`](../specs/2026-10-20-choice-fence-min-compat.md)

## Workspace and authority

- Executor: native spec-coder implement-spec executor; one `tdd-coder`
  lifecycle for T1, followed by `delivery-coder`.
- Specification: `docs/spec-coder/specs/2026-10-20-choice-fence-min-compat.md`;
  Gate 2 approved by the user in the current request.
- Authoritative workspace: `<repo-root>/.trae/worktrees/fix-ring-delivery-recovery` on branch `fix/ring-delivery-recovery`.
- Recorded wave base: `d73277fe84ad850b6390875275b994eefa69d3a`.
- Initial task-owned changes before implementation: the approved
  specification and this plan only; no other worktree changes were present.
- Baseline: focused choice/projector suites passed 110 tests with capture
  `d916dee990fe4215b3c2563ab04cb20d`; typecheck passed with capture
  `f8f16713b695434ab4bae147c459b50f`; build passed with capture
  `ee469b12d333450fb2908c04581dfbfa`.
- Build cache: `<repo-root>/.cache/fix/ring-delivery-recovery/target`.
- Isolation requirement: serial main-local mutation in this existing isolated
  authoritative worktree; no parallel mutation or additional worktree.
- Integration authority: Main alone accepts TDD evidence, stages task-owned
  paths, creates the atomic local commit, and advances the checkbox.
- Durable waves: W1=`T1`; only this singleton wave may execute.
- Excluded authority: no JSONL rewrite, Core schema change, SQLite mutation,
  installation, restart, deployment, push, PR, or live Feishu action.

## Wave W1: T1

### - [x] T1: Lock the single-fence compatibility boundary

| Field | Content |
| --- | --- |
| What to build | Add a regression fixture matching `msg_62370`: ordinary JSON examples in one typed assistant `output_text` plus one terminal `herdr-choice-list` fence; assert only the terminal fence is considered. Strengthen Skill and Hook guidance to prohibit additional choice-shaped JSON examples and preserve exactly one terminal fence. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-2, INV-3 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded producer-guidance and regression-coverage slice with existing parser/projector seams; no credentials, external effects, schema changes, or production data. |
| Delegation mode | main-local |
| Ownership and implementation path | Existing dedicated-fence parser and `HerdrEventProjector.captureCompletionChoice`; do not add generic JSON extraction. Skill/Hook own producer guidance; domain/projector tests own the observed mixed-message contract. |
| Mutation ownership | plugins/herdr-choice-list/skills/herdr-choice-list/SKILL.md, src/runtime/completion-choice-hook.ts, tests/completion-choice-protocol.test.ts, tests/final-trace-envelope.test.ts, tests/herdr-event-projector.test.ts, tests/completion-choice-hook.test.ts |
| Exclusions | Core JSONL, Core event schema, SQLite, CardKit renderer, native metadata model, deployment files, production state. |
| Isolation | Serial main-local mutation in the authoritative worktree at the recorded wave base. |
| Concurrency conflicts | None |
| Verification seam | `inspectTraceEndReviewProtocol`, `normalizeFinalTraceEnvelope`, `HerdrEventProjector` native/protocol precedence, and Skill/Hook contract tests. |
| Host capacity | No child slot required; Main performs the singleton ticket lifecycle. |
| Build cache | <repo-root>/.cache/fix/ring-delivery-recovery/target |
| Direct-child boundary | delegation_allowed = false; no installation, restart, deployment, push, production SQLite access, or JSONL mutation. |
| Acceptance criteria and verification | Mixed ordinary examples plus terminal none yields no choice; mixed examples plus terminal nested v3 yields that choice; native metadata wins; duplicate/nested/non-terminal/malformed fences remain fail-closed; Skill/Hook state the single-fence rule. Run focused choice/projector tests, `npm run typecheck`, `npm run build`, `npm run architecture:check`, `git diff --check`, then full `npm test` and delivery review. |
| Verification commands | ./node_modules/.bin/vitest run tests/completion-choice-protocol.test.ts tests/final-trace-envelope.test.ts tests/herdr-event-projector.test.ts tests/completion-choice-hook.test.ts, npm run typecheck, npm run build, npm run architecture:check, git diff --check, npm test |
| Verification results | Red: the two new producer-contract assertions failed while the existing parser/projector tests remained green. Green: focused choice/projector/Hook suites passed 143/143; `npm run typecheck`, `npm run build`, `npm run architecture:check` (553 source files), `git diff --check`, and full `npm test` (316 files / 5296 tests) passed. |
| Commits | `4fcbc65f76da1baa95c2802ca40aa7020e93332e` |

## Execution Waves

1. W1 contains only T1 and is serial.
2. After T1, run delivery review and fresh full verification.

## Gate 3 Boundary

Gate 3, once approved, authorizes only T1 TDD implementation, focused/full
verification, the atomic local commit, and delivery review.  It does not
authorize installation, restart, deployment, JSONL mutation, SQLite mutation,
push, or PR creation.

## Current State

Gate 1 design selected by the user: minimal compatible dedicated fence.
Gate 2 specification and Gate 3 implementation authorization were approved by
the user.  T1 implementation and verification are complete in the worktree;
delivery review and the atomic local commit are the remaining handoff steps.
