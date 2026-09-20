# Group Active-Pane Card Directory Design

## Goal

Allow a user to run `/swarm panes` from a bound Lark thread, inspect the active
Primary panes in that thread's Space, and publish any selected pane's latest
Main Card as a new group root message. Replies in the new thread must route to
the selected pane's existing Primary Agent.

This specification is for maintainers extending the Lark ingress, durable
outbox, and binding-routing seams. After reading it, they should be able to
implement the feature without creating a second Binding, moving the original
topic, or making an in-memory callback the routing authority.

## User experience

`/swarm panes` remains available from any topic in the configured group. In a
bound topic it lists only active, attached Primary panes in the current Space.
An unbound group entry may list all eligible panes in that group. Each row shows
the task title, Space, pane ID, observed Agent state, and a `发送卡片到群` button.

Clicking the button creates a new Main Card root message in the group. Lark
treats replies beneath that root as a new thread. A normal user reply in that
thread enters the selected Binding's existing FIFO and therefore reaches the
same pane and Agent. Answer Cards for those prompts are created beneath the new
root. The original Binding topic remains valid and unchanged.

The new Main Card is a snapshot taken when the action is accepted. It is an
entry-card rendering of the Main Card's identity and status, not another
continuously updated Main Card projection. It omits controls that mutate or
navigate the canonical topic; users interact with the selected Agent by replying
in the new thread. This avoids multiple physical cards competing for one
`TopicViewState.deliveredVersion` or CardKit sequence. A user may run
`/swarm panes` again to publish a fresh entry.

## Authority and data model

SQLite remains authoritative for both delivery intent and reply routing. Add a
durable `binding_thread_aliases` table with:

- alias thread ID and root message ID, each unique;
- owning Binding ID and captured Binding generation;
- chat ID and selected pane ID;
- source Main Card message ID used by the button fence;
- originating action message ID and stable publication key;
- lifecycle state `reserving`, `active`, or `stale`;
- creation and update timestamps.

The alias does not own a pane, Prompt queue, TopicView, Main Card checkpoint, or
Agent session. It only maps an additional Lark conversation root to one exact
Binding generation. The Binding remains the sole workflow owner. Alias rows are
lease-fenced and included in integrity checks and retention policy.

`findBindingByLarkScope` first resolves the Binding's canonical topic/root, then
an active alias by exact topic/root. Alias resolution succeeds only when the
current Binding still matches the stored chat, generation, pane, active state,
active lifecycle, and attached state. A stale alias returns no Binding; it is
never silently rebound to a replacement pane or generation.

## Durable publication protocol

The current outbox `card_reply` effect cannot create a group root message, so
extend the delivery contract with an explicit `group_card_create` kind. The
schema adds a kind-discriminated `target_chat_id`; this field is required only
for group creation, while `root_message_id` remains the reply target for all
existing kinds and is null for group creation. The migration rebuilds the table
constraint explicitly and preserves every existing row, delivery order, claim,
lane, quarantine, and recovery reference. It does not overload a message-root
column with a chat ID.

The Lark adapter executes `group_card_create` through the existing group-message
create API and returns both the new root message ID and thread ID. The outbound
claim, frozen payload, retry, dead-letter, and uncertain-checkpoint rules remain
unchanged. Target chat, delivery kind, alias ID, and card payload are all frozen
after claim. Group publication has its own immutable lane because it creates one
independent Lark root.

Button acceptance is one SQLite transaction:

1. Reload and fence the selected Binding by chat, generation, pane,
   active/attached lifecycle, and source Main Card message ID.
2. Load the latest `TopicViewState` and render the entry Main Card snapshot.
3. Insert or reuse one `reserving` alias identified by a stable publication key
   derived from action message, Binding generation, pane, and source card.
4. Insert the matching `group_card_create` outbox row.

