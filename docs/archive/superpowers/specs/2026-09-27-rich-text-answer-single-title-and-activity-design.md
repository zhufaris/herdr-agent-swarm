# Rich-text Answer Single-title and Activity Rendering Design

## Goal

Make new Primary and Worker rich-text Answers show one visible metadata title,
render command activity as native highlighted Bash blocks, and use `💭` as the
active generation marker. Preserve the code-language materialization introduced
by `fc45debb` and the durable Answer pagination protocol.

## Observed failure

The active release writes the same metadata title into both the Feishu post
`title` field and the first bold content row. Clients that display native post
titles therefore show two identical title lines. The active release also
predates the command-block and thinking-marker changes, so it renders command
activity inline and ends active Answers with `▌`.

A production `vdfn` turn crossed two deployments: pages produced by the newer
renderer used Bash blocks and `💭`, while pages produced after an older release
was activated reverted to the legacy format. The mixed result is a release
coordination issue rather than nondeterministic pagination.

## Chosen design

### One title authority

`RichTextDocument.title` remains the canonical page title. The Feishu gateway
places it only in `zh_cn.title`; it no longer prepends a duplicate bold text row
to `zh_cn.content`. The Markdown body remains unchanged and starts with Answer
content or activity. Continuation titles retain the existing `· 续 N` suffix.

This favors the current observed Feishu client behavior, where native post
titles are visible. It avoids heuristic client detection and keeps title
construction independent from gateway materialization.

### Activity rendering

The shared Primary/Worker rich-text renderer uses:

- fenced `bash` blocks for `command` and `test` timeline items that carry a
  command;
- compact single-line rows for Read, Search, Edit, Step, and command items that
  have no command text;
- a quoted result preview after a command block;
- `💭` only on active pages, including the initial placeholder;
- no activity marker on frozen, completed, or failed pages.

Commands retain line breaks, pass through ANSI stripping and secret redaction,
are bounded before delivery, and use a fence longer than any embedded backtick
run. Feishu materialization converts recognized fenced languages, including
`bash`, into native `code_block` elements and retains the current language map.

### Pagination and recovery

`answer_timeline_items` remains canonical. Rendering remains a presentation-only
transform and does not change timeline ordering, cursor offsets, page size,
checkpoint fingerprints, or the rule that frozen pages are immutable. Existing
frozen pages are not rewritten; new Answers use the corrected format throughout
when one combined release remains active.

### Release coordination

The implementation is based on `fc45debb` in an isolated checkout and includes
both its code-language preservation and the newer activity rendering. Before
installation, validation records the candidate commit and build ID. After
activation, status must report that exact pair and `readiness.status=ready`.
No second checkout may install another release during this verification window.

## Tests

Focused tests must prove:

1. A titled rich-text document has one native title and no duplicate title row.
2. Untitled documents still materialize normally.
3. Bash, TypeScript, and Python fences retain native code-block languages.
4. Command and test activities produce safe Bash blocks.
5. Active Answers and placeholders end in `💭`; terminal pages do not.
6. Primary and Worker workflows preserve titles, task lists, pagination, and
   terminal transitions.
7. A captured production transcript replay contains the pane token, tool emoji,
   task list, and Bash blocks without changing canonical cursor behavior.

## Non-goals

- Rewriting already frozen Answer pages.
- Changing SQLite schemas or stored canonical timeline items.
- Rebuilding `herdr-core`.
- Changing Main Card title layout or other CardKit cards.
