# Exact Composer Prompt Confirmation

## Problem

Fallback prompt injection currently confirms a paste by counting occurrences of
the normalized prompt across the entire terminal snapshot. Short prompts such as
`hi` collide with unrelated UI text such as `shift`, while an earlier unsubmitted
composer value can be appended again as `hihi`. The bridge then either sends Enter
without proving the current composer content or times out after the text is already
present.

## Decision

Confirm fallback prompt delivery only against the active TraeX composer at the
bottom of the bounded terminal snapshot. Historical answers, status bars, and other
terminal text are not evidence that the current prompt was pasted.

Before sending text, classify the active composer:

- empty: send the prompt text, then wait until the active composer equals the
  normalized prompt exactly before sending Enter;
- equal to the prompt: treat it as a recoverable unsubmitted paste and send Enter
  without appending the prompt again;
- non-empty and different: reject with `composer_not_empty` and preserve the local
  draft;
- unavailable: retain the bounded confirmation wait after sending text, but accept
  only an exact active-composer match.

Soft-wrapped composer lines form one logical composer value. Decorative composer
markers and whitespace are ignored, but prompt content is not matched as a generic
substring.

## Delivery safety

The bridge invokes `onDispatched` only when Enter is sent or native Agent dispatch
may already have reached TraeX. Once that boundary is crossed, the prompt is never
automatically replayed. A different non-empty composer draft is never cleared or
overwritten.

## Testing

Adapter regression tests cover:

- a short `hi` prompt when unrelated terminal UI contains `shift`;
- a composer already containing exactly `hi`, which sends only Enter;
- a composer containing a different draft, which is preserved and rejected;
- a soft-wrapped composer containing the exact prompt;
- absence of Enter when exact composer confirmation never appears.

The existing integration and full test suites remain the deployment gate.
