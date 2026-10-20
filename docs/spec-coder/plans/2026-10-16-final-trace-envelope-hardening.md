# Final Trace Envelope Hardening Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-16-final-trace-envelope-hardening.md`.
Authoritative workspace:
`<repo-root>/.trae/worktrees/final-trace-envelope`
on branch `worktree-final-trace-envelope`. Recorded wave base and starting
revision: `4fea992667be7314fff6615877f5b50aed2c1053`.

Gate 1 selected the shared semantic Final Trace Envelope and Gate 2 approved
the written specification. The native implement-spec executor owns the
post-Gate-3 dependency frontier. Main alone accepts results, stages, commits,
updates checkboxes, and performs delivery review.

The original `main` checkout and all of its modified/untracked user files are
excluded. The authoritative isolated workspace initially contains only the
untracked approved specification and this plan. No install, restart, deploy,
push, PR, dependency upgrade, SQLite migration, or external publication is
authorized.

The current workspace policy accepts the authoritative worktree and the shared
physical build cache
`<repo-root>/.cache/worktree-final-trace-envelope/target`.
Additional parallel mutation isolation is not currently permitted because the
policy-selected `.worktrees/` root is not Git-ignored. W2 therefore remains one
durable wave, but the executor must dispatch and integrate at most one mutating
direct worker at a time in the authoritative workspace. No per-worker worktree
creation or serial-to-parallel substitution is pre-authorized.

Fresh baseline records in the specification are reusable for request
`final-trace-envelope-gate3-20261016`: focused `f3287ef2`, typecheck
`e8f58f6b`, build `8e45fd48`, architecture `67822e2c`, and full suite
`34592c2c`. All captured exit code 0. The baseline was 7 focused files / 256
tests, 547 architecture-checked source files, and 308 full-suite files / 5,035
tests. `npm ci` reported seven high-severity audit findings; dependency changes
remain excluded.

## Wave W1: `T1`

### - [x] T1: Introduce the semantic Final Trace Envelope

| Field | Content |
| --- | --- |
| What to build | Add one pure bounded normalizer that classifies answer, requester syntax, Skill invocation, choice protocol, and terminal memory citation, plus an ordered textual choice-evidence fold. Preserve separate projection and presentation copies. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, ARCH-1 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | Bounded reversible domain work with deterministic unit seams and no credentials or external effects. |
| Delegation mode | Default direct worker; serial authoritative-workspace execution. |
| Ownership and implementation path | Final Trace Envelope domain parser owns collective suffix classification and ordered v2/v3 compatibility folding; existing completion-choice validators retain protocol/value validation; requester syntax remains compatibility evidence only. |
| Mutation ownership | src/domain/final-trace-envelope.ts, src/domain/completion-choice.ts, src/domain/final-request-mention.ts, tests/final-trace-envelope.test.ts, tests/completion-choice-protocol.test.ts, tests/final-request-mention.test.ts, tests/architecture-boundaries.test.ts |
| Exclusions | Runtime/store/card consumers, native typed metadata precedence, persistence, notification authority, SQLite schema. |
| Isolation | One direct worker mutates the authoritative isolated workspace at recorded base `4fea9926`; no concurrent mutating worker. |
| Concurrency conflicts | None |
| Verification seam | Run `validate-affected.py` for every owned source/test path, focused envelope/choice/mention/architecture tests, typecheck, and diff checks; Red must prove citation-following-choice and review-to-none behavior are absent before implementation. |
| Host capacity | One direct-child slot required; recompute before dispatch. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; no indirect delegation, staging, commit, install, restart, push, or plan edits. |
| Acceptance criteria and verification | Full answer -> mention -> invocation -> choice -> citation normalizes deterministically; citation after choice and choice without adjacent invocation validate; arbitrary trailing prose remains nonterminal; projection retains citation while presentation hides exactly one valid terminal citation; malformed/fenced metadata remains visible as specified; fold accepts only v2/v3, latest valid none clears review, v1/truncated/invalid evidence has no authority; normalization is idempotent and architecture direction remains valid. |
| Verification commands | `npx vitest run tests/final-trace-envelope.test.ts tests/completion-choice-protocol.test.ts tests/final-request-mention.test.ts tests/architecture-boundaries.test.ts --reporter=dot --maxWorkers=2 --testTimeout=30000`; `npm run typecheck`; `git diff --cached --check` |
| Verification results | Main observed initial Red for citation-following choice and later explicit none. Independent task review found lossless-citation line-ending gaps; two bounded fix rounds added exact CRLF and bare-CR envelope coverage. Fresh accepted Green passed 4 files / 168 tests, TypeScript typecheck, and staged diff checks. Spec and quality review ended with all findings addressed and no new Critical/Important breakage. |
| Commits | `23c7e0553bd3290594d3e110d79bfa4369354728` |

## Wave W2: `T2`, `T3`, `T4`

W2 tickets are dependency-ready only after T1 is accepted and committed. Their
declared paths and semantics are disjoint, but current isolation policy permits
only serial mutation in the authoritative workspace. The native executor keeps
their approved membership/order and dispatches one direct worker at a time.

