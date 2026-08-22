# Pane and thread lifecycle implementation plan

1. Add lifecycle domain types, validated transitions, derived presentation
   state, and exhaustive unit tests without changing runtime behavior.
2. Extend SQLite through additive migrations for lifecycle, attachment,
   generation, activity, provisioning checkpoints, cancellation, and durable
   inbound dispositions. Backfill current bindings safely.
3. Route every inbound message through a typed disposition and atomically pair
   acceptance with prompt, command, or feedback outbox work. Cover unbound and
   invalid-command paths.
4. Implement soft archive as active-to-draining-to-archived, allow the active
   turn to finish, cancel queued turns and steering, and render cancellation.
5. Replace project creation's one-shot sequence with resumable provisioning
   checkpoints and startup recovery that never creates a duplicate pane.
6. Add attachment health hysteresis, stable pane generation/session identity,
   and explicit reattach/replacement/resume operations without replaying an
   uncertain turn.
7. Persist project result topic identity, add selector-to-thread navigation,
   render ready separately from done, and expose lifecycle maintenance metrics.
8. Update operator documentation; run migrations against a copied production
   database, the full automated suite, typecheck, build, PM2 restart, readiness,
   logs, and a disposable live lifecycle smoke test.
