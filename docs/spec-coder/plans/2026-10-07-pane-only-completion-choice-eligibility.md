# Pane-Only Completion Choice Eligibility Plan

Specification:
[Pane-Only Completion Choice Eligibility](../specs/2026-10-07-pane-only-completion-choice-eligibility.md)

## Workspace, ownership, and baseline

- Workspace: `/workspace/herdr-agent-swarm`.
- Mode: in-place. Tracked files were clean at preflight; the existing untracked
  `.tmp-build/`, `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md` are unrelated user-owned paths and remain excluded.
- Branch and starting revision: `main` at `689ea283`, 52 commits ahead of
  `origin/main`.
- Dependencies were already installed from the repository lockfile.
- Fresh baseline: `npx vitest run --maxWorkers=4` passed 286 files / 4,111
  tests; `npm run typecheck`, `npm run architecture:check`, and
  `npm run build` passed. A prior unrestricted run hit the existing five-second
  timeout in `answer-page-recovery.integration.test.ts`; its focused rerun
  passed 1/1 in 1.58 seconds. `npm run docs:audit` is blocked only by stale
  links in the pre-existing untracked research document named above.
- Gate 1 selected Pane-only server resolution. During T2, implementation
  evidence showed that Choice callbacks and mentions share the same trusted
  actor; reopened Gate 1 approved fail-closed omission of both when that actor
  is unavailable. Revised Gate 2 and Gate 3 are approved; implementation is
  authorized within the revised ticket boundary.
- No push, installation, service restart, production database write, or Ring
  checkpoint work is authorized by this plan.

## Tickets

- [x] **T1: Resolve Completion Choice eligibility from the authoritative Pane**

  | Field | Plan |
  | --- | --- |
  | What to build | Change the Hook request to carry only `paneId`; resolve exactly one current Primary or Worker owner on the Swarm side; validate durable lifecycle, generation, parent and active-work facts against a fresh Herdr Pane/workspace/Agent-session observation; retain bounded fail-open Hook behavior and boolean-only socket responses. |
  | Spec references | SCN-1 through SCN-4 and SCN-6; INV-1 through INV-5 and INV-7; Architecture and Behavior & Failure Modes. |
  | Dependencies | None. |
  | Delegation eligibility | Eligible: grounded existing interfaces, bounded reversible TypeScript change, no production credential or external mutation, independently inspectable focused tests. |
  | Delegation mode | Default direct worker, serialized in the shared checkout. |
  | Ownership and implementation path | Agent Runtime integration owns eligibility. The domain port exposes only Pane identity; the Hook and socket adapter translate untrusted input; `CompletionChoiceEligibility` owns unique-owner and durable/live validation; the existing SQLite Binding/Instance capability supplies bounded lookup without exposing rows to the Hook. Preserve current timeout, socket mode, active-work, session and fail-open semantics. |
  | Mutation ownership | `src/domain/ports/completion-choice-eligibility.ts`, `src/runtime/completion-choice-hook.ts`, `src/runtime/completion-choice-eligibility.ts`, `src/runtime/completion-choice-eligibility-gateway.ts`, the minimum existing SQLite capability wiring required for unique Pane lookup, and focused `completion-choice-*` tests. The worker returns a complete unstaged diff and evidence; main inspects, stages, and commits. |
  | Exclusions | No Core protocol changes, no card renderer changes, no generic Pane authorization service, no unbound-Pane eligibility, no deployment, and no Ring files. |
  | Isolation | Serialized direct worker in the selected in-place workspace. It must account for the specification/plan edits already owned by main and may not mutate either artifact; main owns checkbox updates after accepting verification. |
  | Concurrency conflicts | Cannot overlap T2 because both affect the eligibility integration fixtures and T2's end-to-end acceptance depends on this request contract. |
  | Verification seam | Red Hook test proving only `paneId` is sent; policy tests for Primary/Worker resolution and all rejection cases; socket integration test proving legacy fields cannot influence owner resolution; `git diff --check`, focused tests, typecheck, architecture check, and build. |
  | Host capacity | One direct-child slot is sufficient; recompute live capacity before dispatch. |
  | Direct-child boundary | `delegation_allowed = false`; the child must not spawn directly or indirectly, stage, commit, deploy, or alter unrelated files. |
  | Acceptance criteria and verification | A current attached Primary and Worker are eligible with only `HERDR_ENV=1` and `HERDR_PANE_ID`; the request contains no Bridge owner/generation/project; stale, absent, ambiguous, non-TraeX, wrong-workspace, session-mismatch and inactive-work candidates return false; malformed/socket-timeout paths remain fail-open; old extra fields are ignored; all focused and affected checks pass. |
  | Blocked by | None. |

  Suggested atomic commit: `fix(choice): resolve eligibility by pane`

