# TraeX approval lifecycle implementation plan

1. Add an adapter contract test that holds a turn open while Herdr reports
   `blocked`, observes the transition once, and completes only after approval.
2. Extend `HerdrPort.runPrompt()` with an intermediate state observer and make
   `HerdrCliAdapter` prefer structured pane state while retaining terminal-text
   fallback behavior.
3. Add a coordinator integration test proving the blocked card is published and
   a second prompt remains queued until the first turn resumes and completes.
4. Wire observed states through the coordinator, remove terminal handling of
   returned `blocked`, and preserve FIFO ownership for the active turn.
5. Add timeout coverage, then run focused tests, the full suite, typecheck, build,
   and live health/readiness checks.
