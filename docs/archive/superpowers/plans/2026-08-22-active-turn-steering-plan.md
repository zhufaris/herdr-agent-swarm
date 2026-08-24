# Active-turn steering implementation plan

1. Extend prompt jobs with durable `turn`/`steering` dispatch classification and
   parent prompt identity. Add store tests for idempotent acceptance, separate
   claims, FIFO fallback, and restart recovery.
2. Add `HerdrPort.steerPrompt()` and adapter tests proving it sends text only
   after a structured `working` preflight, returns `not_working` without input,
   and reports command-stage failures as uncertain delivery.
3. Add steering lifecycle events and run-card reducer coverage. Steering cards
   acknowledge injection but never receive the parent turn's output or answer.
4. Add coordinator integration tests for one-waiter steering, ordered injection,
   duplicate-event suppression, blocked/FIFO fallback, and preflight races.
5. Track the active prompt per binding, classify new messages at acceptance, and
   serialize steering dispatch without creating another `runPrompt()` waiter.
6. Run focused tests, the full suite, typecheck, and build. Rebuild/restart the
   bridge and verify health, readiness, logs, and a safe live steering turn.