- [x] **T2: Preserve a trustworthy mention owner for attached Panes**

  | Field | Plan |
  | --- | --- |
  | What to build | When `/swarm attach` creates or reuses an active Binding whose review owner is empty, conditionally adopt the authenticated Feishu actor under exact Binding generation and Pane fences. Preserve the existing Prompt/Worker actor-first action authorization and mention selection. Prove that a Pane-only eligible completion with a trusted actor produces one Choice-bearing card followed by one correctly addressed mention, while absence of a trusted actor preserves the Answer but creates neither optional surface. |
  | Spec references | SCN-1, SCN-3, SCN-5 and SCN-6; INV-3, INV-4, INV-6 and INV-7; Architecture, Compatibility & Migration, and Testing Decisions. |
  | Dependencies | T1, because the integration scenario must exercise the Pane-only Hook eligibility path. |
  | Delegation eligibility | Eligible after T1: bounded reversible workflow/store change with deterministic in-memory SQLite and fake Gateway/Herdr seams; no live credentials or production mutation. |
  | Delegation mode | Default direct worker, serialized after T1. |
  | Ownership and implementation path | Binding attachment owns adoption because it has the authenticated Feishu actor. SQLite enforces one set-if-empty conditional transition using exact Binding generation and Pane identity. Completion projection continues to choose the owning Feishu Prompt/Turn actor first and the Binding owner only as fallback. The same actor authorizes callbacks and receives the mention; without one, both are omitted. Delivery ordering remains card checkpoint before mention. |
  | Mutation ownership | Binding attachment workflow/store and their ports, attach integration tests, and the narrow Primary/Worker Completion Choice integration tests required to prove card-plus-mention behavior. The worker returns an unstaged diff and evidence; main inspects, stages, and commits. |
  | Exclusions | No historical owner backfill, no overwrite of a non-null owner, no owner inference from Lark card contents, no anonymous/group-wide/first-click-wins Choice authorization, no broad binding migration, no deployment/restart, and no Ring files. |
  | Isolation | Serialized direct worker in the authoritative in-place workspace after T1 commits. |
  | Concurrency conflicts | Must not overlap T1; shares eligibility/Choice integration behavior and consumes its finalized contract. |
  | Verification seam | Red store/integration tests for set-if-empty ownership, stale generation/Pane refusal, duplicate attach, actor precedence, Choice-bearing completion and post-card-checkpoint mention; focused suites plus typecheck, architecture check and build. |
  | Host capacity | One direct-child slot is sufficient; recompute live capacity after T1 acceptance. |
  | Direct-child boundary | `delegation_allowed = false`; the child must not spawn directly or indirectly, stage, commit, deploy, or alter unrelated files. |
  | Acceptance criteria and verification | Initial attach records the actor only when owner is empty; an idempotent attach preserves it; a later different actor cannot replace it; stale fences make no change; a Feishu-origin work actor wins over fallback; valid Pane-only final Choice with a trusted actor creates one card action set and exactly one mention after delivery; missing trusted actor preserves the Answer but creates neither action set nor mention; restart/duplicate delivery does not duplicate actions or mention. |
  | Blocked by | T1. |

  Suggested atomic commit: `fix(review): preserve attached pane choice ownership`

## Dependency and execution waves

```text
Wave 1: T1 Pane-only eligibility
              |
              v
Wave 2: T2 attach owner + end-to-end mention
```

Both tickets are delegation-eligible but intentionally serialized in the
shared checkout. Before each wave, main rechecks Host capacity, Git ownership,
and the authoritative base. Each worker receives `delegation_allowed = false`
and cannot stage or commit. Main owns Red/Green acceptance, plan checkbox
updates, explicit path staging, atomic commits, review aggregation, and the
completion claim.

## Coverage check

| Requirement | Ticket |
| --- | --- |
| SCN-1 | T1, T2 |
| SCN-2 | T1 |
| SCN-3 | T1, T2 |
| SCN-4 | T1 |
| SCN-5 | T2 |
| SCN-6 | T1, T2 |
| INV-1 through INV-5 | T1 |
| INV-6 | T2 |
| INV-7 | T1, T2 |

No requirement is uncovered and there is no dependency cycle.

## Final delivery checks

After T1 and T2 are committed:

1. run independent Standards and Specification review passes;
2. route material findings back through the owning ticket's Red-Green repair;
3. run focused Hook, eligibility, socket, attach and Choice/mention integration
   suites;
4. run `npm run typecheck`, `npm run architecture:check`, `npm run build`,
   `git diff --check`, and `npx vitest run --maxWorkers=4`;
5. inspect every task commit and remove any automated co-author trailer before
   any future push;
6. report installation and restart as pending separate authorization.
