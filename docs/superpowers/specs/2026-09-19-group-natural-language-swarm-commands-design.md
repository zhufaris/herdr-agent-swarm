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

## Parsing architecture

### Typed interpreter port

`NaturalLanguageCommandInterpreter` accepts normalized text plus only the
minimum catalog needed for extraction (configured project IDs/display names and
known command vocabulary). It returns a discriminated result and never performs
I/O or effects. A successful command result contains an existing
`BridgeCommand` or `InstanceCommand`; downstream workflows never consume free
form model output.

### Phase-one deterministic interpreter

The initial implementation uses bounded local grammar and aliases for Chinese
and English. It recognizes complete command-shaped sentences, quoted arguments,
configured project aliases, known agent kinds, and explicit Worker names. Rules
are ordered from specific to general and tested as a table. A match must consume
the whole normalized utterance; partial matches are clarification or task
classification, not silent argument truncation.

This implementation requires no new network dependency, credential, model, or
runtime availability.

### Future structured classifier

The port permits a later classifier for paraphrases the grammar cannot cover. A
classifier adapter may return only a versioned Zod-validated allowlist schema.
Unknown command kinds, additional keys, invalid arguments, low confidence, or
multiple candidates become clarification. The adapter cannot call workflows,
construct shell input, or bypass policy. Deterministic matches always win.

## Routing and safety policy

Ingress order becomes:

1. route Worker-session thread messages through their existing exact route;
2. parse explicit slash commands;
3. locate the binding and alias context;
4. for an explicit bot mention, run the natural-language interpreter;
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
retryable inbound failure. Schema-invalid persisted payloads are rejected and
audited rather than executed. Gateway failures retain the current command-intent
uncertain-state semantics; they are never repaired by interpreting card state.

## Testing

Tests cover:

- table-driven Chinese/English grammar for every common command and its missing,
  ambiguous, unsupported, and ordinary-task neighbors;
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
deterministic interpreter and confirmation workflow ship together so no
natural-language mutation can execute without the safety layer. A future
structured classifier is a separate, explicitly configured change and is not
required for this release.
