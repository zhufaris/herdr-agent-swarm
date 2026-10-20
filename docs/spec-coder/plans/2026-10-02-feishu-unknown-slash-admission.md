# Feishu Unknown Slash Admission Plan

Specification:
[`docs/spec-coder/specs/2026-10-02-feishu-unknown-slash-admission.md`](../specs/2026-10-02-feishu-unknown-slash-admission.md)

Workspace: `/tmp/herdr-agent-swarm-feishu-slash-admission`

Branch: `fix/feishu-unknown-slash-admission`

Starting revision: `00bfce11e29f69dfafb42f7d3e094f2d50c37273`

Baseline:

- `npx vitest run tests/inbound-message-routing-workflow.test.ts tests/inbound-message-dispatcher.test.ts tests/concurrency-controls.integration.test.ts` — 66 tests passed.
- `npm run typecheck` — passed.
- `npm run build` — passed; generated build identity SHA-256 `61d645560bd0c93f99670ef979bfbbefe1a8e42556696c7fe48178a3b5172e3d`.
- `npm ci --cache /tmp/npm-cache` reported one pre-existing high-severity audit finding; dependency changes are out of scope.

Approval state:

- Gate 1 design approved by the user.
- Gate 2 written specification approved by the user.
- Gate 3 ticket set and implementation authorization approved by the user.

## Tickets

- [x] T1: Reject unsupported Feishu slash text before Prompt admission

  **What to build**

  Change the existing Feishu inbound route so recognized Worker Session,
  instance, and `/swarm` commands retain precedence, while any remaining text
  whose first non-whitespace character is `/` receives the existing durable
  rejection feedback and a terminal `rejected` routing disposition. Preserve
  the durable inbound record, but do not create Prompt Input, Native Input
  Batch, execution Prompt, Run/Answer projection, or Herdr/TraeX submission.
  Update the user guide and architecture description to state this boundary.

  **Spec references**

  SCN-1 through SCN-4; INV-1 through INV-5; Implementation Decisions / Domain
  Model, Architecture, Behavior & Failure Modes, and Compatibility & Migration.

  **Ownership and implementation path**

  Inbound Routing owns the policy. Apply it in
  `InboundMessageRoutingWorkflow` after existing Worker Session and known
  command classification and before orchestrator, natural-language task, or
  ordinary Prompt routing. Reuse `OutboundIntentPort.enqueueCard`,
  `PrimaryPresentation.requestRejected`, and the existing message-ID-derived
  rejection identity. Do not add a Prompt persistence method, database schema,
  Herdr adapter behavior, or JSONL event. Prompt Execution remains unaware of
  rejected Feishu syntax.

  **Acceptance criteria and verification**

  - A failing routing test first demonstrates that `/plan x` currently calls
    managed Prompt admission; after the change it returns `rejected`, reserves
    one feedback card, and never calls Prompt admission.
  - Leading whitespace before `/` is rejected, while text containing `/tmp` or
    `a/b` after ordinary leading text is still admitted.
  - Existing `/swarm` and instance command tests remain green and prove their
    precedence over the new policy.
  - A failing SQLite-backed integration test first demonstrates that unsupported
    slash text currently creates Prompt state and reaches the Agent; after the
    change it creates none of `prompt_inputs`, `native_input_batches`,
    `prompt_jobs`, or Run Cards, does not call `runPrompt` or `queuePrompt` with
    that text, and allows the next ordinary message to complete.
  - Existing duplicate inbound/outbox identities remain the idempotency owners;
    no new retry path is added.
  - Documentation no longer claims that unknown slash commands pass through to
    TraeX and explains local-Pane usage.
  - Run the affected routing, inbound dispatcher, and concurrency suites,
    `npm run typecheck`, and `npm run build` before the ticket commit.
  - Delivery runs the full `npm test` suite and reviews source dependency
    direction and the complete diff separately.

  **Blocked by**

  None.

## Final Delivery Checks

- Review the complete diff against SCN-1 through SCN-4 and INV-1 through INV-5.
- Confirm no schema migration, Core/TraeX change, synthetic Human Message, or
  historical detached-Prompt mutation was introduced.
- Run `npm test`, `npm run typecheck`, and `npm run build` freshly.
- Inspect the ticket commit and verify it contains only task-owned paths.
- Do not install, restart, deploy, push, or open a pull request without separate
  user authorization.
