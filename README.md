# Herdr Agent Swarm

Herdr Agent Swarm is a standalone, human-controlled multi-agent service built on the
Herdr headless runtime. One Feishu gateway can manage multiple projects; each
bound Lark thread owns its sole TraeX Primary, while durable project instances
are explicitly created Workers using TraeX, Codex, Claude Code, or Pi. Herdr
owns live panes and processes, while its CLI and socket API remain the required
runtime control plane. The standalone
user-systemd service is the repository's only supported deployment identity.

Each ordinary Lark message gets an Answer CardKit entity. The bridge streams safe
structured TraeX transcript output into its fixed Markdown element as the request moves from queued
to running, blocked, completed, or failed. Large answers continue in a new
continuation card without rewriting the frozen earlier card. It does not post
separate acknowledgement or final-answer text messages.

## How it works

```text
Lark message -> durable FIFO turn -> Herdr pane -> TraeX
     |                                  |
     +-> SQLite workflow state <--- authoritative Herdr observation
              |
              +-> durable Lark outbox -> CardKit Answer stream
```

SQLite stores topic-to-pane bindings, FIFO prompt jobs, run-card projections,
deduplication keys, a durable Lark outbox, and audit records. The dispatcher
uses an in-memory work-conserving pump only for wake-ups, active lanes, and
bounded concurrency; unsent messages never exist solely in memory. Herdr snapshots
are authoritative for pane and agent state; Herdr events only wake the bridge
for reconciliation. An interrupted running prompt is not replayed after a
restart; it remains detached while the bridge observes the existing Herdr turn.
Prompts that have not started remain queued.

The project main card presents compact metric rows: authoritative Herdr
`SPACE / TAB / PANE`, `MODEL / CONTEXT / QUEUE`, and the Git `WORKTREE`. The
worktree value is the Git root directory name only, never an absolute host path.
`TAB` is Herdr's stable `tab_id`, not a display label; it is refreshed from
reconciliation and rendered as `—` when the installed Herdr runtime does not
report it.

The product deliberately keeps topology changes human-controlled. A Primary may
call an existing Worker in the same project without per-call confirmation, but
cannot create, remove, promote, retarget, or select Workers automatically.
Worker completion never creates a Primary turn. High-risk approval stays local.
For the reliability model and exact behavioral
constraints, see [Architecture](docs/architecture.md). For a maintainer-oriented
map of the domain model, major modules, and end-to-end flows, see
[Architecture reference](docs/architecture-reference.md).
For the reliability roadmap and verification record, see
[Architecture stability design](docs/architecture-stability-design.md) (delivery claims, Answer snapshot revisions, and recovery evidence implemented locally; remaining stages pending).
Completed milestone evidence and historical implementation records are retained
in the [documentation archive](docs/archive/superpowers/).

## Security model

A message accepted from the configured Lark chat is submitted to a real TraeX
process as the host user that runs the service. The service accepts no user by
default: `LARK_ALLOWED_OPEN_IDS` is required for prompts and session access, and
`LARK_ADMIN_OPEN_IDS` is a required subset for topology-changing or destructive
actions. Treat both allowlists as a high-trust authorization boundary. Use a
dedicated, tightly-scoped group, a least-privilege service account, and an
isolated container, VM, or non-critical host.

TraeX is launched with `--permission-mode $TRAEX_PERMISSION_MODE` (default
`auto`). This keeps approval handling in TraeX while allowing auto-review for
eligible requests. Use `bypass_permissions` only when every chat member is
trusted to act as the host user. The bridge intentionally has no remote
approve/stop action.

Inbound messages are accepted only from the configured chat ID, configured
allowed Open IDs, and user (not bot) senders; card-action callbacks enforce the
same rule.
Logger, command-runner, and terminal-parser redaction strip known credential
shapes before persistence or delivery, but redaction is best-effort and is not a
substitute for the trust boundary above.

## Prerequisites

- Linux with Node.js 22.12 or newer. Node.js 24 LTS is recommended.
- npm, supplied with Node.js.
- A running Herdr workspace.
- `herdr` and at least one supported agent CLI (`traex`, `codex`, `claude`, or
  `pi`) installed and executable by the service account.
