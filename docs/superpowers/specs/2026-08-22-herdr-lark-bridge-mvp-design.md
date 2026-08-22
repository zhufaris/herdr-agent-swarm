# Herdr to Lark Bridge MVP Design

## 1. Goal

Build a TypeScript service that lets members of one configured Lark group operate TraeX agents running in a local Herdr workspace. The bridge maps each managed Lark topic to one real TraeX agent pane so users can start work from Lark, continue it from either Lark or Herdr, and observe the final response in both places.

The MVP runs on the same machine as the Herdr server. It does not provide SSH transport, arbitrary shell execution, or remote approval of high-risk operations.

## 2. Canonical Mapping

The bridge uses these stable relationships:

```text
Bridge instance -> one Lark Bot credential set
Herdr workspace <-> one configured Lark group
Herdr TraeX pane <-> one managed topic in that group
```

A future deployment can run one bridge instance per workspace when each workspace needs a distinct bot identity. The persistence model may support multiple workspace/group bindings, but the MVP configuration enables exactly one.

Terminology in this document is precise:

- `workspace` means a Herdr workspace.
- `pane` means a Herdr terminal pane that the bridge created or recognized as a TraeX runtime.
- `topic` means a Lark group topic/thread rooted at a specific message.
- `binding` means the persisted relationship between a workspace, group, topic, pane, and TraeX session.

## 3. Scope

### 3.1 Included

- Receive Lark events over the official long-connection client.
- Bind one configured Herdr workspace to one configured Lark group.
- Create a Herdr pane and start `traex` from an explicit Lark topic command.
- Create a Lark topic for an unbound TraeX pane discovered in the workspace.
- Send topic messages to the bound TraeX session as prompts.
- Publish TraeX final responses and state changes back to the topic.
- Synchronize topic and pane names in both directions.
- Archive bindings safely when either side disappears or closes.
- Persist mappings, event deduplication, queued prompts, and audit records in SQLite.
- Reconcile persisted bindings with Lark and Herdr after restart.

### 3.2 Excluded

- SSH or a remote Herdr agent.
- Mapping ordinary shell panes.
- Arbitrary command execution from Lark.
- Approving high-risk TraeX operations from Lark.
- Token-by-token streaming.
- Image, file, audio, or rich attachment input.
- Multiple active workspace/group bindings in one process.
- Deleting Lark history or forcibly terminating a running TraeX process when a topic is archived.

## 4. Architecture

The MVP is one Node.js process written in TypeScript and divided into modules with narrow interfaces.

```text
Lark long connection
        |
        v
   LarkAdapter
        | normalized events
        v
 SyncCoordinator <----> BindingStore (SQLite/WAL)
        |
        +----> HerdrAdapter ----> local Herdr CLI/socket API
        |
        +----> TraexRuntime ----> traex in a Herdr pane
```

### 4.1 `LarkAdapter`

Responsibilities:

- Connect with the official Lark Node SDK.
- Validate that an event belongs to the configured group.
- Normalize message, topic, rename, and archive events.
- Create topic roots, post replies, and update the bridge-owned status message.
- Split final responses that exceed Lark message limits.
- Expose Lark identifiers without leaking SDK objects into domain logic.

### 4.2 `HerdrAdapter`

Responsibilities:

- Read the live Herdr snapshot and resolve the configured workspace by stable ID.
- List panes and agent state in that workspace.
- Create, rename, inspect, and close panes through structured Herdr commands.
- Read pane output and submit text through supported Herdr agent/pane operations.
- Inspect foreground process metadata to distinguish a real `traex` process from other agents that share Herdr's compatibility label.
- Return typed results and structured errors; no coordinator code parses human-oriented CLI output.

The implementation invokes the local `herdr` executable. A command runner interface isolates process execution so tests can use a fake implementation and a later release can replace CLI calls with direct socket access.

### 4.3 `TraexRuntime`

Responsibilities:

- Start `traex --permission-mode auto` in a newly created pane.
- Record the runtime as `traex` independently of Herdr's detected agent label.
- Submit one prompt at a time per binding.
- Observe working, blocked, idle, and done transitions.
- Derive a final assistant response from TraeX session metadata/hooks and bounded pane snapshots.

Herdr 0.7.5 does not expose a distinct `traex` agent kind on this host, and compatibility detection may label TraeX as `codex`. The bridge therefore treats its own persisted `runtime = traex` field as authoritative for existing bindings. For discovery, it requires `herdr pane process-info --pane <id>` to report a foreground process whose executable name is exactly `traex`; it must never adopt a pane merely because Herdr reports `agent = codex`.

