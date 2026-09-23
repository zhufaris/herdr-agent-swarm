# Safe Error Diagnostic Tail

## Goal

Keep the actionable tail of long command failures in structured logs without
increasing the existing 500-character error-message bound or weakening secret
redaction. This makes Herdr and Agent stderr visible when a command prefix and
arguments consume most of the error budget.

## Current problem

`safeLogError` redacts a message and then retains only its first 500 characters.
`CommandError` places the command description before the child-process detail,
so a long safe command prefix can hide the stderr at the end. Operators then see
that a command failed but lose the provider or runtime reason needed to diagnose
it.

## Chosen behavior

Short messages remain byte-for-byte unchanged. Long messages are redacted first,
then shortened to exactly the same maximum length by retaining both their start
and end with an explicit ` ... [truncated] ... ` marker between them. The start
preserves the error class and operation context; the larger tail preserves the
most recent stderr and nested cause, where command-line tools conventionally put
the actionable reason.

The truncation helper stays private to `safe-error.ts`. This is a logging and
diagnostic representation change only: persisted workflow decisions, retry
classification, command execution, and user-facing CardKit behavior do not
change.

## Security and bounds

Redaction must run over the complete source message before any fragment is
selected. This prevents a secret that crosses a truncation boundary from evading
the existing patterns. The final message remains at most 500 characters. The
whitelist-only error shape and bounded metadata fields remain unchanged.

## Verification

Focused tests will prove that:

- short messages remain unchanged;
- a long command-style message preserves both its operation prefix and terminal
  stderr reason;
- truncation is explicit and the result is at most 500 characters;
- credentials in the retained tail remain redacted;
- applying `safeLogError` to its own safe shape remains stable.

Validation also includes typecheck, build, and the full Vitest suite because
`safeLogError` is shared across workflow and transport boundaries.
