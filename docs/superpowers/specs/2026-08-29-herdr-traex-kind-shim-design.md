# Herdr TraeX Kind Shim Design

## Goal

Make this command work on the current host without rebuilding Herdr:

```bash
herdr agent start <name> --kind traex --pane <pane-id> [--timeout <ms>] [-- <traex-args...>]
```

The command must start the real `traex` executable, expose the managed agent as
`traex` through Herdr's agent, pane, event, and UI surfaces, and retain the
Codex-compatible prompt, wait, keyboard, state-detection, and session behavior
that TraeX already provides.

## Current constraints

Herdr 0.7.5 accepts only a compiled set of values for `agent.start.kind`;
`traex` is not one of them. Detection manifests can change state matching for a
known kind but cannot register a new start kind. The socket API does accept an
arbitrary `agent` string through `pane.report_agent` and
`pane.report_agent_session`.

The installed `codex` and `traex` commands are different programs. Translating
`--kind traex` to the native Codex start command would launch OpenAI Codex and
is therefore incorrect.

## Chosen approach

Install a small `herdr` command shim earlier in `PATH` and preserve the official
binary at a stable explicit path. The shim intercepts only the exact
`agent start` form whose kind is `traex`. Agent-bearing JSON queries are
delegated and then project only shim-marked managed agents from the internal
Codex protocol identity to `traex`; every other invocation uses `exec` to
delegate unchanged to the official Herdr binary.

For a TraeX start, the shim validates the supported arguments, confirms that the
target is an available shell pane, installs a one-shot shell function for the
native `codex` command, asks official Herdr to establish a Codex managed-agent
reservation, starts a bounded reporter sidecar outside that pane, waits until
the reporter has established TraeX display metadata, and returns a response compatible with native
`herdr agent start`. The command running in the pane is the real TraeX process,
not a persistent wrapper.

No installed Herdr binary bytes, remote manifest cache, or live session database
are patched.

## Components

### CLI shim

The shim owns only argument dispatch. It recognizes:

- `agent start <name>`;
- exactly one `--kind traex`;
- a required `--pane <pane-id>`;
- optional `--timeout <milliseconds>`;
- arguments after `--`, forwarded byte-for-byte as TraeX arguments.

Unknown or malformed TraeX-start options fail before touching the pane. All
non-TraeX commands, including native `--kind codex`, remain byte-for-byte
delegations to the official binary. Recursion is prevented with an absolute
real-binary path rather than `PATH` lookup.

### TraeX launcher

The launcher performs this ordered startup protocol:

1. Ask the official Herdr CLI for the target pane and process state.
2. Reject a pane that is not an available interactive shell.
3. Define a one-shot shell-local `codex` function that invokes the fixed private
   launcher, then call official `agent start --kind codex`. This creates Herdr's
   native name reservation while the launcher executes the configured absolute
   TraeX binary with its real `traex` process identity. The launcher must not use
   `exec -a codex`: Herdr 0.7.5's Codex terminal detector otherwise overrides
   the lifecycle authority reported by the shim. `/proc/<pid>/exe` must resolve
   to TraeX.
4. Start one reporter sidecar keyed by the target pane and TraeX process identity.
   It keeps the internal authority as `codex`, reports `display_agent=traex`,
   `state=unknown`, a monotonic sequence, and a dedicated source.
5. Poll structured Agent state until the reporter's process-fenced initial idle
   authority is visible as `codex` internally; never derive it from screen
   evidence.
6. Keep the name created by native `agent start`.
7. Return success only when `herdr agent get <name>` reports the requested pane,
   `display_agent=traex`, and a non-unknown state; the shim projects that marked
   entry to `agent=traex`.

If startup fails before TraeX is launched, the shim returns a normal failure. If
the process may have launched, it returns an explicit uncertain-start failure and
does not start a second process automatically.

### State reporter

Herdr 0.7.5 does not detect the real TraeX executable as a native Agent. A small
compatibility layer establishes an initial process-fenced idle authority and
maps TraeX `UserPromptSubmit` and `Stop` hook events onto working/idle lifecycle
updates. It never reads terminal content. Its authority is scoped by a unique
source name and increasing sequence.

