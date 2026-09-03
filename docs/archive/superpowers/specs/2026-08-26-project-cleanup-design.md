# Project Cleanup Design

## Goal

Remove code that has no runtime or compatibility purpose, move completed
planning artifacts out of the active documentation surface, and align the
maintainer and user documentation with the current implementation.

The cleanup must preserve the bridge's durability, no-replay, FIFO, recovery,
security, and local-approval invariants.

## Scope

### Runtime code

Use TypeScript's `noUnusedLocals` and `noUnusedParameters` diagnostics as the
initial candidate list. For each candidate:

- delete an unused private function, import, local variable, or parameter when
  it has no runtime effect;
- narrow constructor option types and update callers when an injected
  dependency is no longer consumed;
- retain an item when it represents a public contract or a compatibility
  boundary that is still exercised by persisted state or supported runtimes;
- do not hide dead code by prefixing unused names with underscores.

No unrelated module restructuring is included.

### Compatibility boundary

The following are intentionally retained unless direct inspection proves they
are unreachable and unnecessary for existing installations:

- SQLite schema migrations and normalization of records written by earlier
  bridge versions;
- recovery of legacy CardKit element identifiers and delivery state;
- normalization of older Main Card projections;
- Herdr Socket or snapshot compatibility fallbacks used for supported runtime
  versions;
- detached-turn observation and uncertain-dispatch protections.

These paths protect existing `bridge.db` files or supported operational
environments and are not classified as dead code solely because fresh
installations do not normally enter them.

## Documentation structure

The active documentation surface consists of:

- `README.md` for installation, configuration, operation, and deployment;
- `docs/architecture.md` for authoritative behavior and architectural
  constraints;
- `docs/architecture-reference.md` for the maintainer-oriented module and data
  flow map;
- `docs/feishu-group-usage.md` for user-visible commands and behavior.

Completed artifacts currently under `docs/superpowers/specs/`,
`docs/superpowers/plans/`, and `docs/superpowers/tickets/` move to the matching
directories under `docs/archive/superpowers/`. The cleanup design and its
implementation plan also move to the archive once implementation is complete.
Historical documents remain available but are not behavioral authority.

References between moved documents must be rewritten so repository-relative
links remain valid. Active documents should link to archived material only when
historical context is useful.

## Documentation corrections

Documentation is checked against source, tests, plugin scripts, and the plugin
manifest. Corrections cover:

- current commands and plugin lifecycle actions;
- environment defaults and valid ranges from `src/config.ts`;
- the distinction between `LARK_MESSAGE_CHUNK_SIZE`, whose default is 3,500,
  and the Answer Card stream page limit, which is 9,000 characters;
- current Main Card desired-versus-delivered version behavior;
- Answer Card creation, continuation, freezing, and recovery behavior;
- current workflow ownership, reconciliation, and delivery boundaries;
- removal of statements that describe already-completed work as a future gap.

Documentation should describe stable behavior rather than replaying the
implementation chronology captured in archived plans.

## Safety and data handling

The cleanup does not modify local `.env`, `config/projects.json`, `var/`, live
SQLite databases, Herdr plugin configuration, or service state. It does not
restart the managed service or send Lark messages. Generated `dist/` output is
created only through the normal build and is not committed.

## Verification

After the final edit, run:

1. `npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`;
2. `npm run typecheck`;
3. `npm test`;
4. `npm run build`;
5. a repository-local Markdown link check covering active and archived docs;
6. `git status --short` and `git diff --check`.

Completion requires zero strict-unused diagnostics, all tests passing, a
successful production build, and no broken local Markdown links introduced by
the archive move.

## Explicit non-goals

- Removing historical documents from `docs/archive/`.
- Dropping compatibility migrations needed by existing databases.
- Changing user-visible workflow behavior.
- Changing dependencies, deployment topology, or service configuration.
- Performing a live service restart or smoke test that sends Lark messages.
