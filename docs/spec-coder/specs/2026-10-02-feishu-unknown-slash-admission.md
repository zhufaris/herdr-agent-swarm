# Feishu Unknown Slash Admission

## Problem Statement

Ordinary Feishu text is durably recorded in `inbound_messages` and then routed
into Primary Prompt admission. The current router deliberately treats text such
as `/ti`, `/hooks`, `/new`, and any other slash text that is not recognized by
the Swarm or instance command parsers as an ordinary Prompt. Prompt admission
therefore creates a Prompt Input, Native Input Batch, execution Prompt, and
Run/Answer projection before Herdr writes the text to TraeX.

TraeX commands that do not start a native turn produce no canonical JSONL
`human_message` or `turn_started` event. Herdr can consequently report
`agent_prompt_stalled` after writing the PTY input. Because that external effect
cannot safely be declared absent, Swarm preserves the execution as
recovering/detached and does not replay it. This is correct uncertainty handling
after submission, but it allows an unsupported Feishu slash command to occupy
the Prompt FIFO and block later work.

The intended change is to keep Feishu's durable inbound identity and feedback
delivery while refusing unsupported slash text before Prompt admission. Native
JSONL remains the only authority for accepted Human Message content, turn
ownership, and ordering.

## Solution

At the Feishu message-routing boundary, route recognized Swarm and instance
commands exactly as today. After those parsers have declined the message, reject
text whose first non-whitespace character is `/` instead of routing it as an
ordinary Prompt. Enqueue the existing durable rejection card with an
idempotency key derived from the Feishu message ID, and return a terminal
`rejected` routing disposition.

The durable inbound pipeline continues to retain and deduplicate the original
Feishu event. It marks the event accepted after the terminal rejection result,
so service restarts and duplicate delivery do not repeat admission. The rejected
message creates no Prompt Input, Native Input Batch, execution Prompt, or
Run/Answer projection and causes no Herdr or TraeX call.

This change applies only to Feishu routing. Native TraeX slash commands remain
available in the local Herdr Pane. Ordinary text that contains `/` anywhere
other than its first non-whitespace character remains eligible Prompt input.

## User Stories

### SCN-1: Reject unsupported Feishu slash text before Prompt admission

As a Feishu user in a bound Primary Thread, when I send `/ti`, `/hooks`, `/new`,
or another slash expression not recognized by the existing Swarm or instance
command parsers, I receive a durable rejection card explaining that Feishu
accepts Swarm commands and that native TraeX commands must be used in the Herdr
Pane. The message never becomes a Prompt or native submission.

### SCN-2: Preserve recognized command routing

As a Feishu user, existing `/swarm ...` and instance command namespaces retain
their existing parsing, authorization, help, confirmation, and execution
behavior. A malformed command inside a recognized namespace continues through
that namespace's existing help or rejection behavior rather than the new
unsupported-slash path.

### SCN-3: Preserve ordinary text containing slash characters

As a Feishu user, text such as `please inspect /tmp/output` or `compare a/b`
continues through ordinary Prompt admission. Only a slash at the first
non-whitespace position activates the new refusal.

### SCN-4: Rejection does not block later work

As a Feishu user, after an unsupported slash message is terminally rejected, a
later ordinary message in the same inbound scope can be admitted and executed
normally. Duplicate delivery of the rejected Feishu event does not create
another Prompt or duplicate rejection delivery.

## Implementation Decisions

### Domain Model

The affected contexts are **Inbound Routing** and its neighboring **Prompt
Execution** context.

- Inbound Routing owns the classification of a Feishu message as a recognized
  command, ordinary Prompt candidate, or terminally rejected input.
- Prompt Execution owns Prompt Inputs, Native Input Batches, Prompt lifecycle,
  native submission, and JSONL-correlated execution. It must not receive an
  unsupported slash message.
- `inbound_messages` is a durable transport/intake record, not a canonical
  Human Message transcript. Retaining it after rejection supports idempotency,
  audit, and restart recovery without implying TraeX acceptance.
- A **canonical Human Message** remains an event observed from the native JSONL
  stream. No synthetic canonical event is created from the Feishu record or
  rejection card.

The routing workflow enforces these invariants:

- **INV-1:** Unsupported Feishu slash text cannot create Prompt Execution state.
- **INV-2:** Its routing outcome is terminal, so it cannot retain or repeatedly
  claim the same inbound FIFO position.
- **INV-3:** Repeated delivery uses the existing Feishu message identity and
  rejection outbox identity; it cannot create a second Prompt or feedback
  effect.
- **INV-4:** Ordinary Human Message content, turn ownership, and order remain
  authoritative only after JSONL/Core observation.
- **INV-5:** Existing uncertain or detached Prompts are unchanged and are never
  automatically replayed or migrated by this feature.

