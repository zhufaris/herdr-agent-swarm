# Herdr Choice List Submit-Time Activation

## Problem Statement

The repository-owned `herdr-choice-list` integration currently waits until an
eligible Swarm-managed TraeX turn reaches its first `Stop`. The Stop Hook then
blocks that stop and asks the same Agent to invoke
`$herdr-choice-list:herdr-choice-list` in a protocol-only continuation. This
produces a reliable terminal decision, but every eligible completion pays for a
second model continuation, including answers whose decision is
`intent: "none"`.

TraeX supports a synchronous `UserPromptSubmit` command Hook that can append
model context before the first assistant response. The intended change uses
that hook to activate the Skill during the original turn, while retaining the
Stop Hook as a bounded validator and repair path. The notification itself must
remain downstream of the canonical Core final event and the existing durable
Completion Choice projection; prompt submission must not directly create a
card, outbox row, Prompt, Turn, or notification.

## Solution

Register both `UserPromptSubmit` and `Stop` in the owned
`herdr-choice-list` plugin. For an exactly eligible Swarm-managed TraeX turn,
`UserPromptSubmit` injects constant additional context that explicitly invokes
the Skill in **inline mode**. The Agent answers the user normally and appends
exactly one version-2 terminal `herdr-choice-list` block. The Skill decides from
the completed answer whether to emit `intent: "none"` or
`intent: "human_review"`. For Human Review, the Agent dynamically derives the
question, ordered options, default, labels, and submitted messages from the
actual decision presented by that turn's completed answer. Neither Hook nor
Swarm supplies a fixed business-choice vocabulary or template.

The existing Stop path becomes validation and recovery. A valid terminal
decision passes immediately. A missing or invalid decision on the first Stop
blocks once and explicitly invokes the same Skill in **repair mode**, which
emits only the protocol block and does not repeat or rewrite the visible
answer. A repeated Stop remains unconditionally fail-open.

This is a producer-timing change. The version-2 protocol, terminal parser,
Completion Choice Specification, SQLite state, Completion Action Set, CardKit
rendering, callback handling, completion-notification obligation, and outbox
remain authoritative and unchanged.

## User Stories

### SCN-1: Complete an ordinary answer in one model turn

When an eligible Primary Prompt or Worker Turn reaches `UserPromptSubmit`, the
Hook verifies its exact Swarm owner and injects the inline Skill activation. If
the completed answer needs no human decision, the Agent appends a valid
`intent: "none"` block. The first Stop accepts it, the protocol is omitted from
visible Markdown, and Swarm creates neither a Completion Action Set nor a
completion notification.

### SCN-2: Publish Human Review choices from the original turn

When the completed answer needs a decision, the Agent appends a valid
`human_review` decision during the original turn. Its question and options are
dynamically extracted from the concrete alternatives or next actions in that
answer; they are not selected from a fixed `approve / continue / reject` menu.
The first Stop accepts it. After Core publishes the canonical final event, the
existing terminal projection persists the normalized choice, renders those
exact one-shot buttons, and releases the existing durable notification only
after its Answer revision is acknowledged.

### SCN-3: Repair a missing or invalid terminal decision

If submit-time activation was delivered but the first answer omits the block
or produces an invalid terminal block, the first Stop requests exactly one
repair continuation. The continuation invokes the Skill in repair mode and
emits protocol only. The repeated Stop always allows completion, whether or not
repair succeeded.

### SCN-4: Recover from submit-time integration failure

If `UserPromptSubmit` receives malformed or oversized Hook input, lacks exact
Herdr/Swarm identity, fails eligibility, cannot reach the private socket, or
times out, it emits no additional context and does not block the user prompt.
If eligibility is available by Stop time, the existing repair path can still
request the terminal decision. Otherwise Stop also fails open.

### SCN-5: Upgrade and roll back the owned plugin

Standalone lifecycle activation upgrades the owned plugin from version 1.0.0
to 1.1.0 while keeping activation schema version 1. The new release validates
and records its own source and helper paths. If later activation fails, the
lifecycle can validate and reinstall the recorded 1.0.0 source, restore its
activation bytes, and recover the Stop-only behavior. A Hook observed during a
version-mismatch window fails open.

## Implementation Decisions

### Domain Model

The affected bounded context remains **Trace-End Human Review**. No new entity,
aggregate, persistent state, or domain event is introduced.

Observed and retained concepts:

- A **Completion Choice Specification** is the immutable normalized value
  produced only by a valid terminal protocol block.
- A **Completion Action Set** remains the one-shot aggregate owning actor,
  owner, generation, card, option, successor, and consumption fences.
- A **completion notification obligation** remains the durable publication
  gate after the actionable card revision is delivered.

The proposed terms **inline mode** and **repair mode** describe Skill invocation
behavior at the TraeX adapter seam. They are not persisted domain states and do
not change the protocol.

The enforcing invariants are:

- **INV-1:** Only one valid `herdr-choice-list` block at the physical end of a
  terminal answer can become a Completion Choice Specification.
