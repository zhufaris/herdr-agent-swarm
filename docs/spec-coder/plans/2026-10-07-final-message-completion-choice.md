# Final Message Completion Choice Metadata Implementation Plan

> **Status: superseded in part.** The legacy Hook ticket below that makes Stop
> permanently fail open with no repair was replaced by the implemented
> [2026-10-11 herdr-choice-list reliability one-repair plan](./2026-10-11-herdr-choice-list-reliability.md).
> The [2026-10-11 atomic terminal completion envelope](./2026-10-11-atomic-terminal-completion-envelope.md)
> records a cancelled historical native proposal; it is not current authority
> and cannot be resumed or used as a cutover plan.
> The historical body is retained unchanged below.

Specification:
[`docs/spec-coder/specs/2026-10-07-final-message-completion-choice.md`](../specs/2026-10-07-final-message-completion-choice.md)

## Workspace and Baseline

- Swarm specification/planning workspace: safe in-place checkout at
  `/workspace/herdr-agent-swarm`, branch `main`, wave base
  `f0a3f7b45f82fbb06ce003ef61ae23b0da583d1b`.
- Core implementation target: local `master` at
  `48fdcd625223e6f6e0c9363dbd0989309c738759`.
- In-place planning is safe because only new spec-coder artifacts are written;
  implementation that overlaps live Swarm or Core work uses isolated
  worktrees at the recorded execution-wave base.
- Preserve `.tmp-build/`, the three user-owned untracked Swarm files recorded
  in the specification, Core `.trae/`, and all unrelated worktrees.
- Fresh focused baseline: 6 Vitest files, 71/71 tests passed for current Choice
  protocol/Hook/plugin and Core-event adapter/projector behavior.
- `docs:audit` has pre-existing failures only in the user-owned untracked
  `docs/research/2026-10-02-session-message-jsonl-dependencies.md`; new artifacts
  pass `git diff --check` and must not absorb that unrelated file.
- Gate 1 design and Gate 2 specification were approved on 2026-10-07.
- Gate 3 implementation authorization was approved on 2026-10-07.

## Tickets

- [x] **T1: Consume and render structured final-message Choice in Swarm**

  | Field | Plan |
  | --- | --- |
  | What to build | Extend the Swarm Core-event boundary with optional `completion_choice`; round-trip it durably, translate it into the existing Completion Choice Specification/Action Set during terminal Primary and Worker projection, keep it out of visible Markdown, and let Feishu render buttons plus the existing ACK-gated mention. Retain legacy terminal-fence parsing and accept simultaneous structured/legacy values only when semantically equal. |
  | Spec references | SCN-1 through SCN-5; INV-3 through INV-8; Swarm Core-event adapter and projection; Feishu presentation and delivery; Compatibility & Migration. |
  | Dependencies | None. This is the tolerant consumer and must be deployable before T2/T3 producers. |
  | Delegation eligibility | Eligible at the standard tier: bounded Swarm-only behavior, deterministic adapter/store/card seams, no production credentials or main-only authority. |
  | Delegation mode | Default direct worker using trusted standard routing (`trae` / `GPT-5.6-Terra`). |
  | Ownership and implementation path | Core event adapter owns external snake-case validation; persisted event codec owns restart fidelity; Conversation/terminal projection owns translation into existing Completion Choice domain state; SQLite terminal transition owns atomic specification/action/view/outbox persistence; Feishu presentation consumes the durable view and never parses raw JSONL. |
  | Mutation ownership | Swarm domain Core-event types/codecs, event adapter/projector, Completion Choice terminal projection/store seams, Feishu Answer/Task rendering inputs, and focused tests. Exact paths are selected from existing modules during TDD; no Core files. |
  | Exclusions | No Core producer change, TraeX Hook change, migration of frozen historical cards, Primary-tool authority, Agent Input, deployment, production DB edit, or push. |
  | Isolation | Isolated Swarm worktree at the accepted main wave base because current main and live deployment work may continue concurrently. |
  | Concurrency conflicts | Owns Swarm Completion Choice parsing/projection files; cannot overlap T3 plugin wrapper tests if they edit the same shared protocol fixtures. T2 is a separate repository and may run in parallel after main observes independent Reds. |
  | Verification seam | Adapter and persisted-codec public seams; Primary/Worker terminal store integrations; pure Feishu card renderers; Delivery ACK/mention integration. |
  | Host capacity | One direct-child slot; parallel with T2 only when both have distinct isolated worktrees. Recheck capacity at wave formation. |
  | Direct-child boundary | `delegation_allowed = false`; child cannot delegate, stage, commit, deploy, restart, access production data, or push. |
  | Acceptance criteria and verification | Red-Green covers structured field round trip, pure visible text, one durable specification/action set, Primary and Worker ownership, structured/legacy equality and conflict, invalid/missing field, restart, card buttons, Ignore, ACK-before-mention, and duplicate replay. Run affected Vitest files, typecheck, architecture check, build, public audit, and diff check. |
  | Blocked by | None. |

