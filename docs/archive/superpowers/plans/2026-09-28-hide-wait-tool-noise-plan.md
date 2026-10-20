# Hide Wait Tool Noise Implementation Plan

1. Add a shared visibility predicate beside Tool classification in `src/runtime/tool-activity-projector.ts`; keep `Wait` descriptors protocol-visible but user-invisible.
2. Add a focused TraeX projector regression proving `write_stdin` calls and all paired results emit neither Tool activity nor Answer timeline rows.
3. Apply the shared predicate in `src/runtime/traex-transcript-projector.ts` while retaining the call descriptor for later result pairing.
4. Add equivalent native Herdr event coverage and apply the predicate in `src/runtime/herdr-events-reader.ts` without disturbing the pre-existing untracked implementation.
5. Run focused projector tests, TypeScript checking, the full suite, and a production build.
6. Commit only tracked task-owned files, install the immutable release, force-restart, and verify build identity, readiness, logs, and outbox delivery.
