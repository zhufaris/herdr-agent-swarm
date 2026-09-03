# Bounded Progress, Streaming Recovery, and Incremental Build Design

## Scope

This change contains three independently shippable optimizations:

1. bound the durable Run Card progress projection while preserving cumulative counts;
2. scan detached-turn transcript recovery incrementally instead of buffering the entire file;
3. retain separate TypeScript incremental compiler caches for emit and no-emit commands.

The changes must preserve durable workflow, exact transcript ownership fences, CardKit output semantics, and production artifact contents. They do not change prompt dispatch, replay, steering, or operator authorization policy.

## Bounded progress projection

`RunCardView` will retain a `progressSummary` alongside `progressEvents`. The summary contains:

- `total`: number of distinct progress keys observed;
- `stepTotal`: number of distinct `step` events observed;
- `stepDone`: number of those steps whose latest state is `done`.

`progressEvents` becomes a bounded recent-event projection with a maximum of eight entries. Existing keys within the retained window update in place. A new key advances the cumulative counts and is appended; when the limit is exceeded, the oldest retained entry is evicted. Updating an existing retained step adjusts `stepDone` when its state crosses the `done` boundary.

Snapshot updates are authoritative for their supplied event set. They replace the retained window and recompute the summary from the snapshot because the source explicitly declares a complete progress snapshot. Incremental updates merge into the bounded projection.

SQLite gains a nullable/defaulted summary representation that is added idempotently. Existing databases derive the summary from their stored `progress_events_json` during migration before the history is bounded. New Run Cards initialize all counters to zero. Reads remain compatible with rows created before the column existed.

The Answer Card timeline continues to show the latest three retained events. Its omitted count and titles use `progressSummary.total`; step completion titles use `stepDone/stepTotal`. Full tool history remains available only in the authoritative Herdr/TraeX transcript and is not copied into a new SQLite event table.

## Streaming detached-turn boundary scan

`findCompletedTurnBoundary` will scan the transcript with a fixed-size byte buffer and a bounded carry buffer for a record split across reads. It will:

- reject scans whose total file size exceeds the existing 64 MiB recovery ceiling;
- preserve byte-accurate return offsets into the original file;
- accept LF-delimited JSONL and process a final non-newline-terminated record consistently with the current implementation;
- preserve exact `(turnId, startedAt)` matching;
- return the byte offset before the next distinct turn when the owned turn has no completion record;
- return `incomplete` when the matching turn starts but neither completes nor is superseded;
- return `missing` when no exact start is found.

No prompt is submitted or replayed by this path. Invalid JSON records remain ignored. A single record larger than the recovery chunk limit fails closed as transcript validation failure rather than allowing unbounded carry growth.

Tests will force event records and multibyte UTF-8 content across chunk boundaries and assert the cursor starts at the same exact recovery boundary as before.

## TypeScript incremental compilation

The compiler configuration will enable incremental compilation without placing state under `dist/`. Emit and no-emit commands use separate cache files:

- build: `.cache/tsconfig.build.tsbuildinfo`;
- typecheck: `.cache/tsconfig.typecheck.tsbuildinfo`.

The build command continues to clean `dist/`, emit the same JavaScript and source maps, and generate build identity afterward. Typecheck continues to emit no application files. `.cache/` is ignored by Git and is not copied into immutable production releases.

The implementation may use a small derived typecheck tsconfig or explicit CLI overrides, but the two commands must never share one build-info file. Tests will assert the command/config contract and that production staging still copies only `dist`, `package.json`, and `package-lock.json`.

## Commit and verification boundaries

Each optimization is committed separately:

1. bounded progress projection, SQLite migration, renderer changes, and focused projection/card/store tests;
2. streaming transcript recovery and transcript tests;
3. incremental TypeScript configuration, ignore rules, and build-contract tests.

Before each commit, run its focused tests, `npm run typecheck`, and `npm run build`. After all commits, run the full Vitest suite, strict unused checks, documentation audit, and `git diff --check`.

The untracked `TODO.md` and architecture SVG are outside scope. No installation, service restart, deployment, or push is authorized.
