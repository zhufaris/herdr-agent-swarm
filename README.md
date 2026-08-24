# Herdr Lark Bridge

Herdr Lark Bridge connects a Lark topic to a TraeX process running in a real
Herdr pane. People can submit work from Lark while developers observe or take
over the same terminal session in Herdr.

Each ordinary Lark message gets an Answer CardKit entity. The bridge streams safe
terminal output into its fixed Markdown element as the request moves from queued
to running, blocked, completed, or failed. Large answers continue in a new
continuation card without rewriting the frozen earlier card. It does not post
separate acknowledgement or final-answer text messages.

## How it works

```text
Lark message -> durable turn or steering job -> Herdr pane -> TraeX
     |                                  |
     +-> SQLite workflow state <--- authoritative Herdr observation
              |
              +-> durable Lark outbox -> CardKit Answer stream
```

SQLite stores topic-to-pane bindings, FIFO prompt jobs, run-card projections,
deduplication keys, a durable Lark outbox, and audit records. Herdr snapshots
are authoritative for pane and agent state; plugin events only wake the bridge
for reconciliation. An interrupted running prompt is not replayed after a
restart; it remains detached while the bridge observes the existing Herdr turn.
Prompts that have not started remain queued.

This bridge deliberately omits remote stop and approval actions. High-risk
approval stays in Herdr. For the reliability model, recovery path, and module
ownership, see [Architecture](docs/architecture.md).

## Security model

A message accepted from the configured Lark chat is submitted to a real TraeX
process as the host user that runs the service. That means **every member of the
configured chat can run commands and edit files on the host with that user's
privileges**, and the agent's output is posted back into the chat. Treat the chat
as an authorization boundary: use a dedicated, tightly-scoped group, a least-
privilege service account, and a non-critical host or container.

TraeX is launched with `--permission-mode $TRAEX_PERMISSION_MODE` (default
`auto`). This keeps approval handling in TraeX while allowing auto-review for
eligible requests. Use `bypass_permissions` only when every chat member is
trusted to act as the host user. The bridge intentionally has no remote
approve/stop action.

Inbound messages are accepted only from the configured chat ID and from user
(not bot) senders; card-action callbacks must also originate from that chat.
Logger, command-runner, and terminal-parser redaction strip known credential
shapes before persistence or delivery, but redaction is best-effort and is not a
substitute for the trust boundary above.

## Prerequisites

- Linux with Node.js 22.5 or newer. Node.js 24 LTS is recommended.
- npm, supplied with Node.js.
- A running Herdr workspace.
- `herdr` and `traex` installed and executable by the service account.
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
Node.js distribution method. Avoid a system Node older than 22.5 because this
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

The bridge accepts messages only from the configured chat ID.

## Install as a Herdr plugin

Clone or copy the repository, install the locked dependencies, build it, then
link and enable the checkout. Local `plugin link` intentionally skips the
manifest build step; packaged `plugin install` runs it.

```bash
cd /absolute/path/to/herdr-lark-bridge
./install.sh
```

The installer checks the required commands, installs locked dependencies,
builds the plugin, links the absolute checkout path, enables it, and verifies
the registered plugin state. It is safe to run again after source updates. It
does not modify bridge configuration or service state by default.

To continue directly into interactive configuration and systemd service setup:

```bash
./install.sh --setup
```

The plugin requires Herdr 0.7.5 or newer on Linux and a working user systemd
session. Action IDs are local to the plugin namespace.

## Configure the bridge

Invoke the setup action:

```bash
herdr plugin action invoke setup --plugin herdr-lark-bridge
```

The setup pane creates private files under the Herdr plugin config directory,
opens them in `$EDITOR` (default `vim`), validates them, and starts the bridge:

```text
$HERDR_PLUGIN_CONFIG_DIR/.env
$HERDR_PLUGIN_CONFIG_DIR/projects.json
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
HERDR_BRIDGE_EVENT_PORT=18787
HERDR_BIN=herdr
TRAEX_BIN=traex
TRAEX_PERMISSION_MODE=auto
LOG_LEVEL=info
COMMAND_TIMEOUT_MS=30000
TURN_TIMEOUT_MS=3600000
RECONCILE_INTERVAL_MS=30000
INSTANCE_LEASE_TTL_MS=15000
INSTANCE_LEASE_HEARTBEAT_MS=5000
MAX_QUEUE_DEPTH=20
LARK_MESSAGE_CHUNK_SIZE=3500
```

