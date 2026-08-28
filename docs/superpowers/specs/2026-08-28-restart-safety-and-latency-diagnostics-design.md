# Restart Safety and Latency Diagnostics Design

## Goal

Prevent routine service restarts from extending prompt latency while TraeX turns are active, and expose bounded latency diagnostics that distinguish queueing, model execution, and Lark delivery delay.

## Scope

This change affects the standalone and plugin lifecycle CLI, the SQLite operational summary, and `/status`. It does not change prompt FIFO ordering, steering semantics, turn completion detection, automatic replay rules, or CardKit rendering.

## Restart preflight

Before invoking `systemctl --user restart`, the lifecycle CLI reads the configured service `/status` endpoint. If the service is reachable and reports any running prompts or active turn workers, restart is rejected before `daemon-reload` or service mutation. The error reports bounded aggregate counts for running and queued prompts and explains that the operator can wait for drain or explicitly force the restart.

The CLI accepts `--force` only for `restart`. Forced restart preserves the existing shutdown behavior: an in-flight observer is detached, the prompt is not replayed, and startup recovery observes the existing TraeX turn before allowing later FIFO work to run. Start, stop, install, status, logs, and uninstall behavior remain unchanged.

If `/status` is unreachable, malformed, or belongs to a different service/build, the preflight does not invent activity state. The restart continues because an unavailable or stale process may be the reason the operator requested restart. The post-restart identity and readiness checks remain authoritative.

## Latency diagnostics

`SqliteBindingStore.getOperationalSummary()` adds a `promptLatency` object computed from a bounded recent window of terminal prompts. It contains:

- the sample count and window size;
- queue latency from prompt creation to Run Card start;
- execution latency from Run Card start to finish;
- completion latency from Run Card finish to its final durable update;
- average and maximum milliseconds for each phase.

Only prompts with the timestamps required for a phase contribute to that phase. Empty phases report a zero sample count and `null` averages/maxima. Calculations use SQLite timestamps and expose no prompt text, Lark payload, user identity, or secret. A fixed recent-record limit keeps `/status` inexpensive regardless of database history.

`/status` returns the new data inside the existing `operational` object. It remains diagnostic: high latency alone does not make `/ready` fail or change service health. Existing prompt counts and outbox diagnostics remain unchanged.

## Data flow

1. Lark input is durably accepted as today.
2. Existing prompt and Run Card timestamps capture queue, execution, and completion boundaries.
3. The operational summary aggregates recent completed records at read time.
4. `/status` exposes the bounded aggregate.
5. A lifecycle restart queries `/status`; active work blocks an unforced restart before any systemd command is issued.

## Failure handling

- A reachable status response with active work blocks restart.
- A reachable status response without active work permits restart.
- An unavailable or unparseable status endpoint permits restart and relies on existing post-restart verification.
- `--force` bypasses only the active-work guard; it does not bypass build identity or readiness verification.
- Database aggregation errors continue through the existing bounded `/status` error response.

## Testing

Focused tests cover:

- restart rejection when running prompts or active workers are reported;
- no `daemon-reload` or `systemctl restart` call on rejection;
- `restart --force` proceeds and retains post-restart health checks;
- inactive, unreachable, and malformed status responses preserve restart availability;
- prompt-latency aggregates for mixed completed, running, and incomplete timestamp rows;
- empty latency samples and bounded sample-window behavior;
- `/status` includes latency diagnostics without exposing content.

Before handoff, run the focused lifecycle, store, and health tests, then `npm test`, `npm run typecheck`, and `npm run build`. Restart only after the live service reports no running prompt or active turn worker, then verify `/ready` and `/status`.
