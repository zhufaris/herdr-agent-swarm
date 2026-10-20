# Typed human message and Turn session state implementation plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Native implement-spec executor after Gate 3. Selected specification:
`docs/spec-coder/specs/2026-10-15-typed-human-message-and-session-state.md`.
The authoritative Swarm workspace is the clean detached worktree
`<repo-root>/.trae/worktrees/fix/stop-active-turn-deploy`
at recorded base `75720dc64be138f27874bb17e3f785744130369b`.

The coordinating Core plan is
`/tmp/herdr-core-typed-message-v4-master/docs/spec-coder/plans/2026-10-15-typed-human-message-v4.md`
at Core base `a3ebee21a71e100a3c6d8ad12ddd408e03fedc7f`.
Core T1 must be completed before Swarm T2 can enable typed submission. Each
ticket uses one direct worker by default under spec-coder; main retains Red,
diff acceptance, fresh verification, integration, commits, and plan updates.
The durable waves remain serial singleton waves because their dependencies and
shared authoritative workspaces do not permit concurrent mutation. No
additional implementation worktree, push, installation, restart, or deployment
is authorized.

Gate 1 and Gate 2 are approved. Swarm preparation passed typecheck, build,
architecture check, and 304 files / 4910 tests. Core uses the user-approved
native baseline recorded in its plan; Windows cross-lint remains excluded.

After spec-coder 0.7.0 was loaded, the earlier post-Gate-3 additions of exact
T1 mutation owners activated its Reopened Gate 3 scheduling barrier. The
durable wave order, recorded bases, dependencies, isolation, and delegation
mode did not change. T1/T2 accepted commits were accounted, and the active T3
worker started from accepted base `0b28ffe7` with task-owned paths compatible
with the renewed plan. The user explicitly renewed Gate 3 with `继续` on
2026-10-15; main then reruns the 0.7.0 plan checker before accepting results or
resuming commits and checkbox advancement.

During T3, integration evidence showed that canonical Primary Segment terminal
completion must invoke the existing choice normalizer for a raw v3 fence when
Core supplies no native v2 metadata. The user explicitly approved option `A`
to add `src/store/sqlite/conversation-segment-store.ts` as the exact T3
persistence owner. No other scheduling input changed. Main records this second
Reopened Gate 3 renewal and reruns the 0.7.0 plan checker before resuming the
blocked worker or accepting its result.

The T3 full suite then identified one stale socket-integration assertion that
still expected the v2 Hook repair text. The user approved the default option to
add `tests/completion-choice-eligibility-gateway.integration.test.ts` as the
exact affected T3 test owner. This changes no production ownership, wave,
dependency, base, isolation, or delegation input. Main records the renewed
approval and reruns the 0.7.0 plan checker before applying the assertion-only
repair or accepting T3.

During T4, repository evidence showed that the application composition root
must inject the combined Turn Session State loader and connect TopicView-visible
changes to the existing current-Segment invalidation seam. The user explicitly
approved option `A` to add `src/composition/create-outbound-runtime.ts` as the
exact T4 composition owner. `capability-graph.ts` remains excluded because it
already owns Session Activity invalidation. No other scheduling input changed;
main records this Reopened Gate 3 renewal and reruns the 0.7.0 plan checker
before resuming the blocked worker or accepting T4.

Delivery review found that the approved typed-message and Session State design
was sound but incompletely enforced at several entry and recovery paths. The
user selected option `A` on 2026-10-15: repair every blocking and non-blocking
review finding rather than accept residual risk. This reopens Gate 3 because it
adds repair tickets, durable waves, dependencies, and exact mutation owners;
Gate 1 and Gate 2 remain valid because no architecture assumption or approved
public contract changed. Main stops repair mutation, result acceptance,
staging, commits, and checkbox advancement until this renewed plan passes the
0.7.0 plan checker. The existing accepted T1-T4 commits remain accounted at
Swarm HEAD `b5cd536d2032dd90260865d2c5e0b0d8f58bb26e`.

After T5 commit `6e1812ab3b2ddd3ad8d547cf5769c73b6428105a`, the
main-owned T6 Red proved that two directly coupled owners were absent from the
renewed plan. `src/domain/completion-action-set.ts` owns the sole CardKit Action
Set DTO that must consume `ChoicePrompt`; `src/store/sqlite/migration-registry.ts`
and `src/store/sqlite/migrations.ts` own the durable completion-choice schema
needed to retain an invalid compatibility reason, with
`tests/sqlite-migrations.test.ts` as its migration seam. No scenario, public
contract, wave, dependency, base, isolation, or delegation mode changes. This
exact ownership addition reopens Gate 3 again; T6 remains stopped until the
user renews approval and the 0.7.0 plan checker passes. The user selected `A`
and renewed this exact Gate 3 ownership on 2026-10-15; main may resume T6 only
after the checker records a passing result.

