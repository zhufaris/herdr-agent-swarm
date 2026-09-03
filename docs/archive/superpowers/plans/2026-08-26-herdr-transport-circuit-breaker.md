# Herdr Transport Circuit Breaker Plan

1. Add public state-machine tests for closed, open, half-open, recovery,
   concurrency, transport classification, and prompt no-replay behavior.
2. Implement a `HerdrPort` decorator with bounded diagnostics.
3. Add validated threshold/cooldown configuration and composition-root wiring.
4. Expose diagnostics through `/status` and document runtime behavior.
5. Run focused tests, the full suite, typecheck, build, deploy, and collect live
   status/build evidence.
