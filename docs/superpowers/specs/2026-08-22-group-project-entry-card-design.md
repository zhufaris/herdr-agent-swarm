# Group Project Entry Card Design

## Goal

Every project created through `/herdr new` has a visible, lightweight entry
card in the configured Lark group's main conversation. The card is the root
message of the project's topic. Users enter that topic to send prompts and see
detailed TraeX progress and answers.

The behavior is the same whether `/herdr new` is sent in the group main
conversation or inside an existing topic: the new project always receives an
independent group-level entry card and topic.

## User flow

1. The user sends `/herdr new [title]`.
2. The bridge replies to that command with the existing project selector card.
3. The initiating user selects a project.
4. The bridge creates and starts the Herdr pane.
5. The bridge posts a new project entry card directly to the configured group.
   The returned message ID is both the binding's `topicId` and `rootMessageId`.
6. The selector card becomes a compact success receipt that tells the user to
   open the new project card. It is not reused as the project's status card.
7. Messages sent as replies in the project card's topic become TraeX prompts.

## Entry-card content and updates

The project entry card uses the existing topic-view state and displays only:

- project/space name;
- Herdr pane ID;
- lifecycle state; and
- current queue depth.

It deliberately omits request text, live terminal output, and final answers.
Those remain in request cards inside the topic. This keeps the group timeline
compact while preserving a stable project entry point.

The entry card updates only on meaningful lifecycle changes: provisioning,
idle/ready, running, blocked, error, archived, orphaned, and queue-depth
changes. Existing outbox idempotency and update coalescing continue to protect
against duplicate or excessive card writes.

## Architecture and data flow

The Lark port gains an explicit operation for posting a group-level interactive
card. It returns the created message ID. Topic creation for `/herdr new` uses
this operation after the pane starts successfully. The binding is initially
persisted without a Lark topic, then atomically updated with the returned
message ID as `topicId`, `rootMessageId`, and `statusMessageId`.

Herdr-discovered panes already create a group-level root card and keep their
existing behavior. Only the Lark project-selection path changes.

The selector command's original topic identifiers remain selection metadata
for callback authorization and receipt delivery; they are never copied into
the new project binding. This prevents `/herdr new` issued inside an existing
topic from hijacking that topic's binding or violating the unique topic
constraint.

## Failure handling

- Pane creation or TraeX startup failure leaves the binding failed and updates
  the selector card with the failure. No group entry card is posted.
- Group card creation failure leaves the successfully started pane represented
  by a failed binding with no topic. Reconciliation may later discover the pane
  and create its entry card; the selector receipt reports the immediate error.
- Duplicate selector callbacks reuse the completed selection and binding. They
  update the selector receipt but never create another pane or group card.
- A user message in the old selector thread does not route to the new project.
  Only replies under the new group entry card do.

## Verification

Tests cover:

1. `/herdr new` from the group and from an existing topic both create a new
   group root card after project selection.
2. The returned group message ID becomes all three binding message IDs.
3. The entry card contains project, pane, status, and queue but no detailed
   answer or prompt text.
4. Duplicate callbacks do not create duplicate panes or entry cards.
5. Group-card creation failure is visible and leaves no routable partial topic.
6. Existing Herdr discovery, prompt routing, card projection, and authorization
   tests continue to pass.
