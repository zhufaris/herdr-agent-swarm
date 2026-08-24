# Project Selection Card Design

## Goal

Allow a user in the configured Lark group to create a Herdr/TraeX topic in an
approved project instead of always using the bridge's single configured
workspace and working directory. `/herdr new` opens an interactive project
selection card. The selected project becomes immutable for the resulting topic
binding.

The feature must not expose arbitrary host paths, permit another group member to
hijack a pending selection, or create duplicate panes when Lark retries a card
callback.

## User interaction

The supported commands are:

```text
/herdr new <title>
/herdr new
/herdr projects
```

Both `new` forms reply with the same project-selection card. Each configured
project is represented by one button showing its display name and a short,
non-sensitive description.

- `/herdr new Fix login` preserves `Fix login` as the new topic title.
- Bare `/herdr new` uses the selected project's display name as the topic title.
- After creation, the first ordinary message in the new topic is the first task.
  It does not rename the topic or open another title form.
- `/herdr projects` displays the selector without requiring a title and otherwise
  follows the bare `new` behavior.

After a successful selection, the original selector card is replaced with a
completion card containing the project display name, workspace ID, pane ID, and
an instruction to continue inside the created topic. Expired, unauthorized,
invalid, failed, and already-consumed selections receive explicit status cards.

## Project registry

The repository-owned `config/projects.json` is the only project allowlist. Its
shape is:

```json
{
  "defaultProjectId": "bridge",
  "projects": [
    {
      "id": "bridge",
      "displayName": "Herdr Lark Bridge",
      "description": "Bridge service and Lark integration",
      "workspaceId": "wH",
      "cwd": "/data00/home/feiyu.zhu/work/herdr-lark-bridge"
    }
  ]
}
```

Project IDs are stable machine identifiers and use lowercase letters, digits,
dashes, and underscores. Display names and descriptions are presentation only.
Working directories must be absolute paths. Project IDs must be unique. A
workspace may host more than one configured project only when their working
directories are distinct.

`PROJECTS_CONFIG_PATH` optionally selects the registry file and defaults to
`./config/projects.json`. The legacy `HERDR_WORKSPACE_ID` and
`HERDR_WORKSPACE_CWD` settings remain temporarily accepted as a synthesized
single default project when the registry file is absent. Once a registry file is
present, it is authoritative and there is no fallback for malformed or invalid
entries.

At startup and readiness checks, the bridge validates the schema, confirms the
default project exists, calls `herdr workspace get` for every unique workspace,
and verifies each project directory exists and is a directory. It does not
require an existing pane in that directory because a valid project may not have
one yet. A failed registry or workspace validation makes readiness fail and
prevents message consumption.

## Lark card callback

The existing WebSocket `EventDispatcher` subscribes to both
`im.message.receive_v1` and `card.action.trigger`. No public HTTP callback
endpoint is introduced. The Lark application must enable the card action
callback in its developer-console long-connection configuration.

The domain-level callback contains only normalized fields:

```text
messageId
chatId
operatorOpenId
action.value
```

The project button value contains only:

```json
{
  "action": "select_project",
  "selectionId": "opaque UUID",
  "projectId": "datasage"
}
```

It never contains `cwd`, workspace IDs, credentials, command text, or other host
details. The callback handler resolves all authoritative values from SQLite and
the current server-side project registry. Unknown actions are ignored.

## Durable selection state

SQLite stores each selector before its card is sent:

```text
project_selections
  id                    primary key
  command_message_id    unique
  selector_message_id   nullable until card delivery
  chat_id
  topic_id
  root_message_id
  actor_open_id
  requested_title       nullable
  selected_project_id   nullable
  binding_id            nullable
  state                 pending | processing | completed | failed | expired
  error                 nullable
  expires_at
  created_at
  updated_at
```

The selector is valid for ten minutes. Selection-card creation uses the durable
outbox. The returned Lark message ID is attached to the selection so callback
validation can require an exact card match. Duplicate command delivery returns
the existing selector rather than posting a second card.

