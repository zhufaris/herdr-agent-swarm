# Structured Terminal Block Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse explicit TraeX `Edited`, `Ran`, and `Bash` terminal output into typed blocks and serialize reliable `diff`, `bash`, and `text` Markdown without guessing at unmarked prose.

**Architecture:** Add a pure `traex-terminal-blocks` module between terminal overlap extraction and Markdown output. It derives bounded continuation from the previous terminal snapshot, parses the new delta into typed blocks, and serializes balanced Markdown; the existing parser API, durable Answer model, source-aware pagination, and CardKit delivery remain unchanged.

**Tech Stack:** TypeScript ESM, Node.js 22.5+, Vitest, Lark CardKit Markdown

**Spec:** `docs/superpowers/specs/2026-08-26-structured-terminal-block-parser-design.md`

## Global Constraints

- Classify commands only from explicit TraeX `◆ Ran` or `• Bash` markers.
- Classify diffs from explicit `◆ Edited` blocks; retain numbered-diff rendering only as a historical fallback.
- Never infer Bash from unmarked prose.
- Keep `parseTerminalStreamDelta`'s public return contract unchanged.
- Do not add SQLite state or alter canonical Answer source offsets.
- Preserve 9,000-character Answer pages and frozen-page immutability.
- Keep reasoning removal, terminal chrome filtering, and secret redaction effective for every block kind.
- Do not modify generated `dist/` directly.

---

### Task 1: Typed blocks and explicit Edit parsing

**Files:**
- Create: `src/runtime/traex-terminal-blocks.ts`
- Create: `tests/traex-terminal-blocks.test.ts`

**Interfaces:**
- Consumes: normalized terminal strings after ANSI removal and overlap extraction.
- Produces:

```ts
export type TerminalBlock =
  | { kind: "prose"; lines: string[] }
  | { kind: "diff"; title: string | null; lines: string[] }
  | { kind: "command"; title: string; command: string | null; output: string[] }
  | { kind: "status"; lines: string[] };

export type TerminalContinuation =
  | { kind: "none" }
  | { kind: "diff"; title: string | null }
  | { kind: "command"; title: string; command: string | null };

export function deriveTerminalContinuation(previous: string): TerminalContinuation;
export function parseTraexTerminalBlocks(source: string, continuation?: TerminalContinuation): TerminalBlock[];
export function renderTraexTerminalBlocks(blocks: readonly TerminalBlock[]): string;
```

- [ ] **Step 1: Write failing Edit and prose tests**

Add table-driven assertions for a complete compact Edit block, an Edit body that
starts in a later observation, a folded `⋮` row, and unmarked signed prose. The
core expectations are:

```ts
expect(parseTraexTerminalBlocks([
  "◆ Edited src/model.py (+2 -0)",
  "  10      existing = true",
  "  11 +    first = true",
  "  12 ⋮",
  "  20 +    second = true"
].join("\n"))).toEqual([{
  kind: "diff",
  title: "◆ Edited src/model.py (+2 -0)",
  lines: [
    "  10      existing = true",
    "  11 +    first = true",
    "  12 ⋮",
    "  20 +    second = true"
  ]
}]);

expect(parseTraexTerminalBlocks("+ prose\nGrowth was +12%")).toEqual([
  { kind: "prose", lines: ["+ prose", "Growth was +12%"] }
]);
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run: `npx vitest run tests/traex-terminal-blocks.test.ts`

Expected: FAIL because the new module does not exist.

- [ ] **Step 3: Implement the block types and Edit state machine**

Implement a line-oriented loop with explicit states. `◆ Edited` opens `diff`;
numbered context/change/fold rows remain in that block; any unrelated marker or
line flushes it. A supplied `{ kind: "diff" }` continuation treats compatible
leading rows as a diff without repeating the title. Unknown content is accumulated
as prose without altering line boundaries.

Use small predicates with these responsibilities:

```ts
function isEditedHeading(line: string): boolean;
function isEditedBodyRow(line: string): boolean;
function flushBlock(output: TerminalBlock[], pending: PendingBlock): void;
```

- [ ] **Step 4: Implement deterministic diff/prose serialization**

Serialize Edit blocks as a title followed by a balanced fence:

````text
◆ Edited src/model.py (+2 -0)
```diff
  10      existing = true
  11 +    first = true
