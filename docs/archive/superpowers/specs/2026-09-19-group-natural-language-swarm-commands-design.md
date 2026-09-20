# Group Natural-Language Swarm Commands

## Goal

Allow an authorized user to mention the bot in the configured Feishu group and
operate the common Swarm control surface with natural Chinese or English, while
preserving the existing slash-command, authorization, fencing, durability, and
no-replay guarantees. Natural language is an interpretation layer, not a second
control plane.

The feature must also remove the ambiguity exposed by `@Bot create new project`:
`/swarm new` creates a new Primary task/session in a configured project. It does
not create a project, workspace, or edit `projects.json`.

## Success criteria

The design is successful when an authorized Group user can explicitly mention
the bot and express every common existing Swarm operation in natural language;
the system either executes a read-only query, asks for a durable confirmation,
routes an unmistakable engineering task, or explains what is missing. It must
never silently reinterpret an unsupported or ambiguous control request as agent
work, and no Agent-generated text may directly become a Herdr side effect.

## Scope

The first release covers the common operations already exposed by typed Swarm
and instance commands:

- discovery: help, projects, spaces, panes, sessions, failures, status, instance
  directories and details;
- Primary lifecycle: create a Primary task/session, reset, attach, rename,
  reattach, replace, resume, awake, skip, stop, steer, and model selection;
- pane lifecycle: request pane close and submit the existing close code;
- Worker lifecycle and control: create, list, select, send work, steer, and stop.

It does not dynamically add, remove, or edit configured projects or Herdr
workspaces. It does not approve high-risk TraeX actions, execute arbitrary shell
commands, write arbitrary terminal input, kill processes or panes outside the
existing workflows, or introduce a payload-bearing in-memory queue.

Explicit `/swarm ...` and instance slash commands remain deterministic and keep
their current direct-execution behavior.

## Interaction model

Only a configured-group message that explicitly mentions the bot is eligible
for natural-language command interpretation. Existing bound-thread ordinary
messages without a bot mention remain prompts. Ordinary unbound group chat is
ignored or receives the existing unbound guidance.

The interpreter classifies eligible input into exactly one of four outcomes:

1. `command`: one complete, typed, allowlisted command with extracted arguments;
2. `task`: an ordinary agent task, handled by the existing prompt or default
   project provisioning path;
3. `clarification`: a command-shaped request with missing or ambiguous target or
   arguments;
4. `unsupported`: a clearly requested control operation outside the allowlist.

There is no command-to-task fallback. Once input is recognized as
command-shaped, failure to produce one safe typed command yields guidance or a
clarification card, never a prompt to TraeX. This is the key safeguard for
phrases such as `create new project`.

Examples:

| Input | Interpretation | Result |
| --- | --- | --- |
| `@Bot 当前状态怎么样` | `status` query | Execute immediately |
| `@Bot 列出所有 pane` | `panes` query | Execute immediately |
| `@Bot 在 datasage 创建新任务：修复登录` | `new` mutation | Show confirmation card |
| `@Bot stop current task` | `stop` mutation | Show confirmation card |
| `@Bot 创建 reviewer worker 并启动` | `worker_create` mutation | Show confirmation card |
| `@Bot create new project` | unsupported dynamic project creation | Explain configured-project boundary and offer project listing/new Primary wording |
| `@Bot 帮我实现登录页` | ordinary task | Route as a prompt |
| `@Bot 停一下` | ambiguous | Ask whether to stop the active turn; do not execute |

## Controller Agent architecture

Natural-language interpretation is owned by one service-managed default Swarm
Controller Agent. The service starts and observes it through the existing Herdr
CLI adapter in a dedicated tab of the configured default project's workspace.
The Controller is not a project Primary, has no Lark Binding, and does not
consume a user task slot. Its pane carries a reserved controller identity so
reconciliation and directory rendering can distinguish it from project work.

The service provides a controller-specific skill and MCP surface. The skill
defines the Swarm vocabulary, the project/session distinction, Chinese and
English examples, and the rule that ambiguity must be returned rather than
guessed. The MCP surface exposes only bounded read-only Swarm context and a
submit_interpretation operation that records one validated interpretation for
the current request.