The reporter runs only while the TraeX process exists. It fences the process,
claims the initial idle state, and releases its scoped Codex authority plus TraeX
display metadata when the process exits. The process-local lifecycle hook reports
subsequent transitions. Herdr can then return the pane to ordinary shell
detection after cleanup.

The reporter must preserve these meanings:

- `idle`: composer is ready;
- `working`: TraeX is processing a turn;
- `blocked`: visible approval or question requires local interaction;
- `done`: Herdr derives unseen completion from the settled idle transition;
- `unknown`: evidence is insufficient and must never be treated as completion.

### Session identity

The shim generates the native TraeX conversation UUID before launch and supplies
it to both TraeX `--session-id` and the process-fenced reporter. The reporter
sends the exact UUID through the official `pane report-agent-session` surface
using the trusted `herdr:codex` source and Herdr's internal compatible Codex
protocol identity. Shim-marked results are projected as `agent=traex`;
ordinary Codex results are never rewritten.

Native automatic restore is best-effort in the monkey-patched version because
Herdr's compiled restore registry does not know the TraeX executable. The shim
must not claim restore support unless a restart test proves the full behavior.
Interactive start, prompt, wait, read, focus, send-keys, rename, and attach are in
scope.

## Installation and rollback

Install the shim in a user-owned bin directory that precedes the official Herdr
binary in `PATH`. Record and validate the official binary's absolute path and
version during installation. Refuse installation if the resolved real path points
back to the shim.

The installation is atomic: write a versioned shim and launcher, validate them,
then switch one symlink. Rollback switches that symlink back or removes the shim;
the official Herdr installation remains untouched. Existing Herdr sessions and
configuration remain intact.

Each invocation checks the installed Herdr version against the version validated
by the shim. A mismatch prints a warning for delegated commands and refuses the
TraeX start path until its contract smoke test passes. This prevents a silent
break after `herdr update`.

## Integration with agent-swarm

Agent-swarm already models `traex` as a distinct runtime kind and accepts either
`traex` or legacy `codex` observation for compatibility. Once the shim is
installed, `TraexDriver.start` should prefer the formal managed start path rather
than raw `pane run`. Legacy panes observed as Codex remain attachable so the
change does not orphan running work.

The repository configuration continues to specify `agent: "traex"`. No data
migration is required.

## Security and failure behavior

- Use an absolute TraeX executable path; do not resolve a user-controlled
  executable from the target pane's `PATH`.
- Preserve argument boundaries; do not construct a shell command string from
  forwarded arguments.
- Never log prompt text, MCP secrets, environment values, or session content.
- Do not answer approvals remotely. A `blocked` TraeX pane remains local to
  Herdr.
- Do not retry after an uncertain launch or prompt dispatch.
- Scope report/release operations to the exact pane and reporter source.
- A stale reporter must not retain authority after the TraeX process exits.

## Verification

Automated tests cover argument parsing, transparent delegation, recursion
prevention, executable selection, forwarded arguments, RPC payloads, state
transition deduplication, startup timeout, uncertain launch, process exit, and
authority release. Agent-swarm tests verify that `TraexDriver` requests managed
`kind=traex` startup while retaining legacy `codex` observation compatibility.

An isolated Herdr session provides the end-to-end acceptance test:

1. Create a disposable pane.
2. Run `herdr agent start smoke-traex --kind traex --pane <id>`.
3. Confirm `agent get`, `agent list`, `pane list`, and `api snapshot` all report
   `traex` and the requested name.
4. Submit a harmless prompt with `agent prompt --wait`; observe working followed
   by idle or done.
5. Confirm `agent read`, `send-keys`, focus, and session identity behavior.
6. Exit TraeX and confirm authority is released and the pane returns to a shell.
7. Confirm native `--kind codex` and unrelated Herdr commands are unchanged.

The production Herdr server and existing agent panes are not used for destructive
smoke tests.

## Explicit non-goals

- Patching or replacing bytes inside the official Herdr executable.
- Pretending TraeX is Codex in UI/API state.
- Starting the installed OpenAI Codex executable for `--kind traex`.
- Reimplementing Herdr's general agent management commands.
- Claiming native resume across Herdr server restarts without an end-to-end
  proof.
- Upstreaming the new kind in this iteration; the shim is intentionally a local
  compatibility layer.
