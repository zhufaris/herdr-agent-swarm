# Command Control Execution Implementation Plan

## Objective

Extract durable mutation dispatch from `SwarmCommandGateway` while preserving
the unified authorization/admission surface and all no-replay guarantees.

## Step 1: Characterize dispatcher lanes

Add a focused tracer proving same-lane accepted intents are claimed and executed in
order through the new dispatcher interface.

## Step 2: Extract `CommandIntentDispatcher`

Move lane workers, recovery, shutdown, frozen-context revalidation, mutation routing,
effect-certainty classification, and terminal settlement into a coordinator module.
Inject existing workflows and narrow callbacks; do not change policies or stores.

## Step 3: Reduce the gateway facade

Delegate accepted intent draining, recovery, and stop. Keep all ingress construction,
context resolution, query handling, rejection cards, and awaited Worker result
adaptation in the gateway.

## Step 4: Enforce and document

Add architecture guards, update the implementation map, and mark command/control
complete with explicit confirmation and authorization evidence.

## Step 5: Verify

Run focused command/control tests, typecheck, build, architecture/docs checks, full
tests, and `git diff --check`. Do not install, restart, or push.
