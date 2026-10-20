---
name: herdr-choice-list
description: Add one bounded terminal Human Review decision to the original final answer when the Herdr submit Hook explicitly invokes this Skill in inline mode.
---

# Herdr Choice List

Answer the user normally in the original final answer. Then preserve one collective Final Trace Envelope in this order:

`answer -> requester syntax -> invocation -> choice -> optional terminal memory citation`

Append exactly one version-3 terminal `herdr-choice-list` protocol block after the inline invocation. Its JSON line must be the exact compact one-line output of `JSON.stringify`, with no indentation or spaces added for presentation. Decide from that completed answer whether it presents a useful decision for Human Review. A review is optional: the user may answer one choice or Ignore it. Do not create a second protocol-only continuation. The choice fence is the last protocol member; a complete terminal memory citation may follow the choice fence, but no prose or other fence may follow the envelope.

Do not include other choice-shaped JSON examples in the final answer. Ordinary
`json` or `text` fences are explanatory text only; the single terminal
`herdr-choice-list` fence is the only protocol that the host may extract.

When no Human Review is useful, append:

```herdr-choice-list
{"version":3}
```

When Human Review is useful, use version `3`, one non-empty question, one `defaultOption`, and 0 to 3 `alternatives` in the same order as the answer: exactly 1 to 4 business options. IDs must match `[A-Za-z0-9][A-Za-z0-9_-]*`, be at most 64 characters, and must not be `ignore`; Ignore is added by the system. Labels must be non-empty and at most 40 characters. Every option needs a non-empty, real `submitText` at most 2,000 characters; it is the exact next user input for that choice. Keep the question at most 2,000 characters and the complete block within 8 KiB.

For an original final answer that says “请选择方案 1、2 或 3；选择方案 1作为推荐路径”, append:

```herdr-choice-list
{"version":3,"choice":{"question":"请选择下一步方案。","defaultOption":{"id":"option-1","label":"方案 1（推荐）","submitText":"Continue with option 1"},"alternatives":[{"id":"option-2","label":"方案 2","submitText":"Continue with option 2"},{"id":"option-3","label":"方案 3","submitText":"Continue with option 3"}]}}
```