The resumed T6 preflight then found that the typed Action Set DTO is produced
directly by Primary Prompt and Worker stores and declared by their two ports.
A complete reference-closure audit also identified the existing Action Set
renderer/redelivery/workflow fixtures whose legacy literals must be translated
to structural `ChoicePrompt`. The proposed final T6 ownership closure adds
`src/store/sqlite/projection-store.ts`, `src/store/sqlite/worker-turn-store.ts`,
`src/domain/ports/projection.ts`, `src/domain/ports/instance.ts`, and the nine
listed affected test owners. Orchestration callers only forward the DTO and
remain excluded. No behavior, wave, dependency, base, isolation, delegation,
deployment, or publication authority changes. T6 is stopped at Reopened Gate 3
until this final closure is approved and checked. The user selected `A` and
approved this final closure on 2026-10-16; main may resume T6 only after the
0.7.0 plan checker passes.

Final delivery review and the fresh Swarm suite then exposed one structural
Choice Prompt composition defect, nine concentrated SQLite-suite failures, a
legacy completion-schema positional copy failure, and duplicated option-bound
validation. The user selected the displayed default option `A` on 2026-10-16
and approved reopened Gate 3 Wave W9/T9 with its exact owners, serial direct
delegation, accepted base `1daf2073`, and verification seams. Gateway protocol
version redesign remains excluded because the supported registry is built-in
and a version change would widen the approved durable-delivery contract. Push,
merge, installation, restart, and deployment remain unauthorized. Main reruns
the 0.7.0 plan checker before dispatch or result acceptance.

T9 Red-Green implementation then proved that the terminal lifecycle DTO reaches
`completeTurn` through `src/coordinator/binding-prompt-workflow.ts`; retaining
that caller's legacy compatibility type would either fail typechecking or
reintroduce the structural-to-legacy conversion that T9 repairs. The user said
`继续` on 2026-10-16 after this exact missing-owner consequence was reported,
renewing Gate 3 only to add that coordinator type seam to T9 ownership. Ticket,
wave, base, delegation mode, behavior, and all excluded authorities remain
unchanged. Main reruns the 0.7.0 plan checker before accepting the returned T9
result.

## Wave W1: `T1`

### - [x] T1: Persist one typed human-message ingress contract

