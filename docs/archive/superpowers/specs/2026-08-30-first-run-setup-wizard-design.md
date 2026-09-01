# First-Run Setup Wizard Design

## Goal

Give a first-time operator one guided command that explains, collects, and
validates the configuration required to run Herdr Agent Swarm. The workflow
must produce private, valid configuration before it offers to install or start
the service. It must not create a Lark application, modify tenant settings,
send a Lark message, create a Herdr pane, or start an agent during validation.

The new operator entrypoint is:

```bash
npm run swarm:setup
```

The existing `swarm:init` command remains a non-interactive, idempotent template
initializer for automation and experienced operators.

## Product Boundary

The first version configures an application that the operator has already
created, published, and installed in the intended Lark tenant. For each required
value, the wizard explains where to find it and what the bridge uses it for. It
also shows an explicit manual checklist for permissions, event subscriptions,
application publication, and bot membership in the target group.

The wizard does not open a browser or use Lark management APIs to create an
application, grant permissions, configure subscriptions, publish a version, or
add a bot to a group. Runtime API probes must not be presented as proof of
console settings they cannot reliably observe.

## Chosen Approach

Implement one shared TypeScript setup workflow and expose it through the
standalone npm command and the Herdr plugin setup action. Shell scripts remain
stable launchers; they do not duplicate prompting, validation, or installation
decisions.

This is preferred over making `swarm:init` interactive because `init` must stay
safe for scripts and repeated use. It is preferred over an editor-only flow
because an editor cannot explain value provenance, hide secret input, classify
validation results, or guide recovery. A separate read-only `swarm:doctor`
command reuses the same checks against existing configuration for CI and later
diagnosis.

## Operator Flow

### 1. Environment preflight

The wizard checks the supported Node.js version, user systemd availability, the
`herdr` and `traex` executables, private configuration-directory permissions,
and availability of the configured loopback port. It reports missing
dependencies with remediation instructions but does not install system
packages.

### 2. Lark application configuration

The wizard collects these values in order:

- `LARK_APP_ID`;
- `LARK_APP_SECRET`, using non-echoed input;
- `LARK_CHAT_ID`;
- `LARK_BOT_OPEN_ID`;
- optional comma-separated `LARK_OPERATOR_OPEN_IDS`.

Before each prompt it explains the value's purpose, expected shape, and location
in the Lark developer console or event test data. When valid configuration
already exists, non-secret values become editable defaults. The secret is never
displayed; the operator chooses either to retain it or enter a replacement.

### 3. Project and Herdr configuration

For the first project, defaults derive from the current directory:

- normalize the directory name into the project ID;
- use the directory name as the display name and initial Space name;
- resolve `cwd` to an absolute path;
- list live Herdr workspaces and prefer the current workspace when available;
- default the agent to `traex`;
- create one `primary` instance on the main checkout and one `worker` instance
  using a Git worktree based on `HEAD`;
- retain the existing default of eight maximum instances.

The operator can review and change these values. Runtime tuning stays at schema
defaults and is not expanded into first-run questions. Existing multi-project
configuration is preserved unless the operator explicitly edits it.

### 4. Static validation

Draft configuration is checked with the production Zod schemas and project
directory validation. Additional setup checks confirm that the selected Herdr
workspace exists, its configured Space name matches live state, required agent
executables are available, the HTTP endpoint is loopback-only, the port is
available when no managed service owns it, and private file modes can be
enforced.

The production schemas remain the single authority for configuration formats
and ranges. Setup-specific checks supplement them rather than reimplementing
them.

### 5. Read-only connectivity checks

The wizard performs bounded, read-only probes:

1. exchange the App ID and secret for a tenant access token;
2. read the target chat and confirm that the application can access it;
3. validate the bot open-ID shape and compare it with application or bot
   identity returned by Lark when the tenant and granted scopes expose that
   identity;