Callback claiming is a SQLite transaction. It changes `pending` to `processing`
only when all of these are true:

- callback chat ID equals the configured group;
- callback message ID equals the stored selector message ID;
- operator open ID equals the command initiator;
- selection has not expired;
- project ID exists in the current allowlist; and
- no binding has already been created for the selection.

Only the claimant creates the pane and binding. A retry while `processing` gets
an in-progress result. A callback after `completed` returns the existing binding
and refreshes the success card without creating anything. Invalid or
unauthorized callbacks are audited and do not mutate the selection.

If pane or TraeX startup fails, the selection becomes `failed`, any pending
binding becomes `failed`, and the selector card displays the error. The user
starts a fresh selection with another `/herdr new`; the same failed callback is
not retried automatically. On process restart, interrupted `processing`
selections become `failed` because pane creation may already have caused an
external side effect.

## Binding and creation flow

Bindings add a stable nullable `project_id`. New selector-created bindings
always store it. The existing workspace ID remains on the binding as the
concrete Herdr routing target. The selected project supplies both values used by
pane creation:

```text
herdr.createPane(project.workspaceId, project.cwd)
```

The creation sequence is:

1. atomically claim the selection;
2. create a pending binding using the selected project and requested title;
3. create the Herdr pane in that project's workspace and directory;
4. start TraeX in the pane;
5. activate the binding and publish its lifecycle events;
6. store the binding ID on the selection and mark it completed; and
7. replace the selector card with the completion card.

The Lark command message remains the root of the resulting topic binding. The
selector reply is a bridge-authored child message and is recorded so it can
never become a prompt. Ordinary messages in the topic route through the binding
exactly as before. There is no command for changing a binding's project after
creation.

## Multi-workspace reconciliation

Startup validates and lists every unique configured workspace. Reconciliation
groups active bindings by `workspace_id` and compares each group only with panes
from that workspace. A failure to query one workspace marks only that workspace
unhealthy for the reconciliation pass; it does not orphan bindings from other
workspaces.

Unbound TraeX panes are eligible for Herdr-to-Lark discovery only when their
workspace and effective cwd match exactly one configured project. Ambiguous or
unregistered panes are logged and skipped. Discovered bindings record the
matched project ID.

Existing bindings with a null `project_id` are backfilled only when their stored
workspace ID and current pane cwd identify exactly one project. If no unique
match exists, they remain operational as legacy bindings and `/herdr status`
shows `legacy/unresolved`; the bridge never silently moves or rewrites them.

## Security and audit

Project selection does not expand the existing group allowlist. Every accepted
or rejected callback records actor, selection, project, and outcome without
logging prompts, secrets, or full card payloads. Configuration values are never
trusted from the client callback. Paths are not rendered in Lark cards.

Only the user who issued the command may use its selector. This is an
authorization rule, not merely a UI hint.

## Verification

Automated tests cover:

1. valid and invalid project registry files, default-project resolution, and
   legacy single-project fallback;
2. `/herdr new <title>`, bare `/herdr new`, and `/herdr projects` command
   parsing;
3. selector card button payloads containing IDs but no host paths;
4. normalization of `card.action.trigger` from the SDK's current nested context
   shape and accepted fallback shape;
5. wrong chat, wrong actor, wrong card, unknown project, expired selection,
   duplicate delivery, and restart recovery;
6. one successful callback creating exactly one pane, one binding, and no
   initial prompt;
7. titled and bare-title behavior;
8. two projects using different workspaces and directories;
9. workspace-local reconciliation and safe legacy backfill; and
10. full tests, typecheck, build, PM2 restart, readiness, and a real selector
    click in the configured Lark group.

## Non-goals

- Arbitrary paths or workspace IDs supplied from Lark.
- Creating or deleting Herdr workspaces from Lark.
- Switching an existing topic binding to another project.
- Managing the project registry from Lark.
- Multi-group routing or per-project authorization policies in this iteration.