```
````

Serialize prose with `normalizeLarkPreview(lines.join("\n"))`. An empty block
emits nothing, and every emitted diff fence closes within the same delta.

- [ ] **Step 5: Run the new unit suite**

Run: `npx vitest run tests/traex-terminal-blocks.test.ts`

Expected: all Edit, continuation, folded-row, and prose tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/runtime/traex-terminal-blocks.ts tests/traex-terminal-blocks.test.ts
git commit -m "refactor: parse TraeX terminal blocks"
```

### Task 2: Explicit command and output blocks

**Files:**
- Modify: `src/runtime/traex-terminal-blocks.ts`
- Modify: `tests/traex-terminal-blocks.test.ts`

**Interfaces:**
- Consumes: the `TerminalBlock` and `TerminalContinuation` unions from Task 1.
- Produces: populated `command` blocks for `◆ Ran` and `• Bash`, plus Markdown serialization into separate `bash` and `text` fences.

- [ ] **Step 1: Write failing command parsing tests**

Cover a one-line Ran command, a terminal-width command continuation, output after
`└`, a `• Bash` marker, output containing JSON/diff-like text, and unmarked shell
text. Assert the concrete shape:

```ts
expect(parseTraexTerminalBlocks([
  "◆ Ran git diff --check && npm",
  "  │ test",
  "  └ PASS tests/parser.test.ts",
  "    1 + stdout that resembles a diff"
].join("\n"))).toEqual([{
  kind: "command",
  title: "◆ Ran",
  command: "git diff --check && npm test",
  output: ["PASS tests/parser.test.ts", "    1 + stdout that resembles a diff"]
}]);
```

Also assert that `echo hello` without a marker remains a `prose` block.

- [ ] **Step 2: Run the command tests and confirm they fail**

Run: `npx vitest run tests/traex-terminal-blocks.test.ts`

Expected: command fixtures are classified as prose or have the wrong shape.

- [ ] **Step 3: Implement explicit command recognition**

Parse text after `◆ Ran` or `• Bash` as the command. Join only immediately
following `│` rows into that command. Treat `└` as the first output line and keep
subsequent output lines verbatim until another explicit TraeX marker, composer, or
separator. Derive command continuation only when the last explicit marker in the
previous snapshot is `Ran` or `Bash` and no later boundary closed it.

Add focused helpers:

```ts
function parseCommandHeading(lines: readonly string[], start: number): {
  title: string;
  command: string | null;
  next: number;
};
function stripOutputBranch(line: string): string;
```

- [ ] **Step 4: Serialize commands and stdout separately**

Use this exact layout for a populated command block:

````text
◆ Ran
```bash
git diff --check && npm test
```
```text
PASS tests/parser.test.ts
```
````

Omit `bash` when `command` is null and omit `text` when output is empty. Never run
Markdown normalization inside either code fence.

- [ ] **Step 5: Verify command, diff, and prose fixtures together**

Run: `npx vitest run tests/traex-terminal-blocks.test.ts`

Expected: all fixtures pass, including unmarked shell-like prose.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/runtime/traex-terminal-blocks.ts tests/traex-terminal-blocks.test.ts
git commit -m "feat: structure TraeX command output"
```

### Task 3: Integrate blocks into terminal streaming

**Files:**
- Modify: `src/runtime/traex-output-parser.ts`
- Modify: `tests/traex-output-parser.test.ts`
- Modify: `tests/traex-output-parser-native-regression.test.ts`

**Interfaces:**
- Consumes: `deriveTerminalContinuation`, `parseTraexTerminalBlocks`, and `renderTraexTerminalBlocks` from Task 1.
- Produces: the unchanged `parseTerminalStreamDelta(previousRaw, currentRaw, promptEcho): ParsedTerminalStreamDelta` API.

- [ ] **Step 1: Add failing integration assertions**

Update existing parser expectations so a `◆ Ran` sample produces separate `bash`
and `text` fences. Keep assertions for prompt echo removal, banner removal,
subagent-console filtering, telemetry, redraw `replace-all`, and the existing
compact Edit behavior. Add a secret-bearing command fixture and assert its token
is redacted inside the fence.

- [ ] **Step 2: Run parser integration tests and confirm failure**

Run:

```bash
npx vitest run tests/traex-output-parser.test.ts tests/traex-output-parser-native-regression.test.ts
```

Expected: command Markdown assertions fail while unchanged parser behavior remains
green.

- [ ] **Step 3: Replace inline tool parsing with the new module**

In `parseTerminalStreamDelta`, keep `terminalDelta` and `update` selection, then
replace the `normalizeTerminalForLark` call with:

```ts
const continuation = deriveTerminalContinuation(previous);
const blocks = parseTraexTerminalBlocks(overlap.value, continuation);
const rendered = renderTraexTerminalBlocks(blocks);
```

Keep reasoning removal, prompt-echo filtering, separator filtering, whitespace
bounding, secret redaction, telemetry, and `MAX_TERMINAL_DELTA_CHARS` around this
result. Delete the superseded `Edited` continuation and tool-heading helpers only
after all their behavior is represented in the new module tests.

- [ ] **Step 4: Run parser and Markdown/CardKit tests**

Run:

```bash
npx vitest run tests/traex-terminal-blocks.test.ts tests/traex-output-parser.test.ts tests/traex-output-parser-native-regression.test.ts tests/lark-markdown.test.ts tests/answer-stream.test.ts tests/event-card-integration.test.ts
```

Expected: all tests pass; the large continuation integration test completes within
its existing timeout.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/runtime/traex-output-parser.ts tests/traex-output-parser.test.ts tests/traex-output-parser-native-regression.test.ts
git commit -m "refactor: render terminal output from typed blocks"
```

