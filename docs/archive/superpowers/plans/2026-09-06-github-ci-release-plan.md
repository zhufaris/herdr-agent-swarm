# GitHub CI and Release Implementation Plan

## Objective and authority

Implement
`docs/superpowers/specs/2026-09-06-github-ci-release-design.md`. Preserve the
existing CI security scan and production dependency audit while adding explicit
concurrency, SHA-pinned actions, locally testable packaging, and tag-driven
GitHub Releases. Do not publish to npm or mutate a live service.

## Stage 1: Release packaging contract

Files:

- add `scripts/package-release.mjs`;
- add `tests/package-release.test.ts`;
- update `package.json`.

Steps:

1. Add a command that accepts an explicit output directory and optional release
   tag, reads the package version and compiled build identity, and rejects a
   malformed or mismatched tag.
2. Build a temporary top-level release directory containing compiled output,
   production dependencies, lifecycle scripts, examples, license, and selected
   operator documentation.
3. Create a deterministic Linux x64 tarball and `SHA256SUMS`, then print
   machine-readable artifact paths for CI.
4. Test accepted and rejected tags, archive layout, required files, private file
   exclusions, checksum validity, and output-path safety.

Gate: focused packaging tests and `git diff --check`.

## Stage 2: Continuous integration workflow

Files:

- update `.github/workflows/ci.yml`;
- add `tests/github-workflows.test.ts`.

Steps:

1. Retain pull-request and `main` push triggers, Node.js 24, locked dependency
   installation, typecheck, tests, build, production audit, and credential scan.
2. Add branch/PR concurrency with superseded-run cancellation.
3. Pin checkout and Node setup actions to verified full commit SHAs and disable
   persisted checkout credentials.
4. Add structural tests for triggers, permissions, concurrency, actions, and
   required quality gates.

Gate: workflow tests and YAML parse validation.

## Stage 3: Tag release workflow

Files:

- add `.github/workflows/release.yml`;
- extend `tests/github-workflows.test.ts`.

Steps:

1. Trigger only for pushed `v*` tags and grant only `contents: write`.
2. Check out the exact tagged commit without persisting credentials and set up
   Node.js 24 with locked npm caching.
3. Validate tag/package version, run `npm ci`, typecheck, tests, build, audit,
   credential scan, and the release packager.
4. Publish the tarball and checksum to the tag's GitHub Release using a
   SHA-pinned action, generated notes, failure on missing files, and prerelease
   classification derived from the package version.
5. Verify structural release properties in tests.

Gate: workflow tests, action-version check when the repository helper is
available, and `git diff --check`.

## Stage 4: Operator documentation

Files:

- update `README.md`;
- add or update a focused maintainer release document under `docs/`.

Steps:

1. Document archive download, `SHA256SUMS` verification, extraction, setup,
   install, and explicit service start.
2. Document the maintainer sequence: update `package.json` and lockfile version,
   merge green CI, create and push the matching `v<version>` tag, and observe the
   release workflow.
3. State platform and host prerequisites and that releases do not deploy or start
   services automatically.

Gate: documentation audit and diff check.

## Final validation and commit strategy

Use thematic commits: plan, packaging/tests, workflows, and documentation. Every
implementation commit includes the required
AI co-author trailer. Before handoff run:

```text
npx vitest run tests/package-release.test.ts tests/github-workflows.test.ts
npm run typecheck
npm test
npm run build
npm run docs:audit
npm run release:package -- --output <temporary-directory> --tag v0.3.0
git diff --check
```

Extract the generated archive into a temporary directory and verify the compiled
entry point and production dependency graph load without consulting the source
tree. Do not create or push a Git tag, create a live GitHub Release, install the
service, or restart it during local validation.
