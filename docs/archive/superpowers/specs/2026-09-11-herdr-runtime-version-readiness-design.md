# Herdr Runtime Version Readiness Design

## Goal

Make the Herdr version consumed by Herdr Agent Swarm an explicit runtime
compatibility contract. A bridge whose configured Herdr executable is missing,
unparseable, or below the supported version must remain observable but report
`/ready` as unavailable.

## Scope

- Add `HERDR_MIN_VERSION`, with `0.9.0` as the default.
- Run the configured `HERDR_BIN --version` through the existing command-runner
  abstraction.
- Parse release and fork versions such as `0.9.1-feiyu.1`, compare their core
  semantic version to the configured minimum, and retain the original reported
  version for diagnostics.
- Make the probe a readiness component with a short, shared TTL cache.
- Reuse the same parser/comparator in setup validation, so installation and
  runtime apply identical support rules.

## Non-goals

- Pinning a particular fork suffix such as `-feiyu.1`. Release notes record the
  validated fork build; the runtime contract is the core semantic version.
- Changing Herdr's command, socket, pane, or turn protocol.
- Preventing process startup solely because a version is incompatible. The
  bridge starts so `/status` and service logs remain available, but `/ready`
  returns HTTP 503.

## Design

### Shared compatibility module

Create a small runtime module that owns three facts: parsing the `herdr
--version` output, comparing core semantic versions, and producing a bounded
diagnostic result. It accepts a `CommandRunner`, executable, timeout, and
minimum version. It returns either `{ ok: true, version, minimumVersion }` or
`{ ok: false, minimumVersion, error }`; command stderr and raw output are not
copied into the public response.

Prerelease/fork suffixes are allowed after a valid `major.minor.patch` core and
are reported verbatim. Compatibility compares only numeric core fields, so
`0.9.1-feiyu.1` satisfies `>=0.9.0`.

### Configuration and composition

`HERDR_MIN_VERSION` is validated as a semantic core version and defaults to
`0.9.0`. `BridgeConfig.herdr` carries both the executable and the minimum
version. Composition creates one version probe using the existing command
runner and passes it to the health server.

### Health behavior

The health server combines the version result with its existing workspace
readiness inspection in a single TTL-coalesced read. `/ready` returns 200 only
when the version, workspace, database, projects, Lark, lease, and instance
runtime are all healthy. `/status` exposes a `herdr.version` diagnostic that
includes the required version and either the actual version or a bounded error.
`/health` remains a process-liveness endpoint and stays HTTP 200.

### Setup behavior

`HerdrSetupProbe` delegates version parsing and comparison to the shared module.
Its existing `herdr.version` check reports the configured required version,
eliminating its hard-coded `0.9.0` comparison.

## Failure modes

| Condition | `/health` | `/ready` | `/status` | Operator action |
| --- | --- | --- | --- | --- |
| Herdr core version meets minimum | 200 | 200 if other checks pass | actual and required version | none |
| Herdr below minimum | 200 | 503 | required and actual version | upgrade Herdr or lower the explicitly configured requirement |
| Version output malformed | 200 | 503 | bounded parse error | install a supported Herdr binary |
| Executable cannot run or times out | 200 | 503 | bounded probe failure | fix `HERDR_BIN` or runtime availability |

## Verification

- Unit tests cover stable versions, fork suffixes, too-old versions, malformed
  output, and command failure.
- Health-server tests prove the version component fails readiness, appears in
  status, shares a TTL-coalesced probe, and does not affect `/health`.
- Setup tests prove it honors the same configured minimum.
- Run focused tests, typecheck, build, then the complete test suite before
  installing and safely restarting the bridge.
