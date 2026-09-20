# Transcript Startup Recovery Performance Design

## Problem

Startup reconciliation opens the active TraeX turn for every existing binding. Each cold open recursively scans the same sessions tree and parses up to 64 MiB of JSONL history. With multiple bindings this repeats directory I/O and spends most CPU time parsing records that cannot affect lifecycle recovery.

## Design

`TraexTranscriptReader` builds one process-local transcript-path index for concurrent cold lookups and retains it for at most one second. The index is only a discovery hint: every selected path still passes the existing realpath containment, exact filename, and `session_meta` identity checks. Callers and tests that require immediate filesystem mutation visibility can set the index TTL to zero. No index is persisted and SQLite remains the sole durable workflow authority.

Active-turn recovery keeps the 64 MiB recovery bound and exact lifecycle reducer, but scans 1 MiB chunks backward from EOF. It checks raw buffers for the four event names consumed by the reducer before decoding or parsing JSON: `task_started`, `task_complete`, `turn_aborted`, and `token_count`. The scan stops after it has found the newest turn start, applied later matching terminal events in forward order, and found the required token baseline. If that turn remains active, the cursor still replays every record from its exact start offset, so request, answer, tool, and status projection semantics do not change. If the newest turn is terminal, the cursor opens at EOF with the recovered terminal lifecycle.

The general transcript readers retain their forward bounded baseline scan because they open at arbitrary boundaries. Only cold active-turn recovery uses the backward scan. The superseded per-session recursive discovery helper is removed; the shared index plus per-path validation are now the single discovery path.

## Safety and failure behavior

- Ambiguous paths still fail closed.
- Exhausted discovery still fails closed.
- Cached paths are revalidated before use.
- A newly created transcript can be absent from the shared index for at most one second; normal polling and explicit later observation converge it.
- No prompt is dispatched or replayed by discovery.
- A terminal event can close only its exact turn; a terminal event for another turn cannot suppress active-turn replay.
- Records crossing a reverse-scan chunk boundary are reconstructed before parsing, with the existing 4 MiB per-record bound.
- Memory remains bounded by the configured discovery entry cap and the existing path cache.

## Acceptance

- Existing transcript and exact-turn tests remain green.
- Concurrent cold lookup of different sessions performs one directory scan.
- Production-file recovery remains bounded and is materially faster than the forward 64 MiB scan.
- Typecheck, build, and full suite pass.
- A real installed restart reports startup runtime reconciliation below two seconds without changing readiness semantics or the concurrency cap.
