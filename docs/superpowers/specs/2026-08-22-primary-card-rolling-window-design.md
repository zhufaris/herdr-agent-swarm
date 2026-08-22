# Primary Card Rolling Window Design

## Goal

Keep the channel's primary `TraeX · project / pane` card compact while it updates continuously. Per-request cards remain the durable, detailed record.

## Window

The primary card shows only:

- the latest eight semantic progress entries for the current request;
- the latest 2,000 characters of the current answer;
- current phase, pane, space, and queue metadata.

Progress is ordered from oldest to newest within the retained window so new activity appears at the bottom. When a ninth entry arrives, the oldest displayed entry is discarded. Answer truncation keeps the tail because it represents the newest streamed output, and uses the existing Lark Markdown sanitizer/truncator.

Starting a new request clears the previous request's progress and answer from the primary card. Completion retains the final eight progress entries and final 2,000 answer characters. A stale event from an older request cannot replace the active request.

## Persistence and Restart

The topic view stores only the bounded primary-card window. On process start, it rebuilds that window from the latest persisted request card by selecting its last eight progress entries and the tail of its answer. No full request history is copied into the primary view.

## Delivery and Failure Handling

Updates continue to replace the same primary Lark message through the existing durable SQLite outbox. Request-card delivery and retention limits are unchanged. A failed primary-card update remains retryable without blocking the request card's own update target.

## Verification

Tests cover live accumulation, eviction of the oldest progress entry, tail-preserving answer truncation, reset on a new request, stale terminal-event protection, and bounded startup restoration.
