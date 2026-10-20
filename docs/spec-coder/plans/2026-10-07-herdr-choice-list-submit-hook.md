# Herdr Choice List Submit-Time Activation Implementation Plan

Specification:
`docs/spec-coder/specs/2026-10-07-herdr-choice-list-submit-hook.md`

Workspace preparation:

- Planning workspace: safe in-place checkout at
  `/workspace/herdr-agent-swarm`.
- Branch: `main`.
- Wave base: `ab92bb05a028d6623f7f68d7dd3d49489fb71e1b`.
- Isolation decision: implementation should use one isolated worktree rooted at
  this exact local wave base. The native Host creator defaults to
  `origin/main`, which predates the Completion Choice implementation, so wave
  formation must select an exact-base-safe mechanism rather than silently
  dropping the 31 local commits.
- Initial user-owned changes remain excluded: modified
  `docs/spec-coder/plans/2026-10-07-core-event-card-realtime.md` and
  `docs/spec-coder/specs/2026-10-07-core-event-card-realtime.md`; untracked
  `.tmp-build/`, `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Dependencies: existing locked dependencies; no installation or dependency
  mutation required.
- Fresh baseline: `npm run typecheck` passed; `npm run build` passed with
  build identity
  `sha256:b28eae2990a1bff3e486f82d8579d4ee3adcf8e80c987093a5634f8d12b3dc2b`;
  `npm test` passed 286 files and 4,075 tests.
- Gate 1 design approval: approved 2026-10-07.
- Gate 2 specification approval: approved 2026-10-07.
- Gate 3 implementation authorization: pending.

## Tickets

- [ ] **T1: Produce dynamic Completion Choices in the original TraeX turn**

  | Field | Plan |
  | --- | --- |
  | What to build | Deliver the complete executable path in which an eligible `UserPromptSubmit` activates `herdr-choice-list` inline, the Agent dynamically derives a version-2 decision from its actual completed answer, and Stop validates or requests at most one protocol-only repair. Advance the owned plugin to 1.1.0 and preserve a verified rollback to 1.0.0. |
  | Spec references | SCN-1 through SCN-5; INV-1 through INV-8; Plugin adapter, Runtime Hook module, Skill contract, Behavior & Failure Modes, and Compatibility & Migration. |
  | Dependencies | None. |
  | Delegation eligibility | Eligible for one direct worker: requirements and file ownership are bounded, no credential or live-service action is needed, and focused unit/integration seams exist. Complexity class is strong because Hook protocol, privacy, release activation, compensation, and rollback must remain coherent. |
  | Delegation mode | Default direct worker using the inherited main model unless a compatible trusted strong route is available at wave formation. Main retains design interpretation, Red acceptance, diff acceptance, verification, staging, and commit authority. |
  | Ownership and implementation path | Deepen the existing Trace-End Human Review producer integration. Extend the runtime Hook interface with submit handling while retaining Stop behavior; use the existing `CompletionChoiceEligibilityPort`; route both events through one bounded plugin/CLI adapter; update the Skill for explicit inline and repair modes; update owned-plugin lifecycle validation for current 1.1.0 and recorded prior 1.0.0. Domain protocol parsing, persistence, action sets, cards, callbacks, notifications, and outbox remain unchanged. |
  | Mutation ownership | `plugins/herdr-choice-list/.codex-plugin/plugin.json`; `plugins/herdr-choice-list/hooks/hooks.json`; the plugin wrapper under `plugins/herdr-choice-list/scripts/`; `plugins/herdr-choice-list/skills/herdr-choice-list/SKILL.md` and its metadata only if required; `src/runtime/completion-choice-hook.ts`; the corresponding CLI helper under `src/cli/`; `src/cli/service-lifecycle/owned-traex-choice-plugin.ts`; focused tests in `tests/completion-choice-hook.test.ts`, `tests/completion-choice-plugin-wrapper.test.ts`, `tests/owned-traex-choice-plugin.test.ts`, `tests/service-lifecycle.test.ts`, `tests/standalone-install.test.ts`, and `tests/package-release.test.ts` only as required. File renames inside this owned set are allowed when the old path is removed in the same ticket. |
  | Exclusions | No changes to `src/domain/completion-choice.ts`, SQLite schema/store, coordinators, CardKit renderers, callback payloads, notification obligations, outbox semantics, project configuration, live plugin installation, or service lifecycle execution. Do not touch initial user-owned files. |
  | Isolation | Mutating direct worker in a real isolated worktree at wave base `ab92bb05a028d6623f7f68d7dd3d49489fb71e1b`. Do not create it from `origin/main`. Main records and retains the actual path, branch, mechanism, and recovery handle when Wave 1 forms. |
  | Concurrency conflicts | T1 owns all executable plugin/runtime/lifecycle paths and cannot run concurrently with T2 because the documentation must describe the accepted implementation and version behavior. No other planned ticket may mutate T1 files. |
  | Verification seam | Red-Green at `handleCompletionChoiceUserPromptSubmit`, the documented Hook wrapper stdin/stdout boundary, plugin manifest discovery, and owned-plugin activation/rollback. Separate source review verifies no Hook payload types flow into domain/coordinator/store/card modules and prompt text is absent from gateway requests and output. |
  | Host capacity | Requires one direct-child slot. Recheck live capacity immediately before Wave 1; no parallel mutation is planned. |
  | Direct-child boundary | Every worker brief states `delegation_allowed = false`; the worker must not delegate directly or indirectly, stage, commit, install the live plugin, restart the service, or deploy. |
  | Acceptance criteria and verification | An eligible Submit returns constant inline activation; distinct final-answer fixtures preserve distinct dynamically Agent-declared choices; `none` and valid Human Review decisions pass first Stop; missing/invalid decisions receive exactly one repair; repeated Stop is unconditional allow; malformed/oversized/ineligible/socket-failure paths fail open; prompt/answer text never crosses the eligibility socket or Hook logs; plugin 1.1.0 clean install, 1.0.0 upgrade, failed activation compensation, and 1.0.0 rollback are covered. Run focused Hook, wrapper, owned-plugin, lifecycle, standalone-install, and release-package tests, then `npm run architecture:check`, `npm run typecheck`, and `npm run build`. |
  | Blocked by | None. |

- [ ] **T2: Publish the dual-Hook operating contract in repository docs**

  | Field | Plan |
  | --- | --- |
  | What to build | Update current architecture and Feishu usage documentation so maintainers and users understand submit-time Skill activation, dynamic Agent-owned choices, Stop-only repair, fail-open behavior, and unchanged durable notification ordering. Do not expose internal protocol JSON as user-visible card content. |
  | Spec references | SCN-1 through SCN-5; INV-3 through INV-8; Architecture, Behavior & Failure Modes, Compatibility & Migration, and Out of Scope. |
  | Dependencies | T1, because documentation must match the accepted executable paths and final plugin version. |
  | Delegation eligibility | Eligible for one direct worker after T1 is committed: source and approved specification provide bounded evidence, changes are reversible, and documentation audit is independently inspectable. Complexity class is standard. |
  | Delegation mode | Default serialized direct worker. Main retains source-to-doc claim review, diff acceptance, verification, staging, and commit authority. |
  | Ownership and implementation path | Revise only the current Trace-end Human Review sections of `docs/architecture.md` and `docs/feishu-group-usage.md`. Describe the user-observable contract and authoritative ownership without duplicating implementation internals or editing historical specifications. |
  | Mutation ownership | `docs/architecture.md` and `docs/feishu-group-usage.md` in the isolated implementation workspace. Main alone updates this plan checkbox. |
  | Exclusions | No source, test, historical spec/plan, archived document, generated artifact, service configuration, install, restart, deploy, or push changes. Do not copy or repair the unrelated untracked research document from the original checkout. |
  | Isolation | Reuse the accepted isolated implementation worktree after T1 commit. Serialized execution; no second concurrent worktree is required. |
  | Concurrency conflicts | Must follow T1 and cannot overlap changes to the same architecture or usage sections. No parallel wave with T1. |
  | Verification seam | Review every changed claim against the accepted T1 source and specification; run `npm run docs:audit`, `git diff --check`, and the documentation-focused tests. |
  | Host capacity | Requires one direct-child slot after Wave 1 settles. Recheck live capacity before Wave 2. |
  | Direct-child boundary | Every worker brief states `delegation_allowed = false`; the worker must not delegate directly or indirectly, stage, commit, install, restart, deploy, or push. |
  | Acceptance criteria and verification | Docs state that UserPromptSubmit only activates the Skill, business choices are dynamically Agent-derived, Stop performs one bounded repair, Hook failure is fail-open, and final notification remains gated by Core final persistence and Answer delivery. Documentation audit and focused docs tests pass in the isolated workspace. |
  | Blocked by | T1. |

## Proposed Execution Waves

1. **Wave 1:** T1 as one isolated direct-worker task.
2. **Wave 2:** T2 as one serialized direct-worker task after T1 is accepted,
   verified, checked off, and committed.
3. **Delivery:** main runs findings-first review, routes any repair through the
   owning ticket, then runs `npm run architecture:check`, `npm run typecheck`,
   `npm run build`, and full `npm test` before the final delivery claim.

No parallel mutation is proposed. Live Host capacity and the exact isolated
workspace recovery handle are intentionally re-evaluated at each wave rather
than persisted as stale runtime state.