### - [x] T2: Align the version-3 producer and envelope consumers

| Field | Content |
| --- | --- |
| What to build | Make the shipped Skill, OpenAI prompt, Stop Hook, live event projection, Answer stream, and Answer Timeline consume one version-3 envelope contract so citation/order metadata cannot trigger repair or leak into presentation. Update architecture documentation. |
| Spec references | SCN-1, SCN-4, INV-1, INV-2, INV-4, INV-5, INV-6, ARCH-1 |
| Dependencies | T1 |
| Blocked by | T1 |
| Delegation eligibility | Bounded cross-layer migration over an approved pure interface with inspectable contract and rendering tests. |
| Delegation mode | Default direct worker; serial authoritative-workspace execution. |
| Ownership and implementation path | Plugin producer emits canonical v3; Stop Hook validates envelope choice; runtime projector uses projection Markdown; completed cards/streams use presentation Markdown; docs record the same compatibility boundary. |
| Mutation ownership | plugins/herdr-choice-list/skills/herdr-choice-list/SKILL.md, plugins/herdr-choice-list/skills/herdr-choice-list/agents/openai.yaml, src/runtime/completion-choice-hook.ts, src/runtime/herdr-events/event-projector.ts, src/runtime/answer-stream.ts, src/cards/answer-timeline.ts, tests/completion-choice-hook.test.ts, tests/herdr-event-projector.test.ts, tests/answer-stream.test.ts, tests/answer-timeline-page.test.ts, docs/architecture.md |
| Exclusions | SQLite recovery, Segment precedence, native typed metadata representation, durable action lifecycle, deployment. |
| Isolation | One direct worker after accepted T1, using the authoritative workspace; no concurrent T3/T4 mutation. |
| Concurrency conflicts | None |
| Verification seam | Run `validate-affected.py` for every owned path, producer/Hook contract tests, projector/stream/timeline rendering tests, typecheck, architecture check, and diff checks. |
| Host capacity | One direct-child slot; W2 batch is serialized by isolation policy. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; no indirect delegation, staging, commit, install, restart, push, or plan edits. |
| Acceptance criteria and verification | Skill and OpenAI metadata emit compact canonical v3 with real submitText; valid v3 passes first Stop even with terminal citation; v2 remains read-compatible but not producer output; live projection/presentation removes transport consistently without mutating raw evidence; malformed/mid-body/fenced citations retain existing visibility and arbitrary trailing prose does not activate a choice. |
| Verification commands | `npx vitest run tests/final-trace-envelope.test.ts tests/completion-choice-hook.test.ts tests/herdr-event-projector.test.ts tests/answer-stream.test.ts tests/answer-timeline-page.test.ts --reporter=dot --maxWorkers=2 --testTimeout=30000`; `npm run typecheck`; `npm run architecture:check`; `git diff --cached --check` |
| Verification results | Main observed Red when Stop rejected valid v3 followed by a terminal citation. Independent review found non-final event projection still chained legacy cleanup; Fix Round 1 moved every assistant-visible channel to shared `projectionMarkdown` while leaving choice authority on commentary/final only. Fresh accepted Green passed 5 files / 130 tests, typecheck, 548-file architecture check, and staged diff check; scoped re-review approved with no new breakage. |
| Commits | `6f684c60d76ff1b59c1dba57a3671fa3658ea94a` |

### - [x] T3: Make Segment choice precedence follow latest explicit intent

| Field | Content |
| --- | --- |
| What to build | Replace backward commentary search with canonical lane-ordered compatibility folding so a later explicit none cancels an older review and a later review may replace none; remove stale Markdown mention evidence while retaining trusted actor authorization. |
| Spec references | SCN-2, SCN-4, INV-2, INV-3, INV-4, INV-6, ARCH-1 |
| Dependencies | T1 |
| Blocked by | T1 |
| Delegation eligibility | Transaction-local store repair with deterministic temporary-SQLite tests and no external effect. |
| Delegation mode | Default direct worker; serial authoritative-workspace execution. |
| Ownership and implementation path | Conversation Segment store supplies canonical lane-ordered text evidence to the domain fold; typed native choice and trusted Submission Intent actor remain the durable authorities. |
| Mutation ownership | src/store/sqlite/conversation-segment-store.ts, tests/conversation-segment-store.test.ts |
| Exclusions | Prompt detached recovery, CardKit rendering, notification recipient policy, schema migration. |
| Isolation | One direct worker after accepted T1, using the authoritative workspace; no concurrent T2/T4 mutation. |
| Concurrency conflicts | None |
| Verification seam | Run `validate-affected.py` for both owned paths, focused Segment store tests with deliberately conflicting timestamps/lane order, typecheck, and diff checks. |
| Host capacity | One direct-child slot; W2 batch is serialized by isolation policy. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; no indirect delegation, staging, commit, install, restart, push, or plan edits. |
| Acceptance criteria and verification | review -> later none yields no action; none -> later review selects the later review; canonical lane order wins over timestamp order; valid native final choice remains authoritative; malformed native metadata fails closed; embedded mention/OpenID never supplies recipient authority; stale markerRequested data is removed. |
| Verification commands | `npx vitest run tests/conversation-segment-store.test.ts --reporter=dot --maxWorkers=1 --testTimeout=30000`; `npm run typecheck`; `git diff --cached --check` |
| Verification results | Main established the inherited review-then-none Red, then accepted 106/106 focused tests. Independent review found that a JSON text scalar containing a serialized valid native object was reparsed instead of failing closed. Fix Round 1 added a focused Red, restricted native validation to SQLite JSON objects, and renamed the stale marker-oriented local predicate. Fresh accepted Green passed 107/107, typecheck, staged diff check, and scoped re-review. |
| Commits | `5dfaf4b4e531d0da45906bceb10146e497c124cb` |