### 4.4 `BindingStore`

SQLite is the durable coordination source. It runs in WAL mode and stores:

- Workspace/group configuration and stable IDs.
- Topic root message ID, topic title, pane ID, and TraeX session identity when available.
- Binding lifecycle state and last known state on each side.
- Inbound Lark event/message IDs for deduplication.
- Per-binding prompt queue and delivery state.
- Bridge-originated Lark message IDs for loop prevention.
- Audit events with Lark user identity, action, target, outcome, and timestamp.

### 4.5 `SyncCoordinator`

Responsibilities:

- Apply all lifecycle transitions idempotently.
- Serialize operations for each binding while allowing different topics to progress concurrently.
- Recover pending work after restart.
- Attach an origin to every mutation (`lark`, `herdr`, or `bridge`) to prevent rename and message loops.
- Reconcile persisted state before accepting new events.

## 5. Binding State Model

```text
pending -> active -> archived
    |         |
    |         +-> orphaned
    +------------> failed

failed --retry--> pending
orphaned --repair/rebind--> active
```

- `pending`: creation has begun but not all external identifiers exist.
- `active`: topic, pane, and runtime are usable.
- `archived`: deliberately disconnected while history is retained.
- `orphaned`: one side disappeared unexpectedly; no destructive repair is automatic.
- `failed`: creation or synchronization failed and can be retried idempotently.

Each multi-step creation persists progress after every external side effect. A retry checks for the recorded object before creating another one.

## 6. Lark to Herdr Flow

### 6.1 Creating a Binding

The bridge ignores ordinary group messages and ordinary topics. A new managed topic requires one of these explicit triggers:

- `/herdr new <title>`
- A new topic root that mentions the bot and contains a non-empty prompt

For `/herdr new <title>`, the command message provides the title. The user sends the first prompt as the next topic reply. For an `@Bot` topic root, the bridge derives the title from the first bounded line of the prompt and uses the full mention-stripped body as the initial prompt.

Creation sequence:

1. Persist a `pending` binding keyed by the triggering Lark message ID.
2. Create a Herdr pane in the configured workspace, using the workspace's current project directory.
3. Start `traex --permission-mode auto` in that pane.
4. Persist the pane and TraeX runtime metadata.
5. Create or recognize the Lark topic root and persist its identifier.
6. Mark the binding `active`.
7. Queue the initial prompt when one exists.

### 6.2 Sending Prompts

Any member of the configured group may send text or a code block in an active managed topic. The bridge strips only the bot mention used for routing and preserves the remaining text.

Each binding owns a FIFO prompt queue. If TraeX is working, the new prompt is persisted and the status message says it is queued. The coordinator submits the next prompt only after the current turn reaches a settled state. Prompts are never injected into an active turn.

Bot-authored messages, bridge status messages, duplicate Lark events, and messages from other groups never become prompts.

## 7. Herdr and TraeX to Lark Flow

At startup and on periodic reconciliation, the bridge scans only the configured workspace. It automatically publishes a topic only for panes already recorded as bridge-managed or panes whose foreground process metadata identifies the executable as `traex`. It does not adopt every Herdr pane labeled `codex`, because TraeX currently shares that compatibility label.

For each turn:

1. Update one bridge-owned status message to `working`.
2. Observe TraeX/Herdr state until `done`, `idle`, `blocked`, or timeout.
3. On `done` or `idle`, extract the final assistant response and post it as one or more topic replies.
4. On `blocked`, update the status message with a clear instruction to handle approval in the Herdr terminal.
5. Mark the queue item complete only after its Lark response has been acknowledged or a durable delivery failure has been recorded.
6. Submit the next queued prompt.

The MVP publishes final responses rather than terminal output streams. ANSI escape sequences, spinners, tool progress, and duplicated terminal history are never forwarded as the answer. If the runtime cannot identify a reliable final response, it posts a short fallback telling the user to inspect the Herdr pane instead of publishing guessed or truncated content.

Prompts entered locally in a managed Herdr pane are also observed. Their settled final response is published to the bound topic, with deduplication based on the TraeX turn/session identity or a stored output fingerprint.

## 8. Lifecycle Synchronization

### 8.1 Rename

- `/herdr rename <name>` renames both the Lark topic representation and the Herdr pane.
- A supported Herdr pane rename updates the Lark-side displayed title.
- Every rename records its origin and desired normalized name. Seeing the same value on the other side is an acknowledgement, not a new mutation.

If Lark's topic API does not allow changing a root title after creation, the bridge updates its status card/title marker and posts a rename notice; it does not recreate the topic or lose history.

