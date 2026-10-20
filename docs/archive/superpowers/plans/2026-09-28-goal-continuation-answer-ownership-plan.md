# Goal Continuation Answer Ownership Implementation Plan

## Objective

Deliver one durable Feishu Answer for every runtime turn in a single TraeX goal
continuation chain while preserving exact-turn isolation, restart safety, and
the existing Answer readability rules.

## Phase 1: Swarm metadata-only lineage probe

1. Add metadata-probe tests for:
   - root goal plus two valid continuations;
   - changed objective, reset counters, malformed envelope, explicit user input,
     aborted parent, and mid-turn attach;
   - source replacement and bounded scan failures;
   - no assistant, Tool, or reasoning text can enter probe output.
2. Implement the bounded goal-envelope parser and exact boundary scanner using
   the existing validated transcript locator.
3. Return only origin, parent, chain, turn ID, and start identity; never return
   transcript content.
4. Run focused Vitest tests, typecheck, and build.

## Phase 2: Swarm multi-turn ownership

1. Extend `AgentTranscriptObservation` and the Herdr events reader with optional
   lineage metadata. Missing metadata remains single-turn behavior.
2. Add SQLite migration and records for append-only
   `prompt_transcript_turns`; backfill existing root identities.
3. Add focused store tests for root claim, valid child adoption, idempotency,
   cross-Prompt conflict, missing parent, mismatched chain, and changed binding
   generation/runtime identity.
4. Replace single-turn observation filtering with ordered exact owned-turn
   filtering. Each child is adopted transactionally before any output is
   projected.
5. Keep Answer timeline sequences monotonic across child turns and prevent
   child completion from prematurely finalizing the Prompt.
6. Update detached recovery and external-turn supersession to replay owned
   chains and keep unrelated turns separate.
7. Resolve turn-control operations against the latest active owned turn.
8. Add integration tests covering attached chains, restart recovery, external
   manual turns, no replay, and existing rendering invariants.
9. Update architecture and operator documentation for the new authority and
   compatibility behavior.

## Phase 3: Verification and rollout

1. Run affected Swarm tests after each boundary change.
2. Run Swarm typecheck, build, diff checks, and the full Vitest suite.
3. Inspect live active Prompt, outbox, and service state before installation.
4. Build/install Swarm and force-restart the service.
5. Confirm readiness, build identity, migrations, and absence of new structured
   log errors.
6. Submit a fresh goal that produces at least two runtime turns.
7. Build the final prompt-to-artifact matrix mapping each pane-visible safe
   message or Tool activity to Core event, SQLite timeline, outbound payload,
   and delivered Answer.
8. Treat any unexplained omission, duplication, reordering, title loss, unsafe
   reasoning exposure, or incorrect Tool expansion as a failed acceptance test.

## Commit boundaries

- Swarm lineage probe and persistence/observation changes form one functional
  commit.
- Documentation and any rollout-only adjustments remain separate when they are
  independently meaningful.
- No remote push occurs without a separate request and the repository's public
  audit gate.
