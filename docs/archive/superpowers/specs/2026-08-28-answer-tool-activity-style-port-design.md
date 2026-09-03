# Answer Tool Activity Style Port Design

## Goal

Port the command tool-call rendering introduced by `herdr-lark-bridge` commit
`ca321c9` into Herdr Agent Swarm without importing unrelated bridge changes.

## Design

Successful, running, and failed command activities use the `◆ **Ran**` heading.
The command remains in a `bash` fence and captured output remains in a `text`
fence. Canonical projected output stays complete in durable state. Only the
Answer Card renderer folds output longer than 20 lines into the first 10 lines,
an omission marker, and the last 9 lines, prefixing visible detail with tree
guides. Pagination treats a bounded command activity as atomic when it fits on
one page so the heading, command, and result are not split unnecessarily.

The port is restricted to `tool-activity-projector.ts`, `lark-markdown.ts`, and
their focused tests. Existing Agent Swarm functionality and the pending Lark
`post` normalization change remain intact.

## Verification

The source repository's projector expectations and six representative folding
cases are reproduced in Agent Swarm. Focused projector, answer-stream, and Lark
adapter tests run before typecheck and build. Deployment uses the supported
standalone restart path and must report the new build as ready.