- **INV-2:** An eligible original turn appends at most one decision block, and
  Stop may request at most one repair continuation.
- **INV-3:** Hook eligibility exchanges contain only pane, owner, generation,
  and project identity. User prompt and assistant answer content never cross
  the private eligibility socket or enter Hook logs.
- **INV-4:** Neither Hook creates or mutates a Prompt, Turn, Completion Action
  Set, card, outbox item, or notification.
- **INV-5:** A notification is possible only after the canonical Core final
  event has produced a valid, durable Human Review specification and the
  actionable card revision has been acknowledged.
- **INV-6:** Malformed, stale, unavailable, non-TraeX, or repeated Hook paths
  fail open; they cannot prevent the Agent from eventually stopping.
- **INV-7:** Completion choices cannot approve native tools, write terminal
  input, control processes or Panes, or resolve a Herdr-`blocked` episode.
- **INV-8:** Human Review question, option order, IDs, labels, messages, and
  default are Agent-declared values dynamically derived from the current final
  answer. Hooks, Swarm coordinators, stores, and renderers may validate,
  persist, and project them but must not replace them with fixed business
  choices.

### Architecture

#### Plugin adapter

The plugin Hook manifest registers one synchronous `UserPromptSubmit` command
Hook and one synchronous `Stop` command Hook. Both invoke one bounded generic
wrapper. The wrapper reads the documented JSON payload with the existing byte
and timeout limits, validates the owned activation record, invokes the
release-private helper, and writes only a valid Hook response. It remains
fail-open on all wrapper, activation, child-process, timeout, and output errors.

