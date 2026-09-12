# Conversation Gateway Plugin Architecture Design

## Status

Approved direction: use a built-in registry and one configured Gateway instance.
Feishu is the first plugin. This milestone does not dynamically load npm packages
and does not implement Telegram or Discord. It makes those adapters possible
without changing core workflow code.

## Objective

Move Feishu-specific ingress, delivery, rendering, capability negotiation, and
error semantics behind one deep Conversation Gateway plugin seam while preserving
the current production behavior and durability guarantees.

Completion requires all of the following:

- core workflows depend only on provider-neutral inbound and outbound contracts;
- the composition root selects Feishu through a statically compiled registry;
- Feishu owns its SDK, CardKit materialization, provider error codes, and external
  readiness details;
- SQLite still owns durable acceptance, lane ordering, claims, checkpoints, retry,
  quarantine, dead letters, and the instance lease;
- gateway code cannot submit, replay, interrupt, or approve Herdr/TraeX work;
- current configuration and persisted SQLite data remain usable without operator
  migration;
- a second in-memory conformance adapter proves that a new provider can implement
  the public plugin interface without modifying a coordinator or domain workflow.

## Current problem

The existing `LarkPort` is a broad transport interface. It combines WebSocket
ingress lifecycle, readiness, topic creation, text/card replies, CardKit streaming,
message replacement, and thread sharing. Optional methods make feature detection
an executor concern. Provider names also appear in normalized inbound DTOs, event
origins, actor provenance, delivery operation types, health fields, configuration,
and SQLite column names.

Renaming `LarkPort` to `GatewayPort` would preserve this coupling under a generic
name. Splitting every optional SDK operation into a public capability facet would
instead expose provider differences to every workflow. Neither creates a deep
module.

## Considered interfaces

### Single three-method facade

`start`, `stop`, and `deliver` create a small interface and a straightforward
migration path. However, a large delivery tagged union hides capability selection,
multi-effect checkpoints, and deterministic degradation inside runtime branches.
This shape is useful as the plugin's outer facade but is insufficient as the full
protocol.

### Optional capability facets

Separate optional interfaces for threads, cards, actions, streaming, updates, and
sharing express provider differences precisely. They also recreate the current
optional-method problem: callers must understand combinations and choose fallback
behavior during delivery. This is rejected.

### Negotiated session with ingress and delivery ports

The selected design gives the core two stable operational ports. Startup performs
one explicit capability negotiation and freezes a profile. The plugin prepares a
provider delivery plan before the first external effect, and then executes only a
durably claimed plan. This keeps provider differences local while making recovery
behavior explicit.

## Public plugin interface

The name `ConversationGatewayPlugin` avoids collision with the existing
`SwarmCommandGateway` and `PrimaryToolGateway`.

```ts
export type GatewayKind = "feishu" | "telegram" | "discord";
export type GatewayId = string;

export interface GatewayPluginManifest {
  kind: GatewayKind;
  pluginVersion: string;
  protocolVersion: 1;
}

export interface ConversationGatewayPlugin<Config = unknown> {
  readonly manifest: GatewayPluginManifest;
  create(config: Config, services: GatewayServices): Promise<GatewaySession>;
}

export interface GatewaySession {
  readonly gatewayId: GatewayId;
  readonly profile: NegotiatedGatewayProfile;
  readonly ingress: GatewayIngressPort;
  readonly delivery: GatewayDeliveryPort;
  snapshot(): GatewayStatus;
  close(): Promise<void>;
}

export interface GatewayIngressPort {
  start(sink: GatewayIngressSink): Promise<void>;
  stop(): Promise<void>;
}

export interface GatewayDeliveryPort {
  prepare(intent: GatewayDeliveryIntent): PreparedGatewayDelivery;
  execute(
    plan: PreparedGatewayDelivery,
    context: GatewayDeliveryContext
  ): Promise<GatewayDeliveryReceipt>;
}
```

The registry is explicit and compiled with the application:

```ts
const BUILTIN_GATEWAYS = {
  feishu: createFeishuGatewayPlugin
} satisfies Readonly<Partial<Record<GatewayKind, GatewayPluginFactory>>>;
```

