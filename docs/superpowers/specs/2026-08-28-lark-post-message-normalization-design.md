# Lark Post Message Normalization Design

## Goal

Accept slash commands and bot mentions sent from Lark topic groups, where the
client represents ordinary editor content as `message_type=post`.

## Design

`LarkSdkAdapter.normalizeMessage` remains the boundary that converts untrusted
Lark events into `IncomingLarkMessage`. It continues to accept user-originated
`text` messages and additionally accepts `post` messages. For `post`, it parses
the JSON document, prefers `content_v2` when present, falls back to `content`,
and traverses paragraph nodes in display order. Text nodes contribute their
text. An `at` node contributes the event mention key unless it targets the
configured bot; configured-bot mentions are removed and set `mentionsBot`.
Line boundaries are preserved with newlines so command parsing does not merge
unrelated paragraphs.

Malformed payloads, unsupported message types, and posts without usable text
remain ignored. Chat allowlisting and sender validation are unchanged. No API
lookup is added to the inbound path.

## Verification

Unit tests exercise the exported normalization boundary with topic-group post
payloads for a bare command, a configured-bot mention, and a different-user
mention. Existing text-message behavior must remain unchanged. The focused
test, TypeScript check, and production build must pass before restarting the
managed service. Live acceptance requires a newly sent topic-group command to
appear in SQLite and receive the project-list response.