### - [x] T4: Recover detached commentary choices in canonical lane order

| Field | Content |
| --- | --- |
| What to build | Make both Herdr-origin projected repair and bridge-origin detached recovery reconstruct textual v2/v3 choice evidence from all ordered messages when native final metadata is absent, preserving exact answer settlement and fail-closed native handling. |
| Spec references | SCN-3, INV-1, INV-2, INV-3, INV-5, INV-6, ARCH-1 |
| Dependencies | T1 |
| Blocked by | T1 |
| Delegation eligibility | Bounded recovery-path change with exact Core fixtures, temporary SQLite, and independently inspectable lifecycle output. |
| Delegation mode | Default direct worker; serial authoritative-workspace execution. |
| Ownership and implementation path | Prompt dispatch and prompt recovery stores join Core lane items, preserve lane sequence, validate native final metadata separately, and invoke the shared text fold only when native metadata is absent. |
| Mutation ownership | src/store/sqlite/prompt-dispatch-store.ts, src/store/sqlite/prompt-recovery-store.ts, tests/external-turn-observer.test.ts, tests/detached-core-recovery.integration.test.ts |
| Exclusions | Live event projection, Submission retry, prompt resubmission, schema migration, completion action/outbox lifecycle. |
| Isolation | One direct worker after accepted T1, using the authoritative workspace; no concurrent T2/T3 mutation. |
| Concurrency conflicts | None |
| Verification seam | Run `validate-affected.py` for every owned path, Herdr-origin and bridge-origin detached recovery tests, typecheck, and diff checks. |
| Host capacity | One direct-child slot; W2 batch is serialized by isolation policy. |
| Build cache | <repo-root>/.cache/worktree-final-trace-envelope/target |
| Direct-child boundary | delegation_allowed = false; no indirect delegation, staging, commit, install, restart, push, or plan edits. |
| Acceptance criteria and verification | Commentary v3 plus untyped final recovers the same visible answer and choice in both detached paths; later explicit none clears the recovered review; lane sequence wins over occurred_at/event_id; typed native final choice stays authoritative; present malformed native metadata cannot fall back; v1, truncated, invalid, duplicate, or oversized text evidence cannot create or clear an action; no prompt is resubmitted. |
| Verification commands | `npx vitest run tests/external-turn-observer.test.ts tests/detached-core-recovery.integration.test.ts --reporter=dot --maxWorkers=1 --testTimeout=30000`; `npm run typecheck`; `git diff --cached --check` |
| Verification results | Main established the Herdr-origin commentary-v3 Red. Both recovery stores now anchor exact source/session/turn/lane evidence, use lane sequence, keep native object authority, and fold text only when metadata is absent. Independent review found asymmetric proof and non-isolated oversized/cross-lane fixtures; Fix Round 1 added symmetric Herdr coverage, a complete >8 KiB protocol, and direct cross-lane ambiguity regressions. Fresh accepted Green passed 2 files / 63 tests, typecheck, staged diff check, and scoped re-review. |
| Commits | `01ccc1ac499f11bc10f863fc7a2880e29bb8628d` |

## Final delivery checks

After every ticket is independently accepted, freshly verified, atomically
committed, and checked off, main invokes `delivery-coder` for separate Standards
and Spec review axes, repairs findings through TDD, and runs:

```text
npx vitest run tests/final-trace-envelope.test.ts tests/completion-choice-hook.test.ts tests/completion-choice-protocol.test.ts tests/final-request-mention.test.ts tests/herdr-event-projector.test.ts tests/answer-stream.test.ts tests/answer-timeline-page.test.ts tests/conversation-segment-store.test.ts tests/external-turn-observer.test.ts tests/detached-core-recovery.integration.test.ts --reporter=dot --maxWorkers=2 --testTimeout=30000
npm run typecheck
npm run build
npm run architecture:check
npx vitest run --reporter=dot --maxWorkers=2 --testTimeout=30000
git diff --check
```

Run the delivery artifact checker against this specification and plan. Keep
workflow artifact changes in the isolated branch. Do not install, restart,
deploy, push, create a PR, mutate the original checkout, or upgrade dependencies.