- A Lark custom app with bot capability.
- A topic-enabled Lark group containing the bot.

Check the local tools before installing the bridge:

```bash
node --version
npm --version
herdr --version
traex --version
```

If Node.js is missing, install Node.js 24 using your team's package manager or
Node.js distribution method. Avoid a system Node older than 22.12 because this
project uses the built-in `node:sqlite` module.

## Configure the Lark app

In the Lark developer console:

1. Create a custom app and enable its bot.
2. Enable long-connection (WebSocket) event delivery; no public callback URL is
   required.
3. Subscribe to the `im.message.receive_v1` event and enable the
   `card.action.trigger` card callback.
4. Grant the permissions the bot needs: read messages in groups, send and reply
   to messages, create/update/patch interactive (CardKit) messages, and read
   message/thread metadata. The exact scope names vary by tenant console; enable
   the IM message and interactive-card capabilities and review the consent
   screen before publishing.
5. Publish or install the app for the intended tenant.
6. Add the bot to the target topic-enabled group.
7. Record the app ID, app secret, group chat ID (`oc_...`), and bot open ID
   (`ou_...`). The open ID is available from the bot's contact entry or the
   event-subscription test console.

Set `LARK_ALLOWED_OPEN_IDS` to every authorized user's comma-separated Open IDs.
Set `LARK_ADMIN_OPEN_IDS` to the administrative subset. Both are required; the
service refuses to start if either list is empty or an administrator is not also
an allowed user.

## Install from source

Use this sequence for a first installation from a fresh checkout. Clone the
repository through your internal source-control service, enter the checkout, and
confirm that the required host tools are available:

```bash
node --version
npm --version
herdr --version
traex --version
herdr status server
```

Node.js must be 22.12 or newer. Start Herdr before continuing if
`herdr status server` does not report a running server. The Swarm service uses
Herdr's CLI and socket API but does not require the Herdr TUI to remain open.

Install the locked dependencies, compile the TypeScript sources, and run the
guided setup:

```bash
npm ci
npm run build
npm run swarm:setup
```

The wizard validates the Lark application, configured chat, Herdr workspace,
project route, local executables, user systemd, and loopback port before writing
private configuration. When following this explicit sequence, decline the
wizard's optional install and start or restart actions so the commands below own
those steps.

Build and stage an immutable production release, install and enable the user
unit, then start it explicitly:

```bash
./install.sh
npm run swarm:start
npm run swarm:status
```

`./install.sh` enables `herdr-agent-swarm.service` but deliberately does not
start it. By default, configuration is stored under
`~/.config/herdr-agent-swarm` and runtime state under
`~/.local/state/herdr-agent-swarm`. The `.env`, `projects.json`, and
`runtime.yaml` files are private mode-`0600` files; do not commit or copy them
into the repository.

Finally, verify dependency readiness through the loopback endpoint:

```bash
curl -fsS http://127.0.0.1:8787/ready
```

The response must contain `"status":"ready"`. If a different
`BRIDGE_HTTP_PORT` was saved during setup, use that port instead. `/health` only
proves that the process responds; `/ready` also checks the database, project
registry, Herdr, Lark, lease, and instance runtime.

### Update a source installation

Switch to the intended committed revision, refresh locked dependencies, rebuild,
and install a new immutable release:

```bash
git pull --ff-only
npm ci
npm run build
./install.sh
npm run swarm:status
npm run swarm:restart
```

Inspect status before restarting. An ordinary restart refuses to interrupt
running or queued prompts, active instance work, or pending delivery work. Wait
for that work to drain whenever possible. For an intentional observer handoff,
use the explicit forced form:

```bash
npm run swarm:restart -- --force
```

The forced restart detaches observers and recovers the existing durable work
without replay; it is not a general-purpose way to bypass workload safety. The
restart succeeds only after the replacement process reports the expected build
identity and readiness.

## Install from a GitHub Release

