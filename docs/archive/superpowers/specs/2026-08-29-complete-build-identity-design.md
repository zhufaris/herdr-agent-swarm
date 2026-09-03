# Complete Build Identity Design

## Status

Approved for implementation. The user authorized the recommended approach to
proceed without per-batch confirmation.

## Problem

The generated build ID currently hashes compiled JavaScript, service ID, and
package version. A dependency-only lockfile update can therefore produce the
same identity even though the deployed runtime graph changed. The build also
does not record the Node version or module ABI used to produce it. systemd uses
this ID as the restart handover fence, so false equality weakens deployment
verification and rollback diagnosis.

## Goals

1. Change the build ID when the locked dependency graph changes.
2. Change the build ID when the build-time Node version or module ABI changes.
3. Preserve deterministic hashing, the existing `sha256:<hex>` format, and the
   `build-info.json` schema.
4. Keep build input calculation directly testable without compiling or mutating
   the repository in unit tests.

## Selected design

Extract a pure `calculateBuildId` helper in `scripts/build-id-input.mjs`. It
accepts the service ID, package version, Node version, Node module ABI, lockfile
bytes, and an ordered list of compiled file paths plus bytes. Inputs are framed
with stable field names and byte lengths before SHA-256 hashing so boundaries
cannot be ambiguous.

`generate-build-info.mjs` reads `package-lock.json`, supplies
`process.versions.node` and `process.versions.modules`, and delegates hashing to
the helper. It continues to write the same identity fields consumed by the
runtime and plugin lifecycle. Git commit remains metadata rather than a hash
input; compiled contents and dependency/runtime inputs define the deployable
artifact even in a dirty checkout.

Tests execute the pure ESM helper in a child Node process and verify that source
bytes, lockfile bytes, Node version, and ABI independently affect the result,
while identical inputs remain deterministic.

## Alternatives rejected

- Hash only `package.json`: semver ranges do not identify the installed graph.
- Hash all of `node_modules`: expensive, platform-noisy, and unnecessary when
  the lockfile plus runtime identity define resolution.
- Put `gitCommit` into the digest: two dirty builds at the same commit can differ,
  while identical artifacts from different metadata should retain the same ID.
- Change the JSON schema: runtime consumers need only the final digest, version,
  service ID, and diagnostic commit.

## Tests and acceptance

- Identical ordered inputs produce the same `sha256:<64 hex>` ID.
- Changing compiled content, lockfile content, Node version, or module ABI changes
  the ID.
- The real build generates and validates `dist/build-info.json`.
- Focused tests, typecheck, build, and all unaffected repository tests pass.

## Non-goals

- Detecting a Node binary changed after an artifact was built without rebuilding.
- Reworking dependency installation or pruning dev dependencies.
- Cleaning `dist` before build; that is a separate deployment-hardening batch.
- Deploying while unrelated uncommitted runtime source would be included.
