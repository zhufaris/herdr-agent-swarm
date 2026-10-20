# Complete Assistant and Compact Tool Rendering Implementation Plan

1. Add focused Answer timeline tests proving multiline Assistant commentary,
   including Markdown tables, renders in full without an `omitted` marker.
2. Add tests for exact normalized commentary/final duplication and for distinct
   messages that must both remain visible.
3. Replace the unconditional commentary preview transform with a full-content
   presentation wrapper and add render-only exact-content deduplication.
4. Add native Herdr event-reader coverage proving Skill output does not enter a
   newly projected timeline item; retain renderer-side stripping for legacy rows.
5. Add Tool projection tests for concise semantic command labels while preserving
   the bounded command in collapsed detail, then implement the smallest shared
   classifier change.
6. Run focused tests after each behavior, then run TypeScript checking, build, and
   the full Vitest suite serially.
7. Commit only task-owned files. Keep the pre-existing untracked native Herdr
   reader/test ownership boundary explicit if those files cannot safely be
   committed independently.
8. Install the immutable release, force-restart when no ordinary turn is active,
   and verify build identity, readiness, errors, timeline rows, and the rendered
   outbound payload for a real multiline Assistant response.
