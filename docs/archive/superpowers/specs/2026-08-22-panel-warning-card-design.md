# Panel warning card semantics

## Goal

Make Lark cards clearly distinguish states that need user attention from terminal
failures. A Herdr panel that is waiting for user input, approval, or another
recoverable intervention is a warning. A turn that has already failed remains an
error.

## State mapping

The existing domain phases remain authoritative. This change does not add a new
phase or migrate persisted card state.

| Domain state | Card meaning | Header color | Default label |
| --- | --- | --- | --- |
| `blocked` | Waiting for user action or another recoverable intervention | Orange | Waiting for user action |
| `orphaned` | Binding needs recovery | Orange | Binding warning |
| `failed` / `error` | Execution has terminated unsuccessfully | Red | Execution failed |
| `queued` / `running` | Normal non-terminal execution | Blue | Existing label |
| `completed` / `done` | Successful completion | Green | Existing label |

Expired and unauthorized project-selection cards remain orange because the user
can recover by opening a new selector or using an authorized selector. Project
creation failures remain red.

## Rendering behavior

Both topic cards and request-scoped run cards render `blocked` with an orange
header and an orange callout titled `需要处理`. The status label is generic and
must not claim that terminal approval is always the reason.

When a blocked run has a non-empty `notice`, the callout renders that notice.
Otherwise it renders generic guidance telling the user to inspect the matching
Herdr panel and complete the required interaction. This covers user questions,
approval prompts, and other panel warnings without parsing terminal prose.

Topic cards do not currently persist a structured blocked reason. Until that
contract changes, they render the same generic guidance. Error and failed cards
continue to use a red header and red callout.

## Boundaries

- Do not infer warning categories by parsing terminal text.
- Do not expose approval or response buttons in Lark. User interaction remains in
  the Herdr panel.
- Do not convert timeouts, command failures, or failed turns into warnings.
- Do not change queueing, execution, persistence, or event-delivery behavior.

## Verification

Card rendering tests must prove that:

1. blocked topic and request cards use orange headers and generic user-action
   labels;
2. a blocked request uses its supplied notice when available;
3. default blocked guidance refers to the corresponding Herdr panel without
   asserting that approval is required; and
4. failed request and error topic cards remain red.
