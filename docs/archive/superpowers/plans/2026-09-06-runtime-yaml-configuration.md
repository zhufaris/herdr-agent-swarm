# Runtime YAML Configuration Implementation Plan

## Objective

Introduce a strict, optional `runtime.yaml` and make it the sole production
source for the requested polling, cache, CardKit sizing, debounce, and pane-close
confirmation settings. Preserve current effective defaults and the existing
authority, durability, and delivery invariants.

## Architecture

`src/runtime-config.ts` owns YAML parsing, Zod validation, defaults, and safe
file-loading errors. `src/config.ts` resolves `RUNTIME_CONFIG_PATH`, rejects the
retired environment aliases, and embeds the fully populated runtime policy in
`BridgeConfig`. Composition injects individual values into existing modules; no
runtime module reads configuration files directly.

## Slice 1: Validated YAML configuration

Files:

- add `src/runtime-config.ts`;
- add `config/runtime.example.yaml`;
- update `src/config.ts`, `.env.example`, `package.json`, and lockfile;
- update `tests/config.test.ts`.

Steps:

1. Add failing public configuration tests for missing-file defaults, partial and
   full YAML, strict unknown-key rejection, malformed input, range checks,
   cross-field validation, and retired environment variables.
2. Add `yaml` as a direct runtime dependency.
3. Implement a strict Zod schema and bounded YAML loading error messages.
4. Resolve `RUNTIME_CONFIG_PATH` with `./config/runtime.yaml` as the direct-run
   default; expose the resolved path and normalized `runtimeTuning`.

Gate: `npx vitest run tests/config.test.ts`, typecheck, diff check.

## Slice 2: Polling, cache, debounce, and close TTL injection

Files:

- update Primary, Worker, infrastructure, outbound, and application composition;
- update `TranscriptObserver`, `WorkerTurnObserver`, `ExternalTurnObserver`,
  `ConversationViewProjector`, and `PaneClosureWorkflow`;
- update nearest focused tests.

Steps:

1. Add behavior tests at each constructor seam using short explicit intervals or
   a deterministic clock where available.
2. Add optional constructor settings with current defaults for direct test and
   library consumers.
3. Pass normalized YAML values from production composition.
4. Remove the corresponding independently authoritative production constants.

Gate: focused coordinator, runtime cache, projection, and pane-close tests.

## Slice 3: Card payload and Answer limits

Files:

- update card payload helpers and presentation construction;
- update Answer stream/page planning and outbound composition;
- update card and Answer workflow tests.

Steps:

1. Introduce presentation factories or bound policies so configured limits are
   injected once; retain exported default presentations for tests.
2. Apply `payloadLimitChars` to serialized non-streaming CardKit construction.
3. Apply `answerStreamLimitChars` to render-safe stream functions and
   `answerPageLimitChars` to durable page planning.
4. Verify continuation offsets, frozen pages, and final rendering remain stable.

Gate: card rendering, answer stream, answer page, and delivery recovery tests.

## Slice 4: Setup, validation, and service lifecycle

Files:

- update setup types/config repository/workflow and validation CLI;
- update service lifecycle unit rendering;
- update README and setup/operator documentation;
- update setup, lifecycle, and validation tests.

Steps:

1. Extend the private configuration transaction and backup model from two files
   to three while accepting an existing two-file installation.
2. Materialize normalized default YAML when setup next commits configuration.
3. Export `RUNTIME_CONFIG_PATH` in the managed unit and accept an optional third
   `config:validate` argument.
4. Document the file, schema, defaults, migration from retired environment
   variables, and restart requirement.

Gate: setup/config/lifecycle tests and documentation audit.

## Final Audit

1. Scan production source for the listed numeric constants and confirm each
   remaining match is unrelated, a default at the owning interface, or a bounded
   safety/test constant.
2. Confirm no production consumer reads YAML or environment variables directly.
3. Run focused tests, `npm run typecheck`, `npm test`, `npm run build`, and
   `git diff --check`.
4. Commit implementation in thematic slices with the required co-author trailer.
5. Do not push, merge, install, deploy, or restart.
