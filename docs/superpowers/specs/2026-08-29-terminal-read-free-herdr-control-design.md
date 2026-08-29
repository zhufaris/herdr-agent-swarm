# Terminal-Read-Free Herdr Agent Control

## Goal

Move every bridge-owned TraeX lifecycle and control decision onto Herdr's
structured Agent surface. Production code, the installed TraeX compatibility
shim, and maintained smoke tooling must not read or parse terminal snapshots.
TraeX answer content continues to come only from its validated typed JSONL
transcript.

## Scope and success criteria

The change is complete only when all of the following are true:

1. Managed agent startup uses `herdr agent start`; ordinary turns use `herdr
   agent prompt --wait`; observation uses structured snapshot/Agent state;
   interruption uses `herdr agent send-keys`.
2. The bridge has no `readOutput`/`readPane` port and no fallback to `pane read`,
   `agent read`, terminal-output parsing, composer parsing, or output-marker
   polling.
3. `SessionReconciler` converges from pane identity, native Agent identity,
   process identity, `agent_status`, `state_change_seq`, and transcript state. It
   does not derive lifecycle, model, context, answer, or readiness from terminal
   text.
4. The TraeX shim never captures a terminal snapshot and never runs `agent
   explain --file`. Its fenced reporter establishes the initial idle Agent
   authority, and TraeX lifecycle hooks report working/idle transitions to
   Herdr from structured hook events.
5. Runtime model-menu automation is removed. A model may be selected through
   startup arguments; changing it on a running Agent requires explicit
   replacement/restart. No hidden terminal-control fallback remains.
6. Maintained smoke scripts do not inspect terminal text or automatically answer
   trust/approval dialogs. A structured `blocked` state is reported to the
   operator instead.
7. Repository tests, typecheck, build, and a source audit prove that no
   bridge-owned terminal read remains. An isolated real Herdr/TraeX check proves
   native start, prompt/wait, interruption addressing, and lifecycle cleanup.

The prohibition applies to reading terminal *content*. Pane identity and process
metadata remain legitimate structured inputs. Herdr itself may internally inspect
its terminal to implement Agent detection; that implementation detail is outside
the bridge boundary.

## Considered approaches

### 1. Rename Pane reads to Agent reads

Replace `pane read` with `agent read` but retain output parsers and polling. This
uses a more appropriate namespace but still reads terminal content and preserves
the false-inference risks. It does not satisfy the goal.

### 2. Keep terminal reads only for model menus and recovery

Use native Agent commands for ordinary turns while retaining terminal parsing for
`/model`, unknown-state recovery, and reporter classification. This is compatible
with more legacy behavior, but the same terminal dependency survives in several
high-risk paths. It does not satisfy the requested complete replacement.

### 3. Strict structured control plane

Remove terminal-content access from all maintained bridge and shim paths. Accept
that capabilities without a Herdr structured API, notably runtime model-menu
automation, become unavailable. This is the selected approach because it creates
one authority for lifecycle and input and makes the no-terminal-read property
mechanically auditable.

## Native command mapping

| Intent | Command or source | Notes |
| --- | --- | --- |
| Start | `herdr agent start <name> --kind <kind> --pane <id>` | TraeX remains projected by the installed compatibility shim and executes the real TraeX binary. |
| Submit and settle | `herdr agent prompt <target> <text> --wait --timeout <ms>` | No second bridge-owned polling loop and no prompt echo confirmation. |
| Current state | `session.snapshot` / `herdr agent get` | Use Agent identity, status, revision, and state sequence only. |
| Wait for change | Herdr pane events plus fresh structured snapshot | Events are hints; snapshot is authoritative. |
| Interrupt | `herdr agent send-keys <target> esc` | This is intentional Agent UI control, not raw Pane input. |
| Answer stream | Validated TraeX JSONL transcript | Never use terminal output as answer content or completion evidence. |
| Model selection | Agent startup arguments | Runtime menu selection is unsupported until Herdr exposes a structured operation. |

No code may fall back from an Agent command to `pane send-text`, `pane send-keys`,
`pane read`, or `agent read`.

## Adapter and dispatch behavior

`HerdrCliAdapter.runPrompt` invokes one mutating command with `--wait` and the
turn timeout. The command runner's started callback remains the conservative
durable dispatch boundary: after the Herdr process starts, an unclassified
failure is potentially dispatched and must never be replayed automatically.
Explicit pre-input errors (`agent_not_found`, `agent_not_ready`, and
`agent_blocked`) remain safe not-delivered outcomes.

