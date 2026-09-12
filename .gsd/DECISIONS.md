# Architecture Decisions

## 2026-09-12: Conversation Gateway plugin seam

Use a statically registered, negotiated Conversation Gateway session with separate
ingress and delivery ports. Feishu is the first built-in plugin. Core workflows use
provider-neutral events, views, identities, and durable delivery plans; SQLite
retains ownership of acceptance, lane ordering, claims, checkpoints, retries, and
quarantine.

This shape was selected over a renamed broad `LarkPort` and optional per-feature
facets because it keeps the caller interface small while fixing capability choices
before external effects. The first milestone supports one configured Gateway and
retains existing `LARK_*` configuration and SQLite physical columns for rollback
compatibility. Dynamic npm loading and production Telegram/Discord adapters are
deferred.
