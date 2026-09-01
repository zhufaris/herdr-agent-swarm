# Private Offline Bundle Design

## Goal

Produce one relocatable private Linux x86-64 `.tar.gz` release that installs and
operates both Herdr headless and Herdr Agent Swarm without network access. The
target host supplies Node.js 22.12 or newer, user systemd, and TraeX. The
archive supplies the validated Herdr binary, compiled
Swarm runtime, production Node dependencies, templates, lifecycle scripts, and
integrity metadata.

The bundle is a deployment artifact, not an npm registry package. It must not
contain host configuration, credentials, SQLite state, logs, TraeX transcripts,
or project-specific paths.

## Supported Target

- Linux x86-64.
- Node.js 22.12 or newer; Node.js 24 LTS is recommended.
- npm is not required on the target host.
- A functioning user-systemd session.
- TraeX, which is required for each Lark-bound Primary.
- Codex, Claude Code, and Pi are optional Worker runtimes.
- Herdr 0.7.5, supplied as the validated statically linked x86-64 binary.

The first release intentionally supports one platform tuple. The build must fail
if the supplied Herdr binary is not an x86-64 ELF executable, reports a version
other than 0.7.5, or does not match the pinned SHA-256 digest.

## Artifact Layout

The archive has one versioned root directory:

```text
herdr-agent-swarm-<version>-linux-x64/
├── bin/
│   └── herdr-real
├── runtime/
│   ├── dist/
│   ├── node_modules/
│   ├── package.json
│   └── package-lock.json
├── scripts/
│   ├── swarmctl
│   └── lib/
├── templates/
│   ├── herdr-headless.service
│   ├── herdr-agent-swarm.service
│   ├── env.example
│   └── projects.example.json
├── README.md
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── release.json
└── MANIFEST.sha256
```

`release.json` records the product version, Git commit, Swarm build ID, target
platform, required Node range, Herdr version, Herdr digest, and archive creation
time. `MANIFEST.sha256` covers every regular payload file except itself, using
paths relative to the archive root in stable lexical order. The archive is
accompanied by a separate `<archive>.sha256` file.

## Build and Reproducibility

A repository script builds the artifact into an ignored `release/` directory.
It accepts the original Herdr binary through an explicit argument or
`HERDR_RELEASE_BIN`; it never discovers or packages the active `herdr` command,
because that command may be the TraeX shim. The builder validates the binary's
version, format, architecture, and pinned digest before copying it.

The builder performs these steps:

1. Require a clean committed source identity for tracked files used by the
   build. Unrelated untracked files are never copied.
2. Run the normal TypeScript build and validate `dist/build-info.json`.
3. Stage only `dist`, package metadata, production dependencies, selected
   scripts/templates, documentation, and the validated Herdr binary.
4. Install production dependencies in an isolated staging directory using the
   lockfile. The build host may use its configured registry; the completed
   archive requires no network access.
5. Generate `release.json`, notices, and deterministic checksum metadata.
6. Create the gzip-compressed tar archive with normalized ordering, timestamps,
   owners, groups, and file modes where the host tar implementation supports
   them.
7. Extract the archive into a fresh temporary directory and run its verifier.

Runtime secrets and state are excluded by construction rather than by a broad
copy followed by ignore rules. Source maps remain included because production
units enable actionable stack traces. Development dependencies, tests, source
files, Git metadata, npm caches, and existing release artifacts are excluded.

## Installation Model

