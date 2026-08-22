# Agent-first observability

## Goal

Make the bridge diagnosable from its existing PM2 logs, SQLite database, and
localhost HTTP server without first reproducing a failure or enabling temporary
debug logging. The design favors a small set of structured decision logs and
durable operational counters over verbose activity logs.

## Failure map

The signals must make these failure classes distinguishable:

1. startup configuration, project-directory, SQLite, Herdr workspace, HTTP bind,
   or Lark connection failure;
2. rejected, duplicate, failed, or interrupted inbound Lark messages;
3. turn-versus-steering dispatch decisions, queue saturation, and steering that
   falls back to a normal turn;
4. Herdr command timeout, missing pane, blocked turn, failed turn, and recovery
   after process restart;
5. card projection failure, Lark delivery retry, target-local delivery blocking,
   and dead-letter exhaustion; and
6. reconciliation failures or ambiguous panes that prevent a binding from
   converging.

## Structured log contract

The existing Pino logger remains the only log sink. Every durable operational log
has a stable kebab-case `event` field and a short human-readable message. Fields
are added only when relevant:

- correlation: `eventId`, `messageId`, `bindingId`, `promptId`, `parentPromptId`,
  `selectionId`, `replyId`;
- routing: `projectId`, `workspaceId`, `paneId`, `replyKind`;
- decision: `dispatchKind`, `agentState`, `queueDepth`, `attempt`, `outcome`,
  `reason`; and
- timing: `durationMs`.

Log levels follow operational meaning:

- `info`: service lifecycle, accepted dispatch decisions, turn completion, and
  dependency recovery;
- `warn`: blocked turns, recoverable fallback, retry scheduling, ambiguous panes,
  restart recovery, and dependency degradation;
- `error`: rejected processing after persistence, failed turns, dead letters,
  projection failures, and reconciliation failures; and
- `debug`: duplicate inputs and successful low-level delivery details that are
  useful during investigation but too noisy for normal operation.

The implementation logs decisions and terminal outcomes, not function entry,
poll iterations, terminal observations, or every coalesced card version.

## Privacy and redaction

Logs must not contain Lark message bodies, TraeX terminal output, rendered card
payloads, app secrets, tokens, cookies, authorization headers, or private keys.
User and chat identifiers are treated as operational identifiers and may be
logged only when needed for routing diagnosis. Error objects use Pino's `err`
serialization and the root logger expands its redaction paths for common secret
and authorization field names.

## Instrumentation points

### Process and dependencies

Startup logs the configured project count, workspace IDs, database path, HTTP
address, and log level, but not credentials. Successful startup records elapsed
time. Graceful shutdown keeps its existing signal and component-failure logs with
stable event names.

The Lark adapter receives a logger and records WebSocket `ready`, `error`,
`reconnecting`, and `reconnected` transitions. Repeated callbacks that do not
change readiness are suppressed.

### Inbound decisions and execution

The coordinator records one accepted decision per message: command, new turn,
steering, ignored out-of-scope input, or duplicate. It records IDs, route, queue
depth, and the reason for the decision, never the message body.

Turns record dispatch, blocked, completed, and failed outcomes. Completion and
failure include elapsed time. Steering records queued, delivered, fallback to a
normal turn, and uncertain failure. Restart recovery logs counts for every state
class changed during startup.

### Durable Lark outbox

Delivery failure logs include reply ID, kind, binding and prompt IDs, attempt,
next retry time, and whether the row became dead-letter. A dead letter is logged
at error; a scheduled retry is logged at warn. Successful delivery remains debug
level. No payload is logged.

### Reconciliation and projection

Reconciliation logs workspace-local failure and ambiguous or unregistered pane
decisions with their routing identifiers. Card projection failures include the
bridge event type in addition to IDs. Routine successful reconciliation is not
logged.

## Durable operational summary

SQLite remains the single persistent source of truth. No parallel failure-state
file is introduced. The store exposes a read-only operational summary containing:

- bindings grouped by state;
- prompts grouped by state and dispatch kind;
- outbound replies grouped by state;
- total pending outbox rows, total dead letters, and the oldest pending timestamp;
  and
- the most recently updated failed prompt and dead-letter reply, with identifiers,
  timestamp, attempt count where applicable, and a bounded error summary.

The summary never returns prompt bodies or outbound payloads.

## HTTP health and status

The HTTP server continues to listen on the configured host, which defaults to
localhost.

`GET /health` remains a cheap liveness check and returns only `status: ok`.

`GET /ready` evaluates components independently and returns:

- overall `status` (`ready` or `not_ready`);
- `components.database`;
- `components.projects`;
- `components.herdr`, including each configured workspace ID; and
- `components.lark`.

Each component reports `ok` and a bounded error only when unhealthy. All checks
run even if an earlier check fails so one response shows the full degradation.
HTTP status is 200 only when all components are ready; otherwise it is 503.

`GET /status` is a side-effect-free operational snapshot. It returns readiness,
the durable SQLite summary, process uptime, and the current timestamp. It does not
return configuration secrets, message content, terminal output, card payloads, or
raw stack traces. Its availability follows the same network boundary as the
existing health server and is documented as localhost-only by default.

Unknown paths continue to return 404.

## Error handling

Existing failures that are persisted and rethrown remain explicit. Silent catches
are retained only for expected parse probes or races where absence is part of the
contract; dependency failures at operational boundaries gain structured logs.
Logging must never replace state persistence or change retry behavior. A logging
failure must not crash the bridge.

## Verification

Automated tests cover:

1. stable event names and correlation fields for turn, steering, and recovery
   decisions without logging request bodies;
2. a simulated Lark delivery failure that persists retry metadata and emits a
   structured retry log;
3. repeated delivery failures that persist a dead letter and emit a terminal
   error log;
4. independent readiness component results, including multiple simultaneous
   failures;
5. `/status` counts, bounded recent failures, and absence of bodies/payloads;
6. Lark connection lifecycle logs with duplicate-state suppression; and
7. existing queueing, card projection, restart recovery, and shutdown behavior.

The failure-injection test is the required observability proof: a fresh reader can
identify what failed, which durable row is affected, whether it will retry, and
the component readiness state without enabling extra logging.

## Non-goals

- Prometheus, OpenTelemetry, distributed tracing, or a remote log backend.
- Logging every Herdr poll, output delta, card coalescing event, or successful HTTP
  health probe.
- A public diagnostic endpoint or authentication scheme for `/status`.
- A second persistent failure journal outside SQLite.
- Automatic alert delivery to Lark or another external service.
