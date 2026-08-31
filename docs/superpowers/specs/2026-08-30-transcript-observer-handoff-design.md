# Transcript Observer Handoff Design

## Goal

Publish the first Answer Card commentary as soon as it appears in the TraeX transcript, including when `herdr agent prompt --wait` reports `agent_prompt_stalled` before that commentary is written.

## Root Cause

The attached transcript observer owns a byte cursor while the Herdr prompt waiter is pending. When the waiter reports a stalled observation after about five seconds, the workflow stops that observer and marks the prompt detached. A later safety scan starts a detached observer by opening the transcript again at EOF. Commentary written between those two operations is therefore skipped.

## Design

The active binding worker will retain the existing typed transcript source when it changes the prompt from attached to detached observation. If the prompt already owns an exact transcript turn, the same worker immediately enters the detached observation loop with the same cursor, accumulated Answer chunks, and observation signature.

The detached loop remains responsible for runtime observation and terminal completion. A detached observer discovered after process restart continues to open a fresh transcript cursor and relies on the durable turn ID and start timestamp, because cursor state is intentionally process-local.

## Invariants

- A prompt is never submitted a second time.
- Output is published only after the exact transcript turn is durably claimed.
- The cursor handoff has one reader at a time: the attached observer is stopped and awaited before detached observation begins.
- Previously emitted item IDs, accumulated Answer chunks, and the last observation signature remain available across the in-process handoff.
- Shutdown continues to abort the shared turn supervisor and persists detached observation without replay.
- Restart recovery remains durable-state based and does not serialize cursor internals.

## Verification

An integration test will reproduce a waiter that stalls after the exact turn is claimed, then expose the first commentary only after the stall. The test must prove that the commentary is emitted exactly once and that the prompt completes without a second transcript open or prompt dispatch. Existing concurrency, transcript, typecheck, build, and full-suite checks must remain green.