The bundle installer is non-interactive and relocatable. It validates the
manifest, platform, Node version, user-systemd availability, TraeX
availability, and required executable behavior before changing user state. It
then copies the immutable payload under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-swarm/releases/<release-key>/
```

and atomically updates the existing `current` symlink. Configuration remains
under `${XDG_CONFIG_HOME:-$HOME/.config}`. Existing valid configuration is
preserved. Missing configuration is initialized from templates with private
permissions, and installation stops before starting services until the operator
replaces all placeholders and runs validation.

Installation renders and enables two user units:

- `herdr-headless.service` runs `bin/herdr-real server` directly.
- `herdr-agent-swarm.service` runs the compiled Swarm runtime and declares
  `Requires=herdr-headless.service` and `After=herdr-headless.service`.

The Herdr unit uses an explicit `HERDR_CONFIG_PATH` beneath the user's config
root and owns the persistent default session. It uses restart-on-failure and a
bounded stop timeout. The Swarm unit waits for the Herdr socket/API readiness
probe before starting the bridge. It retains the existing private environment,
project registry, database, log, lease, build-identity, and restart-safety
behavior.

The installer does not silently start either service. After configuration, the
operator runs the bundle's start command, which starts Herdr first and then
Swarm. Reinstallation stages a new immutable release and updates both unit
definitions, but uses the existing safe/forced Swarm restart policy before
switching a running deployment.

## Herdr and TraeX Shim Separation

The packaged `bin/herdr-real` is always the original Herdr binary. The headless
unit must invoke it directly, never through a shim. This prevents recursion and
keeps Herdr server lifecycle independent from Agent integration.

When TraeX is selected, the existing shim installer creates a separate generated
shim release whose `realHerdr` points to the installed immutable
`bin/herdr-real`. Swarm's `HERDR_BIN` points to that shim. Without TraeX,
`HERDR_BIN` may point directly to `bin/herdr-real`. The setup/doctor flow records
and validates this distinction and must never infer the original binary from the
current `herdr` command.

The package does not include TraeX, Codex, Claude Code, Pi, their credentials,
or their session data.

## Operator Surface

The archive exposes one consistent command surface through `scripts/swarmctl`:

- `verify`: verify manifest, platform, Node, Herdr, TraeX, runtime entrypoints,
  and templates without installing.
- `install`: verify and install the immutable release and both units.
- `start`: validate configuration, start Herdr, wait for its socket/API, then
  start Swarm and wait for `/ready`.
- `restart [--force]`: preserve the existing safe restart gate and explicit
  detached-observer handoff.
- `status`: report Herdr unit/socket health plus the existing Swarm identity,
  ownership, readiness, recovery, queue, and SQLite status.
- `logs [herdr|swarm]`: read bounded private log tails through supported paths.
- `stop`: stop Swarm before Herdr.
- `uninstall [--purge-releases]`: remove only package-owned units and links,
  preserving configuration and runtime state by default.

Subcommands share bounded helpers under `scripts/lib/`; they do not recursively
invoke a source checkout or depend on npm.

Existing `npm run swarm:*` commands remain available inside a source checkout,
but target operators do not need npm. The bundle README documents initial
configuration, start, safe restart, forced observer handoff, logs, status, and
rollback to a retained immutable release.

## Upgrade, Rollback, and Uninstall

Upgrade is additive: stage and verify the new release, update `current`, render
units with the new absolute paths, then restart only through the normal workload
safety gate. If the new service does not become ready with matching ownership
and build identity, restore the prior symlink/unit paths and report the failed
handover. A forced restart remains explicit and preserves detached/no-replay
semantics.

Uninstall defaults to preserving all configuration, SQLite/WAL/SHM state, logs,
Herdr configuration, and immutable releases. A separate explicit purge mode may
remove package-owned releases only after both units are stopped; it must never
delete project worktrees, agent sessions, or a database through an unresolved
path.

## Security and Private Distribution

Private distribution permits bundling the internally supplied Herdr binary, but
the archive still records its version, digest, source note, and redistribution
scope in `THIRD_PARTY_NOTICES.md`. The build never substitutes a different local
binary without changing the pinned digest.

All generated configuration directories use mode `0700`; secret environment
files and project registries use `0600`. Systemd units contain paths, not secret
values. The HTTP server remains loopback-only. The existing configured-chat,
operator allowlist, command redaction, transcript redaction, and local approval
boundaries remain unchanged.

## Failure Handling

- Manifest, platform, version, digest, or runtime-probe failures stop before
  installation.
- Missing Node.js or TraeX produces actionable diagnostics without modifying
  the host.
- Missing or placeholder configuration allows artifact installation but blocks
  service start.
- A Herdr readiness failure prevents Swarm startup and is visible in both unit
  status and the bundle status script.
- A Swarm readiness or identity mismatch fails the handover and preserves or
  restores the previous release.
- Active prompt, outbox, or instance work blocks ordinary restart; only an
  explicit forced observer handoff may proceed.

## Verification

Automated tests cover:

1. Exact archive membership and absence of secrets, runtime state, source, tests,
   development dependencies, and Git metadata.
2. Manifest and outer archive checksum validation, including corruption failure.
3. Herdr binary format, architecture, version, and digest rejection paths.
4. Relocation by extracting the bundle under a path containing spaces.
5. Fresh isolated HOME/XDG installation with fake user-systemd command seams.
6. Idempotent reinstall and preservation of valid configuration/state.
7. Unit dependency/order, direct original-Herdr execution, shim separation, and
   loopback-only Swarm configuration.
8. Safe restart refusal, explicit forced observer handoff, release rollback, and
   ownership checks.
9. Uninstall preservation and explicit purge scope.
10. A real-host smoke check that starts the packaged Herdr server in an isolated
    temporary session/config, proves socket/API readiness, then stops only that
    isolated session.

Before producing a distributable artifact, the release gate runs the focused
bundle tests, the full Vitest suite, typecheck, normal build, archive build,
archive self-verification, and `git diff --check`.

## Non-Goals

- Public registry or public binary distribution.
- macOS, ARM64, containers, or system-wide root services.
- Bundling Node.js, npm, or any agent CLI.
- Automatic creation of Lark applications, credentials, project routes, or agent
  sessions.
- Replacing Herdr as the authoritative pane/process runtime.
- Combining Herdr and Swarm into one process or one systemd unit.
