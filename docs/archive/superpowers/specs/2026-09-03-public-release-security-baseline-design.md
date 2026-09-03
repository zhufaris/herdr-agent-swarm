# Public Release Security Baseline

## Purpose

Prepare Herdr Agent Swarm for public source release without making a configured
Lark group an implicit host-level authorization boundary. The public runtime
must deny access until an operator explicitly grants it, and public artifacts
must not redistribute the privately supplied Herdr binary.

## Scope

This change covers Lark identity authorization, first-run configuration, public
release boundaries, and community/security governance. It preserves the
existing durable prompt, outbox, reconciliation, and local TraeX approval
model.

## Authorization model

Two non-empty comma-separated Open ID sets are required:

- `LARK_ALLOWED_OPEN_IDS` controls who may send ordinary prompts, use session
  commands, and invoke cards in the configured chat.
- `LARK_ADMIN_OPEN_IDS` controls destructive or topology-changing actions:
  Worker creation, start, stop, steering, removal, project-pane attachment,
  and session reset, replacement, close, resume, or rename.

Every administrator must also be an allowed user. Configuration parsing rejects
an empty, malformed, or non-subset administrator list. The application refuses
to start on an invalid configuration. A message or card callback received from
another member of the configured chat is ignored before it becomes durable
workflow work; where an answer can safely be sent, it is a generic permission
denial and never exposes project details.

Existing creator checks continue to fence actions that belong to a particular
thread or form. They are an additional constraint, not a substitute for the
administrator role.

## Setup and documentation

The setup wizard collects both sets, displays only redacted/count-oriented
review information, and refuses to save an unsafe configuration. The sample
environment, README, architecture guide, and command reference state that:

1. no group member is authorized by default;
2. public deployments require a dedicated low-privilege Linux account and an
   isolated workspace/container or VM; and
3. `bypass_permissions` is an exceptional local-only operating mode, never a
   recommended public deployment default.

## Public release boundary

The public npm scripts and README support source installation only. The
private offline bundle builder, its pinned internal Herdr digest, binary
distribution notices, and private-bundle documentation are removed from the
tracked public repository. Release output remains ignored. Operators who have
an independently licensed Herdr installation supply it through the documented
`HERDR_BIN` setting.

## Governance and CI

The repository adds:

- `SECURITY.md` with a private reporting route, supported-version statement,
  scope, and coordinated-disclosure expectations;
- `CONTRIBUTING.md` with local verification and security-report guidance;
- `CODE_OF_CONDUCT.md`; and
- a GitHub Actions workflow that runs `npm ci`, typecheck, tests, build, and a
  production dependency audit.

The workflow also scans tracked content for common credential/private-key
patterns. It is a release guard, not a claim that pattern scanning replaces
secret rotation or a dedicated scanner.

## Error handling and observability

Authorization denials are recorded through existing structured logging with
actor identity, route category, and a generic denial reason. They must not log
prompt text, card form values, capabilities, secrets, or complete card JSON.
Unauthorized events do not create bindings, prompts, worker operations, or
outbox delivery intent.

## Test plan

- Configuration tests cover absent lists, malformed entries, duplicate IDs,
  and administrators outside the allowed set.
- Lark adapter and inbound routing tests prove unauthorized users cannot create
  durable inbound work or prompts.
- Instance and card-action tests prove allowed non-admins cannot perform
  privileged lifecycle operations, while administrators can.
- Setup tests cover unsafe configuration rejection.
- Documentation/release tests prove private distribution artifacts are not
  exposed by public scripts or tracked release paths.
- Run focused tests, `npm run typecheck`, `npm run build`, then the full test
  suite before handoff.

## Non-goals

This change does not sandbox an Agent's tools, alter TraeX permission semantics,
add multi-factor approval, or make the service safe for an untrusted public
chat. The service remains appropriate only for explicitly trusted users on a
least-privilege host.
