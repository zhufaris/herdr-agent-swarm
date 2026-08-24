# Herdr Lark Bridge: Agent Guide

## Project overview

Herdr Lark Bridge connects one Lark topic to a TraeX process running in a real
Herdr pane. It is a durable workflow coordinator, not a direct message relay:
incoming work is persisted, observed through Herdr, projected into CardKit
answer cards, and delivered through a retryable Lark outbox.

The source of truth is deliberately split:

- Herdr owns pane identity, terminal identity, foreground process, and agent
  state. Treat `herdr api snapshot` and targeted runtime observation as
  authoritative for the live pane.
- SQLite owns binding lifecycle, per-binding prompt FIFO, run-card and topic
  projections, delivery intent, idempotency, audit data, and the fenced
  instance lease.
- Lark owns only the visible cards and messages. Do not infer workflow state
  from a card, and do not repair SQLite based on Lark output.
- User systemd owns the service process. The Herdr plugin is the supported
  operator surface.

The request path is: normalized Lark message or card action -> durable inbound
record -> `SyncCoordinator` -> one prompt worker per binding -> Herdr/TraeX ->
bridge events -> SQLite card projections and outbox -> Lark CardKit delivery.
Herdr plugin events are bounded loopback wake-up hints; reconciliation against a
fresh Herdr snapshot is the convergence path.

### Invariants that changes must preserve

- A binding dispatches at most one ordinary turn at a time. Later ordinary
  messages remain FIFO-queued; eligible messages during an active turn can be
  delivered as steering work.
- Never automatically replay a prompt after it may have reached TraeX. An
  interrupted or uncertain observer becomes detached and is observed again; only
  work that never started remains eligible for later dispatch.
- Persist workflow intent before Lark delivery. The durable outbox supplies
  idempotency, retry, and dead-letter behavior; a delivery retry must not repeat
  a TraeX prompt.
- CardKit stream sequence is ordered within a card element. Frozen answer pages
  are not patched; large answers continue in a new card.
- Keep high-risk TraeX approval local to Herdr. The bridge intentionally has no
  remote stop or approval action.

### Code boundaries

- `src/main.ts` is the composition root: it loads configuration, creates the
  adapters/store/event pipeline, takes the SQLite lease, and owns startup and
  shutdown wiring.
- `src/adapters/` integrates the Herdr CLI and Lark SDK. Keep external-command
  parsing, SDK normalization, and transport-specific behavior here.
- `src/coordinator/` owns binding, prompt, steering, reconciliation, and
  shutdown-facing workflow decisions. `SessionReconciler` is the single path for
  event-driven and periodic Herdr convergence.
- `src/domain/` defines ports, types, commands, lifecycle transitions, and
  deterministic view reducers. Prefer extending these contracts over coupling
  workflows directly to a concrete adapter.
- `src/events/` projects bridge events into durable views and drains Lark work
  through the publisher.
- `src/store/sqlite-store.ts` owns schema migration and atomic state changes.
  Keep multi-row workflow transitions transactional.
- `src/runtime/` contains bounded terminal parsing, redaction, event inbox,
  lease, shutdown, build identity, and cache mechanics.
- `src/cards/` contains pure Lark CardKit rendering. Keep presentation logic out
  of coordinators.
- `src/cli/` and `plugin/` implement validation and Herdr plugin/systemd
  lifecycle actions.

Read `docs/architecture.md` before changing durability, recovery, reconciliation,
or CardKit behavior. `docs/feishu-group-usage.md` is the user-command reference.
Historical designs are not the current behavioral authority.

## Build and operations

Requirements: Linux, Node.js >= 22.5 (Node 24 LTS recommended), npm, a running
Herdr workspace, `herdr`, `traex`, and a Lark bot configured for long
connections. The Herdr plugin requires Herdr >= 0.7.5.

| Purpose | Command |
| --- | --- |
| Install locked dependencies and build | `npm ci && npm run build` |
| Compile TypeScript and generate build identity | `npm run build` |
| Check TypeScript without emitting | `npm run typecheck` |
| Run the full Vitest suite | `npm test` |
| Watch source during local development | `npm run dev` |
| Start compiled service in foreground | `npm start` |
| Validate an environment file and project registry | `npm run config:validate -- <env-file> <projects-file>` |
| Observe a real configured bridge without sending Lark messages | `npm run smoke:real-user` |
| Build, link, and enable the Herdr plugin | `./install.sh` |
| Configure, install, and start the managed service | `./install.sh --setup` |
| Restart a linked, rebuilt plugin service | `herdr plugin action invoke restart --plugin herdr-lark-bridge` |
| Inspect service health and recent failures | `herdr plugin action invoke status --plugin herdr-lark-bridge` |
| Inspect bounded logs | `herdr plugin action invoke logs --plugin herdr-lark-bridge` |

Run `npm run build` after source changes before using the plugin restart action;
the managed unit verifies the expected generated build identity. Do not manually
edit generated `dist/` output.

For foreground development, load the same environment used by the service before
starting the process. The service exposes `/health`, `/ready`, and `/status` on
the configured loopback host/port. `/health` only means the process responds;
`/ready` additionally requires the lease, projects, Herdr, and Lark to be
usable.