`UserPromptSubmit` ignores matcher configuration by TraeX contract. The helper
therefore performs its own exact eligibility check. It does not classify or
forward the `prompt` field. For an eligible event it returns constant context
equivalent to:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Use $herdr-choice-list:herdr-choice-list in inline mode for this turn. Answer normally, then append exactly one terminal herdr-choice-list protocol block."
  }
}
```

#### Runtime Hook module

The runtime Hook module exposes two small interfaces:

- submit handling validates `hook_event_name`, bounded `prompt` shape, bridge
  identity, and eligibility, then returns either the constant
  `additionalContext` response or an empty response;
- Stop handling validates the terminal assistant message and retains its
  existing valid-pass, first-stop-repair, and repeated-stop-allow outcomes.

Identity parsing and the `CompletionChoiceEligibilityPort` are shared private
implementation. The runtime module depends on the domain protocol inspector
and the domain-owned eligibility port. Plugin and CLI adapters depend inward on
that runtime interface; domain, coordinator, store, and card modules do not
depend on TraeX Hook payloads.

#### Skill contract

The Skill supports two explicitly requested modes:

- **inline:** answer the user normally, then append exactly one version-2
  terminal decision block;
- **repair:** emit only one version-2 decision block without repeating,
  summarizing, or rewriting the preceding answer.

Both modes apply the same existing bounds for question, options, IDs, labels,
messages, default, reserved `ignore`, and total block size. Inline activation
does not infer review need from the incoming user prompt. The Agent evaluates
its completed answer and emits either `none` or `human_review`. For
`human_review`, it derives the question and each option from the actual choices
or next actions stated in that answer. The Skill contains protocol rules and
examples only; examples are not reusable product defaults. It must not invent
generic `approve`, `continue`, or `reject` options unless those are the real
alternatives in the completed answer.

#### Durable completion and notification path

The reserved terminal fence remains hidden during streaming and removed from
visible final Markdown. The existing terminal settlement and recovery seams
continue to normalize and persist the decision. No new SQLite migration,
projection type, CardKit payload, callback schema, idempotency key, or outbox
operation is introduced.

Control flow may reach the external eligibility adapter twice, but source
dependencies continue to point from plugin/CLI adapters toward runtime and
domain-owned interfaces. The composition root continues to assemble the
private eligibility gateway.

### Behavior & Failure Modes

The normal success path is:

1. `UserPromptSubmit` receives a bounded event.
2. The private socket proves current Primary/Worker, Pane, runtime, project,
   and generation eligibility.
3. Constant inline activation is added to model context.
4. The original answer ends with a valid version-2 decision.
5. Stop validates and allows without continuation.
6. Core publishes the final event; existing durable projection and delivery
   behavior continues unchanged.

Failure and recovery behavior:

- Submit input, identity, socket, timeout, or eligibility failure returns no
  injection and never blocks prompt submission.
- A valid v1 compatibility block or valid v2 decision at Stop passes.
- A missing or invalid decision at the first eligible Stop requests repair.
- `stop_hook_active=true` always passes without eligibility lookup, preventing
  recursive repair.
- If both inline generation and repair fail, the answer completes without a
  new Completion Choice; the system does not synthesize choices from prose.
- Duplicate submit-time activation is semantically idempotent because it has
  no external or durable effect and still requires one terminal block.
- Hooks and Swarm never extract choices with regexes or replace Agent-declared
  values with a fixed fallback. If the Agent cannot identify a useful concrete
  decision, it emits `intent: "none"`.
- Selection callbacks and notification retries continue using their existing
  durable idempotency and do not replay Agent work.

### Compatibility & Migration

Protocol version 2 and version-1 read compatibility remain unchanged. Existing
completed answers and stored action sets are not reparsed or rewritten.

The plugin manifest advances from 1.0.0 to 1.1.0. The activation record keeps
schema version 1 and continues recording its exact plugin version, source path,
helper path, socket path, and build identity. Lifecycle validation distinguishes
the current candidate from a previously owned activation: the candidate must
match version 1.1.0 and its new wrapper/helper files, while an explicitly
supported prior 1.0.0 record is validated against its own manifest and stored
paths so rollback remains possible. Unknown or unowned versions remain a hard
installation error rather than being adopted.

No database migration, service configuration, Pane replacement, Core schema
change, or historical backfill is required. Runtime Hook mismatch remains
fail-open during the bounded install/rollback transition.

## Testing Decisions

- **SCN-1 / INV-1 / INV-2:** plugin and runtime tests prove an eligible Submit
  returns the inline activation; valid `none` reaches first Stop without a
  continuation.
- **SCN-2 / INV-4 / INV-5 / INV-8:** fixtures with materially different final
  decisions preserve their distinct Agent-declared questions, option order,
  labels, messages, and defaults through protocol normalization, terminal
  settlement, card rendering, notification obligation, and outbox behavior.
  No Hook or Swarm layer substitutes a fixed business-choice set.
- **SCN-3 / INV-2 / INV-6:** focused Stop tests prove missing and invalid
  decisions request one repair, while repeated Stop always passes without an
  eligibility call.
- **SCN-4 / INV-3 / INV-6:** submit tests cover malformed and oversized input,
  missing environment identity, false/rejected/timed-out eligibility, and
  assert that prompt text is never included in the eligibility request or Hook
  output.
- **SCN-5:** owned-plugin and lifecycle tests cover a clean 1.1.0 install,
  upgrade from recorded 1.0.0, compensation after partial activation, rollback
  to 1.0.0, private activation data, and rejection of unknown/unowned versions.
- Wrapper tests feed documented `UserPromptSubmit` and `Stop` payloads and
  verify bounded stdin/stdout, event dispatch, timeout, malformed helper output,
  and fail-open behavior.
- Skill contract tests verify inline and repair instructions, explicit
  namespaced invocation, version-2 `none` and `human_review`, one terminal
  block, one-to-four dynamically derived business options, examples marked as
  non-defaults, and system-owned Ignore.
- Structural evidence verifies that domain, coordinator, store, and card
  modules do not import TraeX Hook payload or plugin adapter types.
- Required verification is focused Hook/plugin/lifecycle testing followed by
  `npm run typecheck`, `npm run build`, and full `npm test`.

## Out of Scope

- Prompt-text heuristics for deciding whether to activate the Skill.
- Fixed product-level business-choice templates or fallback options.
- Direct notification or card creation from `UserPromptSubmit` or `Stop`.
- Changes to protocol version 2, Completion Choice persistence, CardKit,
  callbacks, notification obligations, or outbox semantics.
- More than one Stop repair continuation or guaranteed recovery from model
  noncompliance.
- Automatic default selection, native approval/denial, terminal input, process
  control, or Pane control.
- Producer integrations for runtimes other than TraeX.
- Historical answer reprocessing or live service deployment.

## Further Notes

- Workspace mode: safe in-place specification writing at
  `/workspace/herdr-agent-swarm` because the native Host
  worktree tool would branch from `origin/main`, which predates the entire
  Completion Choice implementation. The existing same-topic worktree is clean
  but diverged from current HEAD and is not reused.
- Branch: `main`; starting revision:
  `ab92bb05a028d6623f7f68d7dd3d49489fb71e1b`.
- Initial user-owned changes preserved: modified
  `docs/spec-coder/plans/2026-10-07-core-event-card-realtime.md` and
  `docs/spec-coder/specs/2026-10-07-core-event-card-realtime.md`; untracked
  `.tmp-build/`, `docs/research/2026-10-02-session-message-jsonl-dependencies.md`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Dependency readiness: existing locked dependencies were sufficient; no
  install or dependency mutation was performed.
- Fresh baseline at the starting revision and recorded initial changes:
  `npm run typecheck` passed; `npm run build` passed with build identity
  `sha256:b28eae2990a1bff3e486f82d8579d4ee3adcf8e80c987093a5634f8d12b3dc2b`;
  `npm test` passed 286 files and 4,075 tests.
- Gate 1 design approval: approved in conversation on 2026-10-07.
- Gate 2 specification approval: approved in conversation on 2026-10-07 after
  clarifying that all product business choices are dynamically Agent-derived.
- Unresolved load-bearing decisions: none.