- [x] **T2: Normalize terminal Choice into the same Herdr Core final event**

  | Field | Plan |
  | --- | --- |
  | What to build | In an isolated herdr-core worktree, add the bounded transport DTO and optional `completion_choice` field to `ReplyPayload::Message`; extract one exact terminal reserved fence from TraeX/Pi final text, keep clean text in the same message, omit `none`/invalid Choice, and use versioned message/final keys whenever a reserved block is consumed. Preserve normal/recovery identity, checkpoint, Event Ring, redaction, and additive schema behavior. |
  | Spec references | SCN-1 through SCN-4; INV-1 through INV-3, INV-6, INV-7; Herdr Core codec and event schema; Compatibility & Migration. |
  | Dependencies | T1 defines and verifies the tolerant consumer contract. Implementation may be prepared concurrently in a separate repository, but deployment is blocked by T1. |
  | Delegation eligibility | Eligible at the standard tier: bounded Core codec/schema work with deterministic Rust codec/journal/API tests and no production authority. |
  | Delegation mode | Default direct worker using trusted standard routing (`trae` / `GPT-5.6-Terra`). |
  | Ownership and implementation path | Core source codec owns exact bounded terminal extraction and raw-to-canonical translation; Core event schema owns the DTO; journal/Ring retain unchanged durable semantics. The DTO contains no Feishu/CardKit/Swarm persistence types. |
  | Mutation ownership | Core `src/agent_events/codec.rs`, `src/api/schema/agent_events.rs`, focused codec/journal/schema tests, and next-version generated API schema only. |
  | Exclusions | No Swarm files, no published stable schema rewrite, no TraeX runtime change, no terminal UI change, no install/live handoff, no push. |
  | Isolation | Separate Core worktree at Core `master` wave base; mandatory for parallel execution with T1. |
  | Concurrency conflicts | Cannot overlap other Core codec/schema mutation. It is file-disjoint from T1/T3 repositories. |
  | Verification seam | Core codec public decode output, checkpoint serialization, journal retry/recovery/Event Ring identity, API JSON/schema round trip. |
  | Host capacity | One direct-child slot and isolated Core worktree; may share a delegated wave with T1 if capacity allows. |
  | Direct-child boundary | `delegation_allowed = false`; child cannot delegate, stage, commit, install, live-handoff, operate panes, or push. |
  | Acceptance criteria and verification | Red-Green covers valid review, `none`, malformed/duplicate/nonterminal/oversized fences, ordinary code fences, clean text, v2 keys, Choice-free legacy keys, TraeX/Pi mapping, raw-field privacy, checkpoint restart, retry, live/recovery IDs, current schema version, and old Message JSON. Run affected Core tests, fmt, check, clippy, and full-suite baseline comparison. |
  | Blocked by | T1 for rollout; not for isolated implementation preparation. |

- [x] **T3: Produce Choice inline and make Stop permanently fail open**

  | Field | Plan |
  | --- | --- |
  | What to build | Add the synchronous `UserPromptSubmit` Hook to the owned plugin and wrapper so eligible Swarm-managed turns receive bounded inline-mode context before generation. Update the Skill wording for one original final answer. Change Stop behavior so missing, invalid, or absent Choice always completes without a repair continuation; retain exact eligibility/privacy boundaries and non-Swarm fail-open. |
  | Spec references | SCN-1, SCN-2, SCN-5; INV-1 through INV-3, INV-6, INV-8; TraeX plugin boundary; Behavior & Failure Modes. |
  | Dependencies | T1 for live rollout. The protocol shape is fixed by the approved specification. |
  | Delegation eligibility | Eligible at the standard tier: repository-owned plugin scripts/fixtures with deterministic wrapper tests and no need to invoke a live user session. |
  | Delegation mode | Default direct worker using trusted standard routing (`trae` / `GPT-5.6-Terra`), serialized after T1 when shared protocol fixtures overlap. |
  | Ownership and implementation path | Plugin Hook adapter owns bounded Host payload parsing and additional context; Skill owns Agent output instruction; Stop owns local fail-open inspection only. Neither Hook calls Feishu, creates workflow state, or sees prompt/answer content through the eligibility socket. |
  | Mutation ownership | `plugins/herdr-choice-list/`, completion-choice Hook/wrapper helpers and focused plugin tests; shared protocol fixtures only after T1 is integrated. |
  | Exclusions | No Core code, no Completion Choice SQLite writes, no card/outbox/mention creation from Hooks, no arbitrary business options, no live plugin reinstall or process restart, no push. |
  | Isolation | Serialized isolated Swarm worktree rebased on accepted T1 result because shared protocol tests may overlap. |
  | Concurrency conflicts | Must not mutate shared Completion Choice protocol tests concurrently with T1. T2 is independent. |
  | Verification seam | Plugin validation, UserPromptSubmit wrapper response, Stop missing/invalid fail-open, existing valid protocol, repeated Stop, eligibility socket failure, non-Swarm environment. |
  | Host capacity | One direct-child slot after T1 acceptance; recheck before dispatch. |
  | Direct-child boundary | `delegation_allowed = false`; child cannot delegate, stage, commit, install plugin, restart TraeX/Swarm, contact Feishu, or push. |
  | Acceptance criteria and verification | One submit-time activation, no Stop block/continuation for missing or invalid Choice, no prompt/answer leakage, existing-process compatibility notice, plugin package/installation fixtures, typecheck, build, public audit, and diff check all pass. |
  | Blocked by | T1 for rollout and shared-fixture integration. |

