# Runtime Work Lifecycle Hardening

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Four process-local lifecycle gaps can turn an orderly stop or a retryable
background failure into a new external effect or an unhandled rejection:

1. Lark SDK callbacks are not admitted or tracked. A callback delivered after
   `LarkSdkAdapter.stop()` begins can still enter durable ingress, and stop does
   not wait for callbacks already admitted before clearing adapter state.
2. `TurnControlDispatcher` and `OrchestratorClearWorkflow` await asynchronous
   revalidation, then claim durable work and start a Herdr effect without
   checking whether stop won during that await.
3. the Ring delivery work subscription launches exact-scope refill with a bare
   `void`; a refill rejection therefore has no rejection owner;
4. the periodic Command Intent scan also launches with a bare `void`, so a
   store or lane failure can surface as an unhandled rejection instead of the
   existing durable retry path.

The modules already have correct durable authorities and retry semantics. The
missing concept is a small, dependency-free process-lifecycle primitive for
admission/drain and detached rejection ownership.

## Solution

Introduce `src/runtime/work-lifecycle.ts` with two narrow primitives:

```ts
class WorkAdmissionGate {
  get isOpen(): boolean;
  close(): void;
  admit<T>(start: () => Promise<T> | T): Promise<T> | null;
  settle(): Promise<void>;
}

function observeDetached(
  task: Promise<unknown>,
  onRejected: (error: unknown) => void
): void;
```

`WorkAdmissionGate` owns only process-local admission and Promise draining. An
open gate starts and tracks work; a closed gate returns `null` without invoking
the callback. `close()` is idempotent and prevents new admission. `settle()`
waits until all work admitted before close has settled. Synchronous callback
throws are represented as rejected Promises and remain visible to the caller.

`observeDetached` attaches exactly one rejection observer to work whose caller
cannot await it. The supplied module callback keeps ownership of logging or
intentional absorption; a throwing observer must not create a second unhandled
rejection.

Apply the primitives only at the four confirmed boundaries:

- Lark message and card-action SDK callbacks pass through one adapter-owned
  gate. Stop order is `close admission -> close SDK -> settle admitted work ->
  clear cache/state`.
- Turn Control and Orchestrator Clear check their existing stop flag immediately
  after asynchronous revalidation and before rejection, durable claim, or any
  Herdr effect.
- Ring exact-scope work-subscription refill is detached through
  `observeDetached`; its rejection is intentionally absorbed because durable
  prepared work and later safety/refill wakes remain the recovery authority.
- Command Intent periodic scans are detached through `observeDetached` and log
  a bounded periodic-scan failure while leaving accepted intents retryable.

No durable schema, idempotency key, retry policy, CardKit behavior, or Herdr
receipt semantics change.

## User Stories

### SCN-1: Lark stop closes ingress and drains admitted callbacks

When stop begins, a later SDK message or card callback cannot invoke application
ingress. A callback admitted before stop is allowed to finish, and stop does not
resolve or clear the card cache until it settles.

### SCN-2: Stop wins while Turn Control revalidation is pending

If stop begins while exact-turn revalidation awaits Herdr, resolving that check
does not claim the accepted operation, reject it, or call `interruptAgent`. The
operation remains `accepted` for the next process to recover.

### SCN-3: Stop wins while Orchestrator Clear revalidation is pending

If stop begins during accepted clear revalidation, the workflow does not claim
the operation or call session rotation. The operation remains `accepted`; it is
not falsely terminalized as rejected or uncertain.

### SCN-4: Detached maintenance rejection stays owned

An exact-scope Ring refill rejection and a periodic Command Intent scan
rejection do not produce `unhandledRejection`. Ring leaves durable refill work
discoverable. Command Intent logs one bounded failure and a later scan can
retry the still-accepted intent.

## Implementation Decisions

### INV-1: Lifecycle helpers have no workflow authority

`work-lifecycle.ts` may depend on `ActiveWorkTracker` or language/runtime
primitives only. It must not import adapters, coordinators, events, domain
types, SQLite, SDKs, or loggers.