## Code style and implementation guidance

- TypeScript uses the repository `tsconfig.json`; keep code compatible with the
  Node engine declared in `package.json` and use ESM imports with `.js`
  specifiers for local modules.
- The repository has no configured ESLint, Prettier, Biome, or EditorConfig
  command. Follow the established compact TypeScript style: two-space
  indentation, semicolons, double-quoted imports/strings, `camelCase` values and
  functions, `PascalCase` types/classes, and explicit domain-oriented names.
- Validate external configuration and CLI/SDK data at boundaries with Zod. Keep
  adapter output normalized before it reaches coordinators.
- Use `BridgeEventBus` plus reducers/projectors for user-visible lifecycle
  changes. Do not update Lark cards directly from a coordinator.
- Command execution must go through the command-runner abstraction so prompt
  arguments remain redacted in errors. Terminal reads must pass through the
  existing bounded parsing/redaction paths before persistence or Lark delivery.
- Preserve idempotency keys and SQLite transaction boundaries. A change that
  updates a prompt, its run-card, and outbox intent should be designed as one
  durable transition.

## Testing and debugging

Vitest is the test runner. Unit tests use `*.test.ts`; integration-oriented
tests use names such as `*.integration.test.ts` and exercise coordinator, store,
event, and adapter seams with fakes or temporary SQLite databases.

When changing a boundary, extend the nearest focused test first:

- configuration and project validation: `tests/config.test.ts`;
- SQLite lifecycle, queue, outbox, or migration behavior:
  `tests/sqlite-store.test.ts`;
- prompt concurrency, recovery, or steering:
  `tests/concurrency-controls.integration.test.ts`,
  `tests/steering-integration.test.ts`, or `tests/turn-supervisor.test.ts`;
- Herdr observation or prompt submission: `tests/herdr-adapter.test.ts` and
  `tests/session-reconciler.test.ts`;
- Lark/CardKit delivery and answer rendering: publisher, card, stream, or
  markdown tests.

For a focused pass, run `npx vitest run <test-file>`. Before handing off a code
change, run at least the affected test file(s), `npm run typecheck`, and
`npm run build`; run `npm test` for changes spanning workflow, persistence, or
shared runtime behavior. Use `npm run smoke:real-user` only against a configured
bridge for non-mutating operational observation.

For production diagnosis, start with the status plugin action and correlate
structured Pino records by `eventId`, `bindingId`, `promptId`, `paneId`, or
`replyId`. Reconcile state against Herdr rather than trusting stale card text.
Inspect the durable prompt and outbox state before altering or restarting a live
service; shutdown detaches in-flight observers by design.

## Security and data handling

- Keep `LARK_APP_SECRET` and all plugin `.env` files private. Do not commit
  credentials, live project registries, SQLite databases, WAL/SHM files, logs,
  or generated runtime state. `var/` is service-owned runtime data.
- The Lark adapter accepts only configured-chat, user-originated text messages
  and configured-chat card actions. Retain this allowlist on all inbound paths.
- Project registry entries are a security boundary: IDs are restricted and each
  `cwd` must be an accessible absolute directory. Do not broaden a project route
  without intent.
- Logger redaction protects common credential fields; command-runner redacts
  submitted prompt arguments; terminal parsing removes reasoning/protocol text
  and known secret shapes before storage or delivery. Preserve and test these
  protections when changing logs, errors, parser rules, or CardKit rendering.
- Do not expose the health server beyond its configured local interface unless a
  separate deployment decision explicitly changes that boundary.
- Do not copy a live SQLite database without its WAL/SHM companions. Prefer
  retaining the configured absolute database path during a service migration.

## Configuration

The plugin setup action manages private configuration under
`HERDR_PLUGIN_CONFIG_DIR` and state under `HERDR_PLUGIN_STATE_DIR`. With those
variables present, defaults resolve to `projects.json` in the config directory
and `bridge.db` in the state directory. Explicit `PROJECTS_CONFIG_PATH` and
`BRIDGE_DATABASE_PATH` override those defaults.

Required environment variables:

- `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_CHAT_ID`, `LARK_BOT_OPEN_ID`

Common optional settings include `BRIDGE_HTTP_HOST`, `BRIDGE_HTTP_PORT`,
`HERDR_BIN`, `TRAEX_BIN`, `LOG_LEVEL`, `COMMAND_TIMEOUT_MS`,
`TURN_TIMEOUT_MS`, `RECONCILE_INTERVAL_MS`, `INSTANCE_LEASE_TTL_MS`,
`INSTANCE_LEASE_HEARTBEAT_MS`, `MAX_QUEUE_DEPTH`, and
`LARK_MESSAGE_CHUNK_SIZE`. The actual environment schema in `src/config.ts` is
the source for defaults and valid ranges.

`projects.json` must contain a non-empty `projects` array and a
`defaultProjectId` that references one entry. Each project needs a unique
lowercase `id`, display name, description, Herdr `workspaceId`, and an absolute
`cwd`; no two projects may use the same workspace/cwd route. Validate edited
files before service changes with `npm run config:validate -- <env-file>
<projects-file>`.
