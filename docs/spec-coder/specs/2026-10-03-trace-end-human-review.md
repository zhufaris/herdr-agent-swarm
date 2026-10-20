# Trace-End Human Review Specification

## Problem Statement

Herdr Agent Swarm already supports an Agent-declared `herdr-choice-list`
protocol, durable Completion Action Sets, CardKit buttons, exact callback
fences, and ordinary FIFO follow-up messages. However, the Stop Hook asks for
that protocol only when a natural-language heuristic recognizes an explicit
choice. A final answer such as a request to approve a force restart can escape
the heuristic and finish without a clear Feishu notification.

When no valid dynamic protocol exists, current final Answer and Worker Task
Cards also fall back to generic `default / 批准 / 继续 / 拒绝` buttons. These
buttons lack question-specific context and appear after ordinary completions
that need no user decision.

The required change is deliberately narrow: evaluate every eligible trace once
at Stop, let the existing Skill decide whether the final answer needs human
attention, and render a declared question and convenient choices as additional
components of the existing Answer card. A lightweight durable mention message
must notify the reviewer after those components are available. The existing
Herdr-`blocked` Human Review cards and local-only native approval boundary are
not part of this change.

## Solution

Deepen the existing Completion Choice path rather than adding a new Human
Review episode subsystem.

The repository-owned `herdr-choice-list` Skill emits a version 2 terminal
decision after inspecting the completed final message:

- `intent: "none"` means the Answer needs no action component or mention;
- `intent: "human_review"` carries a question, one to four ordered business
  choices, and exactly one default choice.

The Stop Hook requests this decision on every eligible first Stop and allows a
re-entrant Stop unconditionally. The existing protocol parser strips the
reserved block from visible Markdown and normalizes valid version 1 choices as
compatibility Human Review choices.

For `human_review`, the existing Completion Action Set remains the durable,
one-shot interaction owner. The final Answer or Worker Task Card renders the
question, business buttons, and a system-owned Ignore button. After that card
revision is delivered, the existing completion notification obligation and
outbox emit one lightweight `@user` message directing the reviewer to the
Answer. The notification has no buttons and no independent lifecycle.

Business buttons continue through the ordinary FIFO Human Message path.
Ignore consumes the action set and refreshes the Answer without creating a
Prompt or Turn. Any accepted successor Human Message continues to supersede the
action set through the existing semantics. Without a valid Human Review
declaration, no action set, fixed fallback buttons, or mention is produced.

## User Stories

### SCN-1: The final answer needs no review

For an eligible Primary or Worker trace, the first Stop asks the current Agent
to invoke `$herdr-choice-list:herdr-choice-list`. The Skill returns `intent: "none"`. Swarm hides
the protocol block, completes the Answer normally, and creates neither a
Completion Action Set nor a mention notification.

### SCN-2: A Primary answer needs review

The Skill returns a valid Human Review question and choices. Swarm persists the
normalized specification with the completed Primary Prompt. Its final Answer
Card shows the question, one to four business choices, and Ignore. After that
card revision is checkpointed as delivered, Swarm sends one deduplicated
lightweight mention in the same Primary thread. Selecting a business choice
creates exactly one ordinary FIFO Primary Prompt and refreshes the Answer to
remove its buttons.

### SCN-3: A Worker answer needs review

The same behavior applies to a successful Worker Turn using exact Worker,
Worker Session generation, Turn, parent Binding generation, Worker card, and
thread-route identity. A business choice creates exactly one ordinary FIFO
Worker Turn.

### SCN-4: The reviewer ignores the suggestion

The exact mentioned reviewer selects Ignore. Swarm consumes the Completion
Action Set, updates the Answer component to `已忽略`, and creates no Prompt or
Turn. A repeated Ignore or business-choice callback returns the existing
already-handled result.

### SCN-5: Normal input supersedes the choices

An ordinary Human Message accepted for the same owner scope uses the existing
Completion Action supersession path. The next card convergence removes the old
buttons. Swarm does not need a separate review resolution record.

### SCN-6: Notification or process recovery occurs

If the service restarts after completion, action-set creation, Answer delivery,
or mention reservation, existing durable obligations and outbox state converge
the missing work. The Answer component is delivered before its lightweight
mention. Retries do not duplicate the mention or replay the Agent request.

### SCN-7: The Agent remains runtime-blocked

An authoritative Herdr `blocked` transition continues to use the existing
Primary or Worker Human Review episode and independent notification card.
Completion choices never approve a native tool, write to a terminal, or resolve
that blocked episode.