### INV-2: Admission is process-local and monotonic

A gate starts open, closes once, never reopens, and never queues rejected
admissions. Durable replay remains the owning workflow's responsibility.

### INV-3: Stop before claim preserves durable truth

The post-await stop fences run before both negative revalidation handling and
claim. Stop therefore leaves the durable operation exactly `accepted`. Once a
claim and external effect have begun, existing receipt and `uncertain`
convergence remain authoritative.

### INV-4: Detached observation does not invent workflow outcomes

The helper only owns Promise rejection. Ring does not mutate delivery state for
a refill callback failure; Command Intent does not terminalize accepted work.
Each module retains its existing durable retry source.

### ARCH-1: Preserve dependency direction

Runtime lifecycle code remains below adapter/coordinator/event modules. Lark
transport behavior stays in the adapter; control decisions stay in their
coordinators; Ring and Command Intent keep their existing owners.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-2, INV-3, INV-4, ARCH-1

- Prove gate close is idempotent, closed admission does not start work,
  `settle()` drains already admitted work, and sync throws become rejected
  Promises.
- Prove `observeDetached` reports a rejection once and also absorbs an observer
  callback throw without a process-level unhandled rejection.
- Defer Lark message/card application callbacks, begin stop, and prove stop
  waits; then invoke captured SDK callbacks after close and prove ingress is not
  called.
- Defer Turn Control and Orchestrator Clear revalidation, begin stop, resolve
  revalidation, and prove accepted state, zero durable claims/effects, and clean
  drain.
- Force exact-scope refill and periodic scan failures, observe no
  `unhandledRejection`, verify the Command Intent failure log, and prove a later
  scan can retry.
- Run focused affected tests, typecheck, build, architecture check, diff check,
  and the fixed low-concurrency full Vitest command.

## Out of Scope

No Herdr socket `startEvents()` connection coalescing, legacy Session recovery
claim fence, in-lane Command Intent stop fence, broad detached-task mechanical
migration, Final Trace Envelope restructuring, choice-protocol version repair,
database migration, new durable state, deployment, installation, restart, push,
or PR.

## Workspace and Fresh Baseline

The isolated worktree is
`<repo-root>/.worktree/runtime-work-lifecycle-hardening`
on branch `spec-coder-runtime-work-lifecycle-hardening`, pinned to
`7bbb4ed2367514dee4f29f38dbca93a8c0a166fb`. The original `main` checkout and
all user-owned dirty/untracked files remain untouched.

Fresh evidence for request `runtime-work-lifecycle-hardening`:

```json
{"record_id":"4dc706c426e043c897eea9b0d4069f20","command":"focused affected Vitest","exit_code":0,"status":"captured","result":"6 files and 105 tests passed"}
{"record_id":"4f4e13313fed48e6862e2a87b404bee6","command":"npm run typecheck","exit_code":0,"status":"captured"}
{"record_id":"c2a07c20b2e54f249816747f4c12d45b","command":"npm run build","exit_code":0,"status":"captured","build_id":"sha256:b9c3fb112253073fd99c158238350737f2b1b3d2769b1873a408f8a110c0e01b"}
{"record_id":"206d9956291843f0ac326ad6916e8274","command":"npm run architecture:check","exit_code":0,"status":"captured","result":"546 source files checked"}
{"record_id":"03ca7e2e1d774e8884faf39a2794195a","command":"low-concurrency full Vitest","exit_code":0,"status":"captured","result":"307 files and 5027 tests passed"}
```

## Further Notes

The first candidate worktree path under `.trae/worktrees/` was Git-ignored but
Host-read-only, so the clean exact-base worktree was moved before dependency
installation to the existing Git-ignored and writable `.worktree/` container.
No source or artifact mutation occurred before the move. The failed preliminary
evidence record caused by incomplete dependency metadata is intentionally not a
baseline record; every record listed above has `status: captured`, exit code 0,
and no evidence reasons.
