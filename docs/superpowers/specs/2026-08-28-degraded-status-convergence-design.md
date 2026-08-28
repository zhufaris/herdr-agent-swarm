# Degraded Status Convergence Design

## Goal

Make `/status` return `ok` when the bridge has no actionable operational fault, while preserving dead-letter history and never replaying a TraeX prompt.

## Current failure

Two exhausted transient immutable deliveries remain actively quarantined forever. One is a continuation Answer Card creation backed by a durable `creating` answer page; the other is an obsolete standalone `disconnected-topic:` notice. Active quarantines correctly degrade status, but startup recovery has no path to adjudicate these two safe cases. Two project selections whose provisioned panes are confirmed missing also remain indefinitely `processing`.

## Design

Add an atomic SQLite startup-convergence operation for stale quarantines. It may only:

- preserve an exhausted transient `stream_card_create` and derive one deterministic lightweight replacement when its prompt and `creating` answer page still exist; the replacement contains only a recovery placeholder and carries a spent automatic-recovery budget, so canonical content streams after CardKit creation and the recovery remains bounded;
- dismiss an exhausted transient standalone `card_reply` whose idempotency key starts with `disconnected-topic:`, because the notice is advisory and has no workflow identity;
- release the matching quarantine and rebuild the affected lane head without deleting the failed-delivery history.

The startup view converger invokes this operation before projecting durable views and wakes the outbox when work was reopened. If the recovered Answer Card fails again, the lane becomes actively quarantined again and `/status` remains degraded for operator action. No TraeX prompt is enqueued or replayed.

A recovered lightweight Answer Card establishes only the page's CardKit identity; it does not confirm that the page's canonical content is visible. While the latest `stream_content` intent for the current page is pending or dead-lettered, Answer-page convergence must keep that page active and must not freeze it, reserve a continuation, or create the next page. Failed outbox and quarantine rows remain as history. Startup recovery may rebuild only a page whose card creation was not confirmed; it must not cross an unconfirmed content boundary merely because the lightweight replacement card was delivered.

When project-selection recovery confirms that a persisted `pane_created` pane no longer exists, it marks both the selection and binding failed. Uncertain failures remain processing and recoverable.

## Verification

- Store tests cover bounded Answer retry, advisory-message dismissal, audit preservation, and unrelated quarantine retention.
- Provisioning recovery tests cover confirmed missing pane terminalization.
- Startup convergence tests cover wake-up of recovered outbox work.
- Full typecheck, test, build, deployment, and live `/status` verification are required.