## Implementation Decisions

### Domain Model

This change does not introduce a new Human Review aggregate. The existing
Completion Action Set remains the aggregate for a successful terminal answer's
optional next-input affordance. It owns one-shot consumption, actor and owner
identity, generation and card fences, successor supersession, and the selected
result.

The normalized choice specification gains an optional review question. A valid
version 2 `human_review` decision always supplies the question. A valid version
1 choice maps to the same internal specification with a null question and uses
the compatibility copy `请选择下一步。`. An `intent: "none"` decision produces no
stored choice specification.

Agent-provided business options have these valid-value rules:

- one to four options;
- unique IDs matching `[A-Za-z0-9][A-Za-z0-9_-]*`, at most 64 characters;
- the system-reserved `ignore` ID is forbidden;
- non-empty labels of at most 40 Unicode code points;
- non-empty messages of at most 2,000 Unicode code points;
- exactly one declared default whose message is exactly `default`;
- a non-empty question of at most 2,000 Unicode code points;
- a complete protocol block of at most 8 KiB.

The system Ignore action is not an Agent option. It is a local transition of
the Completion Action Set and carries no follow-up message.

The enforcing invariants are:

- **INV-1:** one Completion Action Set creates at most one follow-up Prompt or
  Turn;
- **INV-2:** actor, owner, generation, route, card target, and stored option ID
  must match before an action is accepted;
- **INV-3:** Ignore consumes the set without creating work;
- **INV-4:** an accepted ordinary successor supersedes an available set;
- **INV-5:** Answer delivery precedes the lightweight mention, and outbox retry
  never repeats Agent work;
- **INV-6:** only a valid Human Review declaration on a successful,
  identity-current terminal turn creates a new action set;
- **INV-7:** completion actions cannot resolve or remotely operate a
  Herdr-`blocked` Agent.

### Architecture

The existing module boundaries remain:

- the Stop Hook validates Hook input, Swarm ownership, and private eligibility;
- the Skill decides whether the completed final message needs review and emits
  protocol only;
- the domain protocol parser validates and normalizes the decision;
- terminal Primary/Worker persistence stores the normalized choice;
- Completion Action eligibility and projection create the one-shot set;
- Answer/Worker card renderers add presentation components;
- existing card-action workflows translate callbacks into ordinary FIFO work;
- SQLite and the outbox own atomicity, ordering, retries, and idempotency.

No coordinator imports the Lark SDK or SQLite row shapes. The composition root
continues assembling concrete implementations.

The version 2 protocol retains the current fence:

```json
{"version":2,"intent":"none"}
```

or:

```json
{
  "version": 2,
  "intent": "human_review",
  "question": "是否批准按当前方案强制重启 Swarm？",
  "default": "approve",
  "options": [
    {"id":"approve","label":"批准重启","message":"default"},
    {"id":"cancel","label":"暂不重启","message":"暂不重启，请保留当前状态"}
  ]
}
```

For an eligible first Stop, any missing or invalid decision produces one block
response instructing the same Agent to invoke `$herdr-choice-list:herdr-choice-list`. Valid v1 or
v2 protocol passes immediately. `stop_hook_active=true`, malformed Hook input,
oversized assistant input, stale/missing ownership, eligibility false/error, or
other Hook failure allows Stop. The Hook never creates another Prompt, Turn, or
Agent process.

Recognized trailing protocol fences are withheld during streaming and removed
from terminal Answer Markdown, including malformed internal blocks. A
non-terminal fence-shaped block followed by visible prose remains ordinary
Markdown.

The existing normalized choice tables are extended only with the minimum
question metadata required by the renderer. No trace-choice episode table is
added. Existing completion notification obligations remain the durable
publication gate. An obligation is actionable only when a valid stored Human
Review choice exists; therefore `none` and invalid protocol cannot produce the
fixed fallback.

The final Answer component shows a safe mention, the declared or compatibility
question, ordered business buttons, and Ignore. Business callbacks keep the
existing `completion_action` payload and server-side message lookup. Ignore
uses a distinct callback selection handled by the same action-set fences; its
consumed result is represented without requiring a new episode state.

After the Answer revision containing the components is durably checkpointed,
the completion obligation reserves a text reply on the same logical thread:

```text
<at user> 需要你的选择，请查看上方 Answer 卡。
```

The outbox row uses a deterministic Primary/Worker owner-generation key and is
stored in `notification_reply_id`. Delivery retries repeat only this immutable
notification. The mention is not updated or resolved later; the Answer Card is
the sole interaction surface and reflects consumed/superseded state.

