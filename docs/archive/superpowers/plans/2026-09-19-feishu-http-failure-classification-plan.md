# Feishu HTTP Failure Classification Implementation Plan

1. Change focused Feishu classification tests to encode the retryable 4xx allowlist
   and permanent default for other 4xx responses.
2. Run the focused test to observe the generic-400 failure against current code.
3. Add a small status predicate in the Feishu error adapter and keep provider-code
   recovery precedence intact.
4. Change the outbox integration assertion from five attempts and unknown failure to
   one attempt and permanent rejection.
5. Run focused tests, typecheck, build, architecture check, and the full suite.
6. Commit the behavior independently before proceeding to code-simplification work.