Tagged releases provide a prebuilt Linux x64 archive named
`herdr-agent-swarm-<version>-linux-x64.tar.gz`. The archive includes compiled
JavaScript and locked production dependencies, so the target host does not need
TypeScript or development dependencies. Node.js 24, Herdr, a supported agent
CLI, and user systemd are still required.

Download the archive and `SHA256SUMS` from the GitHub Release, place them in the
same directory, and verify the download before extracting it:

```bash
sha256sum --check SHA256SUMS
tar -xzf herdr-agent-swarm-0.4.0-linux-x64.tar.gz
cd herdr-agent-swarm-0.4.0-linux-x64
```

Replace `0.4.0` with the downloaded release version. For a first installation,
run the packaged setup entry point and review the generated private
configuration:

```bash
npm run swarm:setup
./install.sh
npm run swarm:start
npm run swarm:status
```

The packaged `install.sh` stages the prebuilt release and enables the user unit;
it does not rebuild the source or start the service. Existing configuration and
state directories are retained during an upgrade. Inspect status before
restarting an active installation, because the normal restart safety gate refuses
to interrupt queued or running work.

## Install as a standalone service

For the canonical first-install sequence, follow [Install from source](#install-from-source).
This section describes the setup and lifecycle behavior in more detail.

The wizard collects the Lark application and project route, discovers live
Herdr workspaces, validates the complete draft, shows a redacted review, and
asks before saving the private configuration. Setup may separately offer to
install and then start or restart the service. When following the explicit
sequence above, decline setup's optional install and start or restart prompts;
the following `./install.sh` and `npm run swarm:start` commands own those steps.
Secret input is hidden. When rerunning setup, the existing secret can be kept
without displaying or re-entering it. Cancelling before save leaves the current
configuration unchanged; replacing a valid configuration creates a private
`backup-<UTC timestamp>` directory beside `.env`, `projects.json`, and
`runtime.yaml`.

The read-only checks authenticate the Lark application, confirm that the target
chat is readable, and compare the configured bot open ID when Lark exposes it.
They also inspect the selected Herdr workspace, agent capabilities, local
executables, user systemd, private directory access, and the loopback HTTP port.
The wizard cannot prove or change Lark console settings: permissions,
`im.message.receive_v1`, `card.action.trigger`, application publication, and bot
membership in the target group must still be checked manually. It never creates
a Lark application, sends a message, creates a pane, or starts an agent while
validating.

A failed check blocks save. A warning remains visible but allows save and
startup after explicit acceptance; for example, Lark may not expose bot identity
under the granted read scope. `npm run swarm:setup -- --skip-network` marks the
Lark checks skipped: the configuration may be saved after explicit acceptance,
but the wizard will not install or start the service.

### Non-interactive setup

For automation or experienced operators, keep the template flow explicit:

```bash
npm run swarm:init
$EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm/.env"
$EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm/projects.json"
npm run swarm:doctor
npm run swarm:install
npm run swarm:start
npm run swarm:status
```

The defaults are `~/.config/herdr-agent-swarm` for configuration,
`~/.local/state/herdr-agent-swarm` for SQLite state, and
`herdr-agent-swarm.service` for the
user systemd unit. Override the directories with `SWARM_CONFIG_DIR` and
`SWARM_STATE_DIR`. The installer writes
absolute paths and the expected build identity into the unit; secrets remain in
the mode-600 environment file.

Useful recovery commands are `npm run swarm:doctor`, `npm run swarm:status`, and
`npm run swarm:logs`; lifecycle controls include `npm run swarm:restart` and
`npm run swarm:stop`. If setup reports an incomplete configuration transaction,
restore a matching `.env` and `projects.json` pair from the named private backup
before rerunning it.

After setup has saved valid configuration, follow the install, start, status,
and readiness commands in [Install from source](#install-from-source).
Installation enables the unit but deliberately does not start it. The installer is for an already configured
machine. It is deliberately non-interactive: missing files or the exact shipped template
placeholders stop before service installation and direct the operator to
`npm run swarm:setup`. The installer never enters the wizard implicitly. It
stages only production dependencies under the state directory, then atomically
points `current` at that release; the development checkout keeps its test and
build dependencies. The checked-in service file is an explanatory template;
the installer renders the production unit and enables source maps for actionable
stack traces.

The former repository plugin registration and legacy unit are unsupported. A
one-time live cleanup must remove them only after resolving the current listener
to its owning unit and confirming that no prompt or outbox work is active. Keep
the configured absolute `BRIDGE_DATABASE_PATH`; never copy a live SQLite database
without its WAL and SHM companions.

`npm run swarm:restart` refuses to interrupt active TraeX turns and reports the
running and queued prompt counts. Wait for the active work to drain whenever
possible. For an intentional observer handoff,
`npm run swarm:restart -- --force` preserves the existing detached/no-replay
recovery behavior. `/status` exposes bounded `operational.promptLatency`
aggregates for queue, execution, and final Lark delivery time.

### Use the native TraeX Agent kind

Herdr 0.9.0 or newer provides the native `traex` Agent kind. Configure the
service with the official Herdr binary and verify the native integration before
installation:

```bash
herdr agent start reviewer --kind traex --pane w1:p1 -- --model GPT-5.6-Terra
```

```bash
"$HERDR_BIN" --version
"$HERDR_BIN" agent start --help
"$HERDR_BIN" integration status
```

The output must report Herdr 0.9.0 or newer, list `traex` among the Agent start
kinds, and report `traex: current` for the integration. Setup and doctor perform
the same read-only checks and never start or prompt an Agent. Use absolute paths
for both `HERDR_BIN` and `TRAEX_BIN` so systemd does not depend on interactive
`PATH`.

The runtime accepts only the native session tuple `herdr:traex` / `traex` /
`id` / non-empty thread ID. Bindings created by the retired compatibility shim
may retain `herdr:codex` or `herdr-traex-shim` as audit history, but those values
are not aliases and cannot be reconciled, recovered, observed, or controlled.
They fail closed through the normal orphan lifecycle; create or claim a native
binding instead. The service does not rewrite or delete legacy database rows.

## Configure the service

Run `npm run build && npm run swarm:setup`. The setup wizard collects and
validates values, shows a redacted review, and asks separately before saving and
changing the service. It writes private files under the standalone config
directory:

```text
${SWARM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm}/.env
${SWARM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm}/projects.json
${SWARM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm}/runtime.yaml
```

Set at least these values in `.env`:

```dotenv
LARK_APP_ID=cli_xxxxxxxxxxxxxxxx
LARK_APP_SECRET=replace-me
LARK_CHAT_ID=oc_xxxxxxxxxxxxxxxx
LARK_BOT_OPEN_ID=ou_xxxxxxxxxxxxxxxx
```

The remaining settings have defaults:

```dotenv
BRIDGE_HTTP_HOST=127.0.0.1
BRIDGE_HTTP_PORT=8787
HERDR_BIN=herdr
TRAEX_BIN=traex
CODEX_BIN=codex
CLAUDE_CODE_BIN=claude
PI_BIN=pi
TRAEX_PERMISSION_MODE=auto
TRAEX_SESSIONS_ROOT=/home/your-user/.trae/cli/sessions
LOG_LEVEL=info
COMMAND_TIMEOUT_MS=30000
LARK_REQUEST_TIMEOUT_MS=30000
TURN_TIMEOUT_MS=3600000
RECONCILE_INTERVAL_MS=30000
OUTBOX_SAFETY_SCAN_INTERVAL_MS=30000
HERDR_CIRCUIT_FAILURE_THRESHOLD=3
HERDR_CIRCUIT_OPEN_MS=15000
SQLITE_INTEGRITY_AUDIT_INTERVAL_MS=900000
INSTANCE_LEASE_TTL_MS=15000
INSTANCE_LEASE_HEARTBEAT_MS=5000
MAX_QUEUE_DEPTH=20
LARK_MESSAGE_CHUNK_SIZE=3500
```

Operational polling, cache, CardKit sizing, debounce, and pane-close timing live
in `runtime.yaml`. Setup writes a fully populated file; a missing file preserves
these defaults, while malformed input or unknown keys prevent startup:

```yaml
runtime:
  polling:
    transcriptIdentityMs: 50
    attachedTranscriptMs: 250
    workerTurnMs: 250
    externalTurnMs: 2000
  cache:
    herdrSnapshotTtlMs: 2000
  cards:
    updateDebounceMs: 500
    payloadLimitChars: 12000
    answerStreamLimitChars: 28000
    answerPageLimitChars: 9000
  paneClosure:
    confirmationTtlMs: 60000
```

`answerPageLimitChars` is the durable page boundary and must not exceed the
render safety boundary `answerStreamLimitChars`. Changes require a service
restart; live reload and per-project overrides are intentionally unsupported.
The retired `HERDR_SNAPSHOT_CACHE_TTL_MS` and `CARD_UPDATE_DEBOUNCE_MS`
environment variables are rejected with migration guidance. Validate all three
files with `npm run config:validate -- <env-file> <projects-file> <runtime-file>`.

`projects.json` is the project allowlist. Every
entry contains a stable `id`, display name, description, Herdr `workspaceId`,
absolute `cwd`, and optional `maxInstances`; `maxInstances` limits the number of
durable Worker rows and defaults to 8. Worker templates are not configured in
the registry, and `defaultProjectId` must reference one entry. The registry is
required; a missing or invalid file prevents startup. `npm run swarm:init` can
write templates into the standalone config directory for non-interactive setup.

The service defaults `PROJECTS_CONFIG_PATH` and `RUNTIME_CONFIG_PATH` to its config directory and
`BRIDGE_DATABASE_PATH` to the `bridge.db` file under
`${SWARM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm}`.
Explicit absolute values still override those locations. Use the official
absolute Herdr path for `HERDR_BIN` and the real TraeX path for `TRAEX_BIN`.
Absolute paths ensure the user service does not depend on an interactive shell's `PATH`.
Every project `cwd` must be absolute and accessible. Keep `.env` private because
it contains the Lark app secret. Setup parses it as data and never evaluates
it as shell code.

## Start in the foreground

Load the environment, build, and start the compiled service:

```bash
set -a
source .env
set +a
npm run build
npm start
```

For source-level development with automatic restart:

```bash
set -a
source .env
set +a
npm run dev
```

After startup, send `/swarm help` in the configured Lark group. A successful
long-connection startup logs `bridge started`.
Use `/swarm spaces` to list every configured space and all of its live Herdr
panes, including panes that are not running TraeX. Eligible unbound TraeX panes
can be claimed from the card, while a same-group bound pane can open its topic.
Use `/swarm panes` in a bound topic to list that Space's active attached
Primary panes. “发送卡片到群” publishes a selected pane's latest Main Card as
a new group root; replies in the resulting thread enter that pane's existing
Primary FIFO.
Use `/swarm sessions` for the current group's session inventory and `/swarm
failures` for actionable failures. Only failed Lark delivery can be retried; an
already-dispatched TraeX prompt is never replayed automatically.

The process holds a fenced SQLite lease. A second process using the same database
fails startup while the current lease is live. `/ready` requires lease ownership,
and `/status` reports bounded lease and two-second workspace-cache diagnostics.
It also reports the cached result of a read-only SQLite integrity audit that runs
at startup and every 15 minutes. Integrity findings degrade `/status` without
making `/ready` fail and are never repaired automatically.

## Operate the standalone service

User systemd owns the long-running process. Use the repository lifecycle
commands as the supported operator surface:

```bash
npm run swarm:start
npm run swarm:status
npm run swarm:logs
npm run swarm:restart
npm run swarm:stop
```

`swarm:start` waits for process-local `/health`; dependency failures remain visible as
degraded `/ready` state without killing the service. systemd applies restart and
bounded stop policy. Structured logs are available from the logs action without
requiring host journal access. The canonical unit appends stdout and stderr to
the private `${SWARM_STATE_DIR}/logs/service.log` file (`logs/` is `0700`; the
file is `0600`). Durable state remains under the standalone state directory.

Supported native Herdr Pane and Agent events wake the bridge through the Unix
Socket API. The managed unit receives the invocation-time `HERDR_SOCKET_PATH`;
if it is absent or disconnected, periodic snapshot reconciliation continues.
Socket events only request reconciliation. One fresh `herdr api snapshot` is
authoritative for Pane identity, terminal identity, optional native Agent
session reference, and Agent state. Answer content comes only from an exactly
identified structured TraeX transcript; `unknown` remains fail-closed and runtime
Model/Mode selection is unsupported.
`RECONCILE_INTERVAL_MS` is the full-scan recovery fallback.
`OUTBOX_SAFETY_SCAN_INTERVAL_MS` tunes the durable outbox fallback scan. The
remaining polling, cache, card, and close-confirmation timings are validated in
`runtime.yaml`; their defaults preserve durable ordering, replay, and recovery
semantics.

Exiting the Herdr TUI does not stop the user service; the Herdr server must remain
available for pane orchestration. `npm run swarm:stop` preserves configuration
and SQLite state.

For final acceptance, start the read-only observer and follow its checklist from
a genuine Feishu user account:

```bash
npm run smoke:real-user
```

The script never sends a Lark message and never bypasses the bot-message filter.
Set `SMOKE_TIMEOUT_MS` or `BRIDGE_STATUS_URL` only when a different observation
window or local endpoint is needed.

Logs are newline-delimited Pino JSON with a stable `event` field. `npm run swarm:logs`
reads the private service log directly and prints at most its final 100 lines
from a read window of at most 1 MiB. The lifecycle rotates logs larger than 16
MiB only while the service is stopped and retains only `service.log.1` plus the
current file. Host `systemd-journal` access is an optional platform capability,
not an application prerequisite. Correlate a
request using `eventId`, `bindingId`, `promptId`, `paneId`, or `replyId`. The
bridge deliberately excludes Lark message bodies, terminal output, card payloads,
and credentials from operational logs. For example:

For source updates, follow [Update a source installation](#update-a-source-installation).
The restart command completes only after the replacement service reports the
expected build identity. This lets systemd finish an in-flight graceful shutdown
without treating the handover as a failed restart.
It also refuses to restart while active turns are reported.
To edit the project registry later, rerun `npm run swarm:setup`; it replaces the
validated configuration pair atomically. `npm run swarm:stop` terminates the
process while preserving credentials, project configuration, SQLite state, and
logs.

### Migrate an existing PM2 deployment

Wait until `/status` reports no running or queued prompts and `pendingOutbox` is
zero. Copy the old `.env` and `config/projects.json` into the standalone config
directory with mode `600`. Before switching, replace repository-relative values
such as `./var/bridge.db` or `./config/projects.json` with absolute paths to the
existing files. This preserves the current SQLite database and avoids creating
an empty standalone database. Then stop and remove the PM2 app, run
`./install.sh`, start with `npm run swarm:start`, and verify `/health`, `/ready`,
and `npm run swarm:status`. Never copy a live SQLite database without its WAL/SHM
files; prefer an absolute `BRIDGE_DATABASE_PATH` during migration.

## Use the bridge

For complete Feishu group instructions, command examples, steering behavior, and
safety boundaries, see [Feishu group usage](docs/feishu-group-usage.md).

Available commands:

```text
/projects
/project <id>
/instances
/instance <name>
/to <name> <task>
/steer <name> <text>
/interrupt <name>

/swarm new <title>
/swarm new
/swarm projects
/swarm spaces
/swarm panes
/swarm attach <space> <pane>
/swarm model [name]  # list or select the current Primary session model
/swarm steer <text>  # enqueue a priority turn when idle; active-turn steering is unsupported
/swarm status
/swarm rename <title>
/swarm close
/swarm pane close
/swarm pane close confirm <code>
/swarm reattach <pane-id>
/swarm replace
/swarm resume
/swarm awake  # observe and recover completed turns after a detached Primary prompt
/swarm skip   # explicitly fail one oldest detached Primary blocker and resume FIFO
/swarm help
```

The short commands operate the standalone multi-agent directory. Select a
project with `/project` and create Workers from `/instances`. Each new Worker
Session gets one group-root Worker Main Card and an independent thread. Ordinary
text in that thread creates FIFO work for its fixed Worker; `/status`,
`/steer <text>`, and `/stop` inspect or control its exact current turn. Existing
pre-upgrade Workers can publish one passive compatibility entry from
`/instances` without moving or duplicating their live Main Card. The older
selected-target behavior remains for unbound conversations, while Primary
threads keep their own binding FIFO. Worker creation, stopping, and safe removal
actions remain explicit human card actions.

Run the non-mutating adapter preflight with:

```bash
npm run smoke:headless-multi-agent
```

To perform real read-only turns, run the same command with `-- --execute` from a
Herdr pane. The acceptance path uses a TraeX Primary and TraeX Worker, creates
temporary panes and a temporary Git repository, exercises a real Primary-to-
Worker tool call plus pane-scoped lifecycle/no-replay and safety assertions, reports bounded
evidence, and cleans up only those temporary resources. Adapter contract tests
cover TraeX, Codex, Claude Code, and Pi independently. Executable discovery does
not prove that an adapter is authenticated: on this host TraeX is live-verified,
Claude Code is installed but not logged in, and Pi is not installed.

The `new` and `projects` commands open a project selector. Only the command
initiator can use it, and each resulting topic remains bound to that project.
If `/swarm new` has no title, the bridge uses a short random pane name such as
`task-7kq2`; cards display it as `space / pane_name`.
The read-only `spaces` command lists every configured Space and its current
panes, including empty Spaces and unregistered panes, without creating a
binding or starting TraeX.
The read-only `panes` command is Space-scoped when invoked in a bound topic: it
lists only active, attached Primary bindings in that topic's workspace and
configured Space with a current Main Card. An unbound group entry remains
chat-scoped. A selected card is revalidated against the binding generation,
pane, and Main Card identity before the durable outbox publishes a new group
root. Replies in the new thread route to the selected Binding's existing Primary
FIFO, while Answer Cards remain in that new thread. The entry card is a static
snapshot; it never forwards or mutates the source topic, becomes a second live
Main Card, or sends TraeX input. Session/topology-changing commands must still
be executed from the original Main Card topic.
The `attach` command accepts an exact pane ID or a unique exact pane label and
creates a normal project topic for an existing TraeX pane
in the exact configured space without creating, renaming, restarting, or writing
to that pane. Repeating it for the same healthy binding is idempotent.
Successful and idempotent attach result cards include an `Open project topic`
button when the binding has a Feishu root message. Clicking it makes the bridge
send Feishu's native forwarded-topic card into the current group; open that card
to enter the project thread. This avoids unsupported `openMessageId` chat links.
Bindings owned by another group remain rejected without exposing their topic.
`/swarm model` reads the exact current Primary TraeX session's structured model
catalog. `/swarm model <name>` validates the canonical catalog name and stores a
generation-scoped preference for the next ordinary FIFO prompt; it does not
interrupt an active turn or create an empty turn. The prompt and selected model
are submitted together through one fenced `turn/start`. After delivery may have
started, uncertain outcomes are observed and never automatically replayed. The
bridge does not automate TraeX's terminal `/model` menu.
Only `/swarm …` is reserved for the bridge. Other slash commands, including
`/herdr` and TraeX skill commands, are passed to the bound pane as ordinary prompts.
An `@Bot` root message creates a topic in the default project and uses the
message body as its first prompt. Replies normally enter the binding's FIFO
queue. Active-turn steering requests fail closed as unsupported; they are not
injected into the terminal and are not silently converted into ordinary prompts.
Commands, code blocks, rich content, long messages, and ambiguous requests remain
FIFO. Queued cards show the exact
number of waiting turns ahead and, after three valid historical samples, a
coarse wait range rather than a deadline. Every message has an independent live
card, so queued requests and earlier results remain visible.

When TraeX needs high-risk approval, the card changes to orange and directs the
operator to the associated Herdr pane. Approve or reject the operation in Herdr;
the Lark card cannot bypass that boundary. `/swarm close` archives the binding
but does not kill TraeX or delete Lark history.
To close the actual pane, send `/swarm pane close` from its bound topic, then
send the generated `/swarm pane close confirm <code>` command within 60
seconds as the same Lark user. The bridge rechecks the binding identity, queue,
and current Primary Herdr agent state immediately before closing. Only an
explicit `idle` or `done` Primary is accepted; `working`, `blocked`, and
`unknown` are rejected. Confirmation terminalizes exact child Worker sessions
without replaying their work, closes their recorded panes before the parent pane,
and retains their worktrees for explicit safe removal. A restart observes an
unfinished close rather than repeating either a pane-close command or a Worker
prompt. A successful result is reported only after Herdr no longer returns the
parent pane.
If a pane becomes orphaned, `reattach` verifies the original pane identity and
`replace` creates a new generation. Both leave the session archived until an
explicit `resume`, so uncertain work is never replayed automatically.
If project creation is interrupted before the new pane identity is persisted,
the bridge pauses instead of creating another pane. Inspect the configured
Space; use `/swarm attach <space> <pane>` if the pane survived, otherwise
start again with `/swarm new`. Lark topic creation retries use the binding ID as
a stable platform idempotency key.

## Health checks

The HTTP server listens on `127.0.0.1:8787` by default.

```bash
curl --fail http://127.0.0.1:8787/health
curl --fail http://127.0.0.1:8787/ready
curl --fail http://127.0.0.1:8787/status
```

`/health` confirms that the process can answer HTTP requests. `/ready` also
checks SQLite access, every configured project directory and Herdr workspace,
and the Lark WebSocket connection. It reports every component independently so
multiple simultaneous failures are visible in one response. A disconnected Lark
client or inaccessible project returns HTTP 503. `/status` returns the same
readiness snapshot plus process uptime and a safe SQLite summary of binding,
prompt, outbox, lifecycle, attachment, recoverable-provisioning, archived-pane,
and retention-candidate state, including bounded recent failures. It never returns
prompt bodies, terminal output, or card payloads. Keep the health server bound to
localhost unless an authenticated network boundary is provided externally.

## Verify a deployment

Run the local checks:

```bash
npm test
npm run typecheck
npm run build
```

Then perform a Lark smoke test:

1. Send two prompts in one bound topic.
2. Confirm that two distinct Answer cards appear and no acknowledgement text is
   posted.
3. Confirm that the first Answer card streams safe structured transcript output while TraeX
   works.
4. Confirm that an approval request remains actionable only in Herdr.
5. Confirm that completion flushes the Answer card and does not post another
   text message.
6. Confirm that the second card advances from queued to running.

## Troubleshooting

- `ready` returns 503 with `larkConnected: false`: verify the app credentials,
  long-connection subscription, app publication, and bot installation.
- Herdr workspace errors: run `herdr workspace get <workspace-id>` as the same
  account that runs the service.
- `herdr` or `traex` is not found from the service: set absolute `HERDR_BIN` and
  `TRAEX_BIN` paths in `.env`.
- The service cannot write SQLite: verify that
  `${SWARM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm}`
  exists and is writable by the service account.
- A standalone service action fails: run `npm run swarm:logs` and inspect
  `systemctl --user status herdr-agent-swarm.service`. If the host separately
  grants `systemd-journal` access, `journalctl --user -u
  herdr-agent-swarm.service -n 100 --no-pager` is an optional platform-level
  diagnostic.
- A running card becomes detached after restart. The bridge observes the existing
  Herdr turn and does not replay the prompt because doing so could repeat side
  effects. If completion cannot be observed reliably, inspect the pane before
  deciding whether a fresh request is safe.
- Updates are delayed during high output volume: streaming content is delivered
  through the durable outbox; terminal states flush the active Answer page before
  CardKit streaming is finished.

For module ownership, fact sources, recovery, and Answer pagination, see
[Architecture](docs/architecture.md).