No new entity, aggregate, value object, repository interface, or glossary term
is required. This is a routing policy over existing message and Prompt models.

### Architecture

`InboundMessageRoutingWorkflow` remains the deep module that converts normalized
Feishu messages into command execution, Prompt admission, or user feedback. It
will apply the unsupported-slash check only after `parseInstanceCommand` and
`parseCommand` have had their existing precedence. The check stays at this
application boundary rather than leaking Feishu syntax into Prompt persistence
or the Herdr adapter.

The existing interfaces remain sufficient:

- input: normalized `IncomingLarkMessage`;
- command classification: existing pure parsers;
- rejection output: existing `OutboundIntentPort.enqueueCard` and
  `PrimaryPresentation.requestRejected`;
- result: existing `InboundRoutingResult` with `disposition: "rejected"`;
- Prompt seam: existing `PromptAdmissionWorkflowPort`, which is not called for
  this outcome.

No database schema or external protocol changes are introduced. Source
dependencies remain coordinator -> domain ports, with concrete SQLite and Lark
adapters assembled at the composition root.

### Behavior & Failure Modes

Classification order is:

1. Existing Worker Session Thread handling.
2. Existing instance command parsing and handling.
3. Existing `/swarm` command parsing and handling.
4. Unsupported leading-slash rejection.
5. Existing orchestrator, natural-language, and ordinary Prompt routing.

The leading-slash predicate trims surrounding whitespace only for
classification. It does not rewrite message content. A failure while reserving
the rejection card remains a retryable inbound failure under the existing
durable pipeline. Once reservation succeeds and routing returns `rejected`, the
inbound message becomes terminally accepted. The outbox owns delivery retry and
must not rerun Prompt admission.

### Compatibility & Migration

This intentionally removes Feishu passthrough for native TraeX slash commands,
including slash commands that might be valid locally but do not create a turn.
They remain available in the Herdr Pane. Documentation must replace the current
statement that unknown slash text is submitted to TraeX.

There is no historical migration. Prompts already created, submitted,
recovering, or detached retain their existing state and recovery controls. An
operator may use the existing `/swarm skip` behavior where its current
preconditions are satisfied.

## Testing Decisions

- At the `InboundMessageRoutingWorkflow` interface, replace the existing test
  that expects `/plan x` to enter managed Prompt acceptance. Assert a terminal
  rejection, one idempotent rejection-card reservation, and zero Prompt
  admission calls. Cover leading whitespace and preserve recognized command
  precedence.
- At the existing concurrency/integration seam backed by SQLite, replace the
  unsupported-command submission scenario. Assert no matching `prompt_inputs`,
  `native_input_batches`, `prompt_jobs`, or Run Card is created; neither
  `runPrompt` nor `queuePrompt` receives the slash text; and a following ordinary
  message completes normally.
- Add a routing regression showing that ordinary text containing `/tmp` or
  `a/b` still reaches Prompt admission.
- Preserve the existing recognized `/swarm` and instance-command tests.
- Run the affected routing and concurrency suites, TypeScript typecheck, build,
  and the full Vitest suite before delivery.

## Out of Scope

- Forwarding or allowlisting native TraeX slash commands from Feishu.
- Parsing TraeX terminal output to infer whether a command exists.
- Changing Herdr Core receipt semantics or the TraeX JSONL format.
- Automatically terminalizing, skipping, replaying, or migrating historical
  uncertain/detached Prompts.
- Changing Worker Thread slash handling, which already rejects unsupported
  commands at its own routing boundary.

## Further Notes

- Workspace mode: isolated Git worktree.
- Workspace: `/tmp/herdr-agent-swarm-feishu-slash-admission`.
- Branch: `fix/feishu-unknown-slash-admission`.
- Starting revision: `00bfce11e29f69dfafb42f7d3e094f2d50c37273`.
- Isolation rationale: the original checkout contains a modified `TODO.md` and
  unrelated untracked files and worktrees. None were copied or changed.
- Worktree mechanism: Git fallback after the native worktree tool reported an
  already-active managed session and could not switch to a `/tmp` worktree.
- Dependency baseline: `npm ci --cache /tmp/npm-cache` completed from the locked
  dependency graph. NPM reported one pre-existing high-severity audit finding;
  dependency remediation is outside this change.
- Fresh behavioral baseline:
  `npx vitest run tests/inbound-message-routing-workflow.test.ts tests/inbound-message-dispatcher.test.ts tests/concurrency-controls.integration.test.ts`
  passed 66 tests in 3 files.
- Fresh structural baseline: `npm run typecheck` and `npm run build` both passed;
  build identity SHA-256 was
  `61d645560bd0c93f99670ef979bfbbefe1a8e42556696c7fe48178a3b5172e3d`.
- No unresolved load-bearing design decision remains.
