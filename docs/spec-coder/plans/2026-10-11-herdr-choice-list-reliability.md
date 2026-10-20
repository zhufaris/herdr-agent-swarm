# Herdr Choice List Reliability and Invisible Transport Plan

<!-- spec-coder:artifact-v1 plan -->

## Workspace and authority

Specification:
`docs/spec-coder/specs/2026-10-11-herdr-choice-list-reliability.md`

Status: Gate 1 design, Gate 2 specification, and Gate 3 ticket set and
implementation authorization approved by the user on 2026-10-11.

Workspace: isolated repository worktree for this branch.

Branch and base: `worktree-unified-delivery-ingress` at
`ca4b53d468a4124469e63b17aafe99e515479aad`.

Workspace policy: reuse the clean isolated worktree. Preserve the installed
production release and all state outside this checkout. Stage only ticket-owned
paths. Do not install, restart, mutate production SQLite, perform a live Feishu
action, push, or open a pull request without separate authorization.

Baseline: Node `v24.14.1`, npm `11.11.0`, locked dependencies installed;
`npm test` passed 300 files and 4,576 tests; `npm run typecheck` passed;
`npm run build` passed with build identity
`sha256:dda672133fe061d0d8515a245f7abb0d87eb63f45117f726d3e49af163e33e8a`.

The tickets are serialized because T1 and T2 both own the protocol parser/Hook
contract, while T3 consumes their final durable Human Review semantics.

## Dependency map

```text
T1 Stop enforcement + compact owned protocol
                    |
                    v
T2 Reserved JSON sanitization + repair merge
                    |
                    v
T3 Inline-only Human Review notification behavior
```

## Wave W1: `T1`

### - [x] T1: Enforce one compact terminal decision with one repair attempt

