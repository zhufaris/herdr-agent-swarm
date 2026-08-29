# Disable Terminal Answer Fallback Design

## Goal

Prevent raw Herdr terminal snapshots from becoming user-visible Answer Card
content when a TraeX typed transcript is unavailable. The bridge continues to
observe terminal state for lifecycle convergence, but only validated TraeX JSONL
may supply Answer text and structured tool activity.

## Scope

Delete the terminal-derived Answer fallback and its warning, parsing, streaming,
accumulation, and final-extraction branches. Do not add a compatibility setting
or retain a dormant legacy path. Terminal reads remain only where the control
plane needs them for prompt submission, composer readiness, agent-state
inference, blocked-state detection, completion detection, or reconciliation.

## Turn output policy

Each ordinary turn still attempts to open an exact, validated TraeX transcript
before prompt dispatch and records the selected source and bounded reason in
structured logs. The existing fallback reasons remain authoritative, including
`missing_session_identity`, `unsupported_session_identity`,
`transcript_not_found`, `ambiguous_transcript`,
`transcript_validation_failed`, and `transcript_read_failed`.

When typed output is available, behavior is unchanged. When it is unavailable,
terminal observations must not emit Answer deltas, replace an Answer snapshot,
or become the final Answer. When no typed Answer content exists, completion
persists and publishes the fixed safe notice:

`⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。`

The prompt remains delivered and is never replayed because output was
unavailable. The safe notice intentionally omits terminal text, prompt text,
paths, session identifiers, and detailed transcript failure information. Those
details remain in bounded structured logs only.

If a typed transcript read fails before any typed content has been emitted, the
source changes to an unavailable state. If typed content was already emitted,
accumulated typed content is finalized and no terminal content is appended.

## Detached recovery

Detached observers continue using Herdr terminal and process state to determine
whether an uncertain, already-dispatched turn is still active or has completed.
Neither the completion snapshot nor previously accumulated terminal-derived
RunCard content may become the recovered Answer. If no typed content can be
recovered, completion uses the same fixed safe notice. Recovery never resubmits
the prompt.

This policy applies consistently to newly dispatched turns and restart recovery.
It prevents a restart from reintroducing terminal content that the live path was
configured not to publish.

## Boundaries and durability

The change is centered in `PromptRunWorkflow` and removes terminal Answer parser
imports and helper functions that become unreachable. CardKit, the outbox,
pagination, source offsets, and SQLite transaction boundaries remain unchanged.
The final safe notice is normal canonical Answer text, so existing Answer
delivery and restart convergence stay deterministic. No configuration or schema
migration is required.

## Testing

- Workflow integration tests cover every initial transcript fallback reason and
  assert that terminal text never reaches the RunCard or lifecycle event.
- Transcript-read failure tests cover failure before and after typed emission,
  preserving the no-mixing guarantee.
- Detached-recovery tests assert that terminal output and legacy accumulated
  terminal content are not published.
- Source and test scans assert that the former fallback warning, fallback Answer
  helpers, and terminal-output Answer expectations have been removed.
- Typecheck, the affected Vitest files, the full suite, and production build must
  pass before deployment.

## Rollout

Existing in-flight prompts are not restarted or replayed. Before restart, verify
no active turn or steering worker and no pending outbox delivery. After restart,
verify readiness and then exercise one newly created or reset topic with a valid
typed identity plus one controlled unavailable-identity case. The former must
stream structured output; the latter must show only the safe notice.
