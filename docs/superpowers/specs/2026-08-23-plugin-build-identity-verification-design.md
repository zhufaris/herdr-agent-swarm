# Plugin Build Identity Verification Design

## Goal

Prevent Herdr plugin `start` and `restart` actions from accepting an unrelated
or stale bridge process merely because the configured port responds to
`/health`. A successful lifecycle action must prove that the active systemd
unit is serving the build currently installed at the plugin root.

This change is limited to build identity generation, propagation, reporting,
and verification. Configuration generations, automatic configuration rollback,
release-directory packaging, and documentation archival remain separate work.

## Identity Contract

The production build generates `dist/build-info.json` after TypeScript
compilation. It contains:

- `serviceId`: the stable value `herdr-lark-bridge`;
- `version`: the package version;
- `buildId`: a non-secret identifier unique to the compiled output; and
- `gitCommit`: the source commit when available, otherwise `null`.

`buildId` is derived from immutable build inputs and the compiled output rather
than from the build timestamp alone. Rebuilding unchanged source may retain the
same identity; changing the emitted application changes it. This makes identity
useful for proving code equivalence without creating needless restarts.

The build metadata is public operational information and must never contain
environment variables, credentials, filesystem contents, or uncommitted diff
text.

## Runtime Flow

The lifecycle module reads and validates `dist/build-info.json` before
installing or starting the service. Unit generation injects the expected build
ID as `BRIDGE_EXPECTED_BUILD_ID`.

At startup, the bridge reads the same build metadata. Startup fails if the
metadata is absent, malformed, identifies another service, or disagrees with
`BRIDGE_EXPECTED_BUILD_ID`. Foreground development may run without the expected
environment variable, but still reports the build metadata produced by the
normal build.

The health server exposes the following sanitized response:

```json
{
  "status": "ok",
  "serviceId": "herdr-lark-bridge",
  "version": "0.2.0",
  "buildId": "sha256:..."
}
```

`/status` includes the same identity. `/ready` retains its dependency-readiness
contract and does not become the lifecycle startup gate.

After `systemctl --user start` or `restart`, the lifecycle controller requires
all of the following before returning success:

1. the configured systemd unit is active;
2. `/health` returns `status=ok`;
3. `serviceId` equals `herdr-lark-bridge`; and
4. `buildId` equals the current plugin build ID.

A response from an old build, another bridge, or another application on the
same port is rejected until the bounded timeout expires. The resulting error
reports expected and observed non-secret identities and directs the operator to
the unit status and journal. It never terminates an unidentified process.

## Module Shape

A small build-identity module owns parsing and validation. Its interface is:

```ts
interface BuildIdentity {
  serviceId: "herdr-lark-bridge";
  version: string;
  buildId: string;
  gitCommit: string | null;
}

function loadBuildIdentity(path: string): BuildIdentity;
```

The build generator, lifecycle controller, composition root, and health server
all cross this seam instead of interpreting the JSON independently. The health
server receives identity as an explicit dependency; it does not discover plugin
paths or read files itself.

## Version Source

`package.json` is the canonical application version. The manifest version must
match it, and an automated test enforces equality. This change aligns the
current package version with manifest version `0.2.0`.

## Failure Handling

- Build fails if metadata cannot be generated or validated.
- Unit installation fails before changing systemd state if metadata is missing
  or invalid.
- Bridge startup fails before opening Lark or acquiring durable work if an
  injected expected identity does not match its build.
- Lifecycle readiness rejects a healthy response with missing or mismatched
  identity.
- Status remains diagnostic when the service is stopped or unreachable and
  reports expected versus observed identity when available.

## Verification

Automated tests cover:

- deterministic generation and strict parsing of build metadata;
- rejection of malformed metadata and mismatched service identity;
- package and manifest version equality;
- expected build ID injection into the generated systemd unit;
- successful startup only when active unit and health identity both match;
- rejection of a stale build, unrelated service, and legacy identity-free
  health response;
- health and status identity reporting; and
- bridge startup rejection when the unit-provided build ID disagrees.

Acceptance runs focused tests, the full test suite, typecheck, production build,
shell syntax checks, and Herdr manifest registration.
