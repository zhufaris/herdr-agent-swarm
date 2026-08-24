# Bounded prompt shutdown implementation plan

1. Extend `HerdrPort.runPrompt` with an optional `AbortSignal` and forward it
   through the workspace cache wrapper.
2. Make Herdr prompt submission and turn polling check cancellation between
   bounded CLI calls and sleeps; keep `pane get` as the authoritative liveness
   check.
3. Track an AbortController per active coordinator turn. During stop, allow a
   30-second grace period, abort remaining turns, and await complete settlement
   before returning.
4. Preserve uncertainty semantics: interrupted running prompts become failed
   and are never automatically replayed; queued work remains durable.
5. Add adapter and coordinator shutdown tests, run the full suite and build,
   then deploy only when no healthy active turn would be unnecessarily cut off.