Configuration selects one entry. The registry does not scan directories, evaluate
paths from configuration, use dynamic `import()`, or load third-party npm code.
Adding Telegram or Discord initially requires a source change, build, and restart.

## Capability negotiation

Capabilities describe semantics, not SDK method availability:

```ts
export interface GatewayCapabilities {
  conversations: {
    threads: "native" | "synthetic" | "none";
    share: boolean;
  };
  presentation: {
    richViews: boolean;
    mutableSurfaces: boolean;
    actions: "forms" | "buttons" | "commands-only";
    incremental:
      | { mode: "sequenced-region"; maxChars: number }
      | { mode: "replace-whole"; maxChars: number }
      | { mode: "none"; maxChars: number };
  };
  idempotency: {
    create: "provider-key" | "bridge-reconcile" | "none";
    reply: "provider-key" | "bridge-reconcile" | "none";
    update: "provider-key" | "bridge-reconcile" | "none";
  };
}

export interface NegotiatedGatewayProfile {
  id: string;
  protocolVersion: 1;
  rendererRevision: number;
  capabilities: GatewayCapabilities;
  degradations: readonly string[];
}
```

The selected profile is immutable for one process session. Every new durable
delivery records `gatewayId`, profile ID, renderer revision, and a prepared-plan
hash before its first claim. A retry never renegotiates or silently chooses a new
fallback. Unsupported required capabilities fail startup; optional capabilities
produce explicit, observable degradations.

## Provider-neutral identity and ingress

External identifiers are opaque and namespaced. The core does not interpret
Feishu Open IDs, Telegram chat IDs, or Discord snowflakes.

```ts
export interface ExternalRef {
  gatewayId: GatewayId;
  kind: "actor" | "conversation" | "thread" | "message" | "surface";
  opaqueId: string;
}

export interface ConversationAddress {
  gatewayId: GatewayId;
  conversation: ExternalRef;
  thread: ExternalRef | null;
  rootMessage: ExternalRef | null;
}

export type GatewayInboundEvent =
  | {
      schemaVersion: 1;
      kind: "message.received";
      eventKey: string;
      occurredAt: string;
      address: ConversationAddress;
      message: ExternalRef;
      parentMessage: ExternalRef | null;
      actor: ExternalRef;
      text: string;
      mentionsAgent: boolean;
      isRoot: boolean;
      hasUnsupportedContent: boolean;
    }
  | {
      schemaVersion: 1;
      kind: "interaction.invoked";
      eventKey: string;
      occurredAt: string;
      address: ConversationAddress;
      sourceMessage: ExternalRef;
      actor: ExternalRef;
      interactionRef: string;
      values: Readonly<Record<string, string>>;
    };
```

The adapter validates provider signatures, configured conversation routes, bot or
self messages, actor shape, payload size, and supported content before calling the
sink. The core independently validates the configured gateway/conversation route
and actor authorization before durable acceptance. IDs use `(gatewayId, opaqueId)`
for uniqueness. Cross-provider actor identities are never merged automatically.

The ingress sink returns accepted only after the inbound event, or the command
intent derived atomically from an interaction, is durable. Duplicate events return
the original durable outcome. An adapter timeout cannot create a second prompt.

Interactions carry only an opaque, database-backed `interactionRef`. The record
freezes binding or Worker ownership, generation, pane, native session, logical
turn, runtime turn, and start time where applicable. The core reloads those facts
and performs fresh Herdr observation before a stop or steer. The plugin cannot
construct or weaken the exact-turn fence.

## Portable presentation and durable delivery

Core presentation emits a deliberately small semantic view instead of CardKit
JSON. It is not a universal UI toolkit. Version 1 contains only the structures
used by this repository: heading, markdown, status, divider, buttons, select,
form fields, and toast. Every view includes required `fallbackText` for providers
without rich presentation. Provider-specific escape hatches are forbidden in the
portable schema.

