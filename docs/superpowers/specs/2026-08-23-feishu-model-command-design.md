# Feishu Model Command Design

## Goal

Expose TraeX's native model command in a bound Feishu project topic without
turning it into an agent prompt. Users can inspect or change the model with:

- `/model`
- `/model <name>`
- `/herdr model`
- `/herdr model <name>`

The short form is the primary interface. The `/herdr` form is an equivalent
alias so the command remains discoverable in the bridge help card.

## TraeX contract

TraeX 0.201.5 opens an interactive selector when `/model` is submitted. Text
following `/model` is not a supported direct argument and may become an ordinary
agent prompt. The bridge therefore translates `/model <name>` and card selection
into the native selector sequence: open `/model`, type the exact model filter,
confirm it, and wait for the composer to return.

The bridge delegates model resolution to TraeX. It does not maintain a second
model catalog, rewrite names, guess providers, or mutate `traecli.toml`. This
keeps the result consistent with the exact TraeX process attached to the Pane.

## Command routing

Command parsing recognizes `/model` before the existing `/herdr` grammar. The
optional argument is trimmed at its outer boundary and otherwise preserved.
`/herdr model [name]` normalizes to the same command value. Empty arguments map
to a model-list request.

The coordinator handles this command outside the prompt queue. It does not
create a PromptJob, Request card, Answer card, progress event, or agent turn.
It also does not invoke `runPrompt`, because a slash command can finish without
TraeX entering a working agent state.

## Eligibility and concurrency

The command requires a binding whose lifecycle and state are active and whose
Pane is still attached and present. Otherwise the bridge replies with the same
bounded rejection style used by other topic commands.

Model inspection and switching are accepted only when the binding has no
running prompt and no queued prompt. This prevents command text from being
inserted into an active editor, approval interaction, or queued conversation.
The rejection tells the user to retry after the current work and queue finish.

The coordinator serializes model commands per binding. A second model command
cannot interleave its terminal snapshots or keystrokes with the first. Ordinary
prompt dispatch for that binding observes the same command lock, so a newly
arriving prompt cannot begin between sending `/model` and collecting its result.
Other bindings remain independent.

## Herdr command operation

`HerdrPort` gains a bounded operation for executing a non-agent Pane command.
The adapter:

1. reads a small terminal snapshot;
2. sends `/model` with the existing reliable `send-text` then `Enter` submission
   path;
3. polls for a stable post-command terminal snapshot until a short timeout; and
4. returns only the new visible output attributable to the command; and
5. closes the selector with Escape after collecting its model catalog.

The operation does not wait for an agent-state transition. Snapshot comparison
removes the echoed command and repeated pre-command lines. ANSI controls and
terminal redraw artifacts are normalized, and the existing output redaction
policy is applied before the result is logged, persisted, or sent to Feishu.
Output is bounded so a large model catalog cannot exceed card limits. If terminal
history rolls over, extraction starts at the newest exact `/model` echo and never
falls back to replaying the full visible terminal.

If no stable output is observed before the timeout, the operation fails rather
than claiming that the model changed.

## Result card

Each invocation replies once in the current topic with a compact standalone
card. Its header follows the existing identity convention:

`TraeX · <space> / <pane>`

The subtitle is `HERDR MODEL`. A parsed native selector becomes a Feishu
`select_static` list with the current model preselected. Selecting an option opens
the native TraeX selector, chooses that exact model, and updates the same Feishu
card with the refreshed catalog. Unparseable output falls back to sanitized native
text. The model card remains outside the main project activity feed.

## Errors and audit

- Unbound or archived topic: reject without touching Herdr.
- Missing or mismatched Pane: use the existing attachment failure handling and
  do not send the command.
- Running or queued work: reject and ask the user to retry when idle.
- Unknown or ambiguous model: show TraeX's native bounded response; this is a
  completed command with an unsuccessful selection, not a bridge failure.
- Submission, read, or timeout failure: show a bounded execution-failure card.

Every attempt records an audit entry with actor, binding, requested model or
`list`, and outcome. Model arguments are safe identifiers but still pass through
structured logging rather than interpolated free-form log messages.

## Help and documentation

The Feishu help card lists both forms and explains that model switching is only
available in an idle, bound project topic. The user documentation adds examples
for listing models, selecting a model, and handling ambiguous names.

## Verification

Tests must prove:

1. `/model`, `/model <name>`, `/herdr model`, and `/herdr model <name>` parse to
   the same model command shape;
2. unrelated text and malformed command forms preserve existing routing;
3. model commands never create PromptJobs or Request/Answer cards;
4. unbound, archived, orphaned, busy, and queued bindings are rejected without
   Pane input;
5. eligible commands use the dedicated Pane command operation with the exact
   normalized TraeX command;
6. model commands and prompt starts cannot interleave for one binding;
7. command output excludes echo, pre-command lines, ANSI, redraw artifacts, and
   secrets;
8. current-model lists, successful switches, ambiguous matches, and unknown
   models render in bounded result cards;
9. timeout and adapter failures never report a successful switch;
10. the help card and usage documentation contain both supported forms; and
11. focused tests, the full suite, typecheck, and build pass.
