# Reliable TraeX Prompt Submission

## Problem

The bridge currently calls `herdr pane send-text` and immediately calls
`herdr pane send-keys ... Enter`. TraeX can still be completing bracketed-paste
handling when Enter arrives, so the prompt becomes visible in the composer but
is not submitted. The bridge then leaves the prompt job in `running`.

## Design

Both new turns and active-turn steering use one adapter helper. The helper sends
the text, polls recent terminal output until the exact prompt text is visible,
and only then sends Enter. Polling is bounded by the existing Herdr command
timeout and uses a short interval. If the text never becomes visible, the helper
throws without sending Enter so delivery uncertainty is surfaced to the
coordinator instead of being reported as successful.

The state guard for steering remains unchanged: steering is accepted only while
Herdr reports the pane as `working`. Turn completion and approval observation
also remain unchanged.

## Verification

Adapter tests must prove that Enter is ordered after terminal confirmation for
both paths, that a confirmation timeout does not send Enter, and that steering
still rejects non-working panes. The live reproduction uses a disposable TraeX
pane and verifies that a prompt submitted through the fixed adapter starts a
turn without a second manual Enter.
