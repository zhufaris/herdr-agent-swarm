# Pane Title Review Remediation Design

## Goal

Close the behavioral and documentation gaps found while reviewing the Primary/Worker pane-title change without expanding the naming model or disturbing unrelated prompt-settlement work.

## Identity and presentation boundary

A Primary pane title is runtime identity, not free-form presentation. Every new, reset, or replacement Primary pane receives a newly generated four-character base-36 token. The Herdr adapter remains responsible for rendering that semantic token as `lark_<token>`.

The optional text in `/swarm reset <description>` is user-facing context. It must not replace or alter the runtime token. The replacement binding title may retain the normalized description for Lark presentation, while pane creation receives only the generated token. A blank or omitted description falls back to the token in the binding title.

```text
/swarm reset fresh session
          |
          +-- presentation description --> binding/Lark title
          |
          +-- generated identity token ----> Herdr pane title lark_ab12
```

Replacement uses the same provisioning path and therefore the same token rule.

## Worker naming boundary

Worker names have already passed the domain rule `[a-z][a-z0-9_-]{0,31}`. Pane-title construction must preserve that validated value verbatim:

```text
lark_<primary-token>-<worker-name>
```

It must not run the name through legacy pane-label cleanup, because names such as `task-reviewer` and `lark_ops` are valid domain values. Filesystem/worktree resource names continue to use their separate defensive sanitizer.

## Scope

The change will:

- rename the misleading local Primary-token helper or remove it in favor of `createPrimaryPaneToken()`;
- separate reset pane identity from its optional display description;
- preserve validated Worker names in pane titles;
- add explicit tests for described reset, replacement, and prefix-shaped Worker names;
- update `docs/feishu-group-usage.md` to describe `lark_<token>` titles.

The change will not introduce branded string types or alter Worker resource paths, command syntax, stored schemas, or recovery semantics.

## Error handling and compatibility

Existing reset durability and recovery checkpoints remain unchanged. Legacy Primary labels remain readable by `primaryPaneToken()`. New pane creation uses the canonical token-only identity, while existing panes are not renamed.

## Verification

Focused lifecycle, instance-control, command, and pane-title tests must pass. The final verification includes TypeScript type checking, build generation, and the full Vitest suite.
