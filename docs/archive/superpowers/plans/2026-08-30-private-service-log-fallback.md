# Private Service Log Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bounded service logs available without journal ACL access.

**Architecture:** Direct the canonical user unit's stdout/stderr to a private state-directory file and make `swarm:logs` tail that file directly. Perform fixed-size rotation only while the lifecycle command has stopped the old writer and before starting the next process.

**Tech Stack:** TypeScript, Node.js filesystem APIs, user systemd, Vitest

**Spec:** `docs/superpowers/specs/2026-08-30-private-service-log-fallback-design.md`

## Global Constraints

- Log directory mode is `0700`; log files are `0600`.
- `swarm:logs` returns at most 100 lines and 1 MiB.
- Rotate at 16 MiB and retain only `service.log` plus `service.log.1`.
- Never rotate a file while the service process can still be writing to it.
- Do not require root, journal ACLs, or writable `/run`.
- Preserve Pino redaction and never print configuration secrets or prompt arguments.

---

### Task 1: Add private logging to the canonical lifecycle

**Files:**
- Modify: `src/cli/service-lifecycle.ts`
- Modify: `tests/service-lifecycle.test.ts`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `SWARM_STATE_DIR` and canonical lifecycle actions.
- Produces: runtime paths `logDirectory`, `logFile`, `rotatedLogFile`; bounded `printLogs(paths)`; `rotateLogs(paths)`.

- [ ] **Step 1: Write failing lifecycle tests**

Assert install creates `logs/` as `0700` and `service.log` as `0600` without rotating under an active unit; the unit contains:

```ini
StandardOutput=append:/absolute/state/logs/service.log
StandardError=append:/absolute/state/logs/service.log
```

Assert `logs` prints the last 100 newline-delimited records, caps bytes read to 1 MiB, identifies the private-file source, and never invokes `journalctl`. Assert an oversized inactive log rotates to `.1`. Assert restart ordering is the existing safety gate, `systemctl --user stop`, rotate, atomic unit rewrite, `systemctl --user daemon-reload`, and `systemctl --user start --no-block`; a stop failure must prevent rotation, reload, and start. Assert `--force` bypasses only the pre-stop workload gate and does not bypass stop failure, PID ownership, build identity, recovery, or readiness checks.

- [ ] **Step 2: Run the focused test and observe the journal-only failure**

Run: `npx vitest run tests/service-lifecycle.test.ts`

Expected: FAIL because the unit has no file output directives and `logs` delegates to `journalctl`.

- [ ] **Step 3: Implement private paths and bounded tailing**

Extend `RuntimePaths` with:

```ts
logDirectory: string;
logFile: string;
rotatedLogFile: string;
```

Create the directory and current file with restrictive modes during install/start, and re-apply `chmod` so a pre-existing permissive path converges to `0700`/`0600`. Implement bounded tailing with `openSync`, `fstatSync`, and a read window of at most 1 MiB from the end; split lines and print only the final 100. Do not load an unbounded log with `readFileSync`, invoke `journalctl`, or read `.env`.

- [ ] **Step 4: Implement safe rotation and explicit restart sequencing**

If `service.log` exceeds `16 * 1024 * 1024`, remove only `service.log.1`, rename the inactive `service.log` to `.1`, and create a new `0600` log. A plain `start` may rotate only after confirming the unit is inactive. `install` creates/converges paths and rewrites the unit but never rotates while an active writer exists. For restart, replace the single `systemctl restart` call with exactly: safety gate, `systemctl --user stop`, rotate, atomic unit rewrite, `systemctl --user daemon-reload`, then `systemctl --user start --no-block`. If stop fails, do not rotate, rewrite, reload, or start. Preserve all existing post-start identity, PID ownership, recovery, and readiness checks. `--force` bypasses only the pre-stop workload gate.

- [ ] **Step 5: Update operator documentation**

Document the private log path, 100-line/1-MiB read bound, 16-MiB rotation threshold, and the fact that host journal access is optional. Keep the host-level `systemd-journal` remediation as an optional platform fix, not an application prerequisite.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
npx vitest run tests/service-lifecycle.test.ts tests/standalone-install.test.ts
npm run typecheck
npm run build
npm test
git diff --check
```

Expected: every command exits `0`; no test is skipped.

- [ ] **Step 7: Commit**

```bash
git add src/cli/service-lifecycle.ts tests/service-lifecycle.test.ts AGENTS.md README.md
git commit -m "fix: provide private bounded service logs"
```

---

### Task 2: Deploy and verify logging without journal access

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: canonical installer, safe lifecycle gate, `swarm:logs`, and `/status`.
- Produces: live evidence that private logs work with unreadable journald.

- [ ] **Step 1: Inspect safety state and install**

Run `npm run swarm:status`; require zero active/queued binding and instance work plus drained outbox before restart. Run `./install.sh`. Do not use `--force` without explicit authorization.

- [ ] **Step 2: Safely restart and verify service health**

Run `npm run swarm:restart`, then verify expected identity/build, exact PID ownership, `/ready`, completed recovery, healthy SQLite, and held lease in two consecutive samples.

- [ ] **Step 3: Verify the supported log command**

Run `npm run swarm:logs` from the same account that cannot read `/run/log/journal`. Confirm it reports the private file source, includes a new non-secret startup record, returns no more than 100 lines and 1 MiB, and exits `0`. Confirm `stat` reports directory mode `0700` and file mode `0600`.
