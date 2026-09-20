# Status Diagnostics Isolation Implementation Plan

## Objective

Implement the approved status-diagnostics isolation design. The public seams are
the `/health`, `/ready`, and `/status` HTTP endpoints. A diagnostics provider
failure must remain observable without making those endpoints fail or changing
durable workflow state.

## Slice 1: Isolate optional status providers

- Add one HTTP-level test in `tests/health-server.test.ts` that makes lifecycle
  events, workspace cache, and Herdr socket diagnostics throw in the same
  request.
- Prove the current endpoint fails before implementation.
- Add a health-local typed collector that converts a provider exception into a
  bounded `{ error }` result.
- Route every optional status provider through the collector, including existing
  providers already protected by repeated local `try`/`catch` blocks.
- Derive aggregate degradation from all collected error results.
- Verify one failed provider cannot suppress successful sibling snapshots.

Gate: `npx vitest run tests/health-server.test.ts`.

## Slice 2: Fail closed when lease diagnostics are unavailable

- Add an HTTP-level test for a throwing lease snapshot.
- Prove `/ready` currently fails before implementation.
- Collect lease state once per request.
- Convert a failed lease read into a conservative not-held readiness component
  with bounded error text and null identity/fencing timestamps.
- Reuse the readiness lease component in `/status` instead of reading the lease
  a second time.
- Apply the same fail-closed collection to Lark and initial instance-runtime
  diagnostics, reusing instance-runtime state in `/status`.
- Verify `/ready` returns 503, `/status` returns HTTP 200 with aggregate
  `degraded`, and each request invokes the lease provider once.

Gate: `npx vitest run tests/health-server.test.ts`.

## Slice 3: Documentation and full verification

- Add the diagnostic isolation rule to `docs/architecture.md` without creating a
  second architecture authority.
- Run `npm run typecheck`, `npm run architecture:check`, `npm run docs:audit`,
  `npm run build`, `npm test`, and `git diff --check`.
- Inspect the final diff to confirm that no workflow, persistence, outbox, FIFO,
  no-replay, or reconciliation behavior changed.
- Keep the existing architecture-document edits separate from the implementation
  commit unless the final documentation commit intentionally includes them.

## Completion audit

- `/health` remains independent of diagnostics providers.
- `/ready` fails closed, rather than throwing, when lease diagnostics cannot be
  read.
- `/status` always returns a structured response for covered synchronous
  diagnostics failures.
- All optional providers use the same collection rule.
- Multiple failures remain independently visible.
- Error text is bounded to 500 characters and contains no stack or payload.
- Successful response shapes remain compatible.
- Focused and full verification pass.

Do not install, deploy, restart, push, tag, create a release, or publish a
package as part of this plan.
