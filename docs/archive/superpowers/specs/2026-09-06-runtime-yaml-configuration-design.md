# Runtime YAML Configuration Design

## Status

Approved for specification. Implementation starts after review of this document.

## Objective

Move operator-tunable polling, cache, CardKit sizing, debounce, and pane-close
confirmation values from source constants and environment variables into one
validated YAML file without changing default runtime behavior.

Secrets, process bootstrap settings, executable paths, and service identity remain
in `.env`. Project routing remains in `projects.json`. Runtime policy lives in
`runtime.yaml`.

## Configuration File

The standalone default path is:

```text
${SWARM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-agent-swarm}/runtime.yaml
```

`RUNTIME_CONFIG_PATH` may select another absolute or repository-relative file.
The service lifecycle writes the resolved standalone path into the managed unit,
as it already does for `PROJECTS_CONFIG_PATH`.

The repository provides `config/runtime.example.yaml`:

```yaml
runtime:
  polling:
    transcriptIdentityMs: 50
    attachedTranscriptMs: 250
    workerTurnMs: 250
    externalTurnMs: 2000

  cache:
    herdrSnapshotTtlMs: 2000

  cards:
    updateDebounceMs: 500
    payloadLimitChars: 12000
    answerStreamLimitChars: 28000
    answerPageLimitChars: 9000

  paneClosure:
    confirmationTtlMs: 60000
```

The YAML document and every nested object are strict: unknown keys fail
validation so misspelled tuning settings cannot be silently ignored. Values are
integers expressed in milliseconds or characters as named. YAML aliases and
custom tags are not part of the supported configuration contract.

## Defaults and Validation

Every field is optional. Missing fields inherit the current behavior. The whole
file may be absent, in which case all defaults apply. An existing unreadable,
malformed, non-object, or schema-invalid file is a startup error.

| YAML path | Default | Valid range | Owner |
| --- | ---: | ---: | --- |
| `runtime.polling.transcriptIdentityMs` | 50 | 10–5000 | transcript identity acquisition |
| `runtime.polling.attachedTranscriptMs` | 250 | 10–10000 | attached and detached transcript observation |
| `runtime.polling.workerTurnMs` | 250 | 10–10000 | Worker turn observation |
| `runtime.polling.externalTurnMs` | 2000 | 100–60000 | externally started Primary turn observation |
| `runtime.cache.herdrSnapshotTtlMs` | 2000 | 0–60000 | Herdr workspace snapshot cache |
| `runtime.cards.updateDebounceMs` | 500 | 0–10000 | Answer and Main Card projection scheduling |
| `runtime.cards.payloadLimitChars` | 12000 | 1000–50000 | bounded non-streaming CardKit payloads |
| `runtime.cards.answerStreamLimitChars` | 28000 | 4000–50000 | render-safe Answer stream upper bound |
| `runtime.cards.answerPageLimitChars` | 9000 | 1000–28000 | durable Answer page splitting |
| `runtime.paneClosure.confirmationTtlMs` | 60000 | 5000–600000 | pane-close confirmation code |

Cross-field validation requires `answerPageLimitChars` not to exceed
`answerStreamLimitChars`. The separate values preserve the current 9000-character
durable page policy while moving the existing 28000-character rendering safety
bound into configuration. `payloadLimitChars` remains independent because it
bounds serialized CardKit JSON rather than Markdown source text.

The existing environment variables `HERDR_SNAPSHOT_CACHE_TTL_MS` and
`CARD_UPDATE_DEBOUNCE_MS` are retired from the runtime configuration surface. To
avoid ambiguous precedence, setting either one causes validation to fail with a
migration message pointing to `runtime.yaml`. `OUTBOX_SAFETY_SCAN_INTERVAL_MS`
remains in `.env` because it is not part of the requested parameter set.

## Loading and Ownership

`loadConfig()` resolves and reads `runtime.yaml`, parses it with a direct YAML
dependency, validates it with Zod, applies defaults, and exposes a fully populated
`runtimeTuning` object. Consumers never read YAML or environment variables.

The configuration module owns external representation and validation. Composition
injects only the values each module consumes:

- `TranscriptObserver` receives transcript identity and transcript observation
  polling intervals;
- `WorkerTurnObserver` receives its polling interval;
- `ExternalTurnObserver` receives its polling interval;
- `WorkspaceSnapshotCache` receives its TTL;
- `ConversationViewProjector` receives card update debounce;
- card renderers and Answer-page workflows receive their respective character
  limits;
- `PaneClosureWorkflow` receives confirmation TTL.

Constructor defaults remain for focused tests and direct in-process construction.
Production composition always passes the validated values explicitly. Runtime
configuration is loaded once at startup; live reload and per-project overrides
are out of scope.

The 25 ms values used only by bounded test polling or internal cooperative waits
are not operator policy and remain test or implementation constants. If source
inspection finds a production 25 ms timing that affects external behavior, it
must be assigned a purpose-specific YAML key before implementation is considered
complete.

## Setup, Validation, and Installation

First-run setup writes a private three-file configuration set: `.env`,
`projects.json`, and `runtime.yaml`. The repository extends the existing atomic
configuration transaction so a failed replacement restores all three files.
Backups include all three files, and permissions remain directory `0700` and
files `0600`.

Existing installations that have only `.env` and `projects.json` remain valid.
The setup workflow materializes `runtime.yaml` with effective defaults the next
time configuration is saved. Installation does not require the file to exist;
the service uses defaults until an operator creates it.

`config:validate` validates `.env`, `projects.json`, and the effective runtime
configuration. It accepts an optional third path and otherwise resolves
`RUNTIME_CONFIG_PATH` or the standalone default. A missing runtime file is
reported as defaults in use, not as an error.

## Error Handling

- Missing file: use defaults and emit no repeated warning.
- Unreadable or malformed file: fail startup with the path and a bounded reason.
- Unknown key or invalid value: fail startup with the YAML field path.
- Retired environment override: fail startup with its replacement YAML path.
- Setup transaction failure: restore or remove the complete three-file set using
  the existing recovery rules.

No configuration error may print secrets or dump the complete environment.

## Testing

Configuration tests cover:

- missing-file defaults;
- full and partial YAML overrides;
- malformed YAML, unknown keys, invalid types, boundary values, and cross-field
  limits;
- retired environment-variable rejection;
- explicit and default path resolution.

Focused consumer tests prove each value is injected and affects the intended
wait, cache, render, or expiry decision. Setup tests cover three-file creation,
backup, rollback, permissions, and migration from an existing two-file install.
Service lifecycle and validation CLI tests cover the resolved runtime path.

Before handoff, run affected tests, `npm run typecheck`, `npm test`,
`npm run build`, and `git diff --check`.

## Non-goals

- Moving credentials, executables, HTTP settings, database paths, or project
  routing into YAML.
- Live configuration reload.
- Per-project runtime tuning.
- Exposing parser safety bounds, retry backoff algorithms, security limits, or
  test-only waits as operator settings.
- Installing, restarting, or deploying the service.

## Completion Criteria

- All listed runtime values originate from the validated `runtimeTuning` object
  in production composition.
- No listed value remains duplicated as an independently authoritative production
  constant.
- Defaults preserve current behavior.
- Existing two-file installations start successfully without `runtime.yaml`.
- Invalid present files fail closed with actionable, redacted diagnostics.
- Setup and lifecycle flows consistently treat runtime configuration as the third
  non-secret configuration file.
- Focused and full verification gates pass.