```ts
export interface GatewayView {
  fallbackText: string;
  blocks: readonly GatewayBlock[];
  actions: readonly GatewayAction[];
}

export type GatewayDeliveryIntent =
  | { kind: "conversation.create"; target: ExternalRef; view: GatewayView }
  | { kind: "message.reply"; target: ConversationAddress; view: GatewayView }
  | { kind: "surface.replace"; target: ExternalRef; viewVersion: number; view: GatewayView }
  | { kind: "stream.append"; target: ExternalRef; slot: string; sequence: number; content: string }
  | { kind: "stream.finish"; target: ExternalRef; sequence: number; summary: string }
  | { kind: "conversation.share"; source: ExternalRef; target: ExternalRef };
```

`prepare()` deterministically converts an intent and frozen profile into a
versioned provider plan. The plan, not a mutable current renderer, is persisted
and hashed before claim. Existing rows containing materialized CardKit payloads
remain deliverable by the Feishu compatibility decoder. New providers never
reinterpret those rows.

`execute()` receives only a claimed plan and delivery context. It cannot access the
outbox queue, prompt workflow, Herdr, or TraeX. Feishu's two-step streaming create
is contained here: create CardKit card, persist the external surface checkpoint by
claim CAS, then reply with its reference. If checkpointing or the subsequent call
has an uncertain result, execution stops and the core quarantines the lane.

```ts
export interface GatewayDeliveryContext {
  attemptId: string;
  leaseFencingToken: number;
  idempotencyKey: string;
  priorCheckpoints: readonly GatewayCheckpoint[];
  checkpoint(value: GatewayCheckpoint): Promise<void>;
  signal: AbortSignal;
}

export type GatewayDeliveryReceipt =
  | { outcome: "delivered"; refs: readonly ExternalRef[] }
  | { outcome: "rejected"; retry: "never" | "later"; providerCode: string; retryAfterMs?: number }
  | { outcome: "not-started"; retry: "later"; providerCode: string }
  | { outcome: "uncertain"; providerCode: string };
```

## Ownership and invariants

SQLite remains the only authority for workflow and delivery state. The plugin does
not own a queue. The existing transaction must still commit aggregate changes,
projection changes, and delivery intent before any provider call.

The store derives lane keys from gateway ID, logical projection identity, and
generation. Neither workflows nor plugins may choose arbitrary lane keys. One
lane head may be in flight at a time; independent lanes retain bounded concurrency
and `live/history` fairness. Provider sequence numbers are an additional lane-local
constraint, not a replacement for lane ordering.

The Gateway has no dependency on any prompt submission, Herdr, TraeX, approval, or
process-kill interface. Retrying a delivery can never repeat an Agent prompt. High-
risk approval stays local to Herdr. Remote stop remains exact-turn fenced.

Provider failures normalize to `transient`, `permanent`, or `unknown` plus effect
certainty `not-started`, `rejected`, or `uncertain`, provider code, and optional
retry-after. Only proven safe failures may retry automatically. Uncertain effects
remain quarantined. Feishu codes such as `230031` and CardKit-specific recovery
rules live inside the Feishu plugin's error adapter; core policy consumes the
normalized failure and a provider-neutral recovery reason.

Gateway readiness is separate from historical delivery health. `/ready` requires
the configured Gateway ingress and outbound credentials/session to be usable. A
dead letter degrades `/status` but does not make the process unready. Diagnostics
include gateway ID, kind, profile ID, capability degradations, ingress state, and
delivery state.

## Configuration and registry

The target configuration is a discriminated union selected by `GATEWAY_KIND` and
`GATEWAY_ID`. Feishu retains the existing `LARK_*` environment names as accepted
compatibility inputs in this milestone. Setup writes the old variables unless an
operator explicitly migrates; no secret is copied into logs or SQLite.

Only one Gateway instance is active in the first milestone. Although new in-memory
types carry `gatewayId`, simultaneous multi-Gateway routing is out of scope because
it requires explicit binding ownership, authorization, namespace, and operator
semantics.

## Compatibility and migration strategy

This change is a strangler migration, not a flag-day rewrite.

1. Add provider-neutral Gateway contracts, Feishu plugin, static registry, and an
   in-memory conformance adapter. Keep compatibility type aliases and the current
   configuration shape.
2. Route lifecycle, readiness, message normalization, and interaction responses
   through the Gateway session. Keep existing durable inbound rows readable.
