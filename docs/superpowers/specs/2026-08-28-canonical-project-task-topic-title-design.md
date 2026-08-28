# Canonical project and task topic titles

## Goal

Make every managed Lark topic immediately identifiable by the project and the
Herdr task that owns it. The canonical title is:

```text
<project-space-name> / <pane-name>
```

For example:

```text
herdr-agent-swarm / task-esk0
```

This title is shared by the durable binding and the Lark Main Card. Herdr
remains authoritative for the live pane identity and pane name.

## Naming rules

- New and reset sessions continue to generate a four-character base36 pane
  name in the existing `task-xxxx` form.
- The project component comes from `projectSpaceName(project)`: configured
  `spaceName`, then the project `cwd` basename, then `displayName`.
- Automatically created titles always use the generated pane name. The user's
  first prompt and an optional title supplied to `/swarm new` remain request
  content; they do not replace the task identity in the topic title.
- Explicit `/swarm rename <name>` remains supported. It renames the Herdr pane
  and changes the canonical title to `<project-space-name> / <name>`.
- Existing whitespace normalization and the 80-character canonical-title limit
  remain in `formatProjectPaneTitle`. The Main Card may retain its narrower
  presentation limit.

## Creation and projection flow

`BindingProvisioningWorkflow` generates the pane name once and uses the same
value for both `HerdrPaneCreationOptions.title` and
`formatProjectPaneTitle(...)`. The resulting canonical title is persisted on
the binding before external provisioning continues. The `BindingCreated` event
copies it into `TopicViewState`, and `renderProjectEntryCard` puts it in the
Main Card header and summary. Lark derives the visible topic name from that
root card.

Discovery uses the observed Herdr pane label rather than generating a new name.
Reset creates a new `task-xxxx` pane and updates the existing topic's canonical
binding title through its normal replacement lifecycle. No topic is recreated
solely to change a title.

## Existing-topic convergence

Startup first performs the existing durable view convergence, then normal Herdr
reconciliation checks each attached binding against a fresh pane snapshot. If
the observed pane has a non-empty label and the canonical title derived from
that label differs from `binding.title`, reconciliation performs a fenced,
durable metadata-and-projection transition:

1. Verify the expected pane ID and binding generation.
2. Persist the corrected binding title and corresponding `TopicViewState`.
3. Reserve the Main Card update in the durable Lark outbox in the same
   transaction.
4. Wake outbound delivery and publish `BindingRenamed` only after the durable
   transition succeeds.

This uses the ordinary Main Card update path, so retries do not repeat a Herdr
operation. A stale or missing pane never overwrites the binding title. A blank
pane label is ignored. Legacy bindings whose project cannot be resolved keep
their current title until they can be mapped safely.

The first successful reconciliation after deployment updates existing managed
topics. Subsequent passes are idempotent because an already matching canonical
title produces no state change or outbox work.

## Boundaries

- Do not call a separate Lark topic-rename API or introduce Lark as a title
  authority.
- Do not recreate topics, change `topicId` or `rootMessageId`, or alter prompt
  history.
- Do not infer a title from prompt text, terminal output, card text, or the
  binding UUID.
- Do not rename a Herdr pane during startup convergence. Startup reads the pane
  label and converges the durable/Lark projection toward it.
- Do not combine this work with the npm `solo:*` to `swarm:*` command migration.

## Failure handling

Failure to observe one pane leaves its current title untouched and is retried by
the next reconciliation pass. Failure to deliver the corrected Main Card stays
in the existing outbox retry/dead-letter lifecycle. The reconciliation path
must not replay prompts or perform an unfenced update against a replacement
pane.

## Verification

- New project selection with natural-language input creates a `task-xxxx` pane
  and a `<project> / task-xxxx` binding/Main Card title while preserving the
  original input as the prompt.
- `/swarm new <optional text>` and reset follow the same generated naming rule.
- Discovery uses `<project> / <observed pane label>`.
- `/swarm rename custom-name` yields `<project> / custom-name` in Herdr, the
  binding, and the Main Card.
- Startup/runtime reconciliation corrects a legacy binding title from the
  matching live pane and reserves exactly one Main Card update.
- Matching titles, blank pane labels, unresolved projects, stale generations,
  and missing panes do not enqueue incorrect title updates.
- Focused provisioning, reconciliation, title, and Main Card tests pass,
  followed by typecheck, build, and the full Vitest suite.
