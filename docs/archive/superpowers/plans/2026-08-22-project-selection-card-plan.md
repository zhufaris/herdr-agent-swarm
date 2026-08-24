# Project Selection Card Implementation Plan

1. Add project-registry types and loader tests, including JSON validation and
   legacy single-project fallback.
2. Extend command parsing and add pure selector-card rendering tests.
3. Normalize Lark `card.action.trigger` callbacks through the adapter port.
4. Add SQLite project-selection persistence, transactional claiming, restart
   recovery, and selector outbox delivery linkage.
5. Route selector commands and callbacks through the coordinator with actor,
   chat, message, expiry, allowlist, and duplicate-click checks.
6. Persist `project_id` on bindings and create panes from the selected
   project's workspace and cwd.
7. Reconcile every configured workspace independently and update readiness to
   validate every project workspace.
8. Add the repository project registry and update operator documentation.
9. Run focused and full tests, typecheck, build, and diff checks; commit the
   implementation in an isolated batch.
10. Wait for active requests to settle, restart the PM2 process, verify health,
    and exercise one real project-selection card.
