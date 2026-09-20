# Low-Risk Code Optimization Design

## Goal

Identify and implement a small number of measurable, high-value code
optimizations without changing Herdr Agent Swarm's observable behavior or
durability guarantees. The work targets avoidable runtime, SQLite, memory, I/O,
asynchronous, repeated-computation, and build costs.

## Scope

The optimization pass will scan the complete TypeScript service and its build
configuration, then implement at most three findings that meet all of these
conditions:

- the current cost is supported by code-path evidence, a query plan, or a
  deterministic operation-count test;
- the optimization has a focused implementation and bounded regression surface;
- the expected benefit is meaningful on a hot or repeatedly executed path;
- the behavior can be protected by an existing or newly added focused test.

Findings that require architectural redesign, public-contract changes, schema
semantics changes, or speculative caching will be reported but not implemented
in this pass. Existing optimizations described in the archived runtime
performance hardening design will not be repeated unless current code provides
evidence of a remaining gap.

## Preserved invariants

The implementation must preserve:

- one active ordinary turn per owner and FIFO ordering for later work;
- no automatic replay after a prompt may have reached TraeX;
- SQLite intent persistence before external Gateway delivery;
- atomic SQLite workflow transitions and the fenced writer lease;
- ordered CardKit stream sequences and immutable frozen answer pages;
- Herdr as the authority for live pane and Agent state;
- exact binding, generation, pane, session, and turn identity fences;
- existing external configuration, command, health, Gateway, and card contracts.

Serial work that enforces these invariants is not an optimization candidate
merely because it contains sequential `await` expressions.

## Audit approach

The audit will begin with pattern-based searches rather than reading entire
implementations. Findings will then be verified in local context and
deduplicated across these areas:

- SQLite query shapes, indexes, result bounds, and repeated database work;
- memory lifetime, unbounded collections, copies, and serialization;
- algorithmic complexity and repeated scans;
- async concurrency, timers, shutdown settlement, and resource cleanup;
- subprocess, filesystem, transcript, Gateway, and network I/O;
- cache reuse and invalidation;
- dependencies, TypeScript compilation, and test/build configuration;
- logging and error paths that can amplify load.

Each confirmed finding will record its location, trigger, severity, expected
impact, semantic risk, and verification method. False positives and deliberate
serialization will be discarded.

## Selection and implementation

Candidate fixes will be ranked by expected benefit, execution frequency,
confidence, regression risk, and verification cost. At most three fixes will be
selected. Prefer removing redundant work or improving an existing data path over
adding new state. Any cache must be bounded, have explicit invalidation, and
remain optional for correctness.

Each selected change will be implemented as a focused edit with a focused test.
If investigation shows that no candidate meets the evidence and safety bar, the
result will be an audit report with no production-code changes.

## Verification

Tests will assert stable properties such as query plans, call counts, bounded
work, ordering, or result equivalence instead of fragile wall-clock thresholds.
For every implemented optimization, run the nearest focused Vitest tests. Then
run:

1. `npm run typecheck`;
2. `npm run build`;
3. `npm test` when a change touches persistence, workflow coordination, or a
   shared runtime path.

The final handoff will list confirmed findings, rejected false positives, files
changed, verification results, and any higher-risk follow-up opportunities. No
service installation, restart, deployment, remote push, or Git commit is part of
this work.

## Acceptance criteria

- No more than three evidence-backed optimizations are implemented.
- Every implementation has a focused regression or bounded-work test.
- Public behavior and all preserved invariants remain unchanged.
- Required focused tests, typecheck, and build pass.
- The full suite passes for persistence, workflow, or shared-runtime changes.
- The final report distinguishes measured or deterministic evidence from
  estimated impact.