The Controller receives no Primary capability and cannot call the existing
effectful create_worker, prompt_instance, steer_instance, or interrupt_instance
tools. It does not receive a general Herdr mutation tool. The bridge itself may
use Herdr CLI to create, observe, and prompt the Controller; all requested Swarm
effects remain behind the application workflows. This makes the Agent an
interpreter and planner, not an alternate operator authority.

The Controller may use the Herdr skill for vocabulary and bounded observation.
Its CLI allowlist is limited to read-only commands equivalent to workspace,
pane, and agent list/get/read operations. It cannot use pane run, send-keys,
close, split, agent prompt, agent interrupt, workspace creation, or server
control. When the user asks to change state, the Controller must submit a typed
proposal to the Swarm MCP instead of invoking a Herdr mutation directly.

### Controller lifecycle and configuration

Controller operation is enabled by validated configuration rather than inferred
from whichever pane happens to be focused. The configuration fixes the agent
kind, optional model, workspace, cwd, reserved name, request timeout, and maximum
response size. Defaults are TraeX, the configured default project's workspace
and cwd, name herdr-swarm-controller, and a dedicated background tab.

At service startup the Controller manager:

1. loads the durable controller record and queries a fresh Herdr snapshot;
2. reuses a pane only when workspace, cwd, reserved name, agent kind, terminal
   identity, and generation all match;
3. otherwise marks the old runtime stale and creates one replacement dedicated
   tab through the Herdr adapter;
4. starts the configured agent with only the Controller MCP and controller skill;
5. records the verified pane, terminal, native session, generation, and
   capability hash before accepting interpretation jobs.

Only one Controller runtime may be current. The service lease fences Controller
creation and job claims. Losing the Controller degrades natural-language
interpretation but does not make the whole service unready: health and status
report controller availability separately, while explicit slash commands,
ordinary tasks, and deterministic fast-path commands continue to work.

Shutdown stops job admission, waits for the current bounded observation, marks
an unresolved dispatched job uncertain, revokes the MCP capability, and leaves
the Herdr pane intact for diagnosis. Restart reconciles that exact pane and turn;
it does not create a second Controller or resend an uncertain request.

### Durable interpretation requests

Each eligible Group message is first recorded as a durable interpretation job
with source identity, actor, conversation scope, sanitized text, state, and
controller-generation fence. Jobs are processed FIFO, one at a time, so replies
cannot be associated with the wrong message. The controller MCP capability is
bound to the current job and expires when that job settles.

The Controller must finish by submitting exactly one versioned result: a typed
command proposal, an explicit ordinary-task classification, a clarification
with bounded choices, or an unsupported-operation explanation.

The Controller prompt contains a generated request ID, sanitized user text,
conversation facts, and a bounded catalog snapshot. It explicitly instructs the
Agent to call submit_interpretation exactly once and not to perform the requested
operation itself. Prose printed by the Agent is diagnostic only and is never
parsed as an executable command.

The process-local scheduler is only a wake-up mechanism. SQLite owns the job and
result. If a prompt may have reached the Controller but no structured result was
recorded, the job becomes uncertain; the service observes the exact Controller
turn for a result but never automatically sends the interpretation prompt again.
This applies the same no-replay rule used for project prompts.

Interpretation job states are accepted, dispatching, observing, succeeded,
clarification, unsupported, failed, and uncertain. A stable source-message key
deduplicates admission. Accepted jobs may be dispatched after restart because no
Controller prompt was sent; dispatching or observing jobs become uncertain and
are only reconciled against the recorded Controller session and turn. Terminal
results are immutable.

### Typed interpreter port

`NaturalLanguageCommandInterpreter` accepts normalized text plus only the
minimum catalog needed for extraction (configured project IDs/display names and
known command vocabulary). It returns a discriminated result and never performs
I/O or effects. A successful command result contains an existing
`BridgeCommand` or `InstanceCommand`; downstream workflows never consume free
form model output.

