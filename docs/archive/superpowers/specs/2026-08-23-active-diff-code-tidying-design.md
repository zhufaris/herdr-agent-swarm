# Active Diff Code Tidying Design

## Goal

Improve the readability and maintainability of the current uncommitted
streaming, pagination, and thread-forwarding changes without changing their
behavior or expanding the cleanup into unrelated modules.

## Scope

Production cleanup is limited to files already modified by the active feature
work. The main targets are the render-only Markdown pagination logic, terminal
stream update handling, and Lark thread-forwarding interface. Tests may gain
small local helpers where they remove repeated setup or make expectations
clearer. Existing user changes, including deleted and modified design documents,
remain intact.

The cleanup will not split large pre-existing modules such as
`sync-coordinator.ts` or `sqlite-store.ts`, introduce a new test framework, or
change public behavior beyond the active feature work. No unrelated file will be
staged or committed.

## Production Code

The answer-stream renderer will retain one explicit contract: canonical answer
text is immutable, while each CardKit page is a derived render-safe view. Fence
state detection and page-boundary calculation should use descriptive names and
small helpers where that reduces branching. Pagination must continue to avoid
dropping or duplicating canonical source characters.

The Lark thread-forwarding port will use a named target type rather than an
anonymous object shape. The target contains the action message ID and fallback
chat ID. Forwarding continues to prefer the invoking thread, avoid forwarding a
topic into itself, and fall back to the chat when the invoking message has no
thread. Coordinator error handling continues to log a safe structured error,
reply with the existing retry guidance, and record a failed audit result.

Terminal observation handling continues to propagate the parser's update mode.
A terminal redraw replaces the visible snapshot, while a true incremental delta
appends. The cleanup must not restore removed bridge-owned progress protocols.

## Tests

Tests will continue to assert externally meaningful behavior: exact rendered
Markdown pages, unchanged canonical answer storage, terminal append versus
replace semantics, thread forwarding targets, self-forward prevention, and
failure notices. Repeated fixture construction may be extracted only when the
helper remains local and makes the scenario easier to read.

## Verification

Before completion, run focused tests for the touched runtime, adapter, and
integration paths, followed by the full test suite, typecheck, build, and
`git diff --check`. Any cleanup that changes an existing assertion requires
evidence that the assertion was implementation-specific rather than part of the
approved behavior.
