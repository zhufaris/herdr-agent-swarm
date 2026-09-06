# GitHub CI and Release Design

## Status

Approved for specification. Implementation starts after review of this document.

## Objective

Add GitHub Actions automation that validates every proposed change and publishes
a deployable Linux archive for tagged releases. The automation does not publish
an npm package and does not deploy, install, start, stop, or restart a live
Herdr Agent Swarm service.

## Workflow Separation

Use two workflows with separate permissions and triggers.

### Continuous integration

`.github/workflows/ci.yml` runs for pull requests and pushes to `main`. It uses
Node.js 24 on GitHub-hosted Ubuntu and performs these gates from a clean locked
dependency installation:

1. `npm ci`
2. `npm test`
3. `npm run typecheck`
4. `npm run build`

The workflow receives only read access to repository contents. Concurrent runs
for the same branch or pull request are grouped, and an older in-progress CI run
is cancelled when a newer commit supersedes it.

### Tagged release

`.github/workflows/release.yml` runs only when a tag matching `v*` is pushed. It
uses Node.js 24 on GitHub-hosted Ubuntu and receives `contents: write` solely so
it can create the GitHub Release and upload assets. It does not receive package,
deployment, or identity-token write permissions.

The release job first validates that the tag is exactly `v` followed by the
version in `package.json`. A tag such as `v0.4.0` is accepted only when the
package version is `0.4.0`; malformed or mismatched tags fail before publication.
The job then repeats the complete CI gate so a release cannot rely on a prior
workflow run that may have tested different source.

## Release Artifact

The release asset is named:

```text
herdr-agent-swarm-<version>-linux-x64.tar.gz
```

Its top-level directory has the same name without `.tar.gz`. The directory
contains:

- compiled `dist/`;
- production `node_modules/` produced by `npm ci --omit=dev`;
- `package.json` and `package-lock.json`;
- `scripts/` and `install.sh` needed by the supported service lifecycle;
- `.env.example` and example configuration files needed for first-run setup;
- `README.md`, `LICENSE`, and the current architecture and operator documentation.

The archive is a Linux x64 artifact because production dependencies may include
platform-specific content now or in the future. It requires Node.js 24 on the
destination host and still requires the host-level `herdr`, supported agent CLI,
and user systemd prerequisites documented by the repository. Runtime secrets,
live configuration, databases, logs, caches, and repository metadata are never
included.

A repository-owned packaging script constructs the staging tree and archive.
Keeping packaging outside workflow YAML makes the artifact layout locally
testable and avoids duplicating release rules in CI configuration. The script
accepts an explicit output directory, validates the built identity and version,
uses deterministic ordering and normalized archive metadata where the host tools
support it, and refuses an unexpected output path.

## Checksums and GitHub Release

The workflow generates `SHA256SUMS` containing the archive checksum. It creates
one GitHub Release for the pushed tag and uploads both the archive and checksum
file. Release notes are generated from GitHub history. A prerelease version in
`package.json`, such as `0.4.0-rc.1`, produces a prerelease; a normal semantic
version produces a normal release.

Publication is atomic at the workflow level: validation, tests, typecheck, build,
packaging, and checksum generation all complete before the release creation step.
If any earlier step fails, no GitHub Release is created. Retrying the workflow for
an already-created tag must update or reuse the same release rather than create a
second release.

## Security and Supply-Chain Boundaries

- Pin third-party actions to reviewed full commit SHAs, with comments recording
  the human-readable release version.
- Set workflow permissions explicitly; CI is read-only and only the release job
  can write repository contents.
- Do not execute release workflows for pull-request code with write permissions.
- Use the committed lockfile through `npm ci`; never update dependencies in CI.
- Do not upload npm debug logs, environment files, repository credentials, or
  service-owned state.
- Do not publish to npm and do not perform a production deployment.

## Validation

Focused tests cover the packaging script's version checks, expected file set,
excluded private/runtime files, archive root, and checksum. Workflow validation
checks YAML syntax, supported triggers, explicit permissions, pinned actions, and
the release tag/version gate.

Before handoff, run the packaging tests, `npm test`, `npm run typecheck`,
`npm run build`, a local package smoke check, and `git diff --check`. The smoke
check extracts the archive to a temporary directory and verifies that the
compiled entry point starts far enough to load its modules without relying on
the source tree. It must not configure or launch the live service.

## Documentation

The README gains a release-install section that explains how to download, verify,
extract, configure, install, and explicitly start the service. It retains source
installation as a supported path and makes clear that installation does not start
the unit automatically. Maintainer documentation records the tag/version release
procedure and required repository setting for Actions to create releases.

## Non-goals

- Publishing an npm package.
- Building macOS, Windows, ARM64, or container images.
- Signing artifacts or producing provenance attestations in this first version.
- Automatically changing `package.json`, creating tags, or pushing commits.
- Deploying or restarting a configured service.

## Completion Criteria

- Pull requests and pushes to `main` run test, typecheck, and build gates on
  Node.js 24 after a locked install.
- A matching `v*` tag publishes exactly one GitHub Release with a Linux x64
  deployable archive and `SHA256SUMS`.
- A malformed or package-version-mismatched tag publishes nothing.
- The archive contains the compiled service and production dependencies but no
  secrets or runtime state.
- Workflow permissions are explicit and third-party actions are SHA-pinned.
- The release path can be built and smoke-checked locally without mutating the
  installed service.