The successful command result is parsed for the settled Agent state. If the
installed Herdr response does not contain a supported settled state, the adapter
refreshes `agent get` once and validates the same target. It does not inspect
terminal output. Progress callbacks are driven by structured Herdr events and
snapshots where available; losing an intermediate callback must not affect final
settlement or transcript delivery.

`observeRuntime` treats a matching managed Agent plus verified process/session
identity as runtime presence. `idle` and `done` are ready; `working` and `blocked`
are active; `unknown` remains unknown and cannot be upgraded by parsing output.

## Reconciliation and output

The reconciler removes terminal baselines, output fingerprints derived from Pane
text, output-change projections, and terminal-derived model/context telemetry.
It continues to reconcile:

- workspace, pane, cwd, terminal identity, and native Agent session identity;
- binding lifecycle and queue wakeups from structured Agent state transitions;
- detached turn completion from structured settled state without replay;
- visible answer and tool activity from the typed transcript and durable SQLite
  projections.

If structured transcript output is unavailable, the existing bounded
`STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE` is used. Terminal text is never substituted.
An `unknown` Agent state remains degraded/uncertain until later structured
observation; it is not guessed from a composer or spinner.

## TraeX compatibility shim

The compatibility shim remains reversible and version-gated. It still maps the
public `traex` kind onto Herdr's internally reserved Codex-compatible lifecycle
while executing the configured real TraeX binary. This compatibility identity is
not a license for bridge-side terminal parsing.

The reporter and lifecycle hook form a small structured compatibility layer:

1. verify `/proc/<pid>/exe` and process start ticks through structured process
   metadata;
2. claim the internal Codex-compatible Agent authority as `idle` and publish
   `display_agent=traex` only after that process fence succeeds;
3. report `working` from TraeX `UserPromptSubmit` and `idle` from TraeX `Stop`;
4. release the owned Agent authority and display metadata when the fenced
   process disappears.

It removes `readPane`, temporary snapshot files, `agent explain --file`, and all
terminal-derived `report-agent` state updates. The lifecycle hook accepts only
the exact supported TraeX hook event names, derives no state from prompt or
answer content, emits no hook output, and uses a monotonic sequence. It never
reports `working` before `agent prompt` submits input: `UserPromptSubmit` is the
post-acceptance transition that satisfies Herdr's native prompt guard. A missing
hook therefore stalls explicitly instead of fabricating completion. Production
evidence from panes `wH:p64` and `wH:p65` showed that Herdr 0.7.5 does not create
Agent lifecycle authority from `display_agent` metadata or from a real TraeX
process alone.

## Model and control behavior

The remote model-card flow no longer opens `/model` or parses selector text.
For a running instance it returns a clear unsupported response instructing the
operator to create or replace the Agent with the requested startup model.
Persisted in-flight model-control operations are terminalized without sending
input during recovery.

Stop continues to send `esc`, but through `agent send-keys`. Approvals remain
local to the Herdr pane and are not read or answered by the bridge. Maintained
smoke tooling treats `blocked` as an explicit operator-required outcome instead
of inspecting and answering terminal prompts.

## Failure and recovery semantics

- Never replay after the Herdr prompt process may have started.
- Never repair an `unknown` state using terminal content; only process-fenced
  bootstrap or validated TraeX lifecycle hook events may advance it.
- Never infer successful model selection, readiness, or completion from output
  stability.
- Preserve SQLite dispatch, detached-observer, fencing, and outbox transaction
  boundaries.
- A missing/mismatched Agent or process degrades the binding and requires normal
  reconciliation or explicit replacement; it does not trigger raw input.

## Testing and completion audit

Focused tests cover native command arguments, dispatch uncertainty, structured
settlement, unknown-state behavior, Agent-key interruption, transcript-only
answers, reconciler behavior without output, model-operation rejection/recovery,
and metadata-only reporter behavior. Existing terminal-parser tests and adapter
tests for composer/menu polling are deleted with their production code.

The final audit must include:

```bash
rg -n 'pane[" ,]+read|agent[" ,]+read|readOutput|readPane|agent\.read|pane\.read|inferTraexAgentState|isTraexComposerReady|activeTraexComposer' src scripts plugin
rg -n 'pane[" ,]+send-text|pane[" ,]+send-keys' src scripts plugin
npm test
npm run typecheck
npm run build
git diff --check
```

The first search must return no maintained runtime hits. The second must return
no control fallback; documented installer text is acceptable only if it is not an
executed command. The isolated real check must use a disposable Herdr server and
Pane, verify `/proc/<pid>/exe` is TraeX, observe the initial `idle` authority,
submit a short and a normal turn with `agent prompt --wait`, observe hook-driven
`idle -> working -> idle` advancement, and exit/clean up without touching the
production workspace. Production restart follows the
existing drain gate and must not be forced while turns are active.
