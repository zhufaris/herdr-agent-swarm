# Single Rich-Text Answer Title Implementation Plan

## Scope

Remove the duplicate visible title row from Feishu rich-text Answer payloads
while preserving the native title and all pagination metadata.

## Steps

1. Update `tests/feishu-rich-text.test.ts` so titled payloads require one native
   title and no copied bold content row. Run the focused test and confirm it
   fails against the current implementation.
2. Update `src/gateways/feishu/rich-text.ts` to materialize only Markdown and
   code content below `zh_cn.title`.
3. Run the focused Feishu rich-text test plus Answer workflow, event-card, and
   outbound delivery tests.
4. Run type checking, build, architecture checks, and the full Vitest suite.
5. Stage only the owned implementation and test files, commit without hooks,
   install from a clean detached worktree, force restart, and verify readiness
   plus deployed build identity.

## Success criteria

- A titled Feishu payload contains the title exactly once.
- Untitled and continuation behavior remains valid.
- Existing Markdown and fenced-code output remains unchanged.
- No unrelated dirty-worktree files enter the implementation commit or release.
