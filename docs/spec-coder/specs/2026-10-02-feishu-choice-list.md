# Feishu Completion Choice Lists

## Problem Statement

Herdr Agent Swarm currently appends one fixed completion action set (`default`, `批准`, `继续`, `拒绝`) to eligible final Primary Answer and Worker Task cards. An Agent can end with a concrete choice such as “请选择方案 1、2 或 3；回复 default 即选择方案 1”, but the Feishu user must still type the response or use an unrelated fixed action.

The intended change lets a Swarm-managed TraeX Agent actively attach a machine-readable choice list to that final answer. Only when one trace reaches its end and TraeX emits the `Stop` event, a scoped command Hook detects a likely terminal choice request and, at most once, continues that same trace with an instruction to load the `herdr-choice-list` Skill. The Agent—not the Hook—then emits structured JSON. Swarm validates and persists the list, omits the protocol from Feishu-visible Markdown, and renders the declared options as one-shot Feishu buttons. The default option is visually primary and sends `default` only when clicked.

## Solution

### Agent-produced protocol

The `herdr-choice-list` Skill instructs the Agent to append only one reserved fenced block after its already-produced answer:

````markdown
```herdr-choice-list
{
  "version": 1,
  "default": "option-1",
  "options": [
    { "id": "option-1", "label": "方案 1（默认）", "message": "default" },
    { "id": "option-2", "label": "方案 2", "message": "2" },
    { "id": "option-3", "label": "方案 3", "message": "3" }
  ]
}
```
````

The continuation must not repeat or rewrite the visible answer. The Agent derives labels and submitted messages from its own preceding final response and emits the protocol block itself. The Hook may classify, validate, and request this continuation, but it never synthesizes option content.

Only a valid physical-terminal block is protocol. It is removed from Feishu-visible Markdown, converted into a durable Completion Choice Specification, and rendered instead of the fixed completion actions. The declared default is visually primary but is never submitted automatically. Clicking it submits its persisted `message` (`default` in the example) through the same ordinary follow-up path as typed text.

The version-1 protocol is bounded to 8 KiB and requires two through five ordered options, unique option IDs, one resolvable `default`, labels of at most 40 characters, and non-empty messages of at most 2,000 characters and within ordinary prompt-admission limits. Whitespace after the closing fence is allowed. Protocol-looking content elsewhere is ordinary Markdown.

### Scoped Skill and Stop Hook

The standalone distribution owns a small TraeX integration containing:

- the user-visible `herdr-choice-list` Skill;
- a `Stop` command Hook registration; and
- a bounded local Hook helper that reads TraeX Hook JSON from stdin and writes only the documented Hook JSON response to stdout.

This is a TraeX integration for the standalone service, not a revival of the retired Herdr compatibility plugin and not a second service/operator surface. Installation and removal are managed by the existing standalone setup/lifecycle flow.

The integration registers only the TraeX `Stop` event for this feature. It is not invoked for streaming deltas, intermediate assistant messages, tool-use boundaries, progress/status events, or any other point inside a trace. A blocked first Stop resumes the same trace only long enough for the Agent to append the protocol; it does not create a new Prompt, turn, or trace.

The Hook registration may be user-visible to TraeX, but its behavior is fail-open and scoped to eligible Swarm sessions. The installed plugin resolves the active service's private Hook socket through versioned plugin data maintained by the standalone lifecycle. The helper requires the existing `HERDR_BRIDGE_BINDING_ID`, `HERDR_BRIDGE_GENERATION`, and `HERDR_PROJECT_ID` identity together with `HERDR_ENV=1` and `HERDR_PANE_ID`, then asks the mode-`0600` Swarm-owned Unix socket to verify all of the following against current durable and Herdr-owned state:

- the exact Pane is currently owned by that binding/Worker generation and project;
- the runtime is TraeX and belongs to a Primary ordinary Prompt or Worker Turn currently being observed by Swarm;
- the identity is neither stale, detached, superseded, stopped, nor a Controller/ordinary Herdr Pane.

Missing identity, missing/stale plugin data, a missing/unavailable socket, malformed input, timeout, identity mismatch, inactive work, or shutdown all return normal allow behavior. No message text is sent through the eligibility socket; the helper classifies the local `last_assistant_message` only after eligibility succeeds.

For an eligible first `Stop` invocation (`stop_hook_active` is false), the helper follows this bounded state machine:

1. A valid terminal `herdr-choice-list` block allows the Agent to stop.
2. A likely explicit choice request without a valid block, or an invalid terminal reserved block, returns `decision: "block"` with a continuation instruction explicitly naming the installed `$herdr-choice-list:herdr-choice-list` capability and requiring only the protocol block.
3. A normal answer with no conservative choice signal allows the Agent to stop.

