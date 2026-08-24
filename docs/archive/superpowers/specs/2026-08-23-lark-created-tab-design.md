# Lark-created Herdr tabs

## Goal

Make every pane provisioned from the configured Feishu/Lark group visibly
separate from panes created locally in Herdr. A `/herdr new` flow creates a new
Herdr tab instead of splitting an existing tab.

## Behavior

- A Feishu `/herdr new [title]` request still uses the existing project
  selection and durable provisioning flow.
- After project selection, the bridge creates a new tab in the selected Herdr
  workspace. The tab's root pane uses the selected project's working directory
  and receives the existing bridge identity environment variables.
- The tab label is `lark_<title>`, where `title` is the normalized title supplied
  by the Feishu user (or the configured project display name when omitted). The
  root pane keeps that title without the `lark_` marker. The binding and Lark
  cards may continue to show the richer `<space> / <title>` display title.
- The new tab is created without stealing focus from the active local Herdr
  tab.
- Topic-root creation through the Feishu bot follows the same provisioned-tab
  behavior because it is also a Lark-originated binding.
- Replacing a pane for a Lark binding creates another dedicated Lark tab.
- Attaching an existing pane and discovering a locally created TraeX pane do
  not create or rename tabs.

## Interface and adapter changes

`HerdrPort.createPane` accepts the desired pane title and a creation placement.
The Lark provisioning path requests a dedicated tab. The Herdr CLI adapter
creates the tab and then names its root pane:

```text
herdr tab create \
  --workspace <workspace-id> \
  --cwd <project-cwd> \
  --label lark_<title> \
  --env HERDR_BRIDGE_BINDING_ID=<binding-id> \
  --env HERDR_BRIDGE_GENERATION=<generation> \
  --env HERDR_PROJECT_ID=<project-id> \
  --no-focus
herdr pane rename <root-pane-id> <title>
```

The adapter parses `root_pane` from the `tab create` response and returns it as
the provisioned `HerdrPane`. Existing callers that explicitly need an in-tab
split may retain a split placement, but Lark provisioning never relies on the
workspace's current pane layout.

## Rename behavior

`/herdr rename <name>` renames the pane to the normalized `<name>`. The adapter
obtains the pane's `tab_id` and current tab label from Herdr; only a tab whose
label already starts with `lark_` is renamed to `lark_<name>`. A local or
manually attached pane therefore never causes an unrelated tab rename. If pane
rename succeeds but a qualifying tab rename fails, the command reports failure;
the binding remains usable and no pane or tab is deleted.

## Recovery and failure handling

Tab creation remains one external side effect at the existing `selected` to
`pane_created` provisioning checkpoint. The returned root pane ID and terminal
ID are persisted exactly as before. If Herdr returns no `root_pane`, creation is
treated as ambiguous and the existing recovery guidance tells the operator to
inspect and attach the surviving pane rather than creating a duplicate.

No cleanup closes a tab automatically after an ambiguous response, because the
bridge cannot safely prove ownership until the pane identity has been persisted.

## Tests

- Adapter test: dedicated-tab creation sends `tab create`, includes all identity
  environment variables, uses `--no-focus`, labels the tab with `lark_`, and
  parses `root_pane`.
- Coordinator tests: `/herdr new`, project selection, topic-root creation, and
  replacement pass the normalized title and dedicated-tab placement.
- Rename test: a managed Lark pane renames both the pane and containing tab,
  preserving the `lark_` prefix only on the tab.
- Regression tests: attach and Herdr-originated discovery create no new tab.

## Non-goals

- Moving existing bridge panes into dedicated tabs.
- Changing tabs for locally created or manually attached panes.
- Focusing the new tab automatically.
- Encoding Lark chat or user IDs in human-readable tab labels.
