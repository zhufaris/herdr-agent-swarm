# TraeX Integration Preflight Design

## Context

`herdr-agent-swarm` requires two independent Herdr capabilities before it can
manage a TraeX pane safely:

1. `herdr agent start --kind traex` must expose TraeX as a native agent kind.
2. `herdr integration status` must report a current TraeX lifecycle integration.

The current Core source and candidate binary satisfy the first requirement but
not the second. Core can recognize a TraeX process and consume its typed native
turn transcript, but a newly started session still needs a trusted hook to
report the canonical tuple `{ source: "herdr:traex", agent: "traex", kind:
"id", value: <session UUID> }` and authoritative lifecycle transitions.

An older, uncommitted `feat/traex` worktree contains a complete version-1
integration implementation. It is ten commits behind the current Core branch,
so merging or copying the worktree wholesale would regress newer pane-token,
PTY batching, Agent Event, and Goal-recovery work.

## Decision

Port only the TraeX integration behavior from the older worktree onto a clean
worktree based on the current Core `master`. Do not merge the branch and do not
replace complete files that have evolved on current `master`.

The port includes:

- `herdr integration install traex`, `uninstall traex`, and `status` support;
- `TRAECLI_HOME`, then `TRAE_HOME/cli`, then `~/.trae/cli` path resolution;
- a managed version-1 shell/PowerShell hook asset;
- additive `hooks.json` updates that preserve unrelated user hooks;
- lifecycle authority and exact native session-ID reporting;
- agent detection, resume, CLI, installation, status, and ownership tests;
- unreleased Core documentation and generated API schema where required.

Current Core behavior already present on `master` remains authoritative. In
particular, the port must not undo current PTY batching, pane-token, event
journal, historical turn recovery, or native Goal changes.

## Hook contract

The hook accepts only the fixed actions `session`, `working`, `blocked`, and
`idle`. It activates only when both `HERDR_ENV=1` and `HERDR_PANE_ID` are
present. It reads TraeX hook JSON from standard input, accepts only a non-empty
string `session_id`, and reports through the Herdr pane API with source
`herdr:traex` and agent `traex`.

The event mapping is:

- `SessionStart` -> report the exact session identity, then `idle`;
- `UserPromptSubmit`, tool, subagent, and compaction events -> `working`;
- `PermissionRequest` -> `blocked`;
- `Stop` -> `idle`.

The hook is notification-only. It cannot approve or deny requests, send prompt
text, inject terminal input, stop processes, or close panes. It does not claim a
process-release transition because TraeX does not expose a hook event that
reliably proves terminal ownership ended.

## Installation and ownership safety

Installation writes the managed hook beside the user's TraeX configuration and
merges Herdr entries into `hooks.json`. It must be idempotent, preserve unrelated
top-level configuration and user hook entries, and reject malformed structures
before writing either the hook asset or configuration.

Uninstall removes only exact Herdr-managed hook entries. It deletes the script
only when the ownership marker identifies it as Herdr-managed; a user-modified
or unrelated script is preserved.

`integration status` reports `not installed`, `outdated`, or `current (v1)` by
reading the managed asset marker. Swarm's existing doctor check remains strict;
it should not be weakened to accept process recognition without lifecycle and
session-identity reporting.

## Implementation isolation

Core edits happen in a new dedicated worktree based on current `master`, as
required by Core's contributor guide because the shared Core checkout contains
unrelated changes. The older `feat/traex` worktree is read-only reference
material and is neither modified nor removed.

After the isolated integration patch passes validation, the release candidate
is assembled without overwriting the existing shared-worktree changes needed by
Swarm's Goal and historical-turn recovery. Any overlapping file is reconciled
semantically rather than copied wholesale.

No production Core binary, TraeX configuration, Swarm release, SQLite state, or
systemd service is changed during implementation or offline validation.

## Verification

Core verification must cover:

- every test whose name contains `traex`;
- complete integration-module tests;
- CLI install/status/uninstall against an isolated temporary `TRAECLI_HOME`;
- `cargo fmt --check`;
- `cargo clippy --all-targets --locked -- -D warnings`;
- `cargo check --locked`;
- the complete Core test gate required by the repository when practical;
- release build and generated schema freshness;
- `git diff --check` and an overlap audit against current shared-worktree edits.

Swarm verification must cover:

- the focused Herdr setup-probe tests;
- `npm run typecheck`, `npm run build`, and the full Vitest suite;
- `swarm:doctor` against the candidate Core with an isolated, installed TraeX
  integration, proving both native agent-kind and integration checks pass.

Production installation remains a separate authorization gate. After explicit
authorization, install the verified Core binary and TraeX integration, stage
Swarm `0.5.0`, force-restart through the supported lifecycle command, and check
health, readiness, build identity, queue/outbox state, and recent errors.

## Live acceptance

The remaining TODO entries close only after all of the following are observed
on the deployed runtime:

1. Previously lane-blocked Feishu card effects advance without another Human
   Message and no pending row remains trapped behind an unclaimable lane head.
2. A real Herdr-origin turn with Human Message, Agent answer, tools, Goal, and
   Task List is recovered through the exact typed historical Core turn path and
   converges to Feishu without replaying the prompt.
3. A real external turn whose exact recovery initially returns
   `turn_not_found` reaches the bounded terminal-uncertain path or exact typed
   recovery as appropriate, releases later FIFO work, and does not loop or bind
   a different turn.

Successful effects must remain deduplicated, and any failed acceptance step
must preserve its durable evidence without replaying Agent work.