The conservative classifier recognizes explicit selection/response cues and multiple option references; it is tested at minimum for the motivating Chinese sentence and an equivalent English “choose option / reply default” form. It does not parse option values or produce buttons. False negatives preserve the fixed-action fallback; false positives cost at most one bounded continuation.

When TraeX invokes the Hook again with `stop_hook_active` true, the helper always allows stop after validation. A now-valid block is consumed by Swarm; an absent or invalid block remains ordinary visible Markdown and falls back to fixed actions. This hard one-continuation limit prevents Hook loops even when the Agent ignores the Skill or emits an invalid protocol.

### Feishu behavior

Swarm withholds a bounded trailing `herdr-choice-list` fence candidate from streaming Feishu projection until terminal validation. A valid block is never rendered as Markdown. If the block is malformed, unsupported, oversized, non-terminal, or semantically invalid, the withheld text is flushed unchanged as ordinary Markdown and cannot create dynamic buttons.

Compatibility is additive. Answers without a valid choice list continue to use the existing fixed completion actions. Non-TraeX runtimes are consumers of valid protocol if one is present in their terminal output, but this change does not install a runtime-specific producer mechanism for them.

## User Stories

### SCN-1: Produce and render a Primary choice list

When an eligible Swarm-managed TraeX Primary ends with an explicit choice request but no protocol, the first Stop Hook invocation blocks once and instructs the Agent to load the Skill. When the Agent emits a valid version-1 block, Feishu shows the original answer without the JSON and renders two to five options in declared order. The referenced default alone uses primary styling. Nothing is submitted until the authorized user clicks.

### SCN-2: Produce and render a Worker choice list

An eligible TraeX Worker uses the same one-continuation producer flow. Its final Worker Task card uses the same choice semantics while preserving Worker Session generation, parent Binding, Pane, and card-message fences.

### SCN-3: Scope the Hook and fail open

An ordinary Herdr TraeX Pane, Controller Pane, non-TraeX runtime, stale generation, inactive turn, detached owner, unavailable service, or malformed Hook event is never continued by this feature. An eligible answer with no conservative choice signal also stops normally.

### SCN-4: Bound producer failure and protocol failure

If the continued Agent ignores the Skill, emits invalid JSON, or still omits the protocol, `stop_hook_active` prevents another block. Invalid protocol remains visible and the existing fixed action set remains available. No Hook failure can prevent the Agent from stopping indefinitely.

### SCN-5: Consume exactly one persisted option

When an authorized user clicks a rendered option, Swarm looks up the option by durable action-set and option identity, ignores any client-supplied label or message, atomically consumes the shared one-shot set, and creates one ordinary FIFO successor containing the persisted message. A duplicate callback returns the prior result when its identity matches; another option, a later click, or stale generation/card identity is rejected without creating work.

### SCN-6: Recover without changing the answer or replaying work

After restart, delivery retry, or final-card convergence, the durable specification reproduces the same visible buttons and messages. Feishu delivery retry never repeats the Agent turn, Hook continuation, or successor Prompt. A newer accepted Human message supersedes an available choice set through the existing completion-action cleanup path.

## Implementation Decisions

### Domain Model

The affected bounded context is Completion Interaction, adjacent to Answer Projection and Prompt/Worker Turn Acceptance.

- A **Completion Choice Specification** is an immutable, validated value containing protocol version, ordered Choice Options, and one default option ID. It is produced only from a valid terminal protocol block emitted by the Agent.
- A **Choice Option** has a stable option ID, a bounded Feishu label, and a bounded ordinary Human Message. Option IDs are unique within the specification; order is significant for rendering.
- A **Choice Hook Eligibility** decision is a read-only, exact-owner answer from the running standalone service. It authorizes only whether the local Stop helper may request one Skill continuation; it conveys no terminal-control authority.
- A **Completion Action Set** remains the one-shot aggregate that owns availability, consumption, supersession, actor ownership, owner generation, Pane/root/card fences, and callback idempotency. Dynamic options extend this aggregate; they do not introduce a second interaction lifecycle.
- Existing Primary Prompt and Worker Turn aggregates remain authoritative for FIFO successor creation. A button does not represent native Agent approval and never writes terminal input.

The following invariants are authoritative:

- **INV-1:** Only one valid `herdr-choice-list` block at the physical end of a terminal answer can become a Completion Choice Specification. Ordinary prose, lists, JSON, and earlier fenced blocks cannot create actions.
- **INV-2:** A valid specification has version `1`, two through five ordered options, unique bounded IDs, bounded non-empty labels/messages, and one resolvable default option.
- **INV-3:** A valid protocol block is never exposed in Feishu Markdown; malformed or unsupported content is preserved rather than silently discarded.
- **INV-4:** The Stop Hook can block only the first Stop of an exactly eligible Swarm-owned TraeX turn. Unknown, stale, unavailable, or repeated (`stop_hook_active`) cases allow stop.
- **INV-4a:** Choice production is invoked only at the end of one trace through its `Stop` event. No streaming, tool, progress, or intermediate-message event can invoke it, and its single continuation remains inside that trace.
- **INV-5:** The Hook never generates option content, mutates durable workflow state, submits a Prompt, or controls a Pane/process. The Agent must emit the protocol through the named Skill continuation.
- **INV-6:** The exact persisted option, not callback-controlled text, supplies the successor message. Consumption and successor acceptance share the existing atomic one-shot transaction.
- **INV-7:** Dynamic actions retain all current completion-action eligibility, actor, generation, Pane/root/card, idempotency, successor, and recovery fences.
- **INV-8:** No path introduced by this feature performs remote approval, denial, arbitrary terminal input, process control, Pane control, or automatic default submission.

No new glossary or ADR is required: the change specializes the existing Completion Action Set and adds a bounded adapter-level producer integration without changing Agent-control authority.

### Architecture

A pure protocol module owns terminal-block parsing and validation. A bounded streaming tail recognizer withholds only a reserved-fence candidate; terminal normalization returns either `{ visibleMarkdown, specification }` or a non-protocol result that preserves the original Markdown. For a blocked Stop continuation, the canonical answer is the already-projected assistant answer plus the later protocol-only assistant output from the same turn; a terminal lifecycle field containing only the latest assistant message must not replace or duplicate the earlier visible answer. This shared seam is used before Primary or Worker terminal projection is committed, not only inside card rendering or one transcript adapter, so attached, detached/recovered, and restart convergence agree.

The terminal transition persists the validated specification with completion-action eligibility in the same SQLite transaction that makes the completed answer durable. Answer projection stores visible Markdown; protocol data remains explicit durable interaction state.

Final-card convergence prepares a dynamic Completion Action Set from that durable specification and snapshots its ordered options. Card renderers receive presentation-neutral render state and emit Feishu buttons. Existing fixed render state remains valid for historical rows and answers without a specification.

The callback carries only action-set identity, option ID, owner identity/generation, and exact card message identity. Primary and Worker acceptance workflows resolve the durable option server-side, atomically consume the action set, and submit the stored message through existing ordinary FIFO acceptance interfaces.

The Hook helper and private eligibility socket live at runtime/adapter boundaries. The helper uses existing Swarm Pane identity plus lifecycle-managed private plugin data; ordinary prompt bodies and Pane startup arguments remain unchanged. The socket performs read-only exact-owner checks and exposes no generic query, option extraction, prompt submission, or Agent-control command. Skill/Hook installation is staged and activated with the standalone release so the helper, Skill protocol, and server validator remain version-compatible; rollback restores the previous integration atomically with the service release.

No second model, hidden prompt suffix, Herdr Core event-schema change, or external delivery channel is introduced. The only additional model work is the same Agent's single Hook-requested continuation.

### Behavior & Failure Modes

Protocol parsing and choice-candidate classification are deterministic and side-effect free. Unsupported versions, duplicate IDs, an invalid default, bound violations, invalid JSON, multiple terminal protocol blocks, or trailing non-whitespace produce no specification and preserve the original answer.

The Hook is advisory and fail-open. It has a short bounded socket/processing timeout and emits no secrets or answer content to logs. Its one allowed block asks the current Agent to use a declarative Skill; it does not inject terminal keystrokes or create a new Prompt. `stop_hook_active` is the authoritative recursion fence.

Durability follows the existing persist-before-Lark rule. A crash before terminal settlement exposes neither dynamic actions nor partial protocol. A crash after settlement can re-run card convergence from the persisted specification. Card create/update retry may repeat only the delivery effect.

Option callbacks reuse the existing atomic completion-action consumption boundary. Idempotency is owned by action set plus option ID. The same callback may recover its already-created successor; a callback for another option loses after consumption. Existing successor acceptance supersedes still-available action sets before a later click can create competing work.

### Compatibility & Migration

SQLite migration is additive. Existing `completion_action_sets.selected_action` values and fixed behavior remain readable. Dynamic option identity and option snapshots use additive fields/tables, so the current fixed-action check constraint is not weakened and historical sets need no backfill.

Historical completed answers are not reparsed. Only a terminal transition observed after deployment can create a Completion Choice Specification. Existing available, consumed, superseded, unavailable, legacy next-input, and outbox rows retain their recovery semantics.

