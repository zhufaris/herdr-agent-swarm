# Private Offline Bundle Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Keep each task test-first, run the named focused verification after every green step, and never copy repository-wide content into the artifact.

**Goal:** Produce a private, relocatable Linux x86-64 offline release containing the pinned original Herdr 0.7.5 binary and the compiled Herdr Agent Swarm runtime, with integrity verification and a safe dual-user-systemd lifecycle.

**Architecture:** A repository builder stages an allowlisted payload, installs production dependencies in isolation, writes deterministic release metadata and checksums, creates a normalized archive, extracts it, and invokes the packaged verifier. The payload exposes one Bash control surface, `scripts/swarmctl`, backed by a small shared helper library. Installation copies the verified payload into immutable per-user releases, preserves config/state, atomically switches `current`, and renders two user units; all mutable host interactions are behind command seams so lifecycle behavior is testable in an isolated HOME.

**Tech Stack:** Bash, Node.js >=22.12, npm lockfile, GNU tar, sha256sum, readelf/file, user systemd, Vitest

---

### Task 1: Lock bundle metadata, binary validation, and membership

**Files:**
- Create: `tests/private-offline-bundle.test.ts`
- Create: `scripts/release/build-private-offline-bundle.sh`
- Create: `scripts/release/lib/bundle-common.sh`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Write failing builder contract tests**

