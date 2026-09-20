# Long Answer Continuation Design

## Goal

Keep Primary Answer Cards progressing beyond the legacy 64 KiB transcript
aggregation boundary while retaining a hard per-turn safety bound and recovering
already-truncated running turns after restart.

This vertical slice spans typed transcript observation, durable Run Card state,
Answer pagination, restart recovery, and focused production evidence. After the
slice, a long-running `niru`-style turn can continue creating 9,000-character
Answer pages past 64 KiB instead of silently freezing at page 7.

## Production evidence

The active `herdr-agent-swarm / niru` binding has a running Prompt whose Run
Card is at view version 155 while `answer_delivered_version` remains 36. Both
`answer` and `answer_draft` are exactly 65,536 characters. Its active page 7 has
not advanced past sequence 1, no Answer outbox intent exists after 04:52 UTC,
and Main Card updates continue to be created and acknowledged. This isolates the
failure before Answer projection or outbox delivery.

`BoundedTurnOutput` currently appends a truncation marker at 64 KiB and then
suppresses all later answer deltas. The observed durable state matches that
behavior exactly.

## Selected design

Increase the hard per-turn typed-output budget from 64 KiB to 512 KiB. This
supports roughly 58 normal Answer pages while keeping memory and the Run Card
row bounded. The 9,000-character card page limit and all frozen-page semantics
remain unchanged. Output still receives an explicit truncation marker and stops
growing if the larger safety bound is reached.

Add legacy-prefix recovery for Run Cards that already end in the old truncation
marker. Detached replay will:

1. strip only the exact terminal marker from persisted output;
2. replay the exact owned transcript turn under its existing turn identity;
3. require the replayed transcript to begin with that marker-free prefix;
4. publish the replayed snapshot as `replace-all`, removing the stale marker and
   restoring all currently available content;
5. continue normal delta observation and Answer pagination.

Ordinary detached replay without the legacy marker keeps its suffix-only append
behavior. Missing identity, a prefix mismatch, a truncated replay, or an
unavailable transcript remains fail closed and does not rewrite the Run Card.

## Alternatives

### Remove the bound

This fixes the immediate symptom but permits one turn to grow process memory and
SQLite without limit. It conflicts with the service's bounded-observation
invariant.

### Persist page-local canonical chunks

This is the stronger long-term storage model: completed pages could leave the
hot Run Card row while remaining recoverable. It requires a schema and recovery
protocol migration and is too broad for the current incident slice. It remains
a future optimization if 512 KiB is insufficient in real workloads.

### Raise the bound without legacy recovery

New turns would improve, but the currently affected `niru` turn would retain a
synthetic marker that cannot match the original transcript prefix. Restart would
therefore fail to catch it up.

## Invariants

- Only output from the exact owned transcript turn is replayed or published.
- The per-turn aggregate remains bounded at 512 KiB.
- The legacy marker is stripped only when it is the exact terminal suffix.
- A replay prefix mismatch never replaces durable Answer content.
- Recovery uses `replace-all`; it does not append after a synthetic marker.
- Frozen Answer pages remain immutable and page size stays 9,000 characters.
- Prompt FIFO, no-replay, generation fences, and outbox delivery semantics are
  unchanged.

## Testing

- Prove output beyond 64 KiB still emits and remains below 512 KiB.
- Preserve the hard-bound truncation and post-truncation suppression test.
- Prove detached replay strips a legacy terminal marker, matches the transcript
  prefix, and publishes one `replace-all` snapshot.
- Prove a prefix mismatch or incomplete replay performs no rewrite.
- Run transcript observer/projector tests, Answer pagination integration tests,
  typecheck, build, architecture checks, and the full suite.

## Non-goals

- No unbounded transcript storage.
- No page-local canonical-content schema in this slice.
- No Pane Entry mirroring; that is the next independent vertical slice.
- No production install or restart without separate authorization.