| Field | Content |
| --- | --- |
| What to build | Replace the split legacy text/card-choice admission boundary with `HumanInputMessageV2`; normalize ordinary Feishu text without choice, validate reference-only choice callbacks against the durable Action Set, and atomically consume one choice while admitting one typed Submission Intent. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-2, ARCH-1, ARCH-2 |
| Dependencies | None |
| Delegation eligibility | Bounded durable-ingress slice with an inspectable migration and transaction seam; eligible for one direct worker. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Gateway adapters translate provider SDK data into the application-owned typed message; SQLite owns immutable message persistence and the Action Set/Submission Intent transaction. |
| Mutation ownership | src/domain/inbound.ts, src/domain/submission-intent.ts, src/domain/ports/agent-input.ts, src/domain/ports/conversation-segment.ts, src/domain/ports/workflow.ts, src/gateways/contract/plugin.ts, src/gateways/feishu/plugin.ts, src/gateways/compatibility-ingress.ts, src/coordinator/durable-inbound-pipeline.ts, src/coordinator/card-interaction-workflow.ts, src/store/sqlite/inbound-dispatch-store.ts, src/store/sqlite/submission-intent-store.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/core-event-inbox-store.ts, src/store/sqlite/migrations.ts, src/store/sqlite/schema.ts, src/store/sqlite/schema-manifest.ts, tests/gateway-plugin-contract.test.ts, tests/lark-adapter.test.ts, tests/inbound-message-dispatcher.test.ts, tests/inbound-message-dispatcher.integration.test.ts, tests/inbound-message-routing-workflow.test.ts, tests/card-interaction-integration.test.ts, tests/conversation-segment-store.test.ts, tests/core-event-inbox-store.test.ts, tests/submission-intent-store.test.ts, tests/sqlite-migrations.test.ts |
| Exclusions | Core API implementation, assistant choice rendering, Session State cards, provider credentials, deployment. |
| Isolation | One serial direct worker in the authoritative Swarm worktree at the recorded base; main does not mutate concurrently. |
| Concurrency conflicts | T2, T3 |
| Verification seam | Gateway normalization tests plus SQLite round-trip, duplicate/conflict, tampering, and transaction integration tests; repository-native typecheck and build. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect delegation, staging, commits, installation, or deployment by a child. |
| Acceptance criteria and verification | Text ingress round-trips with `choice` absent; a valid selection stores one immutable reference and resolved text; forged/stale selections create no intent; exact duplicates reuse one submission; conflicting canonical content is rejected; migration preserves legacy text rows. |
| Blocked by | None |
| Verification commands | Focused Gateway/inbound/Submission Intent/segment/Core-alias/migration suites; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm test -- --reporter=dot`; `git diff --check` |
| Verification results | Main observed 8 focused files / 349 tests and the assertion repair 2 files / 31 tests pass; full suite passed 304 files / 4914 tests after freeing generated Core build artifacts; typecheck, build (`sha256:3be8c780abfd2daac7713d6f6a41a8f4eefe5edb7b4a815ed8f85dbc97c61ee8`), 544-file architecture check, and diff checks passed. |
| Commits | `24113e99ecdbfeca6c98d5c0fb2be1ad1e2567f6` |

## Wave W2: `T2`

### - [x] T2: Submit typed human messages through Core v4

| Field | Content |
| --- | --- |
| What to build | Extend Agent Input capability negotiation, immutable Submission Intent draining, Herdr adapter invocation, receipts, and recovery so choice-bearing messages require `agent.input.submit.v4`, while ordinary text may use the compatible existing path. |
| Spec references | SCN-1, SCN-3, INV-1, INV-3, ARCH-2, ARCH-4 |
| Dependencies | T1 |
| Delegation eligibility | Bounded cross-repository protocol integration with independent capability, adapter, and recovery seams; eligible for one direct worker after prerequisites are accepted. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Swarm owns capability gating and immutable request selection; the adapter sends the Core-owned DTO without silently dropping metadata. Core plan T1 is an external readiness prerequisite. |
| Mutation ownership | src/domain/ports/agent-input.ts, src/runtime/agent-input-capability.ts, src/coordinator/agent-input-drainer.ts, src/adapters/herdr-agent-input-adapter.ts, src/store/sqlite/submission-intent-store.ts, src/infra/command-runner.ts, tests/agent-input-capability.test.ts, tests/agent-input-drainer.test.ts, tests/agent-input-workflow.test.ts, tests/herdr-agent-input-adapter.test.ts, tests/submission-intent-store.test.ts, tests/command-runner.test.ts |
| Exclusions | Core source files, provider-native structured prompts, deployment. |
| Isolation | One serial direct worker in the authoritative Swarm worktree after T1 and Core plan T1 are accepted; main does not mutate concurrently. |
| Concurrency conflicts | T1 |
| Verification seam | Capability, adapter command/JSON, drain/retry, receipt adoption, and unsupported-Core tests plus typecheck/build. |
| Host capacity | One direct-child slot; recheck live capacity after dependencies complete. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect delegation, staging, commits, installation, or deployment by a child. |
| Acceptance criteria and verification | Choice-bearing input reaches v4 unchanged; lack of v4 leaves the intent recoverable with explicit capability mismatch; text-only input remains compatible; duplicate/recovery paths never resubmit after a possible effect. |
| Blocked by | T1 |
| Verification commands | Focused Agent Input adapter/capability/drainer/workflow/store suites; architecture-boundary regression; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm test -- --reporter=dot`; `git diff --check` |
| Verification results | Main observed focused 5 files / 48 tests and repair 2 files / 94 tests pass; full suite passed 304 files / 4921 tests; typecheck, build (`sha256:5c29028d04c8bff75769b0b44963599c7b0d4f6b6e5bd0fbc9c57eeb76c681c9`), 544-file architecture check, and diff checks passed. Delivery review then observed separate Reds and accepted repairs that redact typed Agent Input payloads from command failures and reject invalid typed payloads deterministically instead of classifying them as uncertain effects. |
| Commits | `0b28ffe7`, `2f344d798850c689d919264da8fdbd550d884323`, `5147d5a06cbdb2bed287ad56f9ce28e4fb127003` |

## Wave W3: `T3`

### - [x] T3: Produce embedded typed assistant choices

