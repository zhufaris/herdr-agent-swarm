# Feishu group shortcut panel

## Goal

Expose a fixed CardKit shortcut panel in the configured Feishu group so people can
reach common Swarm workflows without remembering slash commands. The menu is
an entry surface, not a second workflow engine.

Native Feishu group menus support only `NONE` and `REDIRECT_LINK`; they do not
send a menu-click callback to the bot. They cannot safely dispatch Swarm
commands without an independently deployed HTTPS application, which is outside
this release.

## Menu

The first release has two visual groups.

| Group | Entry | Result |
| --- | --- | --- |
| 会话 | 活跃会话 | Sends the active Primary navigation card. |
| 会话 | 我的 Primary Pane | Shows the caller's accessible Primary session entry. |
| 操作 | 新建 Primary | Opens the existing project/agent selection CardKit flow. |
| 操作 | 队列与状态 | Sends the existing bounded queue and status cards. |
| 操作 | 模型 | Opens the existing model selection CardKit flow. |
| 操作 | 帮助/恢复 | Sends help plus the existing safe recovery entry points. |

## Delivery and safety

The panel is a durable canonical group-root CardKit message. Its buttons use
the existing card-action callback boundary and are allowed only for the
configured group and user-originated actor. Each action uses the same binding
visibility, generation, interaction, and confirmation checks as the
corresponding CardKit or slash-command route.

No menu item directly stops, resets, replaces, archives, clears, or replays
work. Such changes can only be reached through the existing confirmation cards.
The menu never accepts arbitrary terminal input and never bypasses the durable
inbox/outbox pipeline.

## Configuration and updates

At service startup, a small shortcut-panel projection reserves or refreshes one
idempotent group-root CardKit message through the existing durable outbox. It
records only safe aggregate success/failure diagnostics; it does not persist or
log secret-bearing payloads. A panel-projection failure leaves the bridge ready
when normal Lark messaging remains healthy, while surfacing a bounded degraded
diagnostic for operators.

The panel does not depend on tenant-specific native menu permissions. The Help
entry also displays equivalent `/swarm` commands for users who prefer text.

## Tests

Tests cover the static panel shape, configured-group enforcement, typed card
actions, idempotent startup projection, each entry's existing workflow
dispatch, and rejection of direct mutating operations. Adapter tests cover
provider failures without exposing response bodies or credentials.

## Verification

Run focused panel/adapter/command tests, `npm run typecheck`, the full test
suite, and a configured non-mutating bridge observation before installation.
The deployed panel is verified through its durable outbox state and delivery
receipt, not by logging its payload.