Assert that the builder requires `--herdr-bin <path>` or `HERDR_RELEASE_BIN`, never calls `command -v herdr`, targets only `linux-x64`, pins Herdr version `0.7.5` and SHA-256 `3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253`, and rejects a missing, wrong-digest, non-ELF, non-x86-64, non-executable, or wrong-version binary before staging. Use fake tool commands for negative cases so the test does not require mutating the real binary.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run tests/private-offline-bundle.test.ts`

Expected: FAIL because the release builder and shared library do not exist.

- [ ] **Step 3: Implement bounded argument and Herdr validation helpers**

Add strict argument parsing, canonical path resolution, Linux/x86-64 checks, executable/ELF/machine validation, exact `herdr --version` parsing, and digest validation. All failures must be actionable and occur before output or host state changes. Do not infer the original binary from `PATH`.

- [ ] **Step 4: Add the release command and ignored output root**

Add `npm run release:private -- --herdr-bin <path>` and ignore `/release/`. Keep output under an explicit `--output-dir` or repository `release/`; use `mktemp -d` for staging and a cleanup trap.

- [ ] **Step 5: Define and test exact archive membership**

Build the allowlist around `bin/herdr-real`, `runtime/dist`, production `runtime/node_modules`, runtime package metadata, packaged scripts/library, templates, README/license/notices, `release.json`, and `MANIFEST.sha256`. Assert absence of `.env`, live `projects.json`, databases/WAL/SHM, logs, transcripts, sessions, `.git`, source, tests, npm cache, dev dependencies, and prior release output.

- [ ] **Step 6: Run the focused test**

Run: `npx vitest run tests/private-offline-bundle.test.ts`

Expected: builder contract and rejection cases PASS.

### Task 2: Add release metadata, manifest, and self-verification

**Files:**
- Modify: `tests/private-offline-bundle.test.ts`
- Modify: `scripts/release/build-private-offline-bundle.sh`
- Modify: `scripts/release/lib/bundle-common.sh`
- Create: `scripts/release/swarmctl`

- [ ] **Step 1: Write failing integrity tests**

Build a minimal fixture payload and assert stable lexical manifest order, coverage of every regular file except `MANIFEST.sha256`, a separate archive checksum, and verifier failure after changing, deleting, or adding a payload file. Assert `release.json` contains product version, Git commit, Swarm build ID, platform, Node range, Herdr version/digest, and a normalized creation timestamp.

- [ ] **Step 2: Generate deterministic metadata and checksums**

Read package/build identity from existing authoritative files, accept `SOURCE_DATE_EPOCH` with a documented deterministic fallback, serialize `release.json` through a small inline Node invocation with stable key order, and generate checksums from NUL-safe sorted relative paths. Refuse symlinks escaping the bundle root.

- [ ] **Step 3: Implement `swarmctl verify`**

Verify exact manifest coverage, all digests, release schema, Linux x86-64, Node >=22.12, original Herdr identity, required runtime entrypoints/templates, TraeX availability, and user-systemd availability. Add a test-only command seam through narrowly named environment variables; production defaults remain `systemctl`, `traex`, and the packaged binary. Verification must not mutate host state.

- [ ] **Step 4: Run corruption and relocation tests**

Extract under a path containing spaces, run `scripts/swarmctl verify`, then prove changed, missing, extra, and path-escape content fail.

- [ ] **Step 5: Run the focused test**

Run: `npx vitest run tests/private-offline-bundle.test.ts`

Expected: integrity, corruption, and relocation cases PASS.

### Task 3: Implement isolated installation and dual unit rendering

**Files:**
- Modify: `tests/private-offline-bundle.test.ts`
- Modify: `scripts/release/swarmctl`
- Modify: `scripts/release/lib/bundle-common.sh`
- Create: `scripts/release/templates/herdr-headless.service.in`
- Create: `scripts/release/templates/herdr-agent-swarm.service.in`
- Create: `scripts/release/templates/env.example`
- Create: `scripts/release/templates/projects.example.json`

- [ ] **Step 1: Write failing fresh-install tests**

Use isolated `HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME` plus a fake `systemctl`. Assert preflight happens before mutation, the release is copied beneath `state/releases/<release-key>`, `current` changes atomically, private directories/files use `0700`/`0600`, templates initialize only missing config, both units are installed/enabled, and neither service starts.

- [ ] **Step 2: Implement immutable install**

Run verification first, copy only the verified extracted root into a temporary sibling, fsync/rename where practical, and atomically replace `current`. Preserve existing config, database, WAL/SHM, logs, Herdr config, and releases. Make an identical install idempotent.

- [ ] **Step 3: Render the Herdr unit**

Render absolute paths without shell evaluation. `ExecStart` must invoke `<release>/bin/herdr-real server` directly with an explicit `HERDR_CONFIG_PATH`; use private append-only file logging, `Restart=on-failure`, and a bounded stop timeout. Never point this unit at the TraeX shim.

- [ ] **Step 4: Render the Swarm unit and dependency**

Require and order after `herdr-headless.service`, retain network ordering, private env/projects/database/log paths, generated build identity enforcement, loopback defaults, restart-on-failure, and a bounded readiness precondition that waits for packaged Herdr rather than the active `herdr` command.

- [ ] **Step 5: Validate config gating and shim separation**

Installation may finish with template placeholders, but `start` must stop before systemd calls until `.env` and `projects.json` validate. Ensure Swarm's configured `HERDR_BIN` may be a separate TraeX shim whose `realHerdr` is the immutable `bin/herdr-real`; never rewrite the headless unit to the shim.

- [ ] **Step 6: Run the focused test**

Run: `npx vitest run tests/private-offline-bundle.test.ts`

Expected: fresh install, idempotence, permissions, unit dependency, and shim-separation cases PASS.

### Task 4: Add the complete `swarmctl` operator lifecycle

**Files:**
- Modify: `tests/private-offline-bundle.test.ts`
- Modify: `scripts/release/swarmctl`
- Modify: `scripts/release/lib/bundle-common.sh`

- [ ] **Step 1: Write failing lifecycle tests**

Cover `start`, `restart`, `restart --force`, `status`, `logs [herdr|swarm]`, `stop`, and `uninstall [--purge-releases]` with fake systemd, HTTP, and existing Swarm lifecycle seams. Assert start order Herdr then Swarm, stop order Swarm then Herdr, bounded readiness waits, bounded private log tails, and useful non-zero diagnostics.

- [ ] **Step 2: Reuse the existing Swarm safety authority**

Call the packaged compiled `dist/cli/service-lifecycle.js` for Swarm workload/lease/build-identity decisions instead of reimplementing them in Bash. Ordinary restart must refuse active work. `--force` must remain explicit and preserve detached-observer/no-replay semantics. Herdr is stopped or restarted only after Swarm has safely detached/stopped.

- [ ] **Step 3: Implement start, status, logs, and stop**

Start Herdr and wait for its isolated socket/API before invoking the Swarm lifecycle start; wait for `/ready` and matching build ownership. Status combines both user units, Herdr readiness, and packaged Swarm status. Logs default to Swarm and accept exactly `herdr` or `swarm`; cap output size. Stop in dependency-safe order.

- [ ] **Step 4: Implement safe uninstall**

Require both services stopped, disable/remove only package-owned unit files and links, reload user systemd, and preserve config, SQLite/WAL/SHM, logs, Herdr config, sessions, and releases by default. `--purge-releases` may remove only canonical children of the package-owned releases directory after rejecting unresolved, root, HOME, state-root, or symlink-escape targets.

- [ ] **Step 5: Run the focused test**

Run: `npx vitest run tests/private-offline-bundle.test.ts tests/service-lifecycle.test.ts`

Expected: operator lifecycle and existing restart-safety tests PASS.

### Task 5: Add upgrade handover and rollback

**Files:**
- Modify: `tests/private-offline-bundle.test.ts`
- Modify: `scripts/release/swarmctl`
- Modify: `scripts/release/lib/bundle-common.sh`

- [ ] **Step 1: Write failing upgrade tests**

Install release A, simulate a running deployment, then install release B. Assert B is fully verified/staged before switch, running workloads go through the safe restart gate, unit paths and `current` move together, readiness/build-identity mismatch restores A, and successful handover retains both releases. Cover interruption before and after the symlink switch.

- [ ] **Step 2: Implement transactional handover bookkeeping**

Capture the prior canonical release and unit content, stage B, render temporary units, run the safe stop/detach path, atomically switch `current` and unit files, reload/start, and verify ownership/readiness. On failure, restore prior symlink and units, reload, and bring A back only if it was running before the attempted upgrade.

- [ ] **Step 3: Expose explicit manual rollback**

Add `swarmctl rollback <release-key> [--force]` only if it can share the exact verified handover path. Validate that the target is an installed, manifest-valid canonical child; otherwise keep rollback automatic-only and document the supported symlink recovery procedure. Do not introduce an untested second lifecycle.

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run tests/private-offline-bundle.test.ts tests/service-lifecycle.test.ts tests/build-identity.test.ts`

