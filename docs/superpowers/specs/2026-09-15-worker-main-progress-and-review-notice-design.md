# Worker Main Progress and Human-Review Notice Design

## Goal

Make the canonical Worker Main Card distinguish task progress from low-level
tool activity, and make a Worker that needs human attention as visible as a
blocked Primary on the Primary Main Card.

The motivating production example is Worker `reviewer`, owned by Primary
`51g1`. Its current task had no status title or plan steps, but its persisted
progress contained only `tool:*` events. The Worker Main Card rendered those
events inside a panel titled `当前进展`, making tool calls look like task
progress.

## Decisions

### Separate progress from activity

The Worker Main Card will use the same hierarchy as the Primary Main Card:

1. `当前进展` contains the current reasoning status title and plan steps.
2. `最近活动` contains tool activity such as reads, searches, edits, tests,
   commands, and waits.

The renderer classifies existing durable progress events by their stable keys:
`plan:*` belongs to current progress and `tool:*` belongs to recent activity.
Unknown legacy keys are treated as activity so they cannot be mistaken for the
Worker's explicit plan. No persisted data or transcript projection changes are
required.

When a status title exists without plan steps, `当前进展` still appears with the
status title. When only tool activity exists, the card omits `当前进展` and shows
only `最近活动`. Both sections remain bounded by the existing five-item Worker
Main Card limit. The current task request and task lifecycle stay in the
separate `当前任务` section.

### Reuse the Primary blocked-notice pattern

When the current Worker task is `blocked`, the Worker Main Card will prioritize
an expanded orange `需要处理` callout before task progress and output. Its text
uses the task's persisted notice when available and otherwise explains that the
Worker is waiting for local handling in the corresponding Herdr pane.

The Worker Main Card header remains orange through the existing blocked runtime
state mapping. Its CardKit summary uses the actionable label `等待用户处理`,
matching the Primary Main Card's notification semantics instead of the generic
runtime label. This is a canonical card update, not an additional chat message:
the existing durable Worker Main Card outbox, coalescing, retry, and delivery
checkpoint behavior remain authoritative and prevent repeated reminder spam.

When the Worker leaves `blocked`, the callout disappears and the summary returns
to the normal runtime label. No notification state or acknowledgement table is
introduced.

## Presentation and data flow

The data flow remains:

```text
TraeX transcript
  -> WorkerTurnObserver
  -> Worker Turn Card projection
  -> Worker Main Card context
  -> pure Worker Main Card rendering
  -> durable outbox
  -> Feishu CardKit update
```

Only the pure Worker Main Card renderer changes. The Worker Turn Card continues
to show its existing compact progress representation, and Primary cards retain
their current rendering. One-time Worker snapshots and legacy entry cards reuse
the same corrected read-only body.

## Safety and durability

- High-risk approval and local questions remain in Herdr. The card adds no
  approve, deny, terminal-input, process-kill, or pane-kill action.
- Worker, session, binding, pane, and exact-turn identity fences do not change.
- The renderer does not query SQLite, Herdr, or Feishu.
- Existing redaction, content bounds, CardKit update identity, and outbox
  idempotency remain unchanged.
- A card update is only a notification surface. It never becomes workflow
  authority and never changes a Worker task's state.

## Verification

Focused Worker Main Card tests will assert that:

- a plan and status title appear under `当前进展`;
- tool events appear under `最近活动`, not `当前进展`;
- a tool-only task does not render an empty or misleading `当前进展` panel;
- unknown legacy progress keys fall back to `最近活动`;
- a blocked task renders the orange `需要处理` callout before progress/output;
- a blocked Worker summary says `等待用户处理`;
- leaving blocked removes the actionable presentation; and
- snapshots remain read-only while using the same corrected hierarchy.

After focused tests, run `npm run typecheck`, `npm run build`, and the full
`npm test` suite because the shared Worker Main Card is used by canonical cards
and snapshots.

## Non-goals

- Sending an additional text or card reply for every blocked transition.
- Detecting a new semantic `human_review` state from free-form model text.
- Changing Worker Task Card delivery or transcript parsing.
- Enabling remote approval or arbitrary terminal input.
- Installing, restarting, or deploying the service.
