# Answer Message-Loss Recovery Plan

1. Extend the rich-text edit-limit recovery regression to validate the replacement
   intent against a structured timeline cursor.
2. Pass the durable delivered cursor into `initialRichTextAnswerPayload` from the
   recovery transaction.
3. Change the native Herdr reader regression so a skipped record must emit a
   stable visible omission item while later output continues.
4. Project `record_skipped` as a bounded failed timeline Tool item.
5. Run focused tests, typecheck, build, and the full Vitest suite serially.
