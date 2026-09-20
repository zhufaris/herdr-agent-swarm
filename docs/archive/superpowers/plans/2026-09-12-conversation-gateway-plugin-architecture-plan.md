# Conversation Gateway Plugin Architecture Implementation Plan

**Goal:** Make Feishu the first statically registered Conversation Gateway plugin
while preserving current behavior, durable state, and rollback compatibility, and
prove that another Gateway can be added through the same contract without changing
core workflows.

**Architecture:** Use a strangler migration. Introduce provider-neutral Gateway
contracts and a built-in registry first, then move ingress, delivery, presentation,
and failure semantics behind the plugin seam. SQLite retains all workflow and
delivery authority. Legacy Lark payloads, configuration variables, and physical
column names remain readable throughout the migration.

## Test seams

- Gateway contract conformance: lifecycle, readiness, capability profile, ingress,
  delivery receipts, partial checkpoints, and normalized failures.
- Composition: selecting `feishu` through the static registry without direct SDK
  construction outside the plugin.
- Ingress: normalized events are durably accepted before acknowledgment and are
  deduplicated by namespaced identity.
- Outbox: prepared plans remain immutable after claim, lane order remains strict,
  uncertain effects quarantine, and delivery never reaches Herdr or TraeX.
- Compatibility: pre-Gateway databases and legacy CardKit intents remain usable.
- Architecture checker: provider SDK/CardKit imports stay inside the Feishu plugin;
  provider plugins cannot import coordinator, Herdr, TraeX, or prompt modules.

## Slice 1: Contract, registry, and Feishu session

- Add `src/gateways/contract/` with provider-neutral IDs, capabilities, status,
  ingress events, delivery plans, receipts, and failure types.
- Add a typed static `BuiltinGatewayRegistry`; reject duplicate IDs, unknown kinds,
  protocol mismatch, and unsupported required capabilities at startup.
- Add `src/gateways/feishu/plugin.ts` that creates one negotiated Gateway session
  around the current Feishu adapter behavior.
- Keep compatibility aliases so existing workflows compile unchanged during this
  slice.
- Add a second in-memory Gateway implementation and a shared conformance suite.

Gate: gateway contract/registry tests, config tests, architecture checks, typecheck,
build, and full suite. Commit independently.

## Slice 2: Ingress lifecycle and provider-neutral events

- Move normalized message/action DTOs from the Lark adapter into Gateway contracts.
- Rename core-facing fields to actor/conversation/thread/message terminology while
  preserving compatibility accessors at the SQLite adapter seam.
- Route startup, stop, readiness, message callbacks, and interaction responses
  through `GatewaySession.ingress`.
- Persist `gateway_id` and namespaced event/message identity additively; backfill
  existing rows as `feishu:primary`.
- Make card interactions durable before synchronous provider acknowledgment.
- Replace hard-coded `origin: "lark"` and actor channel values with Gateway identity.

Gate: ingress integration, duplicate replay, allowlist, action durability, readiness,
legacy DB migration, typecheck, build, and full suite. Commit independently.

## Slice 3: Provider-neutral durable delivery plans

- Replace the core-facing `OutboundIntentPort` payload contract with versioned
  Gateway delivery intents and prepared plans.
- Add additive outbox fields for `gateway_id`, `profile_id`, prepared plan, plan hash,
  and provider checkpoint. Backfill legacy rows to the Feishu compatibility plan.
- Derive lane keys from Gateway ID plus logical target/generation; callers and
  plugins cannot choose arbitrary lanes.
- Make the dispatcher call only `GatewayDeliveryPort.execute()` with a claim-fenced
  checkpoint callback.
- Preserve legacy payload execution and all existing retry/quarantine/dead-letter
  semantics.

Gate: mixed legacy/new intent tests, crash-after-checkpoint recovery, lane ordering,
live/history fairness, uncertain effect tests, typecheck, build, and full suite.
Commit independently.

## Slice 4: Portable presentation and Feishu ownership

- Define a bounded `GatewayView` AST with required fallback text.
- Move CardKit rendering and element-ID normalization under
  `src/gateways/feishu/`; keep temporary re-exports for source compatibility.
- Make Feishu own provider plan materialization, message/card operations, CardKit
  streaming, and interaction response translation.
- Move Feishu error-code extraction and recovery hints into the plugin. Core consumes
  normalized failure certainty and recovery reasons only.
- Add deterministic degradation tests for an in-memory capability profile without
  rich cards, forms, or sequenced streaming.

Gate: presentation snapshots, materialization tests, normalized error tests, all
existing card tests, typecheck, build, and full suite. Commit independently.

## Slice 5: Remove core provider leakage

- Rename production `LarkOutboxDispatcher`, `LarkDeliveryOperation`, and health
  diagnostics to provider-neutral names with short-lived compatibility exports only
  where tests or migrations require them.
- Remove `LarkPort` from production coordinator and event imports.
- Keep old SQLite physical names behind repository mapping; do not rename historical
  columns in this milestone.
- Extend `architecture:check` so only `src/gateways/feishu/` can import the Lark SDK,
  CardKit helpers, or provider error constants, and Gateway plugins cannot import
  coordinator/Herdr/TraeX/prompt execution modules.
- Update architecture, setup, operations, and user documentation terminology.

Gate: zero forbidden provider references in core, architecture tests, docs audit,
typecheck, build, and full suite. Commit independently.

## Slice 6: Installation and production verification

- Inspect active prompts, workers, outbox claims, and lease before deployment.
- Build and install an immutable release using supported lifecycle tooling.
- Restart only through the active-work safety gate unless the user explicitly
  authorizes force.
- Verify build identity, PID/listener ownership, completed startup recovery, Gateway
  ingress readiness, SQLite integrity, and outbox progress.
- Verify one real Feishu message, one interaction, Main Card, Answer Card, restart
  recovery, and no duplicate prompt submission.

## Completion audit

Before marking the goal complete, map every design completion criterion to direct
evidence: source paths, migration rows, architecture-check assertions, focused test
names, full-suite output, installed release identity, and live Feishu observations.
Any criterion without evidence remains incomplete. Do not push.
