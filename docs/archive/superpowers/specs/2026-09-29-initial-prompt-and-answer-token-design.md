# Initial TraeX Prompt and Answer Token Design

## Problem

An attached TraeX pane can be idle and ready before TraeX has created its first
native session. The prompt dispatcher currently requires a persisted native
session ID for every native queue submission. Consequently, the first prompt
accepted from Feishu is repeatedly released back to the queue and never reaches
TraeX.

Answer cards have a separate projection problem. A prompt can be accepted before
Herdr's runtime convergence has persisted the pane token. The run-card snapshot
then keeps a null token even after the binding learns the correct token, so the
card continues to show the internal pane ID.

## Design

For an ordinary prompt without an explicit model, the dispatcher may submit to
the native Herdr queue without `expectedSessionId` only when the existing
pre-dispatch checks prove that the same pane and terminal are still attached,
the workspace matches, TraeX is ready, and neither the persisted binding nor the
live pane has a native session. The first accepted prompt creates the native
TraeX session. Once a session exists, all later submissions retain the exact
session fence. Model-aware submissions remain fail-closed because their Core
method requires an existing exact session.

When runtime convergence discovers a new pane token, the binding store will
project that token into actionable run cards for the same binding, bump each
changed card's view version, and reserve updated Answer Card deliveries. This
keeps the durable run-card view authoritative and avoids renderer-time joins.

## Verification

- A dispatcher test proves that a sessionless, identity-matched, idle TraeX pane
  accepts its first ordinary prompt through the native queue.
- Existing tests continue to prove exact-session fencing for established
  sessions and fail-closed model dispatch.
- A convergence/store test proves that a run card created with no token is
  updated to the newly observed token and rendered with that token.
- Relevant tests, type checking, and architecture checks pass. The public audit
  is run and any pre-existing baseline findings are reported separately.