4. connect to Herdr and confirm the selected workspace;
5. confirm that Herdr can recognize the selected agent kind and executable.

The probes do not send messages, mutate Lark resources, create panes, or launch
agents. When Lark cannot expose bot identity with the configured runtime scopes,
the check becomes a warning and directs the operator to compare the value using
the event-subscription test console.

Permissions, `im.message.receive_v1`, `card.action.trigger`, publication, and bot
group membership remain manual checklist items unless a documented read-only API
can prove them. They are never shown as automatically verified based only on a
successful token request.

### 6. Review and durable save

The wizard displays a redacted summary containing the application ID, an
`already set` marker for the secret, resolved chat identity, bot open ID,
operator allowlist, projects, workspace routes, instance layout, config and
state directories, HTTP endpoint, and systemd unit name.

Only explicit confirmation commits the drafts. Each target is written through a
mode-`0600` temporary file in the destination directory, flushed, and atomically
renamed. The containing directory is mode `0700`. Before replacing existing
valid configuration, the workflow creates a timestamped mode-`0600` backup in
the private configuration directory. Both `.env` and `projects.json` are
validated together before either replacement; the commit operation must avoid a
mixed old/new pair if its second replacement fails.

### 7. Optional installation and startup

Saving configuration and changing the service are separate confirmations. After
save, the operator may ask the wizard to reuse the existing lifecycle module to
install the generated systemd unit and start it. The workflow verifies the
generated build identity, waits for `/ready`, and prints the next command or
Lark action.

If a managed service is already running, the wizard displays the affected unit,
endpoint, and current work state and requires an additional restart
confirmation. Existing safe-restart rules remain authoritative; the setup
workflow cannot force an unsafe restart.

## Validation Result Model

All preflight and connectivity checks use one stable result shape:

```ts
type SetupCheck = {
  id: string;
  status: "pass" | "warning" | "fail" | "skipped";
  summary: string;
  remediation?: string;
};
```

The workflow applies these rules:

- `fail` blocks configuration commit, installation, and startup;
- `warning` permits progress but remains visible in the final confirmation;
- `skipped` is available only when the operator explicitly skips network
  checks; it permits configuration commit but blocks automatic startup;
- only a complete pass without skipped checks permits the one-flow
  install-and-start path.

`swarm:doctor` emits the same checks non-interactively, changes no state, and
uses exit code `0` only when no check fails. Warnings remain visible but do not
make the command fail.

## Architecture and Module Boundaries

The implementation introduces these focused modules:

- `src/setup/setup-workflow.ts`: deterministic step orchestration and policy;
- `src/setup/setup-prompts.ts`: terminal interaction and hidden secret input;
- `src/setup/setup-config.ts`: draft loading, rendering, backup, and atomic
  paired commit;
- `src/setup/setup-checks.ts`: check ordering and result classification;
- `src/setup/setup-summary.ts`: redacted review output;
- `src/setup/setup-types.ts`: draft, port, check, and result contracts;
- `src/adapters/lark-setup-probe.ts`: bounded read-only Lark calls;
- `src/adapters/herdr-setup-probe.ts`: workspace and agent capability reads;
- `src/cli/setup.ts`: interactive CLI, signal handling, and exit codes;
- `src/cli/doctor.ts`: non-interactive diagnostic CLI.

`setup-workflow.ts` depends only on explicit prompt, configuration repository,
probe, and lifecycle ports. It does not directly read the terminal, filesystem,
network, or systemd. This keeps the decision path deterministic and testable.
The Lark setup adapter intentionally has no send-message method. Command
execution uses the existing command runner so secret-bearing arguments cannot
appear in errors.

The package exposes `swarm:setup` and `swarm:doctor`. `plugin/setup.sh` delegates
to the shared setup CLI. `plugin/configure-projects.sh` remains the focused
project-registry editor. `install.sh --standalone` detects missing or placeholder
configuration and instructs the operator to run `swarm:setup`; it does not
silently enter an interactive session. Existing `swarm:init`, `swarm:install`,
and other lifecycle commands retain their current semantics.