The production interpreter composes two implementations: a small deterministic
fast path for exact, high-frequency expressions, and the Controller Agent for
open-ended language, references, and parameter extraction.

The Agent result is accepted only after strict Zod validation against the same
allowlisted command union. Unknown command kinds, additional keys, invalid
arguments, low confidence, or multiple candidates become clarification. The
Controller cannot call workflows or construct terminal input. Deterministic
matches always win.

The Controller MCP is intentionally smaller than the Primary MCP:

| Tool | Access | Purpose |
| --- | --- | --- |
| get_interpretation_context | Read-only | Return the current request, project aliases, scoped Primary, Workers, pane IDs, and supported command schema |
| inspect_swarm_target | Read-only | Resolve one named configured project, Primary, Worker, or pane without exposing terminal content |
| submit_interpretation | Proposal only | Persist one schema-validated command, task, clarification, or unsupported result for the fenced request |

No Controller tool executes a command. Even read-only Herdr CLI observations are
advisory; the existing context resolver obtains fresh authoritative state again
before query execution or confirmation creation.

### Deterministic fast path and degraded mode

The local grammar covers exact common Chinese and English forms, obvious
ordinary engineering-task prefixes, and dangerous unsupported phrases such as
dynamic project creation. A match must consume the whole normalized utterance;
partial matches never silently discard arguments.

If the Controller is unavailable, exact fast-path queries still work, exact
mutation requests can still produce confirmation cards, obvious engineering
tasks retain the existing default-project path, and every other command-shaped
message receives an unavailable or clarification card. Degraded mode never
guesses and never turns a failed interpretation into an Agent task.

## Routing and safety policy

Ingress order becomes:

1. route Worker-session thread messages through their existing exact route;
2. parse explicit slash commands;
3. locate the binding and alias context;
4. for an explicit bot mention, run the deterministic fast path and, when
   needed, enqueue a Controller interpretation job;
5. dispatch a query, stage a mutation confirmation, emit clarification, or
   continue through the ordinary-task path;
6. retain existing alias restrictions and default-project task provisioning.

Natural-language commands reuse `SwarmCommandPolicy` and the existing context
resolver. The interpreter does not encode authorization. Query execution still
runs through `SwarmCommandGateway` or the existing instance interaction
workflow, so allowed-user, administrator, creator, scope, and active-turn checks
remain authoritative.

Queries execute immediately because they do not mutate workflow state. Every
natural-language mutation requires a confirmation card, including create,
rename, reset, resume, awake, skip, stop, steer, model changes, Worker control,
and attachments. Pane/topology closure keeps its existing second close-code
confirmation after the generic natural-language confirmation. Thus confirming
“close this pane” requests a close plan; it never bypasses the close code.

Command coverage maps onto the current control surface rather than inventing
new effects:

| Natural-language capability | Existing typed command or workflow |
| --- | --- |
| Help, project/space/pane/session/failure/status/model queries | BridgeCommand through SwarmCommandGateway |
| New Primary task/session, reset, attach, rename, reattach, replace, resume, awake, skip, stop, steer, model, Worker create | BridgeCommand through SwarmCommandGateway after confirmation |
| Project/Worker directory and Worker detail | InstanceCommand through InstanceInteractionWorkflow |
| Send Worker task, steer Worker, stop Worker | InstanceCommand through InstanceInteractionWorkflow after confirmation |
| Close pane | pane_close_request after confirmation, then existing close-code flow |
| Create/delete project or workspace, approve TraeX, arbitrary terminal input | Unsupported |

For a bound topic, pronouns such as current, this task, or this Primary resolve
only to that binding. For an unbound Group root, global queries and creation of a
Primary task may use the configured default project; session-scoped operations
must name a target or receive clarification. Worker names must resolve uniquely
inside the frozen project. The Controller never uses global name similarity to
guess among multiple targets.

## Durable confirmation

A dedicated SQLite `natural_language_command_confirmations` record is used
because root-level commands may have no binding and the existing
`card_interactions` table is binding-specific. The record contains:

