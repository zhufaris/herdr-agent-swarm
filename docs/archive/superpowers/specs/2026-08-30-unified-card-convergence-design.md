# Unified Card Convergence Design

## Goal

Make Lark Answer Cards visible within two seconds and Main Cards visible within three seconds while preserving durable delivery, ordered CardKit sequences, restart recovery, and the no-prompt-replay invariant.

## Responsibilities

- `RunCardView`, `TopicViewState`, and `answer_pages` remain the durable desired presentation state.
- A shared in-process convergence scheduler owns debounce, latest-version coalescing, terminal priority, retry, and post-flight reruns for both card families.
- `AnswerPageWorkflow` retains pagination and frozen-page policy. `MainCardWorkflow` retains compact status rendering.
- SQLite outbox remains the only delivery queue. Card scheduling never calls Lark directly.
- `LarkOutboxDispatcher` remains the CardKit transport and delivery-checkpoint owner.

## Scheduling contract

Each mutable card uses a stable key: `answer:<promptId>` or `main:<bindingId>`. A request carries the desired durable version and one priority: `normal`, `interactive`, or `terminal`. Repeated requests for one key merge to the highest version and highest priority.

- Answer normal updates wait at most 1,500 ms.
- Main normal updates wait at most 2,500 ms.
- Interactive updates wait at most 1,000 ms.
- Terminal, blocked, failed, pagination, and delivery-checkpoint convergence run immediately.
- A request arriving during a flush causes another flush against fresh SQLite state.
- Failed convergence retries with bounded exponential backoff. Periodic/startup reconciliation remains the recovery path if an in-memory notification is lost.

## Delivery semantics

- Main Card pending updates are latest-wins. Older unsent versions are dismissed transactionally. `viewVersion` is the CardKit sequence.
- Answer pages retain their current durable create, stream, finish, and continuation protocol. Exactly one page is mutable. Frozen pages are immutable.
- Answer content is monotonic-visible. A terminal projection shorter than a delivered continuation cannot replace that continuation with empty or shorter content.
- Delivery success advances durable checkpoints. A late old version cannot overwrite a newer version.
- Transient failures retry; invalid mutable targets may rebuild through existing recovery. No delivery failure replays a TraeX prompt.

## Presentation

- Main Card contains current state, queue metadata, and at most eight recent activity summaries.
- Answer Card contains the full streamed answer and tool activity, split into 9,000-character pages.
- Main Card does not copy command output. Answer Card output remains copy-safe and unprefixed.

## Observability

The scheduler reports bounded diagnostics: pending keys by card family, in-flight count, coalesced request count, failure count, oldest pending age, and last successful flush. Structured logs include card key, desired version, priority, latency, and outcome. `/status` exposes these scheduler diagnostics together with existing outbox state.

## Acceptance criteria

- Bursty Answer updates coalesce and flush within 1.5 seconds; terminal updates flush immediately.
- Bursty Main updates coalesce latest-wins and flush within 2.5 seconds; terminal updates flush immediately.
- Delivery checkpoints re-enter the same scheduler rather than bypassing it.
- Updates arriving in flight trigger a fresh-state follow-up flush.
- Answer pagination, restart recovery, stale-event dismissal, and final-content preservation remain green.
- Main Card uses CardKit entity updates with monotonic durable versions.
- `/status` exposes scheduler lag without card or prompt content.

