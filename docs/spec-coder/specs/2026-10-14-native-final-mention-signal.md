# Native Final Mention Signal

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

The Feishu final-trace contract asks an agent to append one native
`<at id=ou_...></at>` line before the terminal `herdr-choice-list` fence. The
canonical Core final retains that line, but the conservative Lark Markdown
normalizer removes all HTML-like tags before an Answer or Turn Card reaches the
outbox. Consequently, a syntactically correct native mention never becomes a
durable requester notification.

The repository already has a trusted Final Request Mention protocol using the
structural `@_user_1` marker. A submission-backed Primary Conversation Segment
resolves the exact human actor from its immutable Submission Intent, renders a
trusted mention in the final Turn Card, and releases one deterministic
standalone notification only after that card revision is acknowledged. The
missing behavior is a safe compatibility translation from the canonical native
mention line to that existing requester-owned lifecycle.

## Solution

Extend the Final Request Mention domain projection to recognize one exact
standalone native mention line at the end of the visible final answer. Treat
the embedded OpenID as untrusted compatibility syntax with no recipient or
authorization meaning, remove the protocol line from visible Markdown, and let
the Conversation Segment completion transition resolve the immutable
Submission Intent actor as the sole notification recipient.

Keep raw HTML passthrough disabled. Keep `@_user_1` behavior compatible only as
an input protocol and always remove the literal marker before CardKit rendering;
new standard finals need only the native mention line. Reuse the existing
final-card acknowledgement, completion obligation, deterministic outbox, retry,
and dead-letter lifecycle without schema or delivery changes.

## User Stories

### SCN-1: A native final mention notifies the exact requester

Given a submission-backed Primary Segment whose final visible answer ends with
one standalone `<at id=OPEN_ID></at>` line, the protocol line is removed from
visible Markdown and requests the existing requester-owned completion
presentation. `OPEN_ID` is ignored for recipient selection; the immutable
Submission Intent actor is the only recipient. The standalone notification
remains ineligible until the exact final-card revision is acknowledged.

### SCN-2: Untrusted or ambiguous native mentions fail closed

A malformed native mention, multiple candidate lines, a non-terminal position,
inline-code placement, or fenced-code placement cannot request a Final Request
Mention. A syntactically valid but stale or incorrect embedded OpenID may still
request the current Submission Intent actor, but can never select that embedded
identity as the recipient. Ordinary answer content remains visible subject to
the existing conservative Markdown normalization.

### SCN-3: Human Review authority remains independent

A valid terminal `human_review` choice continues to create its requester-owned
presentation from the Submission Intent actor. A forged native mention cannot
change the actor, callback authority, options, notification target, or
acknowledgement ordering.

### SCN-4: Duplicate projection remains idempotent

Repeated Core projection, restart recovery, card acknowledgement retry, or
outbox retry cannot create a second completion obligation or repeat Agent
Input. Existing owner, generation, card, and delivery idempotency identities
remain authoritative.

## Implementation Decisions

### INV-1: Submission Intent actor is the sole mention authority

Agent output may request notification but cannot select its recipient. A native
candidate's embedded OpenID is ignored after bounded syntax validation. The
valid human Feishu actor restored from the Segment's immutable Submission Intent
is the sole notification recipient and callback authority.

### INV-2: Agent Markdown remains untrusted

Recognizing a protocol line does not permit native HTML or `<at>` passthrough.
The Final Request Mention projection removes an accepted protocol line, and the
existing Lark Markdown normalizer continues stripping all other HTML-like tags.

### INV-3: Native mention syntax is terminal and unambiguous

The native form is eligible only as one exact standalone nonempty line at the
end of the visible final answer after the terminal choice fence is removed.
Candidate markup inside inline code or fenced code is content, not a request.
Multiple native candidates or trailing visible content reject native request
authorization.

### INV-4: Durable notification ordering is unchanged

Recognizing a request does not create an external effect. The exact final-card
revision must be durably acknowledged before the existing completion
obligation may reserve its deterministic outbox notification.

### INV-5: Structural role-marker compatibility is preserved

The existing `@_user_1` marker retains its current semantics. It requests the
trusted current Submission Intent actor without embedding an OpenID, but the
literal marker must never appear in visible Answer or Turn Card content. Native
syntax is the standard final form; the role marker remains input compatibility
only and is not appended to new rendered final messages.

### ARCH-1: Final Request Mention remains a deep domain projection

`projectFinalRequestMention` owns Markdown-aware recognition and visible-text
cleanup. Its interface returns cleaned Markdown plus a discriminated request:
no request, structural role marker, or native mention signal. Callers do not
reimplement code-fence, inline-code, terminal-line, or ambiguity rules.

