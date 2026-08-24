# Space and pane directory command

## Goal

Add a read-only group command, `/herdr spaces`, that shows every configured
Herdr space and every pane currently present in those spaces. The directory is
an operational overview; it does not create bindings, mutate panes, or start
TraeX.

## Command behavior

`/herdr spaces` is accepted in the group root or in any topic. The bridge
replies to the command message's current root scope. It does not require an
active binding and never creates one. Unknown arguments fall back to the normal
help response. The help card lists the new command.

The command queries every distinct configured workspace through
`HerdrPort.listPanes`. All panes are included, whether or not TraeX is the
foreground process and whether or not the pane has a bridge binding.

## Grouping and ordering

The top-level groups follow `config/projects.json` order. Projects that resolve
to the same `spaceName` and workspace ID are merged into one group. A group
contains:

- the resolved `spaceName`;
- the Herdr workspace ID;
- the configured project directory or directories; and
- every live pane in that workspace whose `cwd` matches one of those configured
  directories.

Within a group, panes sort by normalized pane name and then pane ID. The pane
name uses its label, falling back to the pane ID. Each row also shows pane ID,
agent state, and foreground executable names. Missing foreground executables
are shown as `-`. Empty groups remain visible with `暂无 Pane`.

Panes in a configured workspace whose `cwd` does not match any configured
project directory are included in a final `未注册` group for that workspace.
This makes the directory complete without pretending those panes belong to a
configured space.

## Card layout and size

The response uses CardKit 2.0 with a neutral blue header titled `Herdr Spaces`.
Each space is a separate markdown section. Pane fields are escaped and bounded
before rendering so terminal labels or executable names cannot inject card
markup or create an unbounded payload.

The renderer accepts already-collected groups and returns one or more cards. It
keeps a space together when it fits. If one space alone exceeds the card budget,
it splits that space across cards at pane-row boundaries and repeats the space
heading. No pane is silently omitted. Every card summary states that it is a
Herdr space directory.

## Partial failure behavior

Workspace discovery is independent. If one `listPanes` call fails, the bridge
still renders all other groups and places an orange warning under each affected
space with a bounded safe error message. The failure is also logged as a
dedicated `space-directory-workspace-failed` event with workspace ID and safe
error so an operator can distinguish a user-triggered directory lookup from
background reconciliation.

If all workspaces fail, the command still replies with a warning card rather
than throwing into normal message handling. If no projects are configured, the
existing configuration validation remains authoritative and startup fails
before the command can run.

## Component boundaries

- The command parser recognizes `spaces` as a new command kind.
- The coordinator collects unique workspaces, maps panes to configured spaces,
  records partial failures, and sends the rendered cards through the durable
  Lark outbox.
- A pure card renderer owns grouping presentation, escaping, ordering within a
  group, and card splitting. It receives no Herdr or store dependency.
- Existing `HerdrPort.listPanes` and `LarkChannelPublisher.enqueueCard` APIs are
  sufficient; no database schema or external API change is required.

## Verification

Automated tests cover:

1. parsing `/herdr spaces` and rejecting trailing arguments;
2. invocation from an unbound group message without creating a binding;
3. configured space order and pane-name ordering;
4. inclusion of non-TraeX and unregistered panes;
5. empty spaces;
6. merging duplicate project entries for the same space and workspace;
7. partial workspace failure with safe, bounded errors;
8. card splitting without dropping pane IDs; and
9. help-card discovery of the new command.

## Non-goals

- Buttons for focusing, opening, closing, or renaming panes.
- Persisting directory snapshots in SQLite.
- Filtering to active bridge bindings or TraeX-only panes.
- Periodic publication or automatic card refresh.
- Cross-group access control beyond the bridge's existing configured Lark chat.
