# Herdr Agent Swarm: Agent Guide

## Project overview

Herdr Agent Swarm is a durable, human-controlled multi-agent workflow
coordinator. It manages project-scoped Primary and Worker instances in real
Herdr panes and projects their work into Lark CardKit cards through a retryable
outbox. The repository supports only the standalone `herdr-agent-swarm` service;
the former compatibility plugin is not an operator or deployment surface.

The source of truth is deliberately split:

- Herdr owns pane identity, terminal identity, foreground process, and agent
  state. Treat `herdr api snapshot` and targeted runtime observation as
  authoritative for the live pane.
- SQLite owns binding lifecycle, per-binding prompt FIFO, run-card and topic
  projections, delivery intent, idempotency, audit data, and the fenced
  instance lease.
- Lark owns only the visible cards and messages. Do not infer workflow state
  from a card, and do not repair SQLite based on Lark output.
- User systemd owns the service process. The `npm run swarm:*` commands are the
  supported operator surface.

The request path is: normalized Lark message or card action -> durable inbound
record -> `SyncCoordinator` -> one prompt worker per binding -> Herdr/TraeX ->
bridge events -> SQLite card projections and outbox -> Lark CardKit delivery.
Herdr socket events are bounded wake-up hints; reconciliation against a fresh
Herdr snapshot is the convergence path.

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
- Keep high-risk TraeX approval local to Herdr. The bridge permits only
  identity-fenced exact-turn stop; it has no remote approval, denial, arbitrary
  terminal-input, process-kill, or pane-kill action.

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
- `src/cli/` and `scripts/` implement validation and standalone user-systemd
  lifecycle actions.

Read `docs/architecture.md` before changing durability, recovery, reconciliation,
or CardKit behavior. `docs/feishu-group-usage.md` is the user-command reference.
Historical designs are not the current behavioral authority.

## Build and operations

Requirements: Linux, Node.js >= 22.12 (Node 24 LTS recommended), npm, a running
Herdr workspace, `herdr`, `traex`, and a Lark bot configured for long
connections. Herdr >= 0.7.5 is required for the CLI/socket runtime contract.

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
| Configure the standalone service on first run | `npm run build && npm run swarm:setup` |
| Build, stage, install, and enable the configured service | `./install.sh` |
| Start the installed service | `npm run swarm:start` |
| Inspect service health and recent failures | `npm run swarm:status` |
| Restart or stop the service | `npm run swarm:restart` / `npm run swarm:stop` |
| Inspect the final 100 lines (at most 1 MiB) of the private service log | `npm run swarm:logs` |

Run `./install.sh` after source changes to build and stage an immutable release;
then use `npm run swarm:restart` when the active-work safety gate permits it. The
managed unit verifies the expected generated build identity. Do not manually edit
generated `dist/` output. Installation enables the unit but does not start it.
Candidate staging does not move `${SWARM_STATE_DIR}/current`; lifecycle
installation commits that link only after unit reload and enable succeed. If a
failed compensation leaves `.release-activation.json`, inspect and reconcile the
unit and `current` target before retrying install, start, or restart.
The canonical unit appends stdout and stderr to
`${SWARM_STATE_DIR}/logs/service.log`; the lifecycle keeps `logs/` private at
`0700` and the log at `0600`. Logs rotate at 16 MiB while the unit is stopped,
retaining `service.log.1` through `.3` and the current file. Host journal access
is not required for supported log inspection. `npm run swarm:logs -- <options>`
supports bounded rotated-history, level, time, component, and correlation-ID
filters; use `--json` for headerless JSONL output.

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

For production diagnosis, start with `npm run swarm:status` and correlate
structured Pino records by `eventId`, `bindingId`, `promptId`, `paneId`, or
`replyId`. Reconcile state against Herdr rather than trusting stale card text.
Inspect the durable prompt and outbox state before altering or restarting a live
service; shutdown detaches in-flight observers by design.

## Security and data handling

- Before every push to any remote, inspect the complete commit range that will
  be pushed and run `npm run public:audit`. Treat this as a blocking security
  gate: do not push if the audit fails or if the outgoing commits contain a
  credential, private key, access token, API key, session token, secret-bearing
  configuration, or other sensitive runtime data. Do not limit the review to
  the current worktree because already committed outgoing changes are part of
  the push. If a suspected secret is found, stop, keep it out of the remote,
  report the affected path without printing the value, and require the secret
  to be removed from every outgoing commit and rotated when exposure is
  possible.
- Keep `LARK_APP_SECRET` and the standalone `.env` file private. Do not commit
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

Standalone setup manages private configuration under
`${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm` and state under
`${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm`. `SWARM_CONFIG_DIR`
and `SWARM_STATE_DIR` override those roots. Explicit `PROJECTS_CONFIG_PATH` and
`BRIDGE_DATABASE_PATH` override the derived files.

Required environment variables:

- `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_CHAT_ID`, `LARK_BOT_OPEN_ID`

Common optional settings include `BRIDGE_HTTP_HOST`, `BRIDGE_HTTP_PORT`,
`HERDR_BIN`, `TRAEX_BIN`, `LOG_LEVEL`, `COMMAND_TIMEOUT_MS`, `LARK_REQUEST_TIMEOUT_MS`,
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
