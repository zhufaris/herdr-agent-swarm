# Topic-Scoped Instance Routing Design

## Problem

An active Lark topic already has a durable binding whose `projectId` identifies
the project selected when the topic was created or attached. The new instance
command workflow ignores that binding and looks up `conversation_targets` by
group `chatId`. As a result, `/instances` inside a bound topic can incorrectly
reply with `请先使用 /project <id> 选择项目。`; selections made in one topic can
also affect another topic in the same group.

## Invariants

- An active topic binding fixes the topic's project.
- Commands in a bound topic derive their project from `binding.projectId`.
- A selected instance is topic-scoped and cannot change the binding's project.
- `/project <id>` may initialize an unbound conversation, but it cannot move an
  existing bound topic to another project.
- Missing, retired, or project-less bindings do not silently acquire a project.

## Design

Add a small routing-context resolver used by `InstanceInteractionWorkflow`. For
each incoming message it first looks up the active binding by the normalized
Lark scope (`topicId`, `rootMessageId`). If that binding has a configured
`projectId`, it is authoritative. Only when no bound-topic project exists may
the workflow fall back to an explicitly selected conversation project.

Conversation target persistence uses a topic-specific key derived from the
normalized message scope, rather than bare `chatId`. Card callbacks must carry
or recover the same topic key before changing the selected instance. This state
selects a target within the authoritative project; it never selects the project
for an already-bound topic.

For `/project <id>` in an active bound topic, the workflow accepts the command
only when the requested ID matches the binding project. A different ID returns
a clear rejection explaining that the topic is fixed to its current project.

## Error Handling

- Bound topic with valid project: `/instances` opens that project's directory.
- Bound topic with removed or missing project: reject as invalid binding state;
  do not suggest changing the topic to another project.
- Unbound conversation without a selection: retain the current `/project <id>`
  guidance.
- Stale selected instance generation: retain the current refresh rejection.

## Verification

Integration tests will cover: `/instances` in a bound topic without a separate
conversation target; isolation between two topics in one chat; rejection of a
cross-project `/project`; and preservation of unbound `/project` behavior. Run
the focused instance-routing test, TypeScript typecheck, and production build.
