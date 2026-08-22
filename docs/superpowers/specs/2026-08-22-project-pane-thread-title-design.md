# Project and pane thread titles

## Goal

Name Lark threads and their status cards with enough context to identify both
the project and the Herdr pane. The canonical display format is:

```text
project-name / pane-name
```

For example, a pane labeled `card-markdown` whose working directory is
`/data00/home/feiyu.zhu/work/herdr-lark-bridge` is displayed as:

```text
herdr-lark-bridge / card-markdown
```

## Name sources

For a pane discovered from Herdr, the project name is the basename of the
pane's `cwd`. The pane name is its non-empty label. If the label is absent, the
pane ID is used. If `cwd` is absent, only the pane name is displayed.

For a binding created from Lark with `/herdr new`, the project name is the
basename of `HERDR_WORKSPACE_CWD`, and the pane name is the title supplied by
the user. If the configured working directory has no usable basename, only the
user-supplied title is displayed.

`/herdr rename <name>` renames the Herdr pane to `<name>` and updates the
binding's Lark-facing title to `project-name / <name>`. The project prefix is
not written into the actual Herdr pane label.

## Normalization and limits

Project and pane components are trimmed and internal whitespace is collapsed.
Empty components are removed instead of producing a dangling separator. The
combined title is capped at 80 characters, preserving the project prefix and
truncating the pane component with an ellipsis where both components exist.
If the project component alone would consume the limit, it is truncated as
well so the rendered title never exceeds 80 characters.

The existing card renderer may apply its smaller header limit independently.
The binding title remains the canonical 80-character thread title.

## Component boundary

A pure title-formatting helper accepts a working directory and pane name and
returns the canonical display title. The coordinator uses this helper in three
places: Herdr discovery, Lark-originated binding creation, and `/herdr rename`.
No database migration is required because bindings already persist a title.

The Lark adapter continues to create the thread from the root card. The root
card header carries the canonical binding title, which becomes the visible
thread name under the existing integration behavior.

## Existing bindings

This change applies when a binding is created or explicitly renamed. Existing
bindings are not bulk-renamed during startup, avoiding unexpected edits to
historical Lark threads. A later `/herdr rename` brings an existing binding into
the new format.

## Verification

Automated tests cover:

1. formatting `cwd basename / pane label`;
2. whitespace normalization and the 80-character bound;
3. missing `cwd` and missing label fallbacks;
4. Herdr discovery using the pane's actual `cwd` and label;
5. Lark-originated creation using `HERDR_WORKSPACE_CWD`; and
6. rename preserving the project prefix while sending only the requested name
   to Herdr.

## Non-goals

- Renaming existing bindings automatically at startup.
- Adding the project prefix to the Herdr pane label.
- Deriving a project name from Git remotes, package manifests, or repository
  metadata.
- Changing request-card titles, which continue to summarize each individual
  user request.
