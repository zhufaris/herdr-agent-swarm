# Thread Entry Forward Target Design

## Problem

`/swarm attach` can be issued from inside an unrelated Lark topic. The attach
result correctly resolves the existing binding, but clicking `发送话题入口`
currently resolves the action message's topic and forwards the project topic
into that topic. Lark rejects this production request with error `230001` even
though both topic IDs are valid and visible to the bot.

## Design

`LarkSdkAdapter.shareThread` will always forward the source project topic to the
configured chat ID supplied by the validated card action. It will use
`receive_id_type=chat_id` and will no longer resolve the action message's topic.
This matches the documented interaction: the bridge sends a native project-topic
entry into the current group, where the user can open the original topic.

The source resolution remains unchanged. A persisted `omt_...` topic ID is used
directly; a legacy root message ID is resolved to its thread before forwarding.
Binding ownership validation remains in `DeliveryRecoveryWorkflow`. No binding,
pane, prompt, or historical message state is changed. Existing error reporting
continues to reply beneath the action card if Lark rejects the forward.

## Alternatives

- Continue forwarding into the action message's topic: rejected because the
  production API deterministically returns `230001`.
- Generate a direct AppLink: rejected because public Lark AppLinks cannot derive
  a valid message link from an Open API message ID.
- Send a plain-text instruction instead of a native topic forward: workable but
  loses the direct navigation affordance already implemented by the product.

## Verification

Adapter tests will assert that both root-message and persisted-topic sources are
forwarded with the target `chat_id`, including when the action message itself is
inside another topic. They will also verify that source-root resolution still
works and that no target-message lookup occurs. Focused integration tests,
typecheck, build, and the full test suite will run before installation.
