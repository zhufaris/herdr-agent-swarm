# Inbound Routing Consumer Ports Design

## Goal

Remove the transitional SQLite aggregate that combines inbound route lookup and
Prompt acceptance, and make `InboundMessageRoutingWorkflow` consume those two
capabilities explicitly.

## Problem

`SqliteIngressCapabilityStore` inherits the Prompt acceptance capability while
also implementing inbound routing. It exists only because
`InboundMessageRoutingWorkflow` defines an intersection interface combining the
two unrelated protocols. The result is a broad `inboundMessages` bundle field,
an inheritance-based adapter, and a production path that obscures which calls
route a message versus atomically admit a Prompt. The source labels the class as
transitional, so leaving it would keep a known architecture migration incomplete.

## Selected design

Change `InboundMessageRoutingWorkflow` to receive:

- `routing: Pick<InboundRoutingStore, "findBindingByLarkScope" |
  "isBindingThreadAlias">`;
- `promptAcceptance: PromptAcceptanceStore`.

Route selection uses only `routing`. Queue counts, atomic Prompt admission,
post-commit receipts, and admission audit use only `promptAcceptance`. Delete
`InboundMessageRoutingStore`, `SqliteIngressCapabilityStore`, and the
`inboundMessages` bundle field. Production composition injects the already
existing `inboundRouting` and `promptAcceptance` capabilities directly.

## Alternatives

### Keep the intersection type but remove inheritance

A delegating aggregate would avoid inheritance but retain the unnecessary broad
production seam. The caller still would not express which protocol owns each
operation.

### Move routing into Prompt acceptance

Routing resolves a conversation scope before a Prompt exists and is also used by
commands and card actions. It is not part of the atomic Prompt admission
transaction. Combining them would reduce module depth and reuse.

## Invariants

- Route lookup occurs before command/prompt selection exactly as today.
- Prompt acceptance remains one atomic Prompt/Run Card/outbox transition.
- Post-commit effects and audit behavior remain unchanged.
- Alias routing and rejection policy remain unchanged.
- Production exposes no `inboundMessages` aggregate and constructs no ingress
  capability through inheritance.

## Testing

Add an architecture test that rejects `InboundMessageRoutingStore`,
`SqliteIngressCapabilityStore`, and `inboundMessages`, and requires workflow
construction with routing and prompt-acceptance capabilities. Run focused inbound
routing/dispatcher and architecture tests, typecheck, build, the full suite, and
`git diff --check`.

## Non-goals

- No routing policy, command parsing, authorization, Prompt persistence, schema,
  card, or production lifecycle changes.