| Field | Content |
| --- | --- |
| What to build | Introduce typed `AssistantMessageV2.choice` with a complete `defaultOption` and alternatives, remove new-production dependence on `default` references and the `"default"` message sentinel, translate valid legacy v2 fences at one boundary, and render/persist the typed prompt. |
| Spec references | SCN-4, SCN-5, INV-1, ARCH-3 |
| Dependencies | T1 |
| Delegation eligibility | Bounded protocol/store/renderer change with focused domain and integration seams; eligible for one direct worker. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Domain validation owns valid typed choice construction; the legacy adapter owns translation; Action Set persistence and CardKit consume only normalized typed prompts. |
| Mutation ownership | src/domain/completion-choice.ts, src/runtime/completion-choice-hook.ts, src/runtime/herdr-events/event-projector.ts, src/store/sqlite/completion-choice-store.ts, src/store/sqlite/conversation-segment-store.ts, src/cards/completion-actions.ts, tests/completion-choice-protocol.test.ts, tests/completion-choice-hook.test.ts, tests/completion-choice-eligibility-gateway.integration.test.ts, tests/herdr-event-projector.test.ts, tests/card-interaction-integration.test.ts, tests/conversation-segment-store.test.ts |
| Exclusions | Agent provider-native tool APIs, inbound Gateway persistence beyond T1, historical card rewrites, deployment. |
| Isolation | One serial direct worker in the authoritative Swarm worktree after T1; legacy compatibility remains additive and main does not mutate concurrently. |
| Concurrency conflicts | T1 |
| Verification seam | Domain validation/translation tests, hook invalid-reason tests, exact commentary/final recovery, Action Set round-trip, and CardKit button integration tests. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect delegation, staging, commits, installation, or deployment by a child. |
| Acceptance criteria and verification | Typed default is structurally present; option IDs are unique; no sentinel is required; absence of choice means no review; valid v2 input translates; malformed compatibility input never creates buttons and reports a bounded reason; native typed metadata wins. |
| Blocked by | T1 |
| Verification commands | Focused protocol/Hook/socket/projector/CardKit/Segment suites; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm test -- --reporter=dot`; `git diff --check` |
| Verification results | Main observed 6 focused files / 229 tests pass after canonical Segment and socket assertion repairs; full suite passed 304 files / 4932 tests; typecheck, build (`sha256:3faa7603aa2dd4e62120ec7179c990efa5125cd4366aab1ef4d1633823f3df88`), 544-file architecture check, and diff checks passed. |
| Commits | `b72aca06` |

## Wave W4: `T4`

### - [x] T4: Render bounded Turn session state

| Field | Content |
| --- | --- |
| What to build | Add `TurnSessionStateView`, combine current Topic View and Session Activity facts at the query boundary, render one compact Session section on the mutable Human Turn Card, and invalidate once when a displayed field changes. |
| Spec references | SCN-6, SCN-7, INV-4, ARCH-5 |
| Dependencies | None |
| Delegation eligibility | Bounded query/read-model/renderer slice with pure fingerprint and card-workflow seams; eligible for one direct worker. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | A read-only query module owns composition; domain fingerprinting owns visible equality; Turn Card workflow and renderer consume one DTO without importing SQLite rows. |
| Mutation ownership | src/domain/turn-session-state.ts, src/domain/session-activity.ts, src/domain/ports/session-activity.ts, src/domain/ports/presentation.ts, src/coordinator/turn-card-workflow.ts, src/events/conversation-view-projector.ts, src/composition/create-outbound-runtime.ts, src/store/sqlite/session-activity-store.ts, src/store/sqlite/conversation-segment-store.ts, src/cards/session-activity.ts, src/cards/turn-card.ts, tests/session-activity-store.test.ts, tests/turn-card-workflow.test.ts, tests/turn-card.test.ts, tests/event-card-integration.test.ts |
| Exclusions | Parsing environment-context prose, guessing unavailable values, repairing stale upstream lifecycle facts, frozen historical cards, deployment. |
| Isolation | One serial direct worker in the authoritative Swarm worktree; main does not mutate concurrently. |
| Concurrency conflicts | None |
| Verification seam | Pure read-model/fingerprint tests, SQLite/query integration, current-page reservation tests, renderer ordering/budget tests, and frozen-page preservation. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect delegation, staging, commits, installation, or deployment by a child. |
| Acceptance criteria and verification | Available identity/model/token/wait/turn facts render once; unavailable facts are omitted or marked unavailable; terminal Subagents leave the active list while running facts remain; repeated invisible state is a no-op; current mutable page updates once and frozen pages remain unchanged. |
| Blocked by | None |
| Verification commands | Focused Session Activity/Turn Card workflow/renderer/event integration suites; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm test -- --reporter=dot`; `git diff --check` |
| Verification results | Main observed 4 focused files / 113 tests pass; full suite passed 304 files / 4935 tests; typecheck, build (`sha256:92ec554c6140f5453adac3b1cfd001c3564d3793a0327d38eb31072b33a6a8ae`), 545-file architecture check, and diff checks passed. Delivery review then observed the Worker-owned Segment Red because the Primary-only loader returned `null`; after repair, Main freshly observed the Session Activity and Turn Card workflow suites pass 55/55 tests, typecheck pass, the 545-file architecture check pass, build pass with `sha256:24f902b85d216940ec1b42fa99006ecc5c27488769c776d1fae87eb162bdfb67`, and `git diff --check` pass. A repeated Spec review then observed that Worker-only visible activity did not invalidate the current Worker Turn Card. Main observed the Worker Segment `viewVersion` Red (1 instead of 2), then freshly verified the exact Worker invalidation plus Primary preservation across 3 files / 153 tests, typecheck, the 545-file architecture check, build (`sha256:69b7e20078c6afe14308051619a2168067458f540c5d38ed24e863d8671190c5`), and `git diff --check`. Same visible state replay remained a no-op. |
| Commits | `b5cd536d`, `d979ec5ed44ad346ead52b758bac897de9b35535`, `f9800fe1cadfca3f8be4d6a0e7e1d5ade2a83131` |

## Wave W5: `T5`

### - [x] T5: Repair typed Completion Review admission and replay