Expected: upgrade, rollback, interrupted-handover, and identity cases PASS.

### Task 6: Finish the reproducible builder and archive smoke gate

**Files:**
- Modify: `tests/private-offline-bundle.test.ts`
- Modify: `scripts/release/build-private-offline-bundle.sh`
- Create: `scripts/release/THIRD_PARTY_NOTICES.md`
- Create: `scripts/release/README.bundle.md`

- [ ] **Step 1: Write failing end-to-end builder tests**

Assert the builder requires a committed tracked source identity, runs the normal build, validates `dist/build-info.json`, installs with `npm ci --omit=dev` in isolated staging/cache directories, emits `herdr-agent-swarm-<version>-linux-x64.tar.gz` and its `.sha256`, and creates byte-identical archives for identical inputs and `SOURCE_DATE_EPOCH`.

- [ ] **Step 2: Stage the complete allowlisted runtime**

Copy `dist`, `package.json`, `package-lock.json`, the production dependency tree, pinned Herdr, packaged controls/templates, bundle README, MIT license, and private redistribution notice. Never stage through a broad repository copy. Strip temporary npm cache and verify there are no development packages.

- [ ] **Step 3: Normalize and self-test the archive**

Use stable path ordering, numeric owner/group zero, normalized mtime, and normalized file modes. Write the outer checksum, extract into a fresh directory with spaces in its path, run packaged verification, and delete staging on both success and failure. Do not publish a partially verified final archive.

- [ ] **Step 4: Run the real pinned-binary build**

Run: `npm run release:private -- --herdr-bin /data00/home/feiyu.zhu/.local/bin/herdr`

Expected: one verified archive and checksum under `release/`; reported Herdr version is `0.7.5` and digest is `3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253`.

- [ ] **Step 5: Run an isolated real-Herdr smoke check**

Extract the archive into a temporary directory, launch only packaged `bin/herdr-real server` with a temporary config/session root, prove its socket/API becomes ready, and stop only that isolated process. Do not touch the active Herdr workspace or deployed Swarm service.

### Task 7: Document private distribution and run the release gate

**Files:**
- Modify: `README.md`
- Modify: `scripts/release/README.bundle.md`
- Modify: `tests/readme-source-install.test.ts`
- Modify: `tests/private-offline-bundle.test.ts`

- [ ] **Step 1: Add source-builder documentation**

Document the exact pinned-binary build command, artifact/checksum names, private redistribution boundary, target prerequisites, and the distinction between the original packaged Herdr binary and the separately generated TraeX shim. Keep the existing source installation path intact.

- [ ] **Step 2: Add bundle operator documentation**

Document checksum verification, extraction, `verify`, `install`, private config completion, config validation, explicit `start`, readiness/status, logs, safe restart, forced detached-observer handoff, upgrade rollback behavior, stop, and uninstall preservation/purge scope. State clearly that installation enables but does not start either unit.

- [ ] **Step 3: Run focused release tests**

Run: `npx vitest run tests/private-offline-bundle.test.ts tests/readme-source-install.test.ts tests/standalone-install.test.ts tests/service-lifecycle.test.ts tests/build-identity.test.ts tests/architecture-boundaries.test.ts`

Expected: all focused release, documentation, installer, lifecycle, identity, and architecture tests PASS.

- [ ] **Step 4: Run repository verification**

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm test`

Run: `git diff --check`

Expected: all commands PASS.

- [ ] **Step 5: Rebuild and verify the final artifact from committed inputs**

After committing implementation files, rebuild with the pinned Herdr binary, verify the outer checksum, extract and run `scripts/swarmctl verify`, inspect archive membership, and record artifact path, size, digest, release ID, Git commit, Swarm build ID, and Herdr identity. Keep generated `release/` artifacts untracked.

- [ ] **Step 6: Commit in thematic batches**

Commit only task-owned files. Suggested boundaries are: builder/integrity, installer/dual units, lifecycle/rollback, and documentation/release gate. Never stage the existing architecture HTML/JSON/SVG/PNG artifacts, `.worktree/`, or `TODO.md`.