- [ ] **T4: Roll out consumer first and prove one-message Feishu behavior**

  | Field | Plan |
  | --- | --- |
  | What to build | Review both repositories, run final suites, install/restart Swarm consumer first, then build/install Core via supported live handoff and persist the binary, then install the updated plugin and create a new Swarm-managed TraeX Primary. Exercise one Human Review and one no-Choice final answer and prove one canonical final message, clean text, durable metadata, buttons, ACK-before-mention, and no second protocol message. |
  | Spec references | All scenarios/invariants; Compatibility & Migration; final delivery evidence. |
  | Dependencies | T1, T2, T3. |
  | Delegation eligibility | Main-only for final diff attribution, production authorization, service lifecycle, live evidence interpretation, and completion claim. Read-only review evidence may be delegated separately during delivery. |
  | Delegation mode | Main-local one-ticket wave after all implementation commits and delivery review. |
  | Ownership and implementation path | Swarm lifecycle owns consumer activation; Core live handoff owns Pane-preserving producer activation; plugin lifecycle owns new-process availability; Core/SQLite/Ring/CardKit evidence establishes correctness. |
  | Mutation ownership | No product code unless delivery review returns an in-scope TDD repair. Deployment state only after explicit rollout authority already present in the active user request is revalidated. |
  | Exclusions | No production data deletion, no automatic restart of existing TraeX Panes, no weakening approval policy, no push or PR. |
  | Isolation | Authoritative main/Core master after all accepted commits; no parallel mutation. |
  | Concurrency conflicts | Cannot overlap implementation or another service lifecycle operation. |
  | Verification seam | Full Swarm suite/checks, Core affected/full baseline, installed build identities, `/ready` and `/status`, exact Core final event, SQLite specification/action rows, Prepared Delivery/Ring ACK, Feishu card and mention counts. |
  | Host capacity | Main only; no worker slot required for mutations. |
  | Direct-child boundary | Any read-only reviewer receives `delegation_allowed = false`; main retains rollout and completion authority. |
  | Acceptance criteria and verification | Choice turn has one final Core message with clean text plus metadata, one specification/action set, buttons and one post-ACK mention; no-Choice turn has clean text and no buttons/mention; legacy fallback remains green; no Agent Input replay, duplicate cards, or protocol-only assistant message. |
  | Blocked by | T1, T2, T3 and successful delivery review. |

## Proposed Execution Waves

1. **Wave 1:** T1 and T2 may run as parallel standard delegated tickets only
   with separate validated Swarm/Core worktrees and two available direct-child
   slots. Otherwise serialize them in plan order.
2. **Wave 2:** T3 runs after T1 integration because protocol fixtures overlap.
3. **Delivery:** independent Standards and Spec review, followed by any
   in-scope TDD repair and fresh repository checks.
4. **Wave 3:** T4 is main-local consumer-first rollout and live acceptance.

## Final Delivery Checks

- Map every scenario/invariant to committed tests and verify dependency
  direction separately from behavior.
- Verify each commit contains only ticket-owned paths and no automated
  co-author trailer.
- Run the complete Swarm suite, typecheck, architecture check, build,
  documentation/public audits, and diff check; keep the unrelated untracked
  research-link audit debt separate.
- Run Core codec/journal/API tests, fmt, check, clippy, and compare the known
  host-sensitive full-suite baseline without waiving new failures.
- Verify consumer-first installed identities and live one-message Choice/no-
  Choice Feishu behavior from durable evidence.
- Preserve user-owned files and production data; do not push or open a PR
  without separate authorization.
