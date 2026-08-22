# Herdr Lark Bridge

Herdr Lark Bridge connects a Lark topic to a TraeX process running in a real
Herdr pane. People can submit work from Lark while developers observe or take
over the same terminal session in Herdr.

Each ordinary Lark message gets its own CardKit 2.0 run card. The bridge updates
that card in place from queued to running, blocked, completed, or failed. During
execution it shows filtered answer text and a simplified activity trail such as
file reads, edits, and test runs. It does not post separate acknowledgement or
final-answer text messages.

## How it works

```text
Lark message -> durable turn or steering job -> Herdr pane -> TraeX
     |                                  |
     +-> request card <--- safe output parser + lifecycle events
              |
              +-> SQLite snapshot -> 800 ms coalescer -> Lark card patch
```

SQLite stores topic-to-pane bindings, FIFO prompt jobs, request-card snapshots,
deduplication keys, a durable Lark outbox, and audit records. Runtime events stay
inside the Node.js process. An interrupted running prompt is not replayed after a
restart; its existing card is marked failed. Prompts that have not started remain
queued.

The card interaction follows the useful patterns from
[`lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge):
compact status, in-place updates, visible progress, and the final response in the
primary content area. This bridge deliberately omits remote stop and approval
actions. High-risk approval stays in Herdr.

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
2. Enable long-connection event delivery.
3. Subscribe to `im.message.receive_v1` and the `card.action.trigger` callback.
4. Grant the app permissions to receive group messages, create and reply to
   messages, and patch interactive messages.
5. Publish or install the app for the intended tenant.
6. Add the bot to the target topic-enabled group.
7. Record the app ID, app secret, group chat ID, and bot open ID.

The bridge accepts messages only from the configured chat ID.

## Install

Clone or copy the repository, enter it, and install the locked dependencies:

```bash
cd /path/to/herdr-lark-bridge
npm ci
npm run build
```

For active dependency development, use `npm install` instead of `npm ci`.

## Configure the bridge

Create the local environment file:

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` and set at least these values:

```dotenv
LARK_APP_ID=cli_xxxxxxxxxxxxxxxx
LARK_APP_SECRET=replace-me
LARK_CHAT_ID=oc_xxxxxxxxxxxxxxxx
LARK_BOT_OPEN_ID=ou_xxxxxxxxxxxxxxxx
PROJECTS_CONFIG_PATH=./config/projects.json
```

The remaining settings have defaults:

```dotenv
BRIDGE_DATABASE_PATH=./var/bridge.db
BRIDGE_HTTP_HOST=127.0.0.1
BRIDGE_HTTP_PORT=8787
HERDR_BIN=herdr
TRAEX_BIN=traex
LOG_LEVEL=info
COMMAND_TIMEOUT_MS=30000
TURN_TIMEOUT_MS=3600000
RECONCILE_INTERVAL_MS=30000
MAX_QUEUE_DEPTH=20
LARK_MESSAGE_CHUNK_SIZE=3500
```

`config/projects.json` is the project allowlist shown by `/herdr new`. Every
entry contains a stable `id`, display name, description, Herdr `workspaceId`,
and absolute `cwd`; `defaultProjectId` must reference one entry. If the file is
absent, the legacy `HERDR_WORKSPACE_ID` and `HERDR_WORKSPACE_CWD` variables are
accepted as a temporary single-project fallback. An invalid existing file is
never ignored.

Use absolute `HERDR_BIN` and `TRAEX_BIN` paths so the PM2 process does not depend
on an interactive shell's `PATH`. Every project `cwd` must be an absolute,
accessible directory. Keep `.env` private because it contains the Lark app
secret.

The application reads process environment variables; it does not load `.env`
itself. Source the file for foreground operation. The included PM2 configuration
loads it before starting the application.

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

## Run with PM2

Install PM2 once for the service account, then start the checked-in process
definition from the repository root:

```bash
npm install --global pm2
pm2 start ecosystem.config.cjs
pm2 save
```

Inspect service state and logs:

```bash
pm2 describe herdr-lark-bridge
pm2 logs herdr-lark-bridge
```

Logs are newline-delimited Pino JSON with a stable `event` field. Correlate a
request using `eventId`, `bindingId`, `promptId`, `paneId`, or `replyId`. The
bridge deliberately excludes Lark message bodies, terminal output, card payloads,
and credentials from operational logs. For example:

```bash
pm2 logs herdr-lark-bridge --raw | jq 'select(.event == "turn-failed")'
pm2 logs herdr-lark-bridge --raw | jq 'select(.promptId == "PROMPT_ID")'
```

After code or configuration changes:

```bash
npm ci
npm run build
pm2 restart ecosystem.config.cjs --only herdr-lark-bridge
pm2 save
```

To start the saved process list after a host reboot, run `pm2 startup` and follow
the command it prints. This one-time host integration may require administrator
permission. The configured shutdown timeout lets an active TraeX turn finish
before PM2 force-stops the bridge.

## Use the bridge

For complete Feishu group instructions, command examples, steering behavior, and
safety boundaries, see [Feishu group usage](docs/feishu-group-usage.md).

Available commands:

```text
/herdr new <title>
/herdr new
/herdr projects
/herdr attach <space> <pane-id>
/herdr status
/herdr rename <title>
/herdr close
/herdr help
```

The `new` and `projects` commands open a project selector. Only the command
initiator can use it, and each resulting topic remains bound to that project.
The `attach` command creates a normal project topic for an existing TraeX pane
in the exact configured space without creating, renaming, restarting, or writing
to that pane. Repeating it for the same healthy binding is idempotent.
An `@Bot` root message creates a topic in the default project and uses the
message body as its first prompt. A reply received while a bridge-owned turn is actively `working`
steers that turn; replies received while idle, blocked, or in an unknown state
enter the binding's FIFO queue. Every message has an independent live card, so queued requests and earlier
results remain visible.

When TraeX needs high-risk approval, the card changes to orange and directs the
operator to the associated Herdr pane. Approve or reject the operation in Herdr;
the Lark card cannot bypass that boundary. `/herdr close` archives the binding
but does not kill TraeX or delete Lark history.

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
prompt, and outbox state, including bounded recent failures. It never returns
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
2. Confirm that two distinct cards appear and no acknowledgement text is posted.
3. Confirm that the first card updates in place while TraeX works.
4. Confirm that its progress area stays expanded and contains only simplified
   activity.
5. Confirm that completion updates the same card with the final answer and does
   not post another text message.
6. Confirm that the second card advances from queued to running.

## Troubleshooting

- `ready` returns 503 with `larkConnected: false`: verify the app credentials,
  long-connection subscription, app publication, and bot installation.
- Herdr workspace errors: run `herdr workspace get <workspace-id>` as the same
  account that runs the service.
- `herdr` or `traex` is not found under PM2: set absolute `HERDR_BIN` and
  `TRAEX_BIN` paths in `.env`.
- The service cannot write SQLite: create the database directory and ensure the
  service account can write the repository's `var` directory.
- A running card becomes failed after restart: this is intentional. The bridge
  does not replay an interrupted prompt because doing so could repeat side
  effects. Send the prompt again if retry is safe.
- Updates are delayed during high output volume: ordinary card changes are
  coalesced to protect Lark from update storms; blocked, completed, and failed
  states flush immediately.

The request-card behavior and recovery contract are specified in
[`docs/superpowers/specs/2026-08-22-request-live-card-design.md`](docs/superpowers/specs/2026-08-22-request-live-card-design.md).
