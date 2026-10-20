# Atomic Terminal Completion Envelope Plan

<!-- spec-coder:artifact-v1 plan -->

> **Status / decision (2026-10-11): closed without native rollout.**
> The user decided that TraeX source will not be modified, so the native atomic
> completion-envelope proposal is cancelled and is no longer implementation
> authority. T2 and T3 are cancelled and will not execute. Core T1 was completed
> only as an undelivered prototype on an isolated branch; it is excluded from
> delivery and must not be merged, installed, or deployed. The current supported
> authority remains `UserPromptSubmit` plus the bounded one-repair Stop Hook,
> followed by Core fence stripping and canonical `completion_choice` projection
> for Swarm/Feishu consumption. The historical ticket detail below is retained
> for traceability.

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-11-atomic-terminal-completion-envelope.md`

Gate 1 design selection, Gate 2 written specification, and Gate 3 implementation
authorization were approved earlier on 2026-10-11. The later user decision above
supersedes that native delivery authorization: T1 is prototype-complete but
excluded from delivery, while T2 and T3 are cancelled rather than pending.

Swarm planning workspace:
`<workspace>`,
branch `worktree-unified-delivery-ingress`, specification base
`e93cb6939d9e887ae3e47c0a1eba885e18626bf6`, initial specification commit
`5ed65a8c`. It was clean before planning and was the workspace for the historical
native proposal. The closure decision above is now authoritative, and this plan
cannot be resumed to deliver native work.

Fresh Swarm baseline records are stored in the specification: `npm test`
record `be7bc82ffba8496ebeca30edeac91278` passed 301 files / 4,640 tests;
typecheck record `2dd4e71a03074588b7f572a66d9f32e9`, build record
`fafe8d1747674967b6cf15d3a7034611`, and architecture record
`c2516da6f18846b4ad5e58ae59b1e0f6` all passed.

Herdr Core local `master` is `2c0bff83eef7159bba99f5dec82b36ccc4866105`,
24 commits ahead of freshly fetched `origin/master`. Its main checkout contains
unrelated user changes in `Cargo.lock`, quick-start docs, and mouse-selection
files. The T1 prototype was created in a separate clean Core worktree based on
`2c0bff83`; the historical execution constraint prohibited mutation, staging,
rebasing, or cleaning of that main checkout.

TraeX 0.209.1 is installed as an internal binary, but no authoritative producer
source checkout, repository instructions, build/test commands, or mutation
owner were available during planning. T2 was proposed but never implemented.
The later user decision cancelled T2 and T3 unconditionally: neither ticket is
executable or resumable under this plan, even if source or ownership information
is supplied later. Binary patching, reverse engineering as implementation, and
inferred terminal behavior remain forbidden.

No ticket authorizes installation, deployment, production SQLite mutation,
live Feishu mutation, push, PR, or publication. This closed plan cannot be used
as authority for any of those actions.

## Wave W1: `T1`

### - [x] T1: [prototype completed; excluded from delivery] Add the Core native terminal-envelope consumer and capability

| Field | Content |
| --- | --- |
| What to build | Historical prototype scope: the isolated Core branch added a capability-gated decoder for the specification's frozen `event_msg/turn_completion_end` v1 record, required exact active-turn identity, normalized accepted records into the existing canonical final `message` plus optional `completion_choice`, retained the legacy fence reader, deduplicated equal native/legacy values, and failed closed on disagreement. This prototype is excluded from delivery. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-6, SCN-7, SCN-8, SCN-10, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-11, ARCH-2, ARCH-4, ARCH-5 |
| Dependencies | None |
| Delegation eligibility | Historical prototype execution became eligible only after main prepared a clean Core worktree at the recorded base. No further delegation is authorized. |
| Delegation mode | main-local; historical prototype complete and excluded from delivery |
| Ownership and implementation path | The historical prototype assigned native/legacy record decoding, value validation, conflict policy, redaction, canonical identity, and capability advertisement to Herdr Core Agent Events. That proposed native boundary is non-authoritative for delivery. |
| Mutation ownership | src/agent_events/codec.rs, src/api/schema/agent_events.rs, src/api/server/agent_events.rs, src/api/schema/tests.rs, docs/next/api/herdr-api.schema.json |
| Exclusions | TraeX producer implementation, Swarm choice persistence, Feishu presentation, stable endpoint codec mutation, Core main-checkout user changes, binary installation and deployment. |
| Isolation | Historical prototype execution used a clean Herdr Core worktree based on `2c0bff83eef7159bba99f5dec82b36ccc4866105`; it did not mutate the dirty main checkout. |
| Concurrency conflicts | None |
| Verification seam | Historical Red/Green covered none/choice, required exact-active `turn_id`, stale-turn isolation, exact `tcv1:` identity shape and bounds, malformed records, fence-only empty answers, native/legacy equality and conflict, duplicate scans, redaction, and frozen schema compatibility. Focused codec/schema tests, locked Core tests, and platform-neutral lint/checks were run; Windows/MSVC cross was explicitly skipped. |
| Host capacity | Historical prototype execution used one direct-child slot and the existing Zig 0.16.0 path. No further dispatch is authorized. |
| Direct-child boundary | The historical prototype used `delegation_allowed = false`; the child did not spawn, stage, commit, push, deploy, install, or touch the main checkout. |
| Acceptance criteria and verification | Native records yield exactly one existing-shape canonical final message only when their required `turn_id` strictly equals the current active turn and cleaned visible answer is nonempty; missing, mismatched, stale-turn, and fence-only-empty records fail closed without publishing a final message or contaminating a later turn. Answer text contains no transport syntax; valid choices preserve order and current bounds; Core accepts only the specified 69-byte `tcv1:` identity shape without recomputing producer identity; identical replay uses the existing journal same-key deduplication; no new journal recovery or quarantine behavior is introduced; equal dual-source values deduplicate; mismatch/invalid mixed values yield no actionable choice and one bounded diagnostic; old legacy-only fixtures and stable endpoint contracts remain green. |
| Blocked by | None |
| Verification commands | `just test-one agent_events`; focused native terminal, capability and generated-schema tests; `just lint`; isolated-XDG `just check`. |
| Verification results | Original T1 evidence: Agent Events 111/111, isolated-XDG Rust 4074/4074, maintenance 150/150, release workflows 5/5, UI hot-path 6/6, integration assets 55/55, and fmt/clippy passed. Turn-binding correction Red: all three new tests failed by showing missing `turn_id` accepted, late turn-1 content projected onto active turn 2, and a fence-only empty final published. Green: Agent Events 114/114, maintenance 151/151, release workflows 5/5, and fmt/all-target clippy passed using Zig 0.16.0. A refreshed native `just ci` attempt reached 149 passing tests before six unrelated environment-sensitive CLI agent tests detected the current `codex` process where fixtures expected `pi` and fail-fast skipped the remainder. Windows/MSVC cross was explicitly skipped. Journal code and design remain unchanged. |
| Commits | `259a075706e4c026f922c17e216badb76deaa0a2`, `3a93e418f80a1eceea264f9d26d3cb576407c679`, `8e3407f6f1a8c96e67227f62acf49f5cc85a264d` |
| Delivery status | Prototype completed on an isolated Core branch, then excluded by the 2026-10-11 decision. It must not be merged, installed, deployed, or treated as delivered authority. |

## Wave W2: `T2`

> Cancelled historical wave retained only for artifact traceability. It is not
> executable or resumable under this plan.

### - [ ] T2: CANCELLED — NOT IMPLEMENTED — NOT EXECUTABLE: Produce one atomic terminal envelope from TraeX

| Field | Content |
| --- | --- |
| What to build | Historical proposal only: the authoritative TraeX runtime would have exposed one terminal `complete_turn({answer,review})` interface, allocated the stable producer-owned `completion_id`, driven `open -> finalizing -> committed`, adapted provider forced-tool or native structured output, atomically appended one frozen v1 record, rendered only the committed answer, allowed at most one bounded live same-turn schema repair, and persisted a Session writer pin. None of this work is authorized or executable. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-6, SCN-7, SCN-11, INV-1, INV-2, INV-3, INV-4, INV-6, INV-7, INV-8, INV-11, ARCH-1, ARCH-4, ARCH-5 |
| Dependencies | T1 |
| Delegation eligibility | Cancelled and ineligible for delegation. Supplying a TraeX repository, instructions, build/test contract, or mutation owner does not reopen this ticket. |
| Delegation mode | main-local; cancelled with no execution authorized |
| Ownership and implementation path | Historical proposal only: TraeX terminal finalization would have owned provider adaptation, exact-turn binding, schema validation, producer completion identity, finalization state, terminal uniqueness, repair policy, native-record persistence, restart handling, Session pinning, and visible-output suppression. This ownership proposal is non-authoritative. |
| Mutation ownership | None |
| Exclusions | Patching the installed binary, plugin-to-Swarm IPC, post-terminal review derivation, Core canonical schema redesign, Swarm delivery changes and deployment. |
| Isolation | Cancelled; no TraeX workspace may be prepared under this plan. The historical proposal had contemplated a separate authoritative source workspace. |
| Concurrency conflicts | None |
| Verification seam | Historical proposal only: tests would have covered explicit none, bounded choices, provider modes, full-size answers, duplicate/late/stale calls, Primary/Worker parity, repair outcomes, hidden transport, deterministic `completion_id`, Session-pinned fallback, and fault injection. No such implementation verification is pending under this plan. |
| Host capacity | Cancelled; no dispatch or capacity recomputation is authorized. |
| Direct-child boundary | `delegation_allowed = false`; cancellation prohibits child work and all source or binary mutation. |
| Acceptance criteria and verification | Cancellation criterion: no TraeX source or binary is modified and no native producer work is executed under this plan. The former implementation criteria are historical only and require no pending verification. |
| Cancellation status | Closed without implementation. The user decided not to modify TraeX source; the unchecked item records that implementation did not occur and cannot resume under this plan. |

## Wave W3: `T3`

> Cancelled historical wave retained only for artifact traceability. It is not
> executable or resumable under this plan.

### - [ ] T3: CANCELLED — NOT IMPLEMENTED — NOT EXECUTABLE: Cut over Swarm-managed sessions with mixed-version proof

| Field | Content |
| --- | --- |
| What to build | Historical proposal only: Swarm would have retained its canonical `completion_choice` consumer while adding bounded native diagnostics and compatibility packaging, then proved mixed native/legacy behavior before a separately authorized rollout. No cutover or writer suppression is authorized or executable. |
| Spec references | SCN-1, SCN-2, SCN-5, SCN-7, SCN-8, SCN-9, SCN-10, SCN-11, INV-3, INV-5, INV-6, INV-8, INV-9, INV-10, INV-11, ARCH-3, ARCH-4, ARCH-5 |
| Dependencies | T2 |
| Delegation eligibility | Cancelled and ineligible for delegation. No T2 evidence or later capability can reopen this ticket under this plan. |
| Delegation mode | main-local; cancelled with no execution authorized |
| Ownership and implementation path | Historical proposal only: Swarm would have remained a canonical Core-event consumer while adapters exposed bounded native/legacy diagnostics. The current authority is instead the supported Hook-to-Core canonical projection path. |
| Mutation ownership | plugins/herdr-choice-list/, src/cli/service-lifecycle/owned-traex-choice-plugin.ts, src/adapters/herdr-events-adapter.ts, src/runtime/herdr-events/, src/runtime/completion-choice-hook.ts, src/domain/completion-choice.ts, tests/completion-choice-hook.test.ts, tests/completion-choice-protocol.test.ts, tests/herdr-events-protocol.test.ts, tests/owned-traex-choice-plugin.test.ts, tests/worker-turn-observer.test.ts, tests/card-interaction-integration.test.ts |
| Exclusions | New Completion Review tables, post-terminal model jobs, changing Feishu callback shape, frozen-card controls, automatic uncertain replay, removing legacy readers, install/restart/live Feishu mutation, push and PR. |
| Isolation | Cancelled; no Swarm mutation workspace or post-T2 wave may be prepared under this plan. |
| Concurrency conflicts | None |
| Verification seam | Historical proposal only: Core-event fixtures and a fake Gateway would have exercised native/legacy final messages, review delivery, callbacks, restart, and writer selection. No native or mixed-version test work is pending under this plan. |
| Host capacity | Cancelled; no worker slot, integration run, live E2E, install, or restart is authorized. |
| Direct-child boundary | `delegation_allowed = false`; cancellation prohibits child work, staging, commits, installation, restart, deployment, production access, push, and PR creation. |
| Acceptance criteria and verification | Cancellation criterion: no Swarm native cutover, mixed-version rollout, or writer contraction is implemented under this plan. The supported compatibility path remains authoritative and no native verification is pending. |
| Cancellation status | Closed without implementation or cutover. The unchecked item records that implementation did not occur and cannot resume under this plan. |

## Final delivery checks

- [x] Plan closed by the 2026-10-11 user decision without a native rollout.
- [x] T1 is recorded only as an isolated, undelivered Core prototype and is excluded from merge, install, and deployment.
- [x] T2 is cancelled without TraeX source modification or producer implementation.
- [x] T3 is cancelled without Swarm cutover, mixed-version rollout, or writer contraction.
- [x] The supported path remains the existing writer Hook plus Core canonical `completion_choice` projection consumed by Swarm/Feishu.
- [x] No install, restart, production mutation, push, PR, or external publication is authorized by this closure.

This plan is closed without native rollout. The later 2026-10-11 decision
supersedes the earlier Gate 3 authorization for native delivery: T2 and T3 are
cancelled, not pending and not completed implementations. T1 remains historical
prototype evidence only and must not be merged, installed, or deployed.