### Behavior & Failure Modes

The successful publication order is:

```text
turn completed
  -> normalize/store choice or none
  -> render and deliver Answer components
  -> checkpoint Answer revision
  -> reserve/deliver one lightweight mention
```

If no safe mention actor exists, the action set remains unavailable and no
mention is sent, matching the current security boundary. A choice or Ignore
callback from another actor, an old generation, another card, or an unknown
option is rejected without mutation.

Choice/Ignore and normal successor input race through the existing SQLite
transactional action-set transition. Only one operation can consume or
supersede an available set. Duplicate callbacks observe its current result and
cannot create duplicate work.

Temporary notification failures remain ordinary outbox retries. A permanent
notification failure does not roll back Answer delivery or action-set state and
does not replay the trace. Startup convergence may reserve a missing mention
only when the exact Answer revision and action set are still valid.

Hook or Skill failure loses only the optional review affordance: it does not
block completion indefinitely. Invalid protocol produces no action set or
mention and records only a bounded, redacted diagnostic reason.

### Compatibility & Migration

The plugin name, Stop Hook registration, owned-plugin lifecycle, fence name,
existing option limits for accepted version 1 data, and historical
`completion_action` callback contract remain compatible.

Valid version 1 specifications continue to load and render with compatibility
question copy. Existing delivered fixed or dynamic Completion Action Cards
remain consumable. New completions without a valid Human Review declaration do
not create fixed fallback actions. Frozen historical cards are not rewritten.

The SQLite change is additive where possible and does not rewrite historical
Human Review episodes or Completion Action Sets. Existing `runtime_blocked`
tables, cards, transitions, and candidate enrichment remain untouched.

## Testing Decisions

Protocol tests cover v2 `none` and `human_review`, every value bound, default
semantics, reserved Ignore rejection, invalid and streaming fences, terminal
fence hiding, and v1 compatibility. Hook tests cover every eligible first Stop,
valid direct pass-through, re-entrant and boundary fail-open, and removal of the
natural-language heuristic dependency.

Primary and Worker persistence tests cover normalized question/options, `none`
producing no obligation/action set, v1 reload, exact owner/generation/route/card
fences, and restart recovery. Card tests cover declared and compatibility
questions, one to four business buttons plus Ignore, consumed/ignored state,
and absence of the fixed fallback.

Interaction tests cover exact choice, Ignore with no created work, ordinary
successor supersession, wrong actor, stale identity, unknown option, duplicate
callbacks, and choice/Ignore/successor races at the SQLite seam.

Publisher and convergence tests prove that the Answer revision is checkpointed
before notification reservation, the deterministic notification key is emitted
once across retries/restart, and permanent notification failure never repeats
Agent work.

Existing Primary and Worker `runtime_blocked` tests remain green and explicitly
show no remote approval or Ignore capability. Before delivery, run affected
Vitest files, `npm run typecheck`, `npm run build`, and full `npm test`.

## Out of Scope

- A new trace-choice Human Review episode or state table.
- Unifying Completion Action and Herdr-`blocked` Human Review persistence.
- A second mutable Human Review card for trace-end choices.
- Herdr Core event or JSONL changes.
- Remote native-tool approval/denial, arbitrary terminal input, or Pane/process
  control.
- Time-based review expiry or a separate classifier model.
- Rewriting historical Answer cards or action records.
- Automatic installation, deployment, restart, push, PR, or external issue.

## Further Notes

- Workspace: `/workspace/herdr-agent-swarm`.
- Mode: in-place on `main`; task-owned paths remain separable from user work.
- Starting revision: `d3d6e0282fa70fad59471c71e37b890a4b253a35`.
- Preserved initial user work: modified `TODO.md`; untracked
  `.tmp-core-build/`, `.tmp-core-worktrees/`, `.trae/`, `docs/research/`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- A partial, uncommitted T1 implementation from the superseded design is
  present only in the listed protocol/runtime/test files. It has no commit and
  must be reconciled to this specification after renewed Gate 3 approval.
- Original baseline before task edits: `npm test` passed 254 files and 3,683
  tests; `npm run typecheck` and `npm run build` passed.
- Current partial-work verification: 7 focused files passed 106 tests;
  `tests/sqlite-store.test.ts` passed 498 tests; typecheck and build passed.
- Reopened simplified Gate 1: approved in conversation on 2026-10-03.
- Reopened Gate 2 specification: approved in conversation on 2026-10-03.
- No load-bearing design blocker remains. Production deployment is separate.