| Field | Content |
| --- | --- |
| What to build | Make every fresh Primary Segment and Primary Prompt choice writer persist the same canonical `HumanInputMessageV2` as its indexed text, carry the durable choice reference through Core v4 draining, and recognize an exact consumed retry from immutable decision identity after runtime detachment or generation change. |
| Spec references | SCN-2, SCN-3, INV-1, INV-2, ARCH-2 |
| Dependencies | T1, T2 |
| Delegation eligibility | Bounded SQLite admission/replay repair with workflow-level observable seams; eligible for one direct worker. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Completion Review owns first-consumption eligibility and immutable consumed-result replay; Submission Intent persistence owns canonical typed input. Current runtime liveness fences remain mandatory only for first consumption. |
| Mutation ownership | src/store/sqlite/completion-review-store.ts, src/store/sqlite/conversation-segment-store.ts, src/coordinator/card-interaction-workflow.ts, tests/sqlite-store.test.ts, tests/conversation-segment-store.test.ts, tests/card-interaction-integration.test.ts, tests/agent-input-workflow.test.ts |
| Exclusions | Assistant choice protocol shape, Gateway SDK normalization, Session State, Core source, deployment. |
| Isolation | One serial direct worker in the authoritative Swarm worktree at accepted base `b5cd536d`; main does not mutate concurrently. |
| Concurrency conflicts | T6, T7 |
| Verification seam | Card click through Submission Intent read/drain, canonical input round-trip, conflicting retry, and exact replay after Primary detach/rotation or Worker termination. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect delegation, staging, commits, installation, or deployment by a child. |
| Acceptance criteria and verification | Fresh choices can be read and drained through Core v4 without input mismatch; exact retries return the original immutable submission after runtime liveness changes; forged or conflicting retries remain rejected; action consumption and typed intent admission remain atomic. |
| Blocked by | T1, T2 |
| Verification commands | Focused Completion Review/Segment/card-interaction/Agent Input workflow suites; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed the Primary Prompt mismatch Red, then independently verified fresh Primary Prompt and Segment typed-input reads, Core-v4 drain, Primary detach/session-rotation replay, Worker termination replay, forged/conflicting rejection, and card interaction behavior: 1 + 1 + 1 + 28 focused tests passed. Typecheck, build (`sha256:08412811a57409c76f69b6fbec8226af2c7aefe8780f719854f9810e75d0c03f`), 545-file architecture check, and diff checks passed. |
| Commits | `6e1812ab3b2ddd3ad8d547cf5769c73b6428105a` |

## Wave W6: `T6`

### - [x] T6: Enforce the typed assistant Choice Prompt contract

| Field | Content |
| --- | --- |
| What to build | Represent assistant output as `AssistantMessageV2` with an optional structural `ChoicePrompt`, retain `FinalMessageCompletionChoice` only as a compatibility translation input, persist/render the typed prompt, and durably preserve bounded invalid compatibility reasons. |
| Spec references | SCN-4, SCN-5, INV-1, ARCH-3 |
| Dependencies | T3, T5 |
| Delegation eligibility | Coherent domain/persistence/renderer repair with explicit translation and round-trip seams; eligible for one direct worker. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | The assistant-message domain validates the typed prompt; one compatibility boundary translates legacy fences; durable completion evidence stores either the valid typed prompt or a bounded invalid reason; CardKit consumes only the typed prompt. |
| Mutation ownership | src/domain/completion-choice.ts, src/domain/completion-action-set.ts, src/domain/herdr-events.ts, src/domain/ports/external.ts, src/domain/ports/prompt-acceptance.ts, src/domain/ports/prompt-run.ts, src/domain/ports/projection.ts, src/domain/ports/instance.ts, src/store/sqlite/completion-choice-store.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/prompt-dispatch-store.ts, src/store/sqlite/prompt-recovery-store.ts, src/store/sqlite/projection-store.ts, src/store/sqlite/worker-turn-store.ts, src/store/sqlite/migration-registry.ts, src/store/sqlite/migrations.ts, src/runtime/herdr-events/event-projector.ts, src/cards/completion-actions.ts, tests/completion-choice-protocol.test.ts, tests/herdr-event-projector.test.ts, tests/conversation-segment-store.test.ts, tests/card-interaction-integration.test.ts, tests/sqlite-migrations.test.ts, tests/gateway-view.test.ts, tests/instance-cards.test.ts, tests/primary-card-redelivery-store.test.ts, tests/primary-card-redelivery-workflow.test.ts, tests/run-card.test.ts, tests/sqlite-store.test.ts, tests/turn-card.test.ts, tests/worker-turn-card-workflow.test.ts, tests/worker-turn-observer.test.ts |
| Exclusions | Human choice admission/replay, provider command payloads, Core source, Session State, deployment. |
| Isolation | One serial direct worker in the authoritative Swarm worktree after R1; main does not mutate concurrently. |
| Concurrency conflicts | T5, T7 |
| Verification seam | Typed construction/equality, legacy translation, invalid-reason round-trip, canonical completion recovery, Action Set persistence, and CardKit button integration. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect delegation, staging, commits, installation, or deployment by a child. |
| Acceptance criteria and verification | New production paths expose structural `defaultOption + alternatives`; no sentinel or dangling default ID is produced; legacy input translates once; malformed compatibility input persists one bounded reason and never creates buttons; native typed metadata wins. |
| Blocked by | T3, T5 |
| Verification commands | Focused protocol/projector/Segment/recovery/CardKit suites; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed the structural v3 Red and a second versioned `AssistantMessageV2.schemaVersion=2` Red, then independently verified 9 renderer/redelivery/workflow files / 332 tests, protocol/projector/migration 3 files / 160 tests, and 2 targeted SQLite persistence regressions. Typecheck, build (`sha256:d1f1578d97cc8092fc458b468c212d451e922cc5ba70844cd350c38aae41386d`), 545-file architecture check, and diff checks passed. Invalid compatibility input retains one bounded durable reason with no option rows; contradictory protocol/native choices fail closed. |
| Commits | `531acae97d70d4be7d1da48c37fad6a7f0bde1fb` |

