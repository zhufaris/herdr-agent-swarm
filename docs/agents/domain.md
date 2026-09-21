# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- Read `CONTEXT-MAP.md` at the repo root.
- Follow it to every `docs/domain/<context>/CONTEXT.md` relevant to the task.
- Read system-wide ADRs under `docs/adr/` when they exist and touch the area being changed.
- Read context-scoped ADRs when a context later introduces its own `docs/adr/` directory.

If an ADR directory does not exist, proceed silently. Do not suggest creating ADRs upfront. The domain-modeling workflow creates them lazily when a decision is actually resolved.

## File structure

This repository uses a multi-context layout:

```text
/
├── CONTEXT-MAP.md
├── docs/
│   ├── adr/                         # system-wide decisions, when present
│   └── domain/
│       ├── primary-session/CONTEXT.md
│       ├── prompt-execution/CONTEXT.md
│       ├── worker-runtime/CONTEXT.md
│       ├── conversation-projection/CONTEXT.md
│       └── delivery-operations/CONTEXT.md
└── src/
```

The current contexts are Primary Session, Prompt Execution, Worker Runtime, Conversation Projection, and Delivery and Operations. `CONTEXT-MAP.md` is the routing authority when contexts are added, renamed, or split.

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term defined in the relevant context document. Do not drift to synonyms the glossary explicitly avoids.

If the needed concept is absent, reconsider whether it is language the project actually uses or note a genuine domain-model gap for the domain-modeling workflow.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly instead of silently overriding it. Cite the ADR and explain why reopening the decision may be justified.
