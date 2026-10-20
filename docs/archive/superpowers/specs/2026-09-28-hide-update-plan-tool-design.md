# Hide `update_plan` from Answer Timelines

## Problem

`update_plan` is an internal control operation whose useful state is already projected into the Main Card plan area. Native Herdr events currently classify the call as a generic Tool and emit an Answer timeline row. When the paired result contains no user-visible content, the card shows only `update_plan · ✓`, which is redundant noise.

## Decision

Treat `update_plan` as non-user-visible Tool activity at the shared classification boundary. TraeX transcript and native Herdr event projectors retain enough call identity for protocol pairing but emit neither Tool activity nor Answer timeline items for the call or any paired result.

The structured plan snapshot remains available through `mainStatus.planSteps` and continues to render in the Main Card. Assistant commentary around plan changes remains visible in the Answer. Existing persisted timeline rows are not rewritten.

## Boundary

Extend the shared visibility policy in `tool-activity-projector` to recognize internal control tool names in addition to the existing `Wait` category. The descriptor must carry a non-secret stable identity for this decision; no raw arguments or plan contents are retained for visibility checks.

## Verification

Regression coverage feeds `update_plan` calls with empty and structured success results through TraeX and native Herdr projectors. Both must emit no Answer Tool activity, while TraeX continues to project the supplied plan into `mainStatus.planSteps`. Existing visible command and Tool tests protect unrelated categories.
