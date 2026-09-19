# Orphaned Thread Integrity Plan

1. Add a focused regression test covering a structurally valid orphaned parent
   with active alias and Worker-thread projections. Confirm it fails against the
   current auditor.
2. Add negative controls that still detect generation, Pane, Worker lifecycle,
   and terminal-parent contradictions.
3. Narrow the two integrity queries to structural and terminal-lifecycle
   contradictions without changing routing or persisted lifecycle state.
4. Run the focused test, typecheck, build, full suite, and public audit.
5. Install the new immutable release, perform a non-forced restart, and verify
   build identity plus the production startup reconciliation target.
