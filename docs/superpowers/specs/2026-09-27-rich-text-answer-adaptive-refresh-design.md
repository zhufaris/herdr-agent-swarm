# Rich-text Answer Adaptive Refresh Design

## Goal

Make active rich-text Answers feel more like live typing while preserving Lark
API stability, durable outbox ordering, Markdown safety, and frozen-page
immutability. Refreshes remain driven by real projected content; the service
does not generate timer-only animation or synthetic answer text.

## Considered approaches

### 1. Aggressive fixed thresholds

Refresh every 300 milliseconds after four new characters. This looks closest
to character streaming, but multiplies Lark update traffic and makes transient
provider rejection more likely. It is not the default.

### 2. Adaptive content-driven refresh (selected)

Use a 500 millisecond hard floor. After that floor, refresh when any of these
conditions is true:

- at least eight visible characters changed;
- appended text ends at a sentence or line boundary;
- a non-append mutation changes an existing tool, status, task, or terminal
  projection;
- any non-empty visible delta has waited at least 1,200 milliseconds.

The existing cursor suffix is excluded from change measurement, so changing
only `💭`, `💭·`, `💭··`, or `💭···` never causes a delivery. The activity
marker advances only when a real content projection is otherwise eligible.

This balances perceived responsiveness with a maximum of two accepted updates
per second per Answer page. The 1,200 millisecond age rule reduces the chance
that short prose fragments remain invisible indefinitely, but it does not add
a timer: another real projection event is still required to evaluate it.

### 3. Synthetic playback

Buffer already received text and reveal it on a timer. This can mimic a true
typewriter, but it creates writes with no new source event, delays truthful
output, complicates restart recovery, and increases provider traffic. It is
out of scope.

## Refresh semantics

`shouldRefreshRichText` remains the single deterministic policy shared by
Primary and Worker rich-text projections. It compares the last delivered
payload with the next document after removing only the trailing activity
marker.

- An invalid or unreadable prior payload remains refreshable after the hard
  floor, preserving recovery behavior.
- An unchanged visible document is never refreshed.
- Append-only prose uses the character, semantic-boundary, and maximum-age
  rules above.
- Non-append changes are treated as structured state transitions and refresh
  after the hard floor. This covers tool completion/failure, task-state
  changes, and terminal summaries without coupling the runtime policy to
  renderer-specific Markdown labels.
- Terminal updates remain governed by the durable terminal reservation path;
  they are not suppressed by the active-page throttle.

## Markdown and pagination safety

Incomplete fenced code, inline code, and links continue through
`safeStreamingMarkdown` before refresh selection. A refresh must not expose a
partial Markdown construct. Page boundaries, continuation creation, and late
tool-result handling remain unchanged. Frozen pages never receive cursor or
terminal-state updates.

## Observability and failure handling

No schema or new background scheduler is required. Existing outbox records,
delivery errors, and per-Answer lane ordering remain authoritative. Provider
rejections are handled by the existing retry, dead-letter, and newer-snapshot
replacement policy. The adaptive policy must not retry a TraeX prompt or
bypass Lark delivery controls.

## Verification

Focused tests must prove:

1. updates before 500 milliseconds are withheld;
2. eight-character deltas refresh at 500 milliseconds;
3. sentence and line boundaries refresh after the floor with smaller deltas;
4. small deltas refresh after 1,200 milliseconds when another real event
   arrives;
5. cursor-only changes never refresh;
6. non-append tool or task state changes refresh after the floor;
7. incomplete Markdown remains hidden;
8. Primary and Worker projection tests preserve durable ordering and frozen
   page behavior.

## Non-goals

- Character-by-character playback.
- Timer-only cursor animation or heartbeat traffic.
- Changes to persisted Answer state, page size, or Lark retry policy.
- Rewriting frozen pages.
- Increasing Main Card update frequency.
