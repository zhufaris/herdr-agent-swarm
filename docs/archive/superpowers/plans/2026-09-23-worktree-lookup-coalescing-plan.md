# Worktree Lookup Coalescing Implementation Plan

## Objective

Coalesce concurrent worktree-name cache misses per working directory without
changing completed-result cache semantics.

## Work packages

### 1. Add a red-capable resolver test

- Hold a fake command-runner Promise open.
- Call `resolve()` twice concurrently for the same cold `cwd`.
- Assert only one command starts before releasing it and both calls receive the
  expected worktree name.
- Run the focused test and confirm the current implementation fails.

### 2. Implement per-key in-flight coalescing

- Add a private `Map<string, Promise<string | null>>`.
- After completed-cache checks and expiry pruning, reuse an existing Promise for
  the same `cwd` or create one lookup Promise.
- Keep Git execution, error-to-null conversion, TTL/LRU insertion, and eviction in
  one private lookup method.
- Remove the in-flight entry in `finally` only if it still references that Promise.

### 3. Verify and commit

- Run focused resolver tests, typecheck, build, documentation audit, public audit,
  and the full Vitest suite.
- Archive the completed design and plan.
- Review for retained Promise leaks or cross-key serialization, then commit without
  deployment or push.
