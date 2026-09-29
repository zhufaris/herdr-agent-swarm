# Agent Transcript Adapters Implementation Plan

## Objective

Implement the approved Agent-neutral transcript seam and Pi native JSONL
adapter so newly managed Pi Primary turns reach the existing durable Answer
Card pipeline with exact-turn recovery and without terminal scraping.

Design authority:
`docs/superpowers/specs/2026-09-25-agent-transcript-adapters-design.md`.

## Invariants

- Never replay a Prompt that may have reached an Agent.
- Keep Herdr Agent control identity separate from transcript-file identity.
- Fence transcript ownership by binding generation and exact turn ID/start time.
- Keep coordinators independent of TraeX and Pi record formats.
- Persist only bounded, redacted projections through the existing event/outbox
  path; never persist system/thinking content.
- Legacy Pi panes without a managed transcript descriptor remain unavailable;
  never guess their file by cwd or modification time.

## Task 1: Generalize the transcript port

Rename the domain transcript contracts from `TraexTranscript*` to
`AgentTranscript*`, introduce `AgentTranscriptSource`, and update observers,
workflows, tests, and composition to depend on the neutral seam. Adapt
`TraexTranscriptReader` behind the new source contract without changing its
discovery, cursor, boundary, or projection behavior. Add a small router that
selects a reader by Agent kind.

## Task 2: Define deterministic Pi transcript identity

Add a pure descriptor helper deriving a UUID session ID and private generation
directory from binding ID/generation. Extend startup options with a transcript
descriptor, have `PiDriver` append `--session-id` and `--session-dir`, and create
the directory at `0700` before launch. Compose the descriptor root below the
configured swarm state directory. Preserve all Herdr-native session fields for
control fencing.

## Task 3: Implement the Pi JSONL adapter

Add a Zod-validated Pi record codec, projector, bounded file locator/scanner, and
incremental cursor. Implement all reader openings (`latest`, `active`, `first`,
`at`, `after`) over the selected append-only branch. Project user starts,
assistant text, tool calls/results, completion/abort reasons, and usage into
`AgentTranscriptObservation`; omit system/thinking data and retry partial trailing
records.

## Task 4: Connect managed Primary observation

Pass the same descriptor into Pi startup and transcript source construction.
Advertise Pi structured events only when configured. Route Pi through the
existing `TranscriptObserver`, exact-turn claim, detached recovery, conflict
handling, reducers, Answer Card pagination, and durable outbox. Retain the
fallback only for legacy/missing/invalid transcripts.

## Task 5: Tests and architecture checks

Add focused tests for descriptor determinism/generation fencing, Pi startup
arguments, header validation, partial lines, branches, multiple turns, tool-use
loops, failures, usage, redaction, exact-turn reopen, and a Primary card
integration. Update architecture guards so coordinators can import only the
neutral port and public reader facade.

## Task 6: Verification and deployment readiness

Run focused transcript/driver/coordinator tests, then:

```bash
npm test
npm run typecheck
npm run build
npm run architecture:check
npm run docs:audit
npm run public:audit
git diff --check
```

Commit with hooks disabled if necessary and verify the final commit body contains
no automated co-author trailer. Installation, restart, real Pi/Feishu
verification, and push remain separate operator actions.