| Field | Content |
| --- | --- |
| What to build | Change the eligible Stop Hook from unconditional allow to a one-repair protocol gate. Accept one valid terminal version-2 `none` or `human_review` decision without inspecting prose intent; block the first missing, malformed, multiple, incomplete, nonterminal, version-1, or oversized result with a constant payload-free repair instruction; always allow a repeated Stop. Update the owned Skill and examples to emit compact one-line JSON only. Preserve fail-open behavior when Herdr identity or eligibility cannot be proven. |
| Spec references | SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, SCN-7, INV-1, INV-2, INV-5 |
| Dependencies | None |
| Delegation eligibility | Eligible: Hook inputs, response shape, eligibility boundary, recursion breaker, and focused tests are deterministic and require no live service. |
| Delegation mode | delegate |
| Ownership and implementation path | TraeX Hook Integration owns eligibility and the one-repair Stop policy. The Skill owns canonical compact encoding and the semantic choice between `none` and `human_review`. The Hook treats prose as untrusted presentation and validates only the explicit protocol. |
| Mutation ownership | plugins/herdr-choice-list/scripts/herdr-choice-stop-hook.mjs, plugins/herdr-choice-list/skills/herdr-choice-list/SKILL.md, plugins/herdr-choice-list/skills/herdr-choice-list/agents/openai.yaml, src/runtime/completion-choice-hook.ts, src/cli/completion-choice-stop-hook.ts, tests/completion-choice-hook.test.ts, tests/completion-choice-plugin-wrapper.test.ts, tests/completion-choice-eligibility-gateway.integration.test.ts |
| Exclusions | Visible-Markdown sanitization, Core projection, SQLite choice state, completion-notification suppression, native side-channel, install or restart. |
| Isolation | First serialized wave in the current isolated worktree. |
| Concurrency conflicts | None |
| Verification seam | Red first: eligible missing protocol currently returns `{}` and decision prose with `intent:none` is accepted. Green requires one `decision:block` response containing only constant repair guidance, compact owned examples, no prompt/answer leakage, valid version-2 allow, and repeated-Stop no-loop behavior. Wrapper tests prove byte-for-byte pass-through. |
| Host capacity | One direct-child slot, rechecked before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; the child does not spawn, stage, commit, install, restart, deploy, access production state, or edit later-ticket files. |
| Acceptance criteria and verification | Every eligible first Stop is a valid terminal version-2 protocol or is blocked once; every repeated Stop is allowed; unproven eligibility remains fail open; owned JSON has one line; Stop never promotes prose into Human Review; oversized assistant output within the wrapper transport bound is blocked rather than silently allowed; repair text is bounded and payload-free. |
| Blocked by | None |
| Verification commands | `npx vitest run tests/completion-choice-hook.test.ts tests/completion-choice-plugin-wrapper.test.ts tests/completion-choice-eligibility-gateway.integration.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Exit 0; focused Vitest passed 3 files / 41 tests; typecheck passed; build `sha256:05991b30d51f4fc5199e6f48ac81a48bc65c0af269bbf3e9eb3f8885bdaadcd8`; independent Spec and Standards review passed. |
| Commits | `f98a4a596e651127a75f61ecdba326ebe1dec14a` |

Acceptance evidence (2026-10-11): focused Vitest passed 3 files / 41 tests;
typecheck passed; build passed with
`sha256:05991b30d51f4fc5199e6f48ac81a48bc65c0af269bbf3e9eb3f8885bdaadcd8`;
`git diff --check` passed. Independent Spec and Code Quality review passed with
no blocking findings, including UTF-8 byte-boundary and wrapper pass-through
probes. Commit: `fix(choice-hook): require one compact terminal decision`.

Suggested atomic commit:
`fix(choice-hook): require one compact terminal decision`.

## Wave W2: `T2`

### - [x] T2: Strip every reserved protocol region and merge repair continuations

| Field | Content |
| --- | --- |
| What to build | Separate reserved-region sanitization from protocol validation. Remove every line-boundary `herdr-choice-list` region from visible Markdown for valid, invalid, incomplete, multiple, oversized, and nonterminal inputs while preserving surrounding prose. Activate choice metadata only for one valid terminal decision. When a valid protocol-only repair follows an accumulated answer containing a missing or invalid protocol, replace the invalid transport region and preserve the original visible answer exactly once. |
| Spec references | SCN-3, SCN-4, SCN-6, SCN-7, INV-3, INV-4, INV-6 |
| Dependencies | T1 |
| Delegation eligibility | Eligible after T1: parser inputs and expected visible/structured outputs are pure and have production-shaped projector seams. |
| Delegation mode | delegate |
| Ownership and implementation path | Completion Choice domain policy owns reserved-region scanning, sanitization, validation, and repair selection. Adapters/projectors consume the sanitized result and never implement independent fence parsing. Existing version-1 retained input remains readable; all new output is version 2. |
| Mutation ownership | src/domain/completion-choice.ts, src/adapters/herdr-events-adapter.ts, src/runtime/herdr-events/event-projector.ts, src/runtime/traex-transcript-projector.ts, tests/completion-choice-protocol.test.ts, tests/herdr-event-projector.test.ts, tests/traex-transcript-projector.test.ts, tests/answer-stream.test.ts, tests/external-turn-observer.test.ts |
| Exclusions | Hook eligibility or block policy beyond T1 interfaces, SQLite notification behavior, card layout redesign, native side-channel, arbitrary Markdown code-fence stripping. |
| Isolation | Serialized after accepted T1 commit. |
| Concurrency conflicts | None |
| Verification seam | Red with nonterminal/trailing, multiple, malformed, and incomplete reserved blocks that currently remain visible or prevent repair replacement. Green proves zero reserved fence/JSON in every visible projection, valid terminal metadata only, preserved before/after prose, compact repair replacement, and no duplicate final answer. |
| Host capacity | One direct-child slot, rechecked before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; the child does not spawn, stage, commit, install, restart, deploy, access production state, or edit T3 files. |
| Acceptance criteria and verification | Feishu-facing Markdown and card JSON never contain the fence or protocol JSON; stripping never authorizes invalid choices; a repaired final has one visible answer and one valid decision; nonreserved code blocks remain unchanged; retained version-1 choices still project. |
| Blocked by | T1 |
| Verification commands | `npx vitest run tests/completion-choice-protocol.test.ts tests/herdr-event-projector.test.ts tests/traex-transcript-projector.test.ts tests/answer-stream.test.ts tests/external-turn-observer.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Exit 0; focused Vitest passed 5 files / 127 tests and the shared parser regression passed 3 files / 41 tests; typecheck passed; build `sha256:b6b9ebdc19cada1fdd282c926822022929b585b22e63a4b1dc0bbdbde853c4ee`; independent Spec and Standards review passed. |
| Commits | `84dc81b72121864f33f61fc050a909cbe9fd655f` |

