# Thread Entry Forward Target Implementation Plan

1. Update Lark adapter tests so an action inside another topic still forwards the
   project topic to the configured group chat. Confirm the old implementation
   fails that assertion.
2. Simplify `LarkSdkAdapter.shareThread` to resolve only the source thread and
   call `thread.forward` with `receive_id_type=chat_id`.
3. Run focused adapter and attach integration tests, then typecheck, build, and
   the full Vitest suite.
4. Commit the implementation, install the immutable release, restart the service,
   and verify identity/readiness.

## Added slice: attach by visible Pane token

1. Expose canonical four-character token extraction without the internal hash
   fallback.
2. Resolve `/swarm attach` by exact ID, exact label, then unique canonical token.
3. Reject ambiguous tokens with full candidate Pane IDs and document the syntax.