`projects.json` is the project allowlist shown by `/herdr new`. Every
entry contains a stable `id`, display name, description, Herdr `workspaceId`,
and absolute `cwd`; `defaultProjectId` must reference one entry. The registry is
required; a missing or invalid file prevents startup. Copy
`config/projects.example.json` to `config/projects.json` (or to the plugin
config directory) and replace the workspace ID and cwd with your own values.

The plugin defaults `PROJECTS_CONFIG_PATH` to its config directory and
`BRIDGE_DATABASE_PATH` to `$HERDR_PLUGIN_STATE_DIR/bridge.db`. Explicit absolute
values still override those locations. Use absolute `HERDR_BIN` and `TRAEX_BIN`
paths because plugin commands do not depend on an interactive shell's `PATH`.
Every project `cwd` must be absolute and accessible. Keep `.env` private because
it contains the Lark app secret. The plugin parses it as data and never evaluates
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

After startup, send `/herdr help` in the configured Lark group. A successful
long-connection startup logs `bridge started`.
Use `/herdr spaces` to list every configured space and all of its live Herdr
panes, including panes that are not running TraeX. Eligible unbound TraeX panes
can be claimed from the card, while a same-group bound pane can open its topic.
Use `/herdr sessions` for the current group's session inventory and `/herdr
failures` for actionable failures. Only failed Lark delivery can be retried; an
already-dispatched TraeX prompt is never replayed automatically.

The process holds a fenced SQLite lease. A second process using the same database
fails startup while the current lease is live. `/ready` requires lease ownership,
and `/status` reports bounded lease and two-second workspace-cache diagnostics.

## Operate through Herdr

The setup action installs `herdr-lark-bridge.service` as a user systemd service.
Herdr remains the operator entry point while systemd owns the long-running
process:

```bash
herdr plugin action invoke start --plugin herdr-lark-bridge
herdr plugin action invoke status --plugin herdr-lark-bridge
herdr plugin action invoke logs --plugin herdr-lark-bridge
herdr plugin action invoke restart --plugin herdr-lark-bridge
herdr plugin action invoke stop --plugin herdr-lark-bridge
herdr plugin action invoke uninstall-service --plugin herdr-lark-bridge
```

`start` waits for process-local `/health`; dependency failures remain visible as
degraded `/ready` state without killing the service. systemd applies restart and
bounded stop policy. Structured logs are available from the logs action and the
user journal. Durable bridge state remains under `$HERDR_PLUGIN_STATE_DIR`.

Native Herdr pane lifecycle and agent-status events wake the bridge through a
bounded loopback UDP hint. Event bursts are coalesced and only affected
workspaces are reconciled when the event context identifies them. One fresh
`herdr api snapshot` is authoritative for pane and agent state; terminal parsing
still supplies TraeX answer and task content. `RECONCILE_INTERVAL_MS` is a
full-scan recovery fallback for missed events and defaults to five minutes in
the plugin template.

Disabling or exiting Herdr does not stop the user service. Invoke
`uninstall-service` before unlinking the plugin so the unit never points at a
removed checkout. Configuration and SQLite state are preserved.

For final acceptance, start the read-only observer and follow its checklist from
a genuine Feishu user account:

```bash
npm run smoke:real-user
```

The script never sends a Lark message and never bypasses the bot-message filter.
Set `SMOKE_TIMEOUT_MS` or `BRIDGE_STATUS_URL` only when a different observation
window or local endpoint is needed.

Logs are newline-delimited Pino JSON with a stable `event` field. The logs action
prints the most recent bounded tail. Correlate a
request using `eventId`, `bindingId`, `promptId`, `paneId`, or `replyId`. The
bridge deliberately excludes Lark message bodies, terminal output, card payloads,
and credentials from operational logs. For example:

After source changes, rebuild and restart the linked checkout:

```bash
npm ci
npm run build
herdr plugin action invoke restart --plugin herdr-lark-bridge
```

To edit the project registry later, invoke
`configure-projects`. It edits a temporary copy and atomically replaces the
registry only after validation succeeds.
The stop action terminates the process while preserving credentials, project
configuration, SQLite state, and logs. Stop it before `herdr plugin unlink
herdr-lark-bridge` when removing the linked plugin.

### Migrate an existing PM2 deployment

Wait until `/status` reports no running or queued prompts and `pendingOutbox` is
zero. Copy the old `.env` and `config/projects.json` into the plugin config
directory with mode `600`. Before switching, replace repository-relative values
such as `./var/bridge.db` or `./config/projects.json` with absolute paths to the
existing files. This preserves the current SQLite database and avoids creating
an empty plugin-local database. Then stop and remove the PM2 app, invoke the
plugin setup action to install the user service, and verify `/health`, `/ready`,
and the status action. Never copy a live SQLite database without its WAL/SHM
files; prefer an absolute `BRIDGE_DATABASE_PATH` during migration.

## Use the bridge

For complete Feishu group instructions, command examples, steering behavior, and
safety boundaries, see [Feishu group usage](docs/feishu-group-usage.md).

Available commands:

```text
/herdr new <title>
/herdr new
/herdr projects
/herdr spaces
/herdr attach <space> <pane>
/model [name]
/herdr model [name]
/herdr status
/herdr rename <title>
/herdr close
/herdr pane close
/herdr pane close confirm <code>
/herdr reattach <pane-id>
/herdr replace
/herdr resume
/herdr help
```

The `new` and `projects` commands open a project selector. Only the command
initiator can use it, and each resulting topic remains bound to that project.
If `/herdr new` has no title, the bridge uses a short random pane name such as
`task-7kq2`; cards display it as `space / pane_name`.
The read-only `spaces` command lists every configured Space and its current
panes, including empty Spaces and unregistered panes, without creating a
binding or starting TraeX.
The `attach` command accepts an exact pane ID or a unique exact pane label and
creates a normal project topic for an existing TraeX pane
in the exact configured space without creating, renaming, restarting, or writing
to that pane. Repeating it for the same healthy binding is idempotent.
Successful and idempotent attach result cards include an `Open project topic`
button when the binding has a Feishu root message. Clicking it makes the bridge
send Feishu's native forwarded-topic card into the current group; open that card
to enter the project thread. This avoids unsupported `openMessageId` chat links.
Bindings owned by another group remain rejected without exposing their topic.
In an idle bound topic, `/model` lists the current and available TraeX models;
`/model <name>` switches to a uniquely matching model. `/herdr model [name]` is
an equivalent alias. Model commands do not create an agent turn or enter the
prompt queue, and are rejected while work is running or queued.
An `@Bot` root message creates a topic in the default project and uses the
message body as its first prompt. A reply received while a bridge-owned turn is actively `working`
steers that turn; replies received while idle, blocked, or in an unknown state
enter the binding's FIFO queue. Every message has an independent live card, so queued requests and earlier
results remain visible.

When TraeX needs high-risk approval, the card changes to orange and directs the
operator to the associated Herdr pane. Approve or reject the operation in Herdr;
the Lark card cannot bypass that boundary. `/herdr close` archives the binding
but does not kill TraeX or delete Lark history.
To close the actual pane, send `/herdr pane close` from its bound topic, then
send the generated `/herdr pane close confirm <code>` command within 60
seconds as the same Lark user. The bridge rechecks the binding identity, queue,
active workers, and current Herdr agent state immediately before closing. Only
an explicit `idle` or `done` state is accepted; `working`, `blocked`, and
`unknown` are rejected. A successful result is reported only after Herdr no
longer returns the pane.
If a pane becomes orphaned, `reattach` verifies the original pane identity and
`replace` creates a new generation. Both leave the session archived until an
explicit `resume`, so uncertain work is never replayed automatically.
If project creation is interrupted before the new pane identity is persisted,
the bridge pauses instead of creating another pane. Inspect the configured
Space; use `/herdr attach <space> <pane>` if the pane survived, otherwise
start again with `/herdr new`. Lark topic creation retries use the binding ID as
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
3. Confirm that the first Answer card streams safe terminal output while TraeX
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
- `herdr` or `traex` is not found from the plugin: set absolute `HERDR_BIN` and
  `TRAEX_BIN` paths in `.env`.
- The service cannot write SQLite: verify that `$HERDR_PLUGIN_STATE_DIR` exists
  and is writable by the Herdr account.
- A service action fails: inspect `systemctl --user status
  herdr-lark-bridge.service` and `journalctl --user -u
  herdr-lark-bridge.service -n 100 --no-pager`.
- A running card becomes detached after restart. The bridge observes the existing
  Herdr turn and does not replay the prompt because doing so could repeat side
  effects. If completion cannot be observed reliably, inspect the pane before
  deciding whether a fresh request is safe.
- Updates are delayed during high output volume: streaming content is delivered
  through the durable outbox; terminal states flush the active Answer page before
  CardKit streaming is finished.

For module ownership, fact sources, recovery, and Answer pagination, see
[Architecture](docs/architecture.md).
