# Safe Error Diagnostic Tail Implementation Plan

## Objective

Preserve actionable stderr at the end of long structured error messages while
retaining the existing security boundary and 500-character limit.

## Work packages

### 1. Lock down the regression

- Extend `tests/safe-error.test.ts` with a command-shaped error whose actionable
  cause occurs after the old 500-character prefix boundary.
- Assert the safe result retains the beginning, explicit truncation marker, and
  exact terminal cause within the existing bound.
- Include a tail credential to prove whole-message redaction precedes truncation.

### 2. Implement bounded middle truncation

- Replace the prefix-only slice in `src/runtime/safe-error.ts` with a private
  bounded head-and-tail helper.
- Allocate more retained space to the diagnostic tail while keeping useful head
  context and an unambiguous marker.
- Leave safe error fields and callers unchanged.

### 3. Verify and finish

- Run the focused safe-error test before and after implementation.
- Run typecheck, build, and the full test suite.
- Review the diff for secret handling, accidental scope growth, and exact length
  behavior, then commit the optimization.