## Wave W7: `T7`

### - [x] T7: Close typed Gateway and Core-event boundaries

| Field | Content |
| --- | --- |
| What to build | Replace raw `unknown` interaction payload crossing with a provider-neutral typed command value, preserve Core Human Message choice metadata through adapter and persisted event codecs, and verify Swarm canonical Human Input JSON against the shared cross-repository fixture. |
| Spec references | SCN-1, SCN-2, SCN-3, INV-1, INV-3, ARCH-1, ARCH-2, ARCH-4 |
| Dependencies | T5, T6 |
| Delegation eligibility | Bounded translation/codec repair with schema and fixture seams; eligible for one direct worker after Core T2 is accepted as an external readiness prerequisite. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Gateway contract owns the application-safe interaction command type; Feishu alone translates SDK payloads. Core event adapters/codecs preserve the provider-neutral `ChoiceSelectionRef`; Swarm serialization owns one local copy of the shared canonical fixture. |
| Mutation ownership | src/gateways/contract/plugin.ts, src/gateways/feishu/plugin.ts, src/gateways/compatibility-ingress.ts, src/domain/herdr-events.ts, src/adapters/herdr-events-adapter.ts, src/runtime/herdr-events/event-codec.ts, tests/gateway-plugin-contract.test.ts, tests/feishu-gateway-plugin.test.ts, tests/herdr-events-adapter.test.ts, tests/herdr-event-codec.test.ts, tests/submission-intent-store.test.ts, tests/fixtures/human-input-message-v2.json |
| Exclusions | Provider-native SDK types beyond the adapter, assistant prompt persistence, Session State, Core runtime dispatch, deployment. |
| Isolation | One serial direct worker in the authoritative Swarm worktree after T6 and Core T2; main does not mutate concurrently. |
| Concurrency conflicts | T5, T6 |
| Verification seam | Gateway schema rejection/normalization, adapter and persisted-codec snake/camel round-trips, canonical Human Message choice retention, and serializer equality with the checked-in fixture. |
| Host capacity | One direct-child slot; recheck live capacity after dependencies complete. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect delegation, staging, commits, installation, or deployment by a child. |
| Acceptance criteria and verification | No raw provider object crosses the Gateway contract; valid interaction commands remain sufficient for current routing; canonical/recovered Human Message events retain choice references; Swarm emits byte-identical canonical fixture JSON. |
| Blocked by | T5, T6 |
| Verification commands | Focused Gateway/event adapter/codec/serialization suites; cross-repository fixture comparison; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed the missing Core Human Message `choice` Red and the non-JSON Gateway command Red, then independently verified the accepted adapter/codec and typed Gateway slices. The final affected command passed 6 files / 42 tests; typecheck, build (`sha256:62fdd72e284f256e30d2e909844ee7b776ddcb6d0adb211bd792315571dd551f`), 545-file architecture check, and diff check passed. Swarm and Core canonical Human Input fixtures matched byte-for-byte. Self-review added and closed a `__proto__` own-key clone Red without prototype mutation. |
| Commits | `2a8a186c7930d7c0d8cb80b92a83b053ace9a60c` |

## Wave W8: `T8`

### - [x] T8: Prevent invisible first-event Session State invalidation

