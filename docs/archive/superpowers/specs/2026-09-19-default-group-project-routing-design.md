# Default Group Project Routing Design

## Problem

The configured Lark group already accepts a user-authored root message that
mentions the bot, but an unbound message opens the project selector before a
Primary session can be provisioned. For the normal single-group deployment,
the group should act as the entry point to the configured default project: one
root task creates one durable Lark thread, one binding, and one Primary pane in
that project's Herdr workspace.

The relationship must remain explicit about authority. Lark supplies the group
and thread identifiers, SQLite owns workflow intent and the durable binding,
and Herdr owns live pane identity and state. A display Space name must not be
used as a substitute for the configured Herdr workspace ID.

## Scope and Configuration

This milestone keeps the existing single-group deployment model:

```text
LARK_CHAT_ID
  -> projects.json.defaultProjectId
  -> ProjectConfig { spaceName, workspaceId, cwd }
  -> durable binding
  -> Herdr Primary pane and Lark thread
```

No group-routing table or remotely mutable group setting is introduced.
`LARK_CHAT_ID` remains the inbound and outbound group allowlist, and
`defaultProjectId` remains a validated reference to one configured project.
When a project omits `spaceName`, its resolved display and explicit-attach name
is `herdr`. `workspaceId` remains mandatory, explicit, and authoritative for
Herdr operations. An explicit non-empty `spaceName` remains unchanged.

The default project can be changed only through the private project registry
and the supported install/restart lifecycle. Existing bindings retain their
persisted `projectId` and `workspaceId`; a configuration change affects only
new root-message provisioning.

## Inbound Routing

The existing route precedence is preserved:

1. Persist and normalize an allowed Lark event.
2. Route a persisted Worker session thread when one matches.
3. Parse and execute instance or `/swarm` commands.
4. Route messages in an active binding or alias to that frozen binding.
5. Route an explicitly selected Worker target when applicable.
6. For an otherwise unbound, user-authored root text message that explicitly
   mentions the bot, provision the configured default project directly.
7. Preserve existing disconnected or unbound feedback for all other messages.

The Lark adapter continues rejecting messages outside `LARK_CHAT_ID` and
non-user or unsupported inbound content at its boundary. An unmentioned group
message has no provisioning side effect. A thread reply cannot create a new
binding. Commands never fall through into automatic provisioning.

The normalized message text, after existing mention normalization, becomes the
initial Prompt text. Its derived title continues to use the existing title
logic.

## Durable Provisioning

`BindingProvisioningWorkflow` gains a default-project entry point. It resolves
`config.defaultProjectId` through `ProjectCatalog`, then reuses the existing
project-selection and selected-project lifecycle rather than creating a second
pane or thread implementation. The durable selection freezes the selected
project ID before any external side effect. It is keyed by the inbound Lark
message identity so duplicate deliveries converge on the same selection and
binding.

The direct path omits the interactive selector card but otherwise uses the same
checkpoints:

1. Accept or recover the durable project selection.
2. Create and link the pending binding.
3. Create and identity-fence the pane in the selected project's `workspaceId`
   and `cwd`.
4. Start and observe the configured Primary agent.
5. Persist the Lark conversation creation intent and publish the Primary Main
   Card through the durable outbox/gateway effect path.
6. Activate the binding only after the thread identity is persisted.
7. Enqueue the initial Prompt through the normal prompt-acceptance transaction.

The resulting binding persists `chatId`, `topicId`, `rootMessageId`,
`projectId`, `workspaceId`, and `paneId`. All later thread messages resolve the
binding first and never consult the current default project. Worker instances
and Worker session threads continue to inherit and fence against their parent
binding and session generation.

The existing interactive project selector remains available for explicit
project choice through `/swarm new` and its card action. Explicit selection and
automatic default selection share the same idempotency namespace and cannot
both provision the same source message.

## Recovery and Failure Semantics

- A failure before pane creation can retry from the persisted selection.
- Once pane creation may have occurred, recovery observes the recorded pane and
  checkpoint. It does not blindly create another pane.
- Once a Prompt may have reached TraeX, recovery never submits it again. An
  uncertain observer becomes detached and is observed through existing
  reconciliation.
- A missing default project, invalid workspace route, inaccessible `cwd`, or
  missing project configuration rejects provisioning with durable user
  feedback and a structured diagnostic.
- A Lark thread publication failure remains durable outbox/gateway work. It
  cannot repeat pane creation or Prompt submission.
- Service restart resumes existing provisioning checkpoints from SQLite and
  reconciles live state from Herdr. It never treats card text as workflow state.

The implementation must reuse the existing `project_selections` and
`bindings` schema. A migration is not expected; a schema change is allowed only
if implementation proves that the existing selection identity cannot safely
express direct selection and restart recovery.

## Presentation and Operations

Primary Main Cards, run cards, project/space directories, and attach results
show the resolved `spaceName`; the default is therefore `herdr`. Cards continue
to show or retain pane identity from the binding. The implementation adds no
parallel notification channel and no card-derived state.

Operator documentation explains that:

- `@bot <task>` as a group root message starts the task in the default project;
- an unmentioned group message is ignored;
- `/swarm new` remains the explicit project-choice path;
- `herdr` is the default Space name, while `workspaceId` selects the real Herdr
  workspace; and
- changing the configured default project does not move existing threads.

Deployment continues through the supported build, install, safety gate, and
restart workflow. No forced restart is implied by this design.

## Security Boundaries

- The configured chat allowlist and administrator checks remain unchanged.
- Group messages cannot mutate the default project mapping.
- Project registry validation remains the boundary for project IDs, absolute
  directories, and unique workspace/directory routes.
- High-risk TraeX approval remains local to Herdr.
- No arbitrary terminal input, process kill, pane kill, or remote approval path
  is added.
- SQLite remains the only durable workflow queue; no payload-bearing in-memory
  queue is added.

## Tests and Acceptance

Focused tests cover:

- omitted `spaceName` resolves to `herdr`, while an explicit value is preserved;
- only an allowed, user-authored, supported root text message with an explicit
  bot mention takes the automatic default-project route;
- commands, Worker threads, active binding threads, aliases, thread replies,
  unmentioned messages, other chats, and unsupported content do not fall
  through to automatic provisioning;
- one source `messageId` replay produces one selection, binding, pane, Lark
  thread, and initial Prompt;
- direct selection freezes `defaultProjectId` before external effects and uses
  its configured `workspaceId` and `cwd`;
- changing `defaultProjectId` affects new root messages but not existing
  bindings;
- interrupted provisioning follows existing safe checkpoint recovery, including
  no automatic replay after pane or Prompt uncertainty; and
- Worker pane and Worker thread routing remain scoped to the parent binding and
  session generation.

Acceptance requires the affected Vitest suites plus `npm run typecheck`,
`npm run build`, `npm run architecture:check`, and `npm run docs:audit`. Full
`npm test` is required because the change spans inbound routing, provisioning,
persistence, and shared recovery behavior.

## Non-goals

- Multi-group routing within one service instance.
- A SQLite-backed or Lark-managed mutable group-to-project map.
- Migrating or rebinding existing threads when configuration changes.
- Treating `spaceName` as a Herdr workspace identifier.
- Replacing explicit project selection, pane attachment, or existing Worker
  thread behavior.
- Adding an in-memory delivery queue or weakening delivery and Prompt replay
  safeguards.