3. Introduce versioned provider-neutral delivery intents and prepared plans. Keep
   the legacy CardKit materializer for every existing row. Migrate one delivery
   family at a time: Main, ordinary Answer, Worker, then streaming/recovery.
4. Move Feishu error extraction, CardKit IDs, markdown normalization, and renderers
   under `src/gateways/feishu/`. Core sees only normalized failures and semantic
   views.
5. Add namespaced gateway identity columns only when the first migration needs to
   persist them. Backfill existing rows as `feishu:primary`. Preserve old physical
   column names through repository mapping until a later database-convergence
   migration has a real second provider to validate against.
6. Remove `LarkPort` and compatibility aliases only after production code and
   tests no longer import them.

Every step leaves the current service buildable and deployable. Migrations are
additive before old columns are retired. Rollback binaries can continue reading the
old rows until an explicit compatibility window closes.

## Package layout

```text
src/gateways/
  contract/       provider-neutral events, views, plans, receipts, failures
  registry.ts     static built-in selection and config validation
  feishu/
    plugin.ts     session construction and capability profile
    ingress.ts    SDK events, allowlist, normalization, ACK translation
    delivery.ts   prepared plan execution and partial checkpoints
    presentation.ts  GatewayView -> CardKit
    errors.ts     Feishu error normalization and recovery hints
```

Core directories may import only `gateways/contract`; only composition imports the
registry; only `gateways/feishu` imports `@larksuiteoapi/node-sdk`, CardKit helpers,
or Feishu error codes. The architecture checker enforces these rules.

## Testing strategy

Tests use the same public plugin interface as production callers. Required gates:

- contract tests shared by Feishu and the in-memory adapter for lifecycle, ingress
  normalization, delivery receipts, failure certainty, checkpoint behavior, and
  idempotency;
- ingress integration tests proving accepted-before-ACK durability, namespaced
  duplicate suppression, configured-route allowlist, and durable interactions;
- outbox integration tests proving per-Gateway lane ordering, cross-lane bounded
  concurrency, live/history fairness, crash recovery after a partial provider
  checkpoint, and no prompt replay;
- presentation snapshots for Feishu CardKit plus fallback rendering for a provider
  without rich cards, actions, or ordered streaming;
- exact-turn tests proving opaque interaction references cannot cross binding,
  generation, pane, native session, logical turn, runtime turn, or start-time
  fences;
- config/setup tests for the static registry, unknown kinds, missing capabilities,
  legacy `LARK_*` input, and secret redaction;
- architecture tests forbidding provider SDK/CardKit imports outside
  `src/gateways/feishu` and forbidding Gateway plugins from importing Herdr, TraeX,
  prompt, or coordinator modules;
- migration tests against a pre-Gateway database and mixed legacy/new outbox rows;
- full `npm test`, `npm run typecheck`, `npm run build`, architecture check, and
  `git diff --check` before installation.

## Operational rollout

Deploy the slices as thematic commits. Before each restart, inspect running prompts,
queued prompts, active workers, outbox claims, and the lease. After restart, require
matching build identity, listener ownership, completed startup recovery, Gateway
ingress readiness, SQLite integrity, and a real Feishu message/action delivery.
Rollback must use the previous immutable release and must never replay an uncertain
Agent prompt.

## Explicit non-goals

- dynamic plugin discovery, arbitrary npm loading, hot reload, or third-party code;
- simultaneous multi-Gateway operation;
- Telegram or Discord production adapters;
- cross-provider user identity linking;
- identical UI behavior across providers;
- renaming every historical SQLite column in this milestone;
- weakening exact-turn controls or enabling remote approval.

## Completion criteria

The milestone is complete when Feishu is instantiated only through the built-in
registry, core workflows import only provider-neutral Gateway contracts, all new
durable IDs are namespaced, new delivery rows carry a frozen profile and plan, all
legacy rows remain deliverable, architecture checks prevent provider leakage, the
in-memory adapter passes the shared contract suite, existing Feishu behavior is
covered by regression tests, and production deployment verifies a real message,
interaction, Main Card, Answer Card, restart recovery, and no prompt replay.