### 8.2 Close and Archive

- `/herdr close` archives the binding and stops accepting new prompts.
- Archiving or deleting a Lark topic archives the binding but does not terminate TraeX or close the pane.
- Closing the Herdr pane posts a final notice and archives the binding.
- The bridge never deletes Lark message history.
- A running TraeX process is not forcibly terminated by the MVP.

## 9. Commands

The MVP exposes these commands in the configured group:

```text
/herdr new <title>
/herdr status
/herdr rename <name>
/herdr close
/herdr help
```

`status`, `rename`, and `close` require an active managed topic. Invalid context or syntax receives a concise help response and causes no Herdr mutation.

## 10. Authorization and Safety

- Only events from the configured Lark group are accepted.
- Every member of that group may create bindings and submit prompts.
- Every operation records the acting Lark user for auditability.
- Lark exposes no shell command endpoint and cannot target an arbitrary pane ID.
- The bridge starts TraeX in `auto` permission mode.
- `bypass_permissions`, `danger-full-access`, and equivalent unsafe defaults are prohibited.
- Approval requests that cannot be safely auto-reviewed leave TraeX blocked. The user must resolve them in Herdr.
- Secrets are loaded from environment variables or a restricted configuration file and are redacted from logs.
- Logs do not store full prompt/response bodies by default; they store IDs, sizes, hashes, states, and outcomes.

## 11. Reliability and Recovery

- Lark event ID and message ID have uniqueness constraints.
- Bridge-originated message IDs prevent echo loops.
- External calls use bounded timeouts and exponential backoff with jitter.
- Retryable work is persisted before execution.
- A process lock prevents two bridge instances from consuming the same configuration and database.
- Startup reconciliation completes before the Lark consumer begins dispatching new work. Incoming events received during reconciliation are durably staged.
- Missing topic or pane objects become `orphaned`; the bridge reports the condition and waits for an explicit repair rather than recreating or deleting objects blindly.
- SQLite runs in WAL mode and all state transitions use transactions.

## 12. Configuration

The service validates configuration at startup. Required values are:

- Lark app ID and app secret.
- Lark group/chat ID.
- Stable Herdr workspace ID.
- Paths to the `herdr` and `traex` executables, with safe discovered defaults.
- SQLite database path.

Optional values include log level, command timeouts, reconciliation interval, maximum queued prompts per topic, and Lark message chunk size. Human-readable workspace labels are diagnostic only and never serve as stable binding keys.

## 13. Observability

Structured logs include correlation fields such as `eventId`, `messageId`, `bindingId`, `topicId`, `paneId`, `turnId`, and `actorOpenId`. Key lifecycle changes and retry outcomes are logged at info level; raw command output is diagnostic and redacted.

The process exposes a local HTTP server with:

- `GET /health`: process is alive.
- `GET /ready`: configuration is valid, SQLite is writable, Herdr is reachable, the workspace exists, and Lark has connected at least once.

## 14. Testing and MVP Acceptance

### 14.1 Automated Tests

- Unit tests: command parsing, mention removal, mapping transitions, authorization, origin-loop suppression, response chunking, and deduplication.
- Store tests: transactional transitions, unique events, queue recovery, and WAL configuration against a temporary database.
- Adapter contract tests: fake Lark and fake command runner responses, including timeouts, malformed output, and retries.
- Integration tests: temporary SQLite plus fake Herdr/TraeX processes for bidirectional creation, FIFO prompts, blocked state, restart recovery, and orphan detection.

### 14.2 Manual E2E Acceptance

The MVP is accepted when all of the following work in a test group and workspace:

1. A group member creates a managed topic, a Herdr pane starts TraeX, and the initial prompt's final response returns to the same topic.
2. A second message sent while TraeX is working is queued and runs only after the first turn settles.
3. A bridge-managed TraeX pane created from Herdr receives a corresponding Lark topic without duplicate creation after restart.
4. Rename propagates without a loop.
5. Closing a pane archives the binding and preserves Lark history.
6. A blocked approval is visible in Lark and cannot be remotely bypassed.
7. Restarting the bridge preserves bindings and pending prompts without duplicate Lark replies.
8. Events from a different group and bot-authored messages cause no Herdr action.

## 15. Implementation Constraints

- TypeScript on Node.js 22.
- Official Lark Node SDK for long-connection events and messaging.
- Runtime validation for configuration and untrusted event payloads.
- SQLite with explicit migrations; no external database for the MVP.
- Structured logging with mandatory secret redaction.
- Production and test code depend on adapter interfaces, not global process execution or SDK singletons.