Acceptance evidence (2026-10-11): focused Vitest passed 5 files / 127 tests;
T1 parser-sharing regression passed 3 files / 41 tests; typecheck passed; build
passed with
`sha256:b6b9ebdc19cada1fdd282c926822022929b585b22e63a4b1dc0bbdbde853c4ee`;
`git diff --check` passed. Independent Spec and Code Quality review passed with
no blocking findings, including CRLF, exact-boundary, multibyte oversized,
incomplete, multiple, nonterminal, and retained-version-1 probes. Commit:
`fix(choice-list): hide reserved protocol transport`.

Suggested atomic commit:
`fix(choice-protocol): hide reserved transport JSON`.

## Wave W3: `T3`

### - [x] T3: Keep Human Review inline and suppress standalone choice reminders

| Field | Content |
| --- | --- |
| What to build | For Primary Prompt, Worker Turn, and Primary Segment owners whose exact card contains a current Action Set, do not reserve a standalone `需要你的选择` reply. Safely dismiss only existing pending, unclaimed, never-attempted reminder effects, remove obsolete prerequisite edges, and clear their durable reference without hiding inline controls. Keep choice-free completion notices unchanged and preserve all delivered or possible-effect historical reminders. |
| Spec references | SCN-8, SCN-9, SCN-10, SCN-11, SCN-12, SCN-13, INV-7, INV-8, INV-9, INV-10, INV-11 |
| Dependencies | T2 |
| Delegation eligibility | Eligible after T2: durable owner/action identity, safe pending-effect predicates, restart fixtures, and retention seams already exist. Strong review is required because this changes Outbox/prerequisite lifecycle. |
| Delegation mode | delegate |
| Ownership and implementation path | Completion Interaction owns whether an inline Action Set needs an external reminder. Delivery and Operations owns conditional retirement and prerequisite cleanup. Conversation Projection retains the obligation and choice state needed for inline rendering. Card renderers remain unchanged. |
| Mutation ownership | src/store/sqlite/completion-notification-store.ts, src/store/sqlite/conversation-segment-store.ts, src/store/sqlite/delivery-prerequisites.ts, tests/conversation-segment-store.test.ts, tests/card-interaction-integration.test.ts, tests/detached-core-recovery.integration.test.ts, tests/worker-turn-observer.test.ts, tests/retention-compaction-store.test.ts, tests/turn-card.test.ts, tests/completion-choice-eligibility-gateway.integration.test.ts, tests/sqlite-store.test.ts, tests/t8-worker-task-stream-ring.test.ts |
| Exclusions | Deleting delivered Feishu messages, weakening effect-certainty checks, changing button callback semantics, choice-free completion notices, schema migration unless an existing-state proof is found insufficient. |
| Isolation | Serialized after accepted T2 commit. |
| Concurrency conflicts | None |
| Verification seam | Red first with choice-only and combined-marker completions that currently enqueue standalone text. Green proves zero new choice reminder for all owner kinds, inline mention/buttons unchanged, safe pending reminder dismissal plus prerequisite removal, claimed/attempted/checkpointed/delivered/uncertain preservation, restart idempotence, retention release, and unchanged one-shot callbacks. |
| Host capacity | One direct-child slot, rechecked before dispatch. |
| Direct-child boundary | `delegation_allowed = false`; the child does not spawn, stage, commit, install, restart, deploy, access production state, or broaden into native protocol work. |
| Acceptance criteria and verification | Human Review renders only in the exact card; no standalone choice reminder is created or recovered; safe pending legacy reminders are retired atomically; possible remote effects remain immutable; choice-free notices still deliver once; default/business/Ignore callbacks remain fenced and one-shot. |
| Blocked by | T2 |
| Verification commands | `npx vitest run tests/conversation-segment-store.test.ts tests/card-interaction-integration.test.ts tests/detached-core-recovery.integration.test.ts tests/worker-turn-observer.test.ts tests/retention-compaction-store.test.ts tests/turn-card.test.ts`; `npm run typecheck`; `npm run build` |
| Verification results | Exit 0; focused Vitest passed 6 files / 140 tests, expanded cross-boundary regression passed 3 files / 541 tests, and final Primary Segment suite passed 65 / 65; typecheck passed; build `sha256:393c77d7b46d370f044374019c9668e0f328ec35c9c1448404bcd563469d76ee`; independent Spec and Standards review passed. |
| Commits | `bb2fc3fe3d233ca00c4c6900c54487d7109c1c64` |

