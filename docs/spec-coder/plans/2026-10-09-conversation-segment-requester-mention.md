# Conversation Segment Requester Mention Plan

Specification:
[Conversation Segment Requester Mentions](../specs/2026-10-09-conversation-segment-requester-mention.md)

## Workspace, ownership, and baseline

- Workspace: `/tmp/herdr-agent-swarm-segment-requester-mention`.
- Mode: isolated Git worktree, selected because the original main checkout has
  unrelated modified and untracked user files.
- Branch and starting revision: `fix/conversation-segment-requester-mention`
  at `146c6077ffbf7196f2b9c2da8a5c52698916df47`.
- The Host-native worktree under `.trae/worktrees/` was preserved after its
  read-only filesystem prevented TypeScript cache writes. The `/tmp` fallback
  is task-owned and writable.
- Dependencies: `npm ci` completed from the lockfile. Its audit reported seven
  existing high-severity findings; dependency remediation is excluded.
- Fresh baseline: `npm test` passed 287 files and 4,137 tests at the same
  starting revision; `npm run typecheck`, `npm run architecture:check`, and
  `npm run build` passed after the writable worktree was prepared.
- Gate 1 selected the unified Segment/Submission Intent design. Gate 2 approved
  the specification on 2026-10-09. Gate 3 was approved on 2026-10-09.
- The plan does not authorize installation, service restart, production data
  mutation, deployment, push, pull-request creation, or historical notification
  backfill.

## Tickets

- [x] **T1: Notify the exact requester for every successful Primary Segment**

  | Field | Plan |
  | --- | --- |
  | What to build | Deliver a complete choice-free success path: resolve the immutable Feishu actor from the Segment's Submission Intent, persist one Segment-owned Completion Notice at successful terminal projection, render that trusted actor in the final Turn Card, and reserve one standalone completion mention only after acknowledgement of that exact card revision. A later Turn must not cancel this notice. |
  | Spec references | SCN-2, SCN-3, SCN-5 notice behavior, SCN-6; INV-1 through INV-3 and INV-6; Domain Model, Architecture, Behavior & Failure Modes, Compatibility & Migration. |
  | Dependencies | None. |
  | Delegation eligibility | Eligible: bounded repository-owned TypeScript/SQLite/CardKit behavior with temporary-database and fake-delivery seams; no live credential or production operation is needed. |
  | Delegation mode | Serialized direct worker by default. The ticket owns the foundational schema and Segment completion interface, so no other mutating ticket may overlap. |
  | Ownership and implementation path | Agent Input owns immutable actor provenance; Conversation Projection atomically records successful Segment completion; Completion Interaction owns the independent notice; Delivery and Operations releases it after the exact final-card ACK. The Segment store hides joins and state transitions behind one completion render/release interface. CardKit receives only a trusted render DTO. |
  | Mutation ownership | `src/domain/completion-action-set.ts` or a focused completion-presentation domain type; `src/domain/ports/conversation-segment.ts`; completion choice/notification schema and SQLite migration code; `src/store/sqlite/conversation-segment-store.ts`; `src/store/sqlite/completion-notification-store.ts`; `src/store/sqlite/outbox-delivery-store.ts`; `src/coordinator/turn-card-workflow.ts`; `src/cards/turn-card.ts` and narrowly required composition wiring; focused eligibility-independent Segment/card/outbox tests. |
  | Exclusions | No Human Review button/callback behavior yet; no hook eligibility change; no raw Markdown passthrough; no fixed Binding-creator fallback; no historical notification backfill; no production operation. |
  | Isolation | One direct worker operates in the task-owned `/tmp` worktree. No parallel mutation. Wave base is the recorded starting revision plus approved planning artifacts. |
  | Concurrency conflicts | T2 depends on T1's owner and notice contract and overlaps Segment, completion, migration, and card files; they cannot share a wave. |
  | Verification seam | First add failing temporary-SQLite and Turn Card workflow tests proving submission-actor attribution, inline trusted mention, absence of buttons, ACK-gated standalone notification, duplicate/restart idempotency, newer-Turn preservation, and missing/invalid actor rejection. Then run affected Segment/card/outbox/migration tests, architecture check, typecheck, build, and `git diff --check`. |
  | Host capacity | Requires one direct worker slot when execution begins; if capacity is unavailable, wait and recompute rather than overlap local mutation. |
  | Direct-child boundary | `delegation_allowed = false`; the worker must not spawn directly or indirectly, stage, commit, deploy, touch live SQLite/configuration, or modify files outside the ticket's ownership. Main owns Red acceptance, diff review, verification, staging, and commit. |
  | Acceptance criteria and verification | A successful submission-backed Primary Segment persists one actor-owned notice; its final card has a trusted CardKit mention and no fabricated buttons; no standalone message exists before ACK; one deterministic completion text mention exists after ACK; duplicate delivery/restart and later Turn admission do not duplicate or cancel it; invalid/missing actor, direct-Herdr, failed, and cancelled paths create no mention effect; existing Prompt/Worker rows remain valid after migration and reopen. |
  | Blocked by | None. |

  Suggested atomic commit: `feat(segments): notify each completed request actor`