The module also exposes one pure request operation that distinguishes a
structural role marker or syntactically valid native mention from no request.
It does not compare, return, or authorize the embedded native OpenID as a
recipient. It imports no SQLite, CardKit, Lark SDK, or coordinator type.

### ARCH-2: Conversation Projection owns actor fencing and persistence coordination

The Conversation Segment store reads canonical final text and choice metadata,
uses the domain projection for mention-request evidence, restores the Submission
Intent actor inside its existing transaction, and applies `INV-1` before
persisting a completion notice. The store passes only its already trusted
`mentionOpenId` to presentation state and never persists the embedded native ID.

Choice-bearing completion remains independently eligible. A stale or forged
native ID alongside a valid `human_review` choice cannot change the legitimate
choice actor, callback authority, or notification target; both paths resolve
the same real Submission Intent actor.

### ARCH-3: Delivery and presentation interfaces do not change

Turn Card rendering, completion obligations, action sets, delivery
acknowledgements, outbox payloads, retries, and dead-letter handling consume the
same trusted DTOs and durable identities as before. No schema migration, new
port, new repository, or new external event is introduced.

### ARCH-4: Canonical Core evidence is preserved

Core event JSON remains byte-for-byte canonical. Translation occurs while
projecting a view and deciding a trusted completion effect; ingestion does not
rewrite `<at>` into `@_user_1` and persistence does not infer authority from
rendered card content.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, INV-1, INV-2, INV-3, INV-4, INV-5, ARCH-1, ARCH-2, ARCH-3, ARCH-4

Extend the Final Request Mention unit tests first. Observe a focused failure for
the canonical final answer followed by native mention and a terminal choice
fence. Cover native request projection, whitespace cleanup, structural marker
input compatibility and literal-marker removal, inline/fenced code,
non-terminal placement, malformed IDs, multiple candidates, and trailing
visible content.

At the real temporary-SQLite Conversation Segment seam, prove that a valid
native signal creates one completion obligation for the Submission Intent actor
even when the embedded ID is stale or different, and that a valid Human Review
choice still uses the real actor when raw mention text names another user.
Reproject the same terminal evidence and reopen the database to verify
idempotency and restored behavior.

At the event projection seam, prove that recognized native protocol markup does
not appear in visible final Markdown. Preserve the existing tests that ordinary
HTML-like tags are not passed through.

Run the focused Final Request Mention, Core event projection, and Conversation
Segment tests, then `npm run typecheck`, `npm run architecture:check`, `npm run
build`, `git diff --check`, and the full `npm test` suite.

## Out of Scope

- Passing arbitrary HTML or native `<at>` markup through Answer Markdown.
- Extending Worker completion behavior or direct-Herdr owner-less turns.
- Changing Human Review option semantics, callbacks, or `herdr-choice-list`.
- Schema migrations, historical backfill, production SQLite mutation, or
  replaying prior final messages.
- Installation, deployment, service restart, push, pull request, or external
  issue publication.

## Further Notes

Gate 1 approved the domain-projection approach on 2026-10-14. Live evidence then
showed that the configured native ID (`ou_8aa...`) differed from the actual
Submission Intent actor (`ou_649...`), invalidating exact-ID matching. Reopened
Gate 1 approved treating native ID as non-authoritative syntax while retaining
Submission Intent as the sole actor authority. No glossary term or qualifying
ADR is required: this refines the existing Final Request Mention protocol
without changing context ownership.

Workspace: isolated Git worktree
`/tmp/herdr-agent-swarm-final-mention-signal`, branch
`fix/final-trace-mention-signal`, starting revision
`203e83758a40a5c8f67310dcde3175a60e2619a1`. The original checkout had unrelated
modified and untracked files, and the deployed per-pane branch had 102 unrelated
baseline failures in a clean worktree, so neither was used for mutation.

Dependencies were installed with `npm ci`; npm reported seven existing high
severity audit findings, whose remediation is outside this task. Fresh baseline
records observed by main in this uninterrupted request:

- `npm run build`: record `f176a4fa62374b56a846f60603b20731`, exit 0.
- `npm test`: record `e8e8e9681ff74adfaa60a686b86bcc2c`, exit 0; 298 files and 4,459 tests passed.
- `npm run typecheck`: record `d53ef43050b241558359c854896da376`, exit 0.
- `npm run architecture:check`: record `4cd43d6362614924befa0041a6f7e3be`, exit 0; 531 source files checked.

The complete emitted evidence records remain in the task-owned `/tmp` files
`mention-native-*-evidence.json`; they are not repository artifacts. No
load-bearing decision remains unresolved.
