# Tool Call Card Information Hierarchy Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification: `docs/spec-coder/specs/2026-10-23-tool-call-card-hierarchy.md`.
Authoritative workspace: `./.worktrees/feat/tool-call-card-hierarchy`.
Branch: `feat/tool-call-card-hierarchy`; recorded wave base:
`bb3b3d397d05f095e1f8f481c72dc49e7cbe93a9`. This is an isolated Git
worktree created to preserve unrelated untracked main-worktree content. Native
implement-spec executor runs one approved wave at a time. Integration remains
main-owned; no push, installation, restart, or production mutation is allowed.

Prepared baseline: `npm ci` completed; `npm run typecheck` passed; focused Tool
Timeline suite passed 5 files / 155 tests. The specification records the
observed baseline records `7b674f6228174ee8bee72dabadad9e75` and
`1f4328fec4434d10b474825e7d93b457`.

## Wave W1: `T1`

### - [x] T1: Persist semantic Tool Call presentation fields

| Field | Content |
| --- | --- |
| What to build | Extend the Tool Timeline domain contract and activity projector with optional action, target, and structured resultSummary values; project them through TraeX transcript and Herdr event paths, including explicit timeout classification without text guessing. |
| Spec references | SCN-1, SCN-2, SCN-4, INV-1, INV-2, INV-3, INV-5, ARCH-1 |
| Dependencies | None |
| Blocked by | None |
| Delegation eligibility | A bounded source-to-domain translation slice with focused pure/projector seams and no external effects. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | `AnswerTimelineItem` owns durable optional semantics; `tool-activity-projector` owns extraction and outcome classification; transcript/event projectors translate only those values into canonical timeline deltas. |
| Mutation ownership | src/domain/answer-timeline.ts, src/runtime/tool-activity-projector.ts, src/runtime/traex-transcript-projector.ts, src/runtime/herdr-events/event-projector.ts, tests/tool-activity-projector.test.ts, tests/traex-transcript-projector.test.ts, tests/herdr-events-reader.test.ts |
| Exclusions | CardKit rendering policy, timeline page layout, SQLite schema migration, Core cursor handling, and frozen page mutation. |
| Isolation | Serial W1 in the authoritative isolated worktree at the recorded wave base; main verifies ownership and base before dispatch. |
| Concurrency conflicts | None |
| Verification seam | Table-driven projector classification plus canonical TraeX/Herdr event delta assertions; structural typecheck proves all producers satisfy the expanded domain contract. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | ./.cache/feat/tool-call-card-hierarchy/target |
| Direct-child boundary | delegation_allowed = false; main supplies the common implementation brief, retains staging/commit authority, and requires heartbeat evidence. |
| Acceptance criteria and verification | Recognized Tool Calls persist action and target; structured success, failure, and timeout results persist bounded redacted summaries with the correct outcome; free text alone cannot classify a timeout; legacy fields remain present; focused projector/event suites and `npm run typecheck` pass. |
| Verification commands | `npx vitest run tests/tool-activity-projector.test.ts tests/traex-transcript-projector.test.ts tests/herdr-events-reader.test.ts`; `npm run typecheck`; `git diff --check` |
| Verification results | 3 files / 111 tests passed; typecheck passed; diff whitespace check passed; observed by main. |
| Commits | `4f305965` |

## Wave W2: `T2`

### - [x] T2: Render compact semantic Tool Call cards

| Field | Content |
| --- | --- |
| What to build | Make Answer Tool render ports and timeline CardKit rendering consume semantic action, target, and resultSummary fields; render running/success calls as compact rows and automatically expand failures/timeouts and failed aggregate groups. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-4, INV-5, ARCH-1 |
| Dependencies | T1 |
| Blocked by | T1 |
| Delegation eligibility | A bounded CardKit presentation slice with pure renderer and SQLite reload seams; no provider delivery or lifecycle effect is invoked. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Answer Tool render ports define compatibility fallback and render model; Answer Timeline renderer owns compact-row versus expanded-panel policy; existing SQLite timeline JSON loading proves restart compatibility. |
| Mutation ownership | src/cards/answer-tool-render-ports.ts, src/cards/answer-timeline.ts, tests/answer-tool-render-ports.test.ts, tests/answer-timeline-card.test.ts, tests/answer-timeline-page.test.ts, tests/conversation-segment-store.test.ts, tests/traex-transcript.test.ts, tests/herdr-events-reader.test.ts |
| Exclusions | Tool event parsing, Core event order, outbox delivery, card interaction controls, historical-row backfill, and frozen Answer page rewrites. |
| Isolation | Serial W2 follows accepted T1 in the same authoritative isolated worktree; no parallel mutation is allowed because it consumes T1's domain contract. |
| Concurrency conflicts | T1 |
| Verification seam | Render-port and page tests inspect CardKit shape/content for compact success/running rows and expanded failure/timeout groups; SQLite store reload verifies old and new item JSON render without mutation. |
| Host capacity | One direct-child slot; recheck before dispatch. |
| Build cache | ./.cache/feat/tool-call-card-hierarchy/target |
| Direct-child boundary | delegation_allowed = false; main supplies the common implementation brief, retains staging/commit authority, and requires heartbeat evidence. |
| Acceptance criteria and verification | Semantic fields take precedence over legacy label/command display; legacy JSON falls back deterministically; successful output stays absent from default cards and expanded groups omit successful sibling result bodies; failed items expand even without a resultSummary; failure/timeout panels render an independent bounded redacted Summary before command/result/diff; a timeout group is orange and expands, otherwise any failed group is red and expands; frozen pages are not rewritten when later semantic items arrive; focused, full-suite, typecheck, build, and diff checks pass. |
| Verification commands | `npx vitest run tests/conversation-segment-store.test.ts tests/answer-tool-render-ports.test.ts tests/answer-timeline-card.test.ts tests/answer-timeline-page.test.ts tests/traex-transcript.test.ts tests/herdr-events-reader.test.ts`; `npm test`; `npm run typecheck`; `npm run build`; `git diff --check` |
| Verification results | Initial renderer evidence was 4 files / 213 tests passed, but Delivery Review found P1/P2 gaps and a fresh full suite produced 5 failing stale/insufficient assertions. Repair evidence: 6 files / 331 tests passed; typecheck, build, and diff whitespace check passed; observed by main. Full-suite delivery verification remains pending. |
| Commits | `6f42e6b5`, `b93ee451` |

## Final delivery checks

Main reviews both accepted tickets, records one atomic commit per ticket, runs
fresh affected verification and the full applicable suite, checks specification
and plan artifacts, inspects the final range, and invokes delivery-coder before
claiming completion.