- a generated ID and unique source-message idempotency key;
- actor, chat, source message, topic, and root message identity;
- command family and versioned validated command JSON;
- expected binding ID/generation when applicable;
- resolved target instance ID/generation when applicable;
- state (`pending`, `consumed`, `expired`, or `cancelled`), expiry, timestamps,
  and result detail.

Creating the record and enqueueing its confirmation card occur in one SQLite
transactional transition. Re-delivery of the same inbound message reuses the
same record and outbox identity. A confirmation click atomically consumes one
pending record only when all of these remain true:

- the click comes from the original actor in the configured chat;
- the record has not expired or already been consumed;
- the stored typed payload still passes the current schema;
- the binding and instance generation fences still match;
- the current command policy still authorizes the actor and scope.

After consumption, the command goes through the existing gateway. Its own
durable `CommandIntent`, lane, external-effect fencing, and recovery behavior
remain unchanged. The confirmation action derives a stable message identity
from the confirmation ID so repeated CardKit callbacks cannot create multiple
command intents. A crash before consumption leaves the confirmation pending; a
crash after consumption cannot automatically replay the click.

Cancellation marks a pending record cancelled. Expired or stale confirmations
return a warning and require a fresh request. No in-memory state is required for
correctness.

The Controller interpretation job and mutation confirmation are separate facts.
The first records what the Agent proposed; the second records what the human
agreed to execute. A successful task classification records its final routing
decision before the existing prompt acceptance transaction. A successful query
records its interpretation result before invoking the existing query handler.

## Cards and user feedback

The confirmation card displays:

- the canonical action in user-facing language;
- project, Primary/Worker, pane, model, or text argument as applicable;
- a warning that only the shown allowlisted action will execute;
- `确认执行` and `取消` buttons;
- an expiry timestamp.

Clarification cards show at most three typed candidates or a concrete missing
field, with examples of accepted wording. Unsupported project creation says
that projects are statically configured and offers “查看项目” plus an example
for creating a new Primary task/session. It must never claim that a pane is a
new project.

Help and `docs/feishu-group-usage.md` use “项目配置” for `projects.json` entries
and “Primary 任务/会话” for `/swarm new`. They include a concise natural-language
example matrix and retain slash commands as the exact fallback.

## Failure handling and observability

Structured logs record interpretation outcome, command family/kind, confidence
source (`deterministic` initially), confirmation ID, and final disposition. They
must not log full steer/task text, model credentials, or raw card payloads. Audit
rows record requested, confirmed, cancelled, expired, stale, unauthorized, and
executed outcomes.

Parser failure is user feedback, not an exception. SQLite or outbox failure is
retryable inbound failure. Controller startup and availability are surfaced in
health/status diagnostics. A schema-invalid Controller proposal is rejected and
audited rather than executed. Controller prompt delivery uncertainty is retained
and observed without replay. Gateway failures retain the current command-intent
uncertain-state semantics; they are never repaired by interpreting card state.

## Testing

Tests cover:

- table-driven Chinese/English grammar for every common command and its missing,
  ambiguous, unsupported, and ordinary-task neighbors;
- Controller lifecycle, single-job FIFO, capability/request fencing, structured
  proposal validation, timeouts, and restart recovery without prompt replay;
- proof that the Controller cannot invoke the effectful Primary MCP tools or a
  generic Herdr mutation surface;
- the `create new project` regression in root and bound contexts;
- explicit mention gating and preservation of slash-command behavior;
- direct query routing versus mutation confirmation;
- confirmation idempotency, actor/chat checks, expiry, cancellation, schema
  validation, binding/instance generation fences, and repeated callbacks;
- restart recovery with pending and consumed confirmations;
- pane close retaining the existing close-code stage;
- no prompt enqueue or Herdr call for ambiguous/unsupported commands;
- CardKit rendering, public audit, typecheck, build, architecture checks, and the
  full Vitest suite.

## Rollout

The feature is enabled for the configured Feishu group after installation. The
Controller Agent, deterministic fast path, and confirmation workflow ship
together so no natural-language mutation can execute without the safety layer.
Readiness reports Controller availability separately; degraded-mode behavior is
available while the Controller is being repaired.