No Lark call occurs in the callback workflow. After Lark accepts the root card,
the delivery ACK transaction records its message/thread identity, activates the
alias, records the bridge message, and marks the outbox row delivered. A retry
uses the same Lark UUID and publication key. If the external create may have
succeeded but SQLite cannot checkpoint it, the claim remains uncertain and no
second root message is created automatically.

The directory card itself may remain in the invoking thread. Only the selected
pane Main Card is sent to the group root. This distinction is explicit in card
copy and tests.

## Reply routing

When Lark delivers a message from an alias thread, ingress persists the message
normally. Routing resolves the alias to its current Binding before command or
ordinary-message handling. Ordinary text is accepted through the existing
Prompt transaction and FIFO, using the alias root as the Answer Card target for
that Prompt. The Prompt still carries the canonical Binding ID and generation;
there is no second queue.

Ordinary text and non-topology Agent controls such as status, model inspection,
stop, and safe steering use the same generation and authorization checks as the
canonical topic. Commands that create, attach, reset, resume, archive, rename,
reattach, or close a pane/session are rejected from an alias with guidance to
use the canonical topic. An alias never becomes ownership evidence for a
destructive or topology-changing operation. High-risk approval remains local to
Herdr.

To preserve per-request reply location, Prompt acceptance receives the inbound
root message ID as the Answer Card root. Later Run Card and Answer page
projections already follow the Prompt's delivered Answer identity, so they stay
inside the alias thread. Main Card lifecycle projection continues to update only
the Binding's canonical Main Card.

## Failure and lifecycle behavior

- Stale button identity returns a refresh notice and creates neither alias nor
  outbox work.
- A permanent group-card rejection keeps the alias non-active and exposes the
  normal dead-letter recovery path. It never sends a TraeX Prompt.
- Binding generation change, pane replacement, archive, orphaning, or detach
  makes prior aliases stale. Reconciliation may mark them stale eagerly; lookup
  also fails closed if that cleanup has not yet run.
- Restart resumes `reserving` publication only through the durable outbox. An
  alias without a confirmed root is not routable.
- Repeated delivery callbacks and repeated button actions cannot create another
  alias or Prompt.
- Alias history must not delete the canonical Binding, topic, cards, or Prompt
  history. Retention may remove stale aliases only after no pending outbox or
  inbound record references their roots.

## Security

The existing configured-chat and allowed-user checks apply before callback or
message routing. The callback carries only server-verifiable identity fields; it
cannot select another chat, arbitrary root message, Agent, or terminal input.
The group target always comes from validated service configuration and the
Binding's chat. Logs and audit records include alias/publication IDs and bounded
outcomes, never card payloads or Prompt text.

## Verification

Tests use fake Lark and temporary SQLite only. They must prove:

- a bound `/swarm panes` directory stays Space-scoped, including when invoked
  inside a thread;
- the button reserves a `group_card_create`, never a reply to the directory
  card;
- accepted group creation atomically activates one alias with the returned
  root/thread identity;
- duplicate action and retry are idempotent, and uncertain checkpoint does not
  create another root automatically;
- a reply in the alias thread resolves the existing Binding and creates its
  Prompt/Answer Card under the alias root;
- the canonical Main Card remains the only continuously updated Main Card;
- the entry-card renderer contains identity/status but no canonical-topic
  mutation or navigation actions;
- topology-changing commands from an alias are rejected, while ordinary text
  enters the existing Binding FIFO;
- stale chat, generation, pane, source card, lifecycle, attachment, or alias
  state fails closed;
- restart preserves active aliases, while archive/reset/pane replacement makes
  them unroutable without replaying a Prompt;
- outbox ordering, claim immutability, delivery recovery, authorization, and
  full regression tests remain green.

## Non-goals

- Moving or forwarding the original topic.
- Creating a second Binding, pane, Agent session, or Prompt queue.
- Keeping every published entry card continuously synchronized.
- Letting an alias bypass canonical lifecycle, generation, or creator/admin
  policy.
- Sending prompts or terminal input as part of card publication.
