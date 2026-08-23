# Feishu Model Command Implementation Plan

## Scope

Implement the approved `/model [name]` and `/herdr model [name]` behavior from
`docs/superpowers/specs/2026-08-23-feishu-model-command-design.md`. Preserve all
concurrent terminal-streaming work already present in the worktree.

## Test seams

- `parseCommand`: accepted syntax and normalization.
- `HerdrAdapter` through `HerdrPort`: exact Pane command submission and bounded
  terminal result extraction.
- card renderers: identity header, native result, and bounded error states.
- `SyncCoordinator` through inbound Lark events: eligibility, queue isolation,
  command dispatch, reply, and audit behavior.

## Vertical slices

1. Add failing parser tests for both command forms, then add the `model` command
   type and parser branches.
2. Add failing result-card tests, then implement the standalone model card and
   update the help card and user documentation.
3. Add failing adapter tests for `/model` submission, echo removal, stable output,
   and timeout, then implement `runPaneCommand` and cache delegation.
4. Add failing coordinator tests for unbound, inactive, busy, queued, successful,
   and failed commands, then route model commands outside PromptJob creation.
5. Add per-binding command serialization and a test proving prompt dispatch cannot
   interleave with the model command.
6. Run focused tests after each slice. Run the full test suite, typecheck, build,
   and `git diff --check` after the final edit.
7. Stage only model-command files and compatible hunks, inspect the staged diff,
   commit, confirm no active prompts or pending outbox entries, restart the user
   service, and verify service health.