### Task 4: Captured regression fixture, architecture, and release gate

**Files:**
- Create: `tests/fixtures/task-jz33-terminal-output.txt`
- Modify: `tests/traex-terminal-blocks.test.ts`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: the public block parser and serializer from Task 1.
- Produces: a sanitized durable regression artifact and updated architectural source of truth.

- [ ] **Step 1: Add the sanitized task-jz33 fixture**

Include representative, non-secret sections for:

```text
◆ Edited scripts/render_domain.py (+20 -3)
    145 +        *_table(
    146 +            ["Relationship", "Count"],
    147 ⋮
    180 -        return old_value
◆ Ran uv run pytest -q tests/test_render.py
  └ 11 passed in 0.44s
```

Do not copy prompt bodies, credentials, live IDs, or unrelated terminal history.

- [ ] **Step 2: Assert the fixture's block and Markdown output**

Read the fixture with `readFileSync`, parse it, and assert:

- one `diff` block with distinct context/change/fold rows;
- one `command` block with command `uv run pytest -q tests/test_render.py`;
- balanced `diff`, `bash`, and `text` fences;
- no concatenation such as `147 ⋮180`;
- no source line loss.

- [ ] **Step 3: Update architecture documentation**

In `docs/architecture.md`, replace the description of regex-oriented terminal
normalization with the typed-block pipeline. State that native structured tool
events may later feed the same block serializer, while terminal parsing remains
the current fallback.

- [ ] **Step 4: Run all release checks**

Run in order:

```bash
npx vitest run tests/traex-terminal-blocks.test.ts tests/traex-output-parser.test.ts tests/traex-output-parser-native-regression.test.ts tests/lark-markdown.test.ts tests/answer-stream.test.ts tests/event-card-integration.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: focused tests, all Vitest files, typecheck, build, and whitespace checks
all succeed.

- [ ] **Step 5: Commit Task 4**

```bash
git add tests/fixtures/task-jz33-terminal-output.txt tests/traex-terminal-blocks.test.ts docs/architecture.md
git commit -m "test: lock down structured terminal rendering"
```

- [ ] **Step 6: Build and deploy the committed tree**

After confirming the worktree contains no unrelated uncommitted source changes,
run `npm run build` and:

```bash
herdr plugin action invoke restart --plugin herdr-lark-bridge
```

If unrelated work is present, build the final commit in a temporary detached
worktree and copy only its generated `dist/` into the linked plugin root before
restarting.

- [ ] **Step 7: Verify deployed identity and delivery health**

Query `/status` using the plugin's private `.env` host and port. Confirm:

- `identity.gitCommit` equals the final implementation commit;
- `status=ok` and `readiness.status=ready`;
- Lark and Herdr are healthy;
- outbox blocked, stalled, and active quarantine counts are zero.

Replay the sanitized fixture through the deployed `dist` parser and assert balanced
`diff`, `bash`, and `text` fences. Prefer a naturally occurring live `Edited` or
`Ran` payload for final confirmation; do not inject a prompt into an active user
task solely for validation.