Acceptance evidence (2026-10-11): focused Vitest passed 6 files / 140 tests;
the expanded cross-boundary regression passed 3 files / 541 tests; the final
Primary Segment exact-card and effect-preservation suite passed 65 / 65;
typecheck passed; build passed with
`sha256:393c77d7b46d370f044374019c9668e0f328ec35c9c1448404bcd563469d76ee`;
`git diff --check` passed. Independent review found and then verified the repair
for one exact-card recovery defect; final Spec and Code verdicts passed with no
blocking findings. Commit:
`fix(human-review): suppress redundant choice reminders`.

Suggested atomic commit:
`fix(human-review): suppress redundant choice reminders`.

## Wave W4: `T4`

### - [x] T4: Keep inline Human Review visible on long cards

| Field | Content |
| --- | --- |
| What to build | Move Human Review controls before a long Timeline, preserve choice-free completion order, and sanitize reserved transport regions from every visible assistant channel. |
| Spec references | SCN-6, SCN-8, SCN-9, SCN-10, INV-3, INV-7 |
| Dependencies | T3 |
| Delegation mode | main-local |
| Mutation ownership | src/cards/turn-card.ts, src/runtime/herdr-events/event-projector.ts, tests/turn-card.test.ts, tests/herdr-event-projector.test.ts |
| Concurrency conflicts | None |
| Acceptance criteria and verification | Long cards show mention and choices prominently without reserved JSON; focused Turn Card, event-projector, Conversation Segment and Gateway View tests, typecheck, build, full suite and live Feishu E2E pass. |
| Verification commands | Focused four-file Vitest matrix; `npm test`; `npm run typecheck`; `npm run build`; `git diff --check`; configured live Feishu mention/button/callback E2E. |
| Verification results | Exit 0; focused tests passed 4 files / 121 tests; full Vitest passed 300 files / 4,596 tests; typecheck passed; build `sha256:7dc909d3dd465bce266d02ad0316f6d66ebfdbadfc61b27657914daaef594634`; independent review passed; live E2E rendered controls and consumed the selected option once. |
| Commits | `6d40781be80f389e5734580e8ae0cb4e871cb4b2` |

## Execution policy

Each ticket follows a main-observed Red-Green cycle and produces one
path-scoped atomic Conventional Commit after main inspection, fresh affected
verification, and independent ticket review. A worker result is provisional.
Do not begin a dependent wave until the previous checkbox, evidence, and commit
are recorded.

If implementation evidence shows that raw TraeX transcript hiding requires a
new tool/metadata transport, stop at the approved W1 boundary and leave that
work to the native side-channel design. Do not silently expand this plan.

## Final delivery checks

- [x] SCN-1 through SCN-13 and INV-1 through INV-11 map to committed tests.
- [x] Eligible first Stop is valid or blocked exactly once; repeated Stop never loops.
- [x] Owned protocol JSON is compact one-line JSON.
- [x] Every Feishu-visible projection contains no reserved fence or protocol JSON.
- [x] Protocol-only repair preserves one original Answer and one structured decision.
- [x] Primary Prompt, Worker Turn, and Primary Segment Human Review create no standalone reminder.
- [x] Choice-free notices and all one-shot callback fences remain unchanged.
- [x] Pending reminder cleanup is effect-safe, restart-safe, replacement-safe, and retention-safe.
- [x] Each ticket's focused tests, typecheck, and build pass with fresh main evidence.
- [x] Full `npm test` passes after all tickets.
- [x] Independent Standards and Spec reviews have no unresolved blocking finding.
- [x] Delivery artifact checker passes and the worktree is clean.
- [x] Installation, restart and live Feishu actions occurred only under separate user authorization; no push or PR occurred.

Final integrated evidence (2026-10-11): `npm test` passed 301 files / 4,640
tests; typecheck, build, architecture and documentation audits passed; the
installed immutable release is build
`sha256:38b12fd8c22f2fd4782fdd079311f492ab84c4a7cc756763a34f42d9a288b70d`
at commit `56d30a65a30b25d7572aac944754b96222584935`; `/health` is `ok` and
`/ready` is `ready` on the configured loopback endpoint.

Gate 3 approval authorizes T1 through T3 in the listed serial waves, ticket-level
TDD, path-scoped atomic commits, plan evidence updates, independent review, and
fresh verification. It does not authorize installation, restart, deployment,
production SQLite mutation, live Feishu testing, push, pull request, native
side-channel implementation, or the remaining P0/P1 optimization work.