- [x] **T2: Render and consume trusted Human Review choices on Primary Segments**

  | Field | Plan |
  | --- | --- |
  | What to build | Extend Primary choice-list eligibility beyond legacy PromptJobs to exact active attached Pane/session identity, persist a valid canonical Core `completion_choice` under its submission-backed Segment, render ordered business buttons plus Ignore on the final card, and route a valid selection through normal Agent Input exactly once. Supersede stale actions on a newer Turn without suppressing T1's completion notice. |
  | Spec references | SCN-1, SCN-3 through SCN-6; INV-1, INV-2, and INV-4 through INV-6; Architecture, Behavior & Failure Modes, Compatibility & Migration. |
  | Dependencies | T1 supplies Segment completion ownership, trusted actor resolution, independent notice persistence, and ACK release. |
  | Delegation eligibility | Eligible after T1: bounded runtime/coordinator/store integration with existing fake Pane/Core/Lark and temporary-SQLite seams; no external operation is required. |
  | Delegation mode | Serialized direct worker after T1 is accepted and committed. Shared completion/Segment files prohibit parallel mutation. |
  | Ownership and implementation path | Runtime eligibility may grant only choice-protocol context for an exact active Primary Pane/session. Conversation Projection owns canonical choice association. Completion Interaction owns immutable specification, Action Set, actor/card/generation fences, consumption, Ignore, and supersession. Card interaction coordinates the stored choice with the existing Agent Input interface; CardKit only renders supplied state. |
  | Mutation ownership | `src/runtime/completion-choice-eligibility.ts` and its port/store query; completion owner/choice/action schema and stores; `src/coordinator/binding-prompt-workflow.ts` or the canonical Segment projection seam; `src/coordinator/turn-card-workflow.ts`; card-action routing and interaction workflow; composition wiring; focused hook/eligibility, Segment, card, callback, migration, and delivery tests. Existing `acd6d20e` and `b8a98ba0` may be consulted but not cherry-picked wholesale. |
  | Exclusions | No prose/list parsing; no synthetic PromptJob; no anonymous, first-click-wins, or Binding-creator authorization; no native tool approval or direct terminal input; no broad historical repair; no Worker behavior change except compatibility preservation. |
  | Isolation | One direct worker operates serially in the same task-owned `/tmp` worktree after T1. Wave base is T1's accepted commit. |
  | Concurrency conflicts | Cannot overlap T1 or any change to the same completion/Segment/callback modules. No parallel wave is permitted. |
  | Verification seam | Add failing eligibility tests for a Primary without PromptJob and stale/ambiguous/runtime mismatch rejection; canonical Segment integration tests for valid/invalid choice; rendered ordered buttons and mention; callback success, duplicate, Ignore, wrong actor/card/generation; and the Turn-B supersession interleaving that preserves Turn-A notice. Run affected hook/eligibility/observer/Segment/card/interaction/outbox/migration suites, architecture check, typecheck, build, and `git diff --check`. |
  | Host capacity | Requires one direct worker slot after T1. If unavailable, wait and recompute; do not mutate concurrently in the shared worktree. |
  | Direct-child boundary | `delegation_allowed = false`; the worker must not spawn directly or indirectly, stage, commit, deploy, touch live SQLite/configuration, or modify outside ticket ownership. Main owns Red acceptance, integration judgment, verification, staging, and commit. |
  | Acceptance criteria and verification | A valid choice-bearing Feishu Segment produces one immutable specification and one current Action Set; the final card contains trusted actor mention, question, ordered buttons, and Ignore; selecting a valid option creates exactly one same-binding normal Agent Input; duplicates return the prior result; Ignore creates no input; wrong/stale callbacks fail closed; a later Turn removes old actions while the older completion notice remains once-deliverable; missing actor or invalid choice preserves the answer without actions. |
  | Blocked by | T1. |

  Suggested atomic commit: `feat(segments): support requester-owned completion choices`

## Dependency and execution waves

```text
Wave 1: T1 requester-owned completion mention
              |
              v
Wave 2: T2 requester-owned Human Review actions
```

Each wave contains one serialized direct worker because both tickets share the
same persistence and Segment seams. Before dispatch, main rechecks live Host
capacity, the exact wave base, Git cleanliness, and ticket ownership. The
worker returns an unstaged diff and verification evidence; main independently
checks Red-Green evidence, accepts the diff, updates the checkbox, stages only
ticket-owned paths, and creates the atomic commit.

## Coverage check

| Requirement | Responsible ticket(s) |
| --- | --- |
| SCN-1 | T2 |
| SCN-2 | T1 |
| SCN-3 | T1, T2 |
| SCN-4 | T2 |
| SCN-5 | T1 notice behavior, T2 action supersession |
| SCN-6 | T1, T2 |
| INV-1 through INV-3 | T1, T2 |
| INV-4 and INV-5 | T2 |
| INV-6 | T1, T2 |

Every approved scenario and invariant has a responsible ticket. T2's only
blocking edge is T1's persisted Segment completion/notice contract. No
load-bearing decision remains open, and both tickets expose behavior through
existing production-shaped workflow/store seams.

## Final delivery checks

After both ticket commits:

1. review the complete `146c6077..HEAD` diff against the approved specification,
   architecture boundaries, security rules, and existing Prompt/Worker
   compatibility;
2. run focused completion hook/eligibility, Conversation Segment, Turn Card,
   card interaction, outbox/delivery, and SQLite migration tests;
3. run `npm test`, `npm run typecheck`, `npm run architecture:check`, `npm run
   build`, and `git diff --check` freshly;
4. perform independent findings-first Standards and Specification reviews and
   route material repairs through the owning ticket;
5. inspect task commits and commit messages. Do not install, restart, deploy,
   push, open a PR, or mutate live data without separate authorization.