| Field | Content |
| --- | --- |
| What to build | Compute a missing Session Activity snapshot baseline from the same `TurnSessionStateView(topic, null)` used after projection so a first invisible event cannot reserve a card revision. |
| Spec references | SCN-7, INV-4, ARCH-5 |
| Dependencies | T4, T7 |
| Delegation eligibility | Small deterministic read-model repair with one focused integration seam; eligible for one direct worker. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | Session Activity projection compares the exact rendered read-model fingerprint before and after every event, including the no-snapshot state. |
| Mutation ownership | src/store/sqlite/session-activity-store.ts, tests/session-activity-store.test.ts |
| Exclusions | New Session State fields, guessed values, frozen-card mutation, deployment. |
| Isolation | One serial direct worker in the authoritative Swarm worktree after T7; main does not mutate concurrently. |
| Concurrency conflicts | None |
| Verification seam | Existing displayable Topic View plus first invisible tool/commentary event remains a projection no-op; a first visible event still invalidates once. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect delegation, staging, commits, installation, or deployment by a child. |
| Acceptance criteria and verification | Invisible first events report `visibleChanged=false` and do not advance Topic View/card revisions; visible changes retain exactly-once invalidation. |
| Blocked by | T4, T7 |
| Verification commands | Focused Session Activity and Turn Card workflow suites; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `git diff --check` |
| Verification results | Main observed the first invisible Tool-event Red (`visibleChanged=true`), then independently verified the repaired baseline and exactly-once visible invalidation: Session Activity and Turn Card workflow suites passed 2 files / 55 tests. Typecheck, build (`sha256:9044a8e938fb619c08f037cb9f5d34f3c358c3f7df919fb43e79818c45273497`), 545-file architecture check, and diff checks passed. |
| Commits | `1daf20731daa5595c632b5bb42566b45768a9676` |

## Wave W9: `T9`

### - [x] T9: Close structural Choice Prompt composition and migration compatibility

| Field | Content |
| --- | --- |
| What to build | Keep the new-production Choice Prompt structural from event projection through terminal lifecycle persistence and recovery, translate legacy native metadata only at the compatibility boundary, update remaining legacy-shaped renderer fixtures, make the completion-schema rebuild copy explicit columns across pre-existing `invalid_reason` layouts, and consolidate duplicated option-bound validation without changing accepted values. |
| Spec references | SCN-4, SCN-5, INV-1, ARCH-3 |
| Dependencies | T6 |
| Delegation eligibility | Bounded delivery repair with an inspectable projector-to-SQLite composition seam, migration fixture, and full SQLite suite; eligible for one direct worker. |
| Delegation mode | Default direct worker |
| Ownership and implementation path | The assistant-message domain owns structural typed choices; Core-native/legacy metadata is translated exactly once; terminal lifecycle ports and stores carry the structural value; SQLite migration owns explicit legacy-column projection; CardKit consumes only validated typed prompts. |
| Mutation ownership | src/coordinator/binding-prompt-workflow.ts, src/domain/completion-choice.ts, src/domain/completion-action-set.ts, src/domain/ports/external.ts, src/domain/ports/prompt-acceptance.ts, src/domain/ports/prompt-run.ts, src/domain/ports/projection.ts, src/domain/ports/instance.ts, src/runtime/herdr-events/event-projector.ts, src/store/sqlite/completion-choice-store.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/prompt-dispatch-store.ts, src/store/sqlite/prompt-recovery-store.ts, src/store/sqlite/projection-store.ts, src/store/sqlite/worker-turn-store.ts, src/store/sqlite/migration-registry.ts, src/cards/completion-actions.ts, tests/completion-choice-protocol.test.ts, tests/herdr-event-projector.test.ts, tests/conversation-segment-store.test.ts, tests/card-interaction-integration.test.ts, tests/sqlite-migrations.test.ts, tests/sqlite-store.test.ts, tests/gateway-view.test.ts, tests/instance-cards.test.ts, tests/primary-card-redelivery-store.test.ts, tests/primary-card-redelivery-workflow.test.ts, tests/run-card.test.ts, tests/turn-card.test.ts, tests/worker-turn-card-workflow.test.ts, tests/worker-turn-observer.test.ts |
| Exclusions | Gateway protocol-version redesign, Core source, Human choice admission/replay, Session State, deployment. |
| Isolation | One serial direct worker in the authoritative Swarm worktree at accepted base `1daf2073`; main does not mutate concurrently. |
| Concurrency conflicts | None |
| Verification seam | Main-owned Red for a non-sentinel v3 default traversing projector to durable Action Set; exact migration upgrade fixture; structural renderer fixtures; focused protocol/projector/persistence/CardKit suites; complete `sqlite-store.test.ts`; full Swarm suite. |
| Host capacity | One direct-child slot; recheck live capacity before dispatch. |
| Direct-child boundary | delegation_allowed = false; no direct or indirect delegation, staging, commits, installation, or deployment by a child. |
| Acceptance criteria and verification | New production never re-encodes a structural prompt as legacy sentinel metadata; a normal default `submitText` persists and renders; native legacy metadata still validates strictly; malformed values fail closed; old completion schemas with or without `invalid_reason` migrate without positional-column failure; option bounds remain unchanged; all nine observed SQLite failures are closed. |
| Blocked by | T6 |
| Verification commands | Focused protocol/projector/persistence/CardKit/migration suites; complete `tests/sqlite-store.test.ts`; `npm run typecheck`; `npm run build`; `npm run architecture:check`; `npm test -- --reporter=dot`; `git diff --check` |
| Verification results | Main observed three intended Reds: terminal lifecycle re-encoded a structural v3 prompt, its non-sentinel default persisted as `invalid-native-completion-choice`, and migration 124 failed on a 9-column legacy source. After repair, main independently verified the protocol/projector/persistence/CardKit/migration surface (13 files / 501 tests), the complete SQLite store file (525 tests), and the complete Swarm suite (306 files / 4,948 tests). Typecheck, build (`sha256:98abae494df33807a127c06bfc5eef348881eda9cb848fb8d2a16e959469491f`), 545-file architecture check, and diff check passed. Structural prompts now cross terminal lifecycle and durable stores without legacy-sentinel revalidation; migration 124 preserves `invalid_reason` from both 8- and 9-column historical layouts. |
| Commits | `7553c99620a1ce4b480ce9fcd214cad7f7eb43c4` |

