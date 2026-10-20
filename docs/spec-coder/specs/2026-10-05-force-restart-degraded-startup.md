# Force Restart of Degraded Startup

## Problem Statement

The restart safety evaluator tells operators to retry with `--force` when startup recovery is degraded, but it rejects every non-`completed` startup state even under force. A non-required one-shot startup stage can therefore leave a healthy running unit permanently unable to use the supported restart path, including the restart needed to deploy its repair.

## Solution

Under explicit `--force`, allow only the terminal `degraded` startup state to pass this gate. Continue to reject `running`, missing, and unknown startup states. Preserve identity validation and SQLite `quick_check=ok` as non-bypassable gates. Existing force behavior for workload and business-integrity debt remains unchanged.

## User Stories

- **R1:** an operator can force-restart a unit whose startup completed in degraded state after a non-required stage failure.
- **R2:** force cannot interrupt startup while its state is `running`.
- **R3:** missing/unknown startup diagnostics, foreign identity, or failed SQLite quick-check still fail closed.

## Implementation Decisions

`RestartSafetyEvaluator` owns this pure policy. `degraded` means the startup workflow reached completion and exposed failed optional stages; it is distinct from `running`. No service lifecycle, systemd, process, or persistence behavior changes.

## Testing Decisions

Add policy tests proving forced degraded admission, unforced degraded rejection, and forced unknown-state rejection. Retain existing forced-running, incomplete-metrics, identity, quick-check, active-work, and non-force tests. Operator guidance must recommend force only when it can change the outcome. Run focused lifecycle tests, typecheck, build, full suite, review, install, and live forced restart.

## Out of Scope

- bypassing a running startup;
- bypassing identity or physical SQLite corruption;
- changing which startup stages are required.

## Further Notes

- In-place `main`, starting at `cc59837bf0d23f1369e1c6e70688a2fabda73dda`.
- Existing user dirty files remain untouched.
- Standing deployment authorization applies.