If the Skill/Hook integration is absent or disabled, all Agent and card behavior remains compatible with the fixed-action path. Existing managed Panes already carrying the Swarm bridge identity can become eligible after plugin/service activation without Pane replacement, but only while the socket proves their current exact ownership and active turn.

## Testing Decisions

- Skill/Hook contract tests prove that only the TraeX `Stop` event is registered, feed documented Stop payloads, and cover missing/malformed input, `HERDR_ENV`, Pane/binding/generation/project identity, missing/stale plugin data, exact Chinese and English choice cues, valid/invalid protocol, no-choice answers, socket failure/timeout, and unconditional allow on `stop_hook_active`.
- Trace-boundary integration tests prove no invocation during streaming, intermediate assistant output, tool-use completion, progress, or status events; a blocked Stop adds at most one protocol-only continuation to the same trace and never creates another Prompt, turn, or trace.
- Eligibility socket tests cover active Primary ordinary Prompt, active Worker Turn, exact runtime/Pane/generation/project matching, mode/cleanup, bounded requests, and rejection of Controller, ordinary Herdr, stale, detached, superseded, stopped, non-TraeX, and shutdown cases. They also prove answer text is not transmitted.
- Skill fixture tests validate that the documented output is protocol-only, versioned, bounded, and maps the declared default to `message: "default"` for the motivating example.
- Pure protocol and streaming-tail tests cover valid extraction, withheld reserved fences, whitespace, ordering, default resolution, every bound, malformed JSON, unsupported versions, duplicates, non-terminal/multiple blocks, and byte-for-byte flush of invalid Markdown.
- Transcript/final-settlement tests prove attached, detached/recovered, Primary, and Worker final answers use the shared normalization seam; the two-stage Stop continuation retains exactly one copy of the original answer, treats the later assistant message as protocol-only tail, and never leaks valid protocol JSON into Feishu Answer/Task Markdown.
- SQLite migration/store tests cover additive migration, reopen, ordered-option round trips, historical fixed-action compatibility, and atomic persistence with completion eligibility.
- Primary and Worker card tests prove options render in order, the default alone uses primary styling without auto-submit, fixed actions remain the fallback, and consumed/superseded sets expose no buttons.
- Card interaction integration tests prove server-side message lookup, duplicate recovery, competing-option rejection, stale actor/generation/card rejection, successor supersession, FIFO creation, and absence of terminal-control effects.
- Startup/final-card convergence tests prove reopen and delivery retry reproduce the option set without replaying the Agent turn, Hook continuation, or Prompt.
- Setup/lifecycle tests prove idempotent plugin installation and enablement, active Hook discovery, version-compatible plugin-data activation, rollback/removal, private socket permissions, and no retired compatibility-plugin/operator surface.
- Verification runs focused Hook, protocol, transcript, card, SQLite, interaction, startup, and lifecycle tests, then `npm run typecheck`, `npm run build`, and full `npm test` in build-before-test order.

## Out of Scope

- Asking a second LLM or extractor Agent to summarize or repair choices.
- Having the Hook synthesize option labels/messages from natural-language prose.
- More than one Agent continuation or guaranteed recovery when the Agent violates the Skill contract.
- Automatically clicking or submitting the default option.
- Multi-select, free-text form fields, dropdowns, nested/conditional choices, or more than five options.
- Native Agent approval/denial or direct terminal, process, or Pane control.
- Producer support for non-TraeX runtimes in this change.
- Reprocessing historical answers or patching frozen continuation pages.

## Further Notes

- Workspace mode: isolated Git worktree at `/tmp/herdr-agent-swarm-feishu-choice-list`.
- Branch: `feat/feishu-choice-list`; starting revision: `5a19f7b19b58a84c6e0d3a0d89da769b3205537d`.
- The original checkout contains unrelated user-owned changes and remains untouched.
- `npm ci --cache /tmp/npm-cache-herdr-feishu-choice` completed without dependency changes; npm reported one pre-existing high-severity audit finding.
- Fresh baseline passed in repository-required order: `npm run typecheck`, `npm run build` (build identity `sha256:dd309607b4ba0a0c7671ef279cd107fd93bfbf21518d1ff162fd531730d466ee`), then `npm test` (236 files, 3,310 tests).
- A pre-build test attempt confirmed `tests/standalone-install.test.ts` requires generated `dist/build-info.json`; the build-before-test sequence is authoritative.
- Approval state: Gate 1 Skill + scoped Stop Hook design approved; revised Gate 2 specification approval pending.
- Unresolved load-bearing decisions: none.
