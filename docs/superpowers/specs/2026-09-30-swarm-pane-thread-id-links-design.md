# Swarm Pane Thread-ID Direct Links

## Goal

Make every eligible Primary and Worker row in `/swarm panes` open its current
canonical Feishu Thread directly. The directory must use the durable
generation-fenced `thread_id`; it must not create a copied permalink, forward a
Thread into the group, or mutate workflow state.

## Link contract

An eligible row renders a CardKit `open_url` button whose default, desktop,
iOS, and Android targets all use:

```text
https://applink.feishu.cn/client/thread/open?chatid=<chat_id>&threadid=<thread_id>&thread_position=-1
```

The URL builder accepts only a configured-chat ID beginning with `oc_` and a
canonical Thread ID beginning with `omt_`. It percent-encodes both identifiers
with `URLSearchParams`. A missing or malformed Thread ID never produces a
synthetic URL.

## Projection and ownership

`OperationsQueryWorkflow` remains the only assembler for the directory view.
For each active, attached Primary it copies `binding.topicId` into the
presentation DTO only after the existing chat, generation, Pane, lifecycle,
attachment, and Main-message filters pass.

For each Worker, the operations store resolves the active canonical
`worker_session_threads` row using the complete current identity:

- Worker ID and runtime generation;
- Worker Session generation;
- parent Binding ID and generation;
- parent Pane ID and canonical Primary Main message ID; and
- configured chat ID.

The read returns only the canonical `topic_id`. It does not reserve, publish,
forward, or repair a Thread. Missing or stale identity leaves the row visible
but uses the existing identity-fenced forward callback as a compatibility
fallback.

## Card behavior

Rows with a validated Thread ID render `打开会话` or `打开 Worker Thread` as a
direct `open_url` action. Rows without one retain the existing callback action,
so legacy data remains navigable without inventing a link. Direct-link clicks
do not call the bridge and therefore do not create audit or outbox records.

The old forwarding workflow and callback parser remain supported for legacy
cards already delivered to Feishu. New `/swarm panes` cards prefer direct
links whenever canonical Thread identity is available.

## Tests

Focused tests cover:

1. exact AppLink encoding and rejection of malformed chat/Thread IDs;
2. Primary direct links from the current binding `topicId`;
3. Worker direct links only after the complete generation/parent fence passes;
4. callback fallback when canonical Thread identity is absent; and
5. absence of callback values on direct-link buttons.

Verification runs the directory card/workflow/store tests, architecture check,
typecheck, build, and the full Vitest suite. Installation and restart are
separate operational steps.
