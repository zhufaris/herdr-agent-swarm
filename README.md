# Herdr Lark Bridge

TypeScript bridge that maps one Lark topic to one TraeX process running in a real Herdr pane. Group members can submit prompts from Lark while developers can observe and take over the same session in Herdr.

## Architecture

```text
Lark events                         Herdr / TraeX state
     │                                      │
     └──────────────┐        ┌──────────────┘
                    ▼        ▼
             ┌────────────────────┐
             │ Sync Coordinator   │
             │ lifecycle + FIFO   │
             └─────────┬──────────┘
                       │ BridgeEvent
                       ▼
             ┌────────────────────┐
             │ Node EventEmitter  │
             └─────────┬──────────┘
                       ▼
             ┌────────────────────┐
             │ TopicView Reducer  │  pure
             └─────────┬──────────┘
                       ▼
             ┌────────────────────┐
             │ SQLite view snapshot│
             └─────────┬──────────┘
                       ▼
             ┌────────────────────┐
             │ CardKit 2 Renderer │  pure
             └─────────┬──────────┘
                       ▼
                 Lark run card
```

SQLite is not an event store. It persists only the topic/pane binding, FIFO prompt jobs, duplicate-event keys, bridge message IDs, current card projection, and audit records. Runtime events are distributed through Node.js `EventEmitter`.

The run-card shape follows the useful interaction principles from [`lark-coding-agent-bridge`](https://github.com/zarazhangrui/lark-coding-agent-bridge): one CardKit 2.0 card is updated in place, status remains compact, and the final response occupies the primary content area. This bridge intentionally omits remote stop/approval actions because its safety model requires high-risk approvals to happen in Herdr.

## Requirements

- Node.js 22.5 or newer (Node 24 is recommended while `node:sqlite` remains experimental in older releases)
- A running local Herdr server
- `herdr` and `traex` available to the service account
- A Lark custom app with bot capability and long-connection event subscription

Subscribe the app to `im.message.receive_v1` and grant permissions required to receive group messages, create/reply to messages, and patch interactive messages. Add the bot to the configured topic-enabled group.

## Setup

```bash
npm install
cp .env.example .env
```

Set these required environment variables:

```bash
export LARK_APP_ID=cli_xxx
export LARK_APP_SECRET=xxx
export LARK_CHAT_ID=oc_xxx
export LARK_BOT_OPEN_ID=ou_xxx
export HERDR_WORKSPACE_ID=wG
export HERDR_WORKSPACE_CWD=/absolute/path/to/project
```

The service reads environment variables directly; it does not parse `.env` automatically. Start it through a shell that sources `.env`, a process manager, or systemd `EnvironmentFile`.

```bash
npm run build
npm start
```

Development mode:

```bash
npm run dev
```

## Commands

```text
/herdr new <title>
/herdr status
/herdr rename <title>
/herdr close
/herdr help
```

An `@Bot` root message also creates a binding and uses the message body as the first prompt. Subsequent topic replies are persisted in that topic's FIFO queue.

## Safety

- Only the configured `LARK_CHAT_ID` is accepted.
- Any member of that group may operate managed topics.
- Only panes running a foreground executable named `traex` are automatically adopted.
- TraeX starts with `--permission-mode auto`.
- Lark cannot run arbitrary shell commands or approve blocked high-risk actions.
- `/herdr close` archives the mapping; it does not kill TraeX or delete Lark history.

## Health and Operations

```text
GET http://127.0.0.1:8787/health
GET http://127.0.0.1:8787/ready
```

`/ready` requires SQLite, the configured Herdr workspace, and an established Lark WebSocket connection. Logs are structured JSON and omit prompt/response bodies by default.

An example systemd user unit is available at [`deploy/herdr-lark-bridge.service`](deploy/herdr-lark-bridge.service).

## Verification

```bash
npm test
npm run typecheck
npm run build
```

See the complete behavior and acceptance criteria in [`docs/superpowers/specs/2026-08-22-herdr-lark-bridge-mvp-design.md`](docs/superpowers/specs/2026-08-22-herdr-lark-bridge-mvp-design.md).
