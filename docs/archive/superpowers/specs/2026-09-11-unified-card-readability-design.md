# Unified Feishu Card Readability Design

## Goal

Make the Primary Main Card, Primary Answer Card, Worker Main Card, and Worker
Task Card easier to scan in a busy Feishu group without changing their workflow
authority, delivery identity, or recovery behavior.

This specification is for maintainers changing the pure CardKit renderers. After
reading it, they should be able to adjust information order and visual hierarchy
while preserving every durable identifier, callback fence, page boundary, and
state transition.

## Shared visual system

All four cards use the same reading order:

1. identity and lifecycle in the header;
2. one compact current-state row;
3. the card's primary content;
4. actionable warning or recovery guidance when needed;
5. legal actions grouped together;
6. secondary history and runtime evidence last.

Renderer-owned section titles retain one semantic marker. State color, icon, and
text must agree: blue for queued/running, orange for blocked/uncertain/degraded,
green for ready/completed, red for failed, purple or grey for archived/stopped.
Emoji supplement text and never become the only state signal.

Cards use Chinese product labels consistently. Stable technical identifiers such
as Pane, Turn, model, branch, and generation remain code-formatted. Long values
are truncated only in display copies. Canonical state, request text, Agent
output, and recovery offsets remain unchanged.

Horizontal metric rows are preferred for two to three short related fields. A
vertical list is used for values that routinely wrap, such as worktree paths,
requests, output, and notices. Separators appear only between different semantic
groups, not between every field.

## Primary Main Card

The Primary Main Card answers three questions in this order: what is happening,
what changed recently, and where is it running.

- Header: `🧭 <title>` with `HERDR PROJECT · <state>` and the existing phase
  color.
- Current state: show the structured live-status block when available; otherwise
  show one compact status/queue summary. Actionable warning callouts immediately
  follow this state block.
- Latest message: show a bounded preview of at most six recent lines and 3,000
  display characters. Preserve both ends only when a single structured value is
  too large to understand from the prefix alone.
- Workers: show a compact summary of active Workers before detailed recent
  activity. Keep existing Worker navigation actions on the canonical Main Card.
- Recent activity: show at most five non-plan events. Do not repeat steps already
  visible in the live plan.
- Runtime footer: retain the compact horizontal identity/runtime rows for Space,
  Tab, Pane, model, context, queue, and worktree. It remains last.

The pane-entry snapshot reuses this hierarchy but removes every callback button
and appends the fixed instruction that replies enter the selected Primary. It is
not a second live Main Card.

## Primary Answer Card

The Answer Card prioritizes the Agent's response. Its opening must not make the
reader pass through a full activity history before reaching content.

- Header: keep the current answer lifecycle title, page number, request title,
  and phase color.
- First row: one compact line containing lifecycle, Pane identity, elapsed time
  when known, and queue position only while queued.
- Page 1 while queued/running/blocked: show the current progress summary and at
  most three active or newest progress events before the answer element.
- Page 1 after completion/failure: omit routine progress history. Show only an
  actionable failure/interruption callout when applicable, followed by the final
  answer.
- Continuation pages: show only the compact page identity/status row and answer
  content. Do not repeat request, progress, Worker activity, or generic notices.
- Worker activity: keep it only on page 1 and bound it to the three most relevant
  current/recent Worker summaries.
- Actions: keep the exact human-interruption continuation button immediately
  beside its warning. Do not add general controls to Answer Cards.

The Markdown element ID, CardKit streaming mode, final-fold panels, 9,000-source
pagination policy, canonical source offsets, and frozen-page rule do not change.

## Worker Main Card

The Worker Main Card answers: is this Worker usable, what is it doing, and what
can I do next.

- Header: retain `🤖 Worker · <name>` and phase color.
- Current state: merge runtime state, attachment/availability, model, and queue
  count into a compact top summary. Put a blocking or terminal notice directly
  below it.
- Current task: show title, phase, duration, and a bounded request preview. Show
  at most three progress rows and a bounded latest-output preview.
- Actions: group current-task continuation/interrupt and new-task actions in one
  action area. Display only actions legal for the current Worker and task state.
  Keep all existing callback payloads and identity fences unchanged.
- Queue and recent tasks: show next queued task when present, followed by at most
  five recent tasks. Use Chinese labels and shared lifecycle markers.
- Runtime details: move owner, Primary pane, Worker session generation, runtime
  generation, workspace, and branch to the final secondary section.

One-time Worker snapshots retain their explicit timestamp and canonical-card
link, but do not expose live mutation controls.

## Worker Task Card

The Worker Task Card follows the task itself rather than duplicating the Worker
session overview.

- Header: retain Worker name, short Turn ID, lifecycle color, and page number.
- First row: one compact lifecycle/queue/duration line.
- Request: show the bounded request on page 1 only. Continuation pages omit it.
- Progress: show while queued, preparing, running, blocked, or uncertain. Limit
  visible rows to the three active or newest events. Completed pages omit routine
  progress when captured output exists.
- Result: place completed output immediately after status on continuation pages
  and after the request on page 1. Empty, unavailable, failed, and uncertain
  outcomes retain explicit text rather than a blank section.
- Parent relationship: keep the parent Turn reference as compact secondary
  metadata rather than a full section.
- Actions: group continue/follow-up and interrupt actions after the content they
  affect. Navigation links remain last and only appear when their exact message
  identities are checkpointed.

Worker streaming element IDs, page state, source offsets, result-capture state,
action payloads, and exact-turn fences do not change.

## Rendering structure

Introduce small pure presentation helpers rather than one universal card
component:

- a compact metadata-row formatter;
- a bounded activity selector shared by Primary and Worker cards;
- an action-row builder that omits empty rows;
- a passive-card filter for snapshots that removes callback elements recursively;
- shared localized labels for queue, current task, recent tasks, runtime, and
  output.

Each renderer keeps ownership of its card-specific layout. Helpers accept already
sanitized display strings or perform the existing bounded normalization. They do
not read SQLite, infer workflow state, mutate domain views, or generate callback
identity.

## Stability and safety constraints

- Rendering remains pure and deterministic for the same view and options.
- No change to outbox kind, idempotency key, projection revision, lane, claim,
  ACK, retry, recovery ledger, or thread alias behavior.
- No change to canonical transcript text, pagination source units, content hash,
  or Answer coverage evidence.
- Existing redaction runs before any user or Agent text is displayed.
- Card payloads stay under the configured payload limit. Truncation applies to
  display copies only.
- No unsupported CardKit elements or legacy action containers are introduced.
- Buttons remain absent until their durable message identity and lifecycle fence
  are available.

## Verification

Pure renderer tests must cover each phase and assert exact ordering of semantic
sections, bounded line counts, localized labels, legal actions, passive snapshot
behavior, and CardKit schema compatibility. Existing workflow tests must prove
that callback payloads, targets, element IDs, page starts, sequence numbers, and
outbox payload stability are unchanged.

The final gate is the affected card suites, Answer workflow and Worker projection
tests, architecture checks, full `npm test`, typecheck, build, and local `v0.4.0`
release packaging. No real Lark message, installation, restart, tag, or remote
release is part of this change.

## Non-goals

- New commands, workflow states, persistence tables, or remote-control powers.
- A second live Main Card for pane-entry threads.
- Rich animation, custom images, or terminal-style chrome.
- Rewriting arbitrary Agent prose to add decorative markers.
- Changing the separate instances multi-Agent usability work.
