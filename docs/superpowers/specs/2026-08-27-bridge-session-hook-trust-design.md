# Bridge Session Hook Trust Design

## Goal

Allow a bridge-created TraeX Pane to report its exact native session UUID to
Herdr, so the bridge can safely select the matching JSONL transcript instead of
falling back to terminal output.

## Cause and boundary

TraeX accepts the bridge's `hooks.SessionStart` override but requires explicit
trust before it runs command hooks. In the observed fresh Pane `wH:p39`, the
TraeX process started with the reporter hook and the bridge created a binding,
but Herdr never received `agent_session`; the binding therefore remained in
terminal output mode.

The bridge owns the injected hook command. It is the compiled local
`report-traex-session.js` reporter, which accepts only a bounded `SessionStart`
payload, reports the UUID with the current Herdr Pane identity over the local
Herdr socket, and does not read or transmit prompt or transcript content.

## Design

`HerdrCliAdapter.startTraex()` will add TraeX's
`--dangerously-bypass-hook-trust` flag immediately before the existing
SessionStart `-c` override. The flag applies only to TraeX processes started by
the bridge; it does not modify global TraeX configuration, existing Panes, or
user-started TraeX processes.

The existing reporter validation remains the security boundary:

- it requires `HERDR_ENV=1`, current Pane ID, and Herdr socket path;
- it accepts only a UUID-bearing `SessionStart` JSON payload;
- it reports only the session UUID and bounded identity metadata to Herdr.

The bridge continues to use terminal mode if Herdr does not report a validated
native `traex` ID session. It must not infer a session from cwd, timestamp, pane
title, or newest JSONL filename.

## Verification

The adapter test asserts the exact bridge-managed TraeX startup arguments
include the hook-trust flag and the quoted SessionStart override. Focused adapter
and reporter tests, type checking, and build must pass. After managed-service
restart, a newly created or reset binding must show a native `traex` ID session
in the Herdr snapshot and in SQLite before its next prompt is considered JSONL
eligible.