## Delivery repair tickets

## Wave W10: `T10`

### - [x] T10: Remove raw command-error causes from typed Agent Input failures

| Field | Content |
| --- | --- |
| What to build | Keep command failures redacted even when callers inspect the structured error cause. |
| Spec references | SCN-1, INV-3, ARCH-4 |
| Dependencies | T9 |
| Delegation mode | main-local |
| Ownership and implementation path | `src/infra/command-runner.ts` owns the redacted `CommandError`; `tests/command-runner.test.ts` exercises the real `ExecFileCommandRunner` failure path. |
| Mutation ownership | src/infra/command-runner.ts, tests/command-runner.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Typed input never appears through raw `Error.cause` fields; the real process-error path remains redacted. |
| Verification commands | `npx vitest run tests/command-runner.test.ts`; `npm run typecheck`; `git diff --check` |
| Verification results | Main observed the Red with the secret present in `cause.message`/`cause.cmd`, then freshly verified 10/10 focused command-runner tests, `npm run typecheck`, and `git diff --check`. |
| Commits | `be0a5b8e5aa0584870c4914f82c7e19b19ace425` |

## Wave W11: `T11`

### - [x] T11: Fence Worker Turn Card invalidation by exact producer identity

| Field | Content |
| --- | --- |
| What to build | Carry `SessionActivityProducerFence` through live projection and retained recovery, and select only the exact Worker producer instead of treating `updated_at` as producer identity. |
| Spec references | SCN-7, INV-4, ARCH-5 |
| Dependencies | T10 |
| Delegation mode | main-local |
| Ownership and implementation path | `SessionActivityInvalidationFence` is the shared domain contract; `capability-graph.ts` and `session-activity-store.ts` preserve exact producer identity; `conversation-segment-store.ts` applies all producer generations and runtime-pane fences; `tests/conversation-segment-store.test.ts` covers two Workers sharing one timestamp. |
| Exclusions | Core protocol, CardKit schema, deployment, merge, push. |
| Mutation ownership | src/domain/session-activity.ts, src/domain/ports/conversation-segment.ts, src/store/sqlite/capability-graph.ts, src/store/sqlite/session-activity-store.ts, src/store/sqlite/conversation-segment-store.ts, tests/conversation-segment-store.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Two Workers sharing an observed timestamp yield one exact Worker invalidation; Primary and binding/session/page fences remain enforced. |
| Verification seam | Baseline timestamp implementation fails by invalidating both Worker cards; exact producer implementation passes the focused regression and preserves Primary/session/page fences. |
| Verification commands | `npx vitest run tests/conversation-segment-store.test.ts tests/session-activity-store.test.ts tests/turn-card-workflow.test.ts tests/turn-card.test.ts`; `npm run typecheck`; `npm run architecture:check`; `npm run build`; `npm test -- --reporter=dot`; `git diff --check` |
| Verification results | Main observed Red with both Worker segments advancing, then freshly verified the exact Worker regression and the complete Conversation Segment suite (98/98), Session Activity/Turn Card suites (86/86), `npm run typecheck`, `npm run architecture:check` (545 files), `npm run build` (`sha256:ae2d0534ae80976a85bcd42107d8f6688cd0e56c8e2bbcb1317ddd06a62b394f`), and `git diff --check`. |
| Commits | `ab161dc5a8b98f109685c37f27e6a1b763c051d3` |

## Final delivery checks

Main reviews and commits each accepted ticket atomically, then runs all affected
Gateway, Submission Intent, Agent Input, completion-choice, Session Activity,
Turn Card, migration, and integration suites; `npm run typecheck`, `npm run
build`, `npm run architecture:check`, `npm test`, artifact delivery checking,
and `git diff --check`. Fresh delivery evidence is Swarm 306/306 suites and
4954/4954 tests, plus Core native `just ci` 4087/4087 Rust tests, 150
maintenance tests, 5 release-workflow tests, 6 UI architecture tests, and
18 + 9 + 28 integration-asset tests. Cross-repository fixture equality is
checked after Core T1 and Swarm T2. Windows cross-lint remains excluded by the
approved host baseline. No push, installation, restart, or deployment is
authorized.