## Secret Handling

- Secret input is not echoed and is never rendered as a default.
- Existing secrets are represented only by a retain/replace choice.
- Secrets never appear in summaries, logs, thrown errors, command arguments,
  snapshots, or test failure output.
- Lark tokens remain in memory and are discarded after the probe.
- Drafts, backups, and final configuration use mode `0600`; the configuration
  directory uses mode `0700`.
- Signal and cancellation handlers remove drafts without touching committed
  configuration.

## Failure and Recovery

- Cancellation removes drafts and leaves committed configuration unchanged.
- Static or connectivity failure returns to the relevant step without losing
  non-secret answers collected during the process.
- Temporary Lark unavailability allows the operator to commit configuration
  only by explicitly accepting skipped network checks; installation and startup
  remain blocked.
- A configuration commit failure restores the complete previous pair from the
  private backup and reports a bounded diagnostic.
- Installation failure retains the newly validated configuration and reports
  the systemd failure without substituting an invalid template.
- `/ready` failure leaves the service available for diagnosis, does not enter a
  restart loop, and prints `swarm:status` and `swarm:logs` recovery commands.
- Existing active work is never interrupted merely because setup was rerun.

## CLI Behavior

`swarm:setup` is interactive and uses these exit codes:

- `0`: configuration was saved, or requested installation completed;
- `1`: validation, persistence, installation, or readiness failed;
- `2`: command usage was invalid;
- `130`: the operator cancelled or interrupted the workflow.

`swarm:doctor` accepts existing configuration paths, never prompts, never
modifies files, never controls the service, and prints a human-readable report.
A later structured-output flag may be added independently; it is not required
for the first version.

## Testing

Workflow tests use scripted prompt and port fakes to cover first-time setup,
editing existing configuration, retaining or replacing a secret, navigating
back to an earlier step, cancellation, each check status, and independent save,
install, restart, and startup confirmations.

Configuration safety tests cover private modes, same-directory drafts, paired
atomic commit and rollback, backup permissions, signal cleanup, and deliberate
failure during each filesystem transition. They assert that known secrets never
occur in stdout, stderr, summaries, errors, logs, or snapshots.

Adapter tests cover successful Herdr discovery and Lark probes plus malformed
responses, authentication failure, authorization failure, missing chat, rate
limiting, and timeout. External failures become actionable `SetupCheck` values
without including credentials or access tokens.

CLI integration tests drive `swarm:setup` through a scripted prompt adapter and
verify exit codes and lifecycle calls. `swarm:doctor` tests prove that it is
non-interactive and leaves all files and services unchanged. Existing lifecycle
tests verify that `swarm:init`, `swarm:install`, service restart safety, plugin
delegation, and `install.sh --standalone` keep their defined behavior.

Live Lark checks are opt-in, read-only, and excluded from the default test suite.
Before handoff, run the focused tests, `npm run typecheck`, `npm run build`, and
the full `npm test` suite because setup crosses configuration, adapters, plugin
entrypoints, and lifecycle behavior.

## Acceptance Criteria

A new operator can run `npm run swarm:setup` from the repository root and obtain
validated private configuration with clear provenance for each required value.
The workflow distinguishes automatically verified facts from manual Lark setup
requirements, can optionally install and start the service, and reports success
only after readiness passes. Any cancellation or failure preserves the previous
valid configuration and does not send a message, create an agent, modify Lark,
or interrupt active work.

## Non-goals

- Creating or publishing a Lark application.
- Granting permissions or configuring event subscriptions.
- Adding the bot to a group or sending a test message.
- Installing Node.js, systemd, Herdr, TraeX, or agent executables.
- Exposing every runtime tuning option in the first-run flow.
- Replacing the existing lifecycle implementation or safe-restart policy.
- Supporting non-systemd service managers in the first version.
