# `/herdr spaces` implementation plan

1. Extend `BridgeCommand` and `parseCommand` with an argument-free `spaces` command.
2. Add a pure space-directory card module with explicit group and pane view models, deterministic sorting, safe field bounds, and pane-row pagination.
3. Add coordinator collection that queries each workspace once, groups configured routes by `spaceName`, retains empty groups, assigns unmatched panes to `未注册`, and captures workspace-local safe errors.
4. Reply through the durable outbox with one idempotency key per page and add the command to the help card.
5. Verify parser, renderer ordering/pagination, all-pane inclusion, empty spaces, duplicate-space merging, partial failure, and no binding creation.
